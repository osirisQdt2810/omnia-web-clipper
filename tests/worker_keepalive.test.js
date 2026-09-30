/**
 * @fileoverview The worker outlives a slow model, and says something useful if it does not.
 *
 * Chrome ends an MV3 service worker after about 30 s without an event or an extension API call;
 * a pending fetch counts as neither. A phrase check against a self-hosted model that sleeps when
 * idle takes 85-100 s to wake, so the worker was ended mid-request and the page showed Chrome's
 * own "The message port closed before a response was received." These run the REAL background.js
 * and content.js in a sandbox, with timers the test drives, so no test waits for real seconds.
 *
 * Plain Node with `assert`, like the other test files.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/** Load the real worker with a mock chrome, a fetch the test resolves, and manual intervals. */
function worker() {
  const listeners = [];
  const intervals = new Map();
  let nextId = 1;
  let beats = 0;
  const pending = [];
  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: {addListener() {}},
      onStartup: {addListener() {}},
      onMessage: {addListener(fn) { listeners.push(fn); }},
      reload() {},
      openOptionsPage() {},
      getPlatformInfo(cb) { beats += 1; if (cb) cb({}); },
    },
    storage: {
      sync: {get(defaults, cb) { cb(Object.assign({}, defaults)); }, set(_v, cb) { if (cb) cb(); }},
      local: {get(defaults, cb) { cb(Object.assign({}, defaults)); }, set(_v, cb) { if (cb) cb(); },
              remove(_k, cb) { if (cb) cb(); }},
    },
    contextMenus: {onClicked: {addListener() {}}, removeAll(cb) { if (cb) cb(); }, create() {}},
    tabs: {query() { return Promise.resolve([]); }, sendMessage() {}},
    scripting: {executeScript() { return Promise.resolve(); }},
  };
  const sandbox = {
    chrome,
    self: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, {fn, ms}); return id; },
    clearInterval(id) { intervals.delete(id); },
    URL,
    URLSearchParams,
    AbortController,
    Date,
    // Every request hangs until the test answers it — the slow model.
    fetch() { return new Promise((resolve) => pending.push(resolve)); },
  };
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      vm.runInContext(fs.readFileSync(path.join(SRC, name), 'utf8'), sandbox);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), sandbox);
  return {
    clipper: sandbox.self.OmniaClipper,
    intervals,
    get beats() { return beats; },
    pending,
    /** Send a message; resolves with the worker's answer. */
    send(message) {
      return new Promise((resolve) => listeners[0](message, {}, resolve));
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

/** A fetch answer shaped like the slice of Response that shared.js uses. */
const ok = (body) => ({ok: true, status: 200, json: async () => body});

const tests = [];
const test = (name, fn) => tests.push({name, fn});

for (const [type, message, body] of [
  ['omnia-check', {type: 'omnia-check', text: 'what is the stages', mode: ''}, {rewritten: 'x'}],
  ['omnia-generate', {type: 'omnia-generate', noteId: 1, fields: ['Definition']}, {results: []}],
  ['omnia-save-check', {type: 'omnia-save-check', text: 'a phrase', mode: 'written'}, {ok: true}],
]) {
  test(`${type}: the worker keeps itself alive while the add-on is slow`, async () => {
    const w = worker();
    const answer = w.send(message);
    await tick();
    assert.strictEqual(w.pending.length, 1, 'the request should be in flight');
    assert.strictEqual(w.intervals.size, 1, 'no keep-alive beat while the request is pending');
    const [{fn, ms}] = [...w.intervals.values()];
    assert.ok(ms < 30000, `the beat (${ms} ms) must come before Chrome's 30 s idle cut-off`);
    fn();
    fn();
    fn();  // ninety seconds of a model waking up
    assert.strictEqual(w.beats, 3, 'each beat must make an extension API call');
    w.pending[0](ok(body));
    const response = await answer;
    assert.strictEqual(response.ok, true, JSON.stringify(response));
    assert.strictEqual(w.intervals.size, 0, 'the beat must stop once the request settles');
  });
}

test('a failed request stops the beat too', async () => {
  const w = worker();
  const answer = w.send({type: 'omnia-check', text: 'x', mode: ''});
  await tick();
  w.pending[0]({ok: false, status: 502, json: async () => ({error: 'provider down'})});
  const response = await answer;
  assert.strictEqual(response.ok, false);
  assert.strictEqual(w.intervals.size, 0);
});

test('a check allows for a model that has to wake up first', () => {
  const {clipper} = worker();
  // A self-hosted model that sleeps when idle takes 85-100 s to start, before it answers.
  assert.ok(clipper.CHECK_TIMEOUT_MS >= 150000, `CHECK_TIMEOUT_MS is ${clipper.CHECK_TIMEOUT_MS}`);
});

test("the page never shows Chrome's raw port-closed text", () => {
  const source = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
  const fn = source.match(/  function workerFailureText\(failure\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'workerFailureText moved');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn[0] + '\nthis.workerFailureText = workerFailureText;', sandbox);
  const text = sandbox.workerFailureText({
    message: 'The message port closed before a response was received.',
  });
  assert.ok(!/message port/i.test(text), text);
  assert.ok(/try again/i.test(text), text);
  assert.strictEqual(sandbox.workerFailureText({message: 'Something else.'}), 'Something else.');
  assert.strictEqual(sandbox.workerFailureText(null), '');
});

(async () => {
  let failed = 0;
  for (const {name, fn} of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${err && err.message}`);
    }
  }
  console.log(`\n${tests.length - failed} passing${failed ? `, ${failed} failing` : ''}`);
  process.exit(failed ? 1 : 0);
})();
