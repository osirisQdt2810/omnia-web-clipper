/**
 * @fileoverview The panel's requests, as the SERVICE WORKER actually makes them.
 *
 * Plain Node with `assert`, like the other two test files. background.js is evaluated as
 * SOURCE in a sandbox because a service worker is not importable -- its work happens at top
 * level -- and running the real file is what makes this meaningful: it catches the branch
 * being edited out, which a re-implementation in the test could not.
 *
 * Why the worker at all: a page-context fetch to 127.0.0.1 carries an `Origin` header, and the
 * add-on refuses those on /generate by design (that endpoint mutates notes and spends the
 * user's LLM credits, so anything a web page could have initiated is refused). So the content
 * script may only ASK, over runtime messaging, and this is the half that answers.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const SEND_TIMEOUT_MS = 2000;

/** A fetch answer shaped like the slice of Response that shared.js uses. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    statusText: 'test',
    json: async function () {
      if (body === undefined) {
        throw new Error('no body');
      }
      return body;
    },
  };
}

/**
 * Load background.js (and, for real, the shared.js it imports) with a mock `chrome`.
 *
 * Both storage areas are modelled, and every write to either is recorded: the lookup token is
 * deliberately kept OUT of chrome.storage.sync (it is a machine-local loopback credential), and
 * a stub with one area could not tell that apart from a token written wherever.
 *
 * @param {{settings: (!Object|undefined), local: (!Object|undefined),
 *          respond: (function(string, !Object)|undefined)}=} options
 *     settings: what chrome.storage.sync holds; local: what chrome.storage.local holds;
 *     respond: the fake network.
 * @return {!Object} `{requests, writes, storage, send}` — what went out, what was written,
 *     what each area holds now, and how to send the worker a message.
 */
function runWorker(options) {
  const opts = options || {};
  const stored = Object.assign({}, opts.settings);
  const localStored = Object.assign({}, opts.local);
  const respond = opts.respond || function () {
    return jsonResponse(200, {});
  };
  const requests = [];
  const writes = [];
  const listeners = [];

  /** One storage area: reads merge over the caller's defaults, writes are recorded. */
  function area(name, backing) {
    return {
      get: function (defaults, cb) { cb(Object.assign({}, defaults, backing)); },
      set: function (values, cb) {
        writes.push({area: name, keys: Object.keys(values)});
        Object.assign(backing, values);
        if (cb) cb();
      },
      remove: function (key, cb) {
        writes.push({area: name, removed: key});
        delete backing[key];
        if (cb) cb();
      },
    };
  }

  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: {addListener: function () {}},
      onStartup: {addListener: function () {}},
      onMessage: {addListener: function (fn) { listeners.push(fn); }},
      reload: function () {},
      openOptionsPage: function () {},
    },
    storage: {
      sync: area('sync', stored),
      local: area('local', localStored),
    },
    contextMenus: {
      onClicked: {addListener: function () {}},
      removeAll: function (cb) { if (cb) cb(); },
      create: function () {},
    },
    tabs: {query: function () { return Promise.resolve([]); }, sendMessage: function () {}},
    scripting: {executeScript: function () { return Promise.resolve(); }},
  };

  const sandbox = {
    chrome: chrome,
    self: {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    URLSearchParams: URLSearchParams,
    // requestGenerate budgets a /generate the way the desktop clipper does, and needs a real
    // AbortController to do it.
    AbortController: AbortController,
    Date: Date,
    fetch: async function (url, init) {
      requests.push({url: url, init: init || {}});
      return respond(url, init || {});
    },
  };
  sandbox.globalThis = sandbox;
  // The real importScripts, so shared.js is the one under test rather than a stand-in.
  sandbox.importScripts = function () {
    for (let i = 0; i < arguments.length; i += 1) {
      vm.runInContext(fs.readFileSync(path.join(SRC, arguments[i]), 'utf8'), sandbox);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), sandbox);
  assert.strictEqual(listeners.length, 1, 'background.js must register its message handler');

  return {
    requests: requests,
    writes: writes,
    storage: {sync: stored, local: localStored},
    // The real shared.js the worker imported, for the settings half that no message reaches.
    clipper: sandbox.self.OmniaClipper,
    send: function (message) {
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error('the worker never answered ' + message.type));
        }, SEND_TIMEOUT_MS);
        const kept = listeners[0](message, {}, function (response) {
          clearTimeout(timer);
          resolve(response);
        });
        if (!kept) {
          clearTimeout(timer);
          reject(new Error('the worker did not keep the channel open for ' + message.type));
        }
      });
    },
  };
}

// The synced half of the settings. The token is NOT here: it is a credential for a loopback
// service on this machine, so it lives in chrome.storage.local (see LOCAL below).
const SETTINGS = {
  ankiConnectUrl: 'http://127.0.0.1:8765',
  apiKey: '',
  lookupUrl: 'http://127.0.0.1:8766',
};

/** The machine-local half. */
const LOCAL = {lookupToken: 'sekret'};

/** The header value, whatever case the header was written in. */
function header(init, name) {
  const headers = init.headers || {};
  const key = Object.keys(headers).filter(function (k) {
    return k.toLowerCase() === name.toLowerCase();
  })[0];
  return key === undefined ? undefined : headers[key];
}

const tests = {
  'a regenerate request goes out from the WORKER, as a POST to /generate': async function () {
    const answer = {
      note_id: 7,
      results: [{field: 'Definition', status: 'generated', message: '', text: 'ok'}],
    };
    const worker = runWorker({
      settings: SETTINGS,
      local: LOCAL,
      respond: function () { return jsonResponse(200, answer); },
    });
    const response = await worker.send({
      type: 'omnia-generate',
      noteId: 7,
      fields: ['Definition'],
    });
    assert.strictEqual(worker.requests.length, 1, 'the worker made no request at all');
    const request = worker.requests[0];
    assert.strictEqual(request.url, 'http://127.0.0.1:8766/generate');
    assert.strictEqual(request.init.method, 'POST');
    assert.strictEqual(header(request.init, 'Content-Type'), 'application/json');
    assert.strictEqual(
      header(request.init, 'X-Omnia-Token'),
      'sekret',
      'the endpoint writes to the collection, so it is authenticated — and the token has to ' +
        'be found in chrome.storage.LOCAL, which is where it is now kept'
    );
    assert.deepStrictEqual(JSON.parse(request.init.body), {
      client: 'web_clipper',
      note_id: 7,
      fields: ['Definition'],
    });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.result.results[0].text, 'ok');
  },

  'no field list means the whole note': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(200, {note_id: 7, results: []}); },
    });
    await worker.send({type: 'omnia-generate', noteId: 7, fields: null});
    assert.strictEqual(
      JSON.parse(worker.requests[0].init.body).fields,
      null,
      '"Generate all" sends null, which the add-on reads as every field'
    );
  },

  'the worker sets no Origin header of its own': async function () {
    // Chrome attaches `Origin: chrome-extension://<id>` at the network layer for an extension's
    // cross-origin POST, and `Origin` is a forbidden header name so JS can neither set nor
    // remove it. This only pins the half we control: nothing in our code adds one, so a 403
    // from the add-on is about Chrome's header, not about a stray line here.
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(200, {note_id: 7, results: []}); },
    });
    await worker.send({type: 'omnia-generate', noteId: 7, fields: ['Definition']});
    const headers = worker.requests[0].init.headers || {};
    assert.ok(
      !Object.keys(headers).some(function (k) { return k.toLowerCase() === 'origin'; }),
      'the clipper must not send an Origin header itself'
    );
  },

  'a 409 comes back as the switch to flip, a 503 as a different fix': async function () {
    const conflict = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(409, {error: 'regenerate_from_clippers off'}); },
    });
    const conflictResponse = await conflict.send({type: 'omnia-generate', noteId: 7});
    assert.strictEqual(conflictResponse.ok, false);
    assert.ok(
      /Regenerate from clippers/.test(conflictResponse.error),
      '409 has ONE remedy and the panel has to name it: ' + conflictResponse.error
    );

    const busy = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(503, {error: 'smart notes disabled'}); },
    });
    const busyResponse = await busy.send({type: 'omnia-generate', noteId: 7});
    assert.strictEqual(busyResponse.ok, false);
    assert.ok(/Smart Notes/.test(busyResponse.error), busyResponse.error);
    assert.notStrictEqual(
      busyResponse.error,
      conflictResponse.error,
      'two different problems must not read as the same sentence'
    );
  },

  'the token is read from LOCAL storage and never written to sync': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      local: LOCAL,
      respond: function () { return jsonResponse(200, {note_id: 7, results: []}); },
    });
    await worker.send({type: 'omnia-generate', noteId: 7, fields: ['Definition']});
    assert.strictEqual(
      header(worker.requests[0].init, 'X-Omnia-Token'),
      'sekret',
      'a token in chrome.storage.local must still reach the request'
    );
    assert.ok(
      worker.writes.every(function (w) {
        return w.area !== 'sync' || (w.keys || []).indexOf('lookupToken') === -1;
      }),
      'the token was written to chrome.storage.sync, which replicates it to Google and to ' +
        'every Chrome profile signed into the account — for a credential that only works on ' +
        'the machine whose Omnia issued it'
    );
  },

  'saving the form puts the token in local storage and the rest in sync': async function () {
    const worker = runWorker({settings: SETTINGS, local: {}});
    await worker.clipper.saveSettings({lookupToken: 'fresh', deckName: 'Omnia Capture'});
    assert.strictEqual(worker.storage.local.lookupToken, 'fresh', 'the token must be kept');
    assert.strictEqual(
      worker.storage.sync.lookupToken,
      undefined,
      'pressing Save on the options page is the commonest way the token gets written — if it ' +
        'goes to sync from here, moving the READ to local changed nothing'
    );
    assert.strictEqual(
      worker.storage.sync.deckName,
      'Omnia Capture',
      'and every other setting still follows the user to their other machines'
    );
  },

  'a token an older build left in sync is migrated, not lost': async function () {
    const worker = runWorker({
      // Exactly what an install that predates the split holds: the token still in sync.
      settings: Object.assign({}, SETTINGS, {lookupToken: 'legacy'}),
      local: {},
      respond: function () { return jsonResponse(200, {note_id: 7, results: []}); },
    });
    await worker.send({type: 'omnia-generate', noteId: 7, fields: ['Definition']});
    assert.strictEqual(
      header(worker.requests[0].init, 'X-Omnia-Token'),
      'legacy',
      'the upgrade must not make the user re-enter a token that already works'
    );
    assert.strictEqual(
      worker.storage.local.lookupToken,
      'legacy',
      'the token was not copied into local storage, so the next read starts over'
    );
    assert.strictEqual(
      worker.storage.sync.lookupToken,
      undefined,
      'the synced copy has to GO — leaving it means the secret stays replicated for ever'
    );
    const copied = worker.writes.findIndex(function (w) {
      return w.area === 'local' && (w.keys || []).indexOf('lookupToken') !== -1;
    });
    const dropped = worker.writes.findIndex(function (w) {
      return w.area === 'sync' && w.removed === 'lookupToken';
    });
    assert.ok(
      copied !== -1 && dropped !== -1 && copied < dropped,
      'removing the synced copy first would lose the token outright if the local write failed'
    );
  },

  'a /generate is given a deadline, and a missed one says so': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      local: LOCAL,
      respond: function () { return jsonResponse(200, {note_id: 7, results: []}); },
    });
    await worker.send({type: 'omnia-generate', noteId: 7, fields: ['Definition']});
    assert.ok(
      worker.requests[0].init.signal,
      'a fetch with no AbortSignal has no deadline at all: if the answer never comes the ' +
        "panel spins for as long as the browser keeps the worker alive, and the user's own " +
        'request is what they are waiting on'
    );

    const slow = runWorker({
      settings: SETTINGS,
      local: LOCAL,
      // What an aborted fetch rejects with, which is NOT the same as an unreachable service.
      respond: function () {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      },
    });
    const response = await slow.send({type: 'omnia-generate', noteId: 7});
    assert.strictEqual(response.ok, false);
    assert.ok(
      !/Word Lookup/.test(response.error),
      'a request Omnia spent minutes on must not be reported as "Anki is not running": ' +
        response.error
    );
    assert.ok(
      /still be generating/.test(response.error),
      'the work carries on inside Anki after the clipper gives up, and the message has to say ' +
        'so or the user regenerates it a second time: ' + response.error
    );
  },

  'a service that is not there is reported, not thrown': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () { throw new TypeError('Failed to fetch'); },
    });
    const response = await worker.send({type: 'omnia-generate', noteId: 7});
    assert.strictEqual(response.ok, false);
    assert.ok(
      /Word Lookup/.test(response.error),
      'Anki being closed is the commonest failure; say what to switch on: ' + response.error
    );
  },

  'the lookup goes out naming the client': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(200, {word: 'run', found: false, cards: []}); },
    });
    const response = await worker.send({type: 'omnia-lookup', word: 'run'});
    assert.strictEqual(response.ok, true);
    assert.ok(
      worker.requests[0].url.indexOf('client=web_clipper') !== -1,
      'the add-on keys per-clipper settings on this parameter: ' + worker.requests[0].url
    );
  },

  '"Open in Anki" asks AnkiConnect for the note BY ID': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () { return jsonResponse(200, {result: null, error: null}); },
    });
    const response = await worker.send({type: 'omnia-gui-browse', noteId: 42});
    assert.strictEqual(response.ok, true);
    assert.strictEqual(worker.requests[0].url, 'http://127.0.0.1:8765');
    const body = JSON.parse(worker.requests[0].init.body);
    assert.strictEqual(body.action, 'guiBrowse');
    assert.deepStrictEqual(body.params, {query: 'nid:42'});
  },

  'a refused AnkiConnect call is reported to the panel': async function () {
    const worker = runWorker({
      settings: SETTINGS,
      respond: function () {
        return jsonResponse(200, {result: null, error: 'collection is not open'});
      },
    });
    const response = await worker.send({type: 'omnia-gui-browse', noteId: 42});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error, 'collection is not open');
  },

  'the capture path still answers': async function () {
    // The regenerate branches were inserted ahead of it; a `return false` in the wrong place
    // would silence the "+" everywhere.
    const worker = runWorker({
      settings: Object.assign({}, SETTINGS, {enabled: false}),
    });
    const response = await worker.send({type: 'omnia-capture', payload: {selection: 'run'}});
    assert.strictEqual(response.ok, false);
    assert.ok(/disabled/.test(response.error), response.error);
  },
};

let failed = 0;
const names = Object.keys(tests);

(async function () {
  for (const name of names) {
    try {
      await tests[name]();
      console.log('  ok   ' + name);
    } catch (err) {
      failed += 1;
      console.error('  FAIL ' + name + '\n       ' + err.message);
    }
  }
  console.log(failed ? '\n' + failed + ' failing' : '\n' + names.length + ' passing');
  process.exit(failed ? 1 : 0);
})();
