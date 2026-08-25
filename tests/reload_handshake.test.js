/**
 * @fileoverview The Omnia "Reload" handshake, exercised with a mock `chrome`.
 *
 * This repo carries no test framework and this file deliberately adds none: it is plain Node
 * with `assert`, run by the same CI job that already syntax-checks `src/*.js`.
 *
 * Both halves are evaluated as SOURCE in a sandbox rather than imported, because neither is
 * importable: options.js wraps itself in an IIFE and background.js is a service worker whose
 * work happens at top level. Running the real file is also what makes the test meaningful --
 * it catches the handshake being edited out, which a re-implementation in the test could not.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const REOPEN_KEY = 'omniaReopenOptionsAfterReload';

/** A recording stand-in for the slice of `chrome.*` these two files touch. */
function makeChrome(initialStorage) {
  const store = Object.assign({}, initialStorage);
  const calls = [];
  return {
    calls: calls,
    store: store,
    runtime: {
      lastError: null,
      reload: function () { calls.push('runtime.reload'); },
      openOptionsPage: function () { calls.push('runtime.openOptionsPage'); },
      getURL: function (p) { return 'chrome-extension://testid/' + p; },
      onInstalled: {addListener: function () {}},
      onStartup: {addListener: function () {}},
      onMessage: {addListener: function () {}}
    },
    storage: {
      local: {
        get: function (key, cb) {
          calls.push('storage.get:' + key);
          const out = {};
          if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          cb(out);
        },
        set: function (obj, cb) {
          calls.push('storage.set:' + Object.keys(obj).join(','));
          Object.assign(store, obj);
          if (cb) cb();
        },
        remove: function (key, cb) {
          calls.push('storage.remove:' + key);
          delete store[key];
          if (cb) cb();
        }
      }
    },
    contextMenus: {
      onClicked: {addListener: function () {}},
      removeAll: function (cb) { if (cb) cb(); }
    },
    tabs: {
      query: function () { return Promise.resolve([]); },
      create: function () { calls.push('tabs.create'); }
    },
    scripting: {executeScript: function () { return Promise.resolve(); }}
  };
}

/** Evaluate background.js top-level with a mock chrome, and return what it did. */
function runBackground(initialStorage) {
  const chrome = makeChrome(initialStorage);
  const selfObj = {
    OmniaClipper: {
      loadSettings: async function () { return {}; },
      ankiConnect: async function () { return {}; }
    }
  };
  const sandbox = {
    chrome: chrome,
    self: selfObj,
    importScripts: function () {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    URLSearchParams: URLSearchParams,
    fetch: async function () { return {json: async function () { return {}; }}; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), sandbox);
  return chrome;
}

/** Build a DOM element stub that swallows everything options.js does to one. */
function stubElement() {
  return {
    addEventListener: function () {},
    appendChild: function () {},
    setAttribute: function () {},
    classList: {add: function () {}, remove: function () {}, toggle: function () {}},
    style: {},
    value: '',
    textContent: '',
    options: [],
    dataset: {}
  };
}

/** Evaluate options.js and fire DOMContentLoaded, with a mock chrome + DOM. */
function runOptions(search) {
  const chrome = makeChrome({});
  const listeners = {};
  const body = {textContent: ''};
  const document = {
    body: body,
    addEventListener: function (name, fn) { listeners[name] = fn; },
    getElementById: stubElement,
    createElement: stubElement,
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; }
  };
  const sandbox = {
    chrome: chrome,
    document: document,
    location: {search: search},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URLSearchParams: URLSearchParams,
    alert: function () {},
    fetch: async function () { return {json: async function () { return {}; }}; },
    // options.js destructures these out of `self.OmniaClipper`, which shared.js normally
    // defines. The reload branch runs before any of them is called, so stubs are enough.
    self: {
      OmniaClipper: {
        loadSettings: async function () { return {}; },
        saveSettings: async function () {},
        ankiConnect: async function () { return {}; }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'options.js'), 'utf8'), sandbox);
  assert.ok(listeners.DOMContentLoaded, 'options.js never registered DOMContentLoaded');
  listeners.DOMContentLoaded();
  return {chrome: chrome, body: body};
}

const tests = {
  'background: no flag means no reopen': function () {
    const chrome = runBackground({});
    assert.ok(
      !chrome.calls.includes('runtime.openOptionsPage'),
      'Settings was reopened on an ordinary service-worker start. The worker restarts on ' +
        'the browser own schedule, so this would open a tab out of nowhere.'
    );
  },

  'background: the flag reopens Settings exactly once': function () {
    const chrome = runBackground({[REOPEN_KEY]: true});
    assert.ok(chrome.calls.includes('runtime.openOptionsPage'), 'Settings was not reopened');
    assert.strictEqual(chrome.store[REOPEN_KEY], undefined, 'the flag survived the reopen');
  },

  'background: the flag is cleared BEFORE Settings opens': function () {
    const chrome = runBackground({[REOPEN_KEY]: true});
    const cleared = chrome.calls.indexOf('storage.remove:' + REOPEN_KEY);
    const opened = chrome.calls.indexOf('runtime.openOptionsPage');
    assert.ok(cleared !== -1 && opened !== -1, 'expected both a clear and an open');
    assert.ok(
      cleared < opened,
      'clearing after opening leaves the flag set if opening throws, and Settings then ' +
        'reopens on every later worker start'
    );
  },

  'options: an ordinary open does not reload': function () {
    const result = runOptions('');
    assert.ok(
      !result.chrome.calls.includes('runtime.reload'),
      'opening Settings reloaded the extension'
    );
    assert.ok(
      !result.chrome.calls.some(function (c) {
        return c.indexOf('storage.set:' + REOPEN_KEY) === 0;
      }),
      'an ordinary open wrote the reopen flag'
    );
  },

  'options: the reload parameter stores the flag and reloads': function () {
    const result = runOptions('?omnia-reload=1');
    assert.ok(result.chrome.calls.includes('runtime.reload'), 'the extension was not reloaded');
    assert.strictEqual(result.chrome.store[REOPEN_KEY], true, 'the reopen flag was not stored');
  },

  'options: the flag is stored BEFORE the reload': function () {
    const result = runOptions('?omnia-reload=1');
    const stored = result.chrome.calls.indexOf('storage.set:' + REOPEN_KEY);
    const reloaded = result.chrome.calls.indexOf('runtime.reload');
    assert.ok(
      stored !== -1 && reloaded !== -1 && stored < reloaded,
      'reloading before the flag is stored destroys this page with nothing written, so the ' +
        'fresh worker has nothing to act on and Settings never comes back'
    );
  },

  'options: the user is told what is happening': function () {
    const result = runOptions('?omnia-reload=1');
    assert.ok(
      /reload/i.test(result.body.textContent),
      'the page went blank with no explanation while the extension restarted'
    );
  },

  'options: an unrelated query string is ignored': function () {
    const result = runOptions('?omnia-reload=0&other=1');
    assert.ok(!result.chrome.calls.includes('runtime.reload'), 'reloaded on omnia-reload=0');
  }
};

let failed = 0;
const names = Object.keys(tests);
for (const name of names) {
  try {
    tests[name]();
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name + '\n       ' + err.message);
  }
}
console.log(failed ? '\n' + failed + ' failing' : '\n' + names.length + ' passing');
process.exit(failed ? 1 : 0);
