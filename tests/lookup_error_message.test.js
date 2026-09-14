/**
 * @fileoverview What a failed lookup actually tells the user.
 *
 * Every failure used to come back as one sentence: "Can't reach Anki's lookup service. Make sure
 * Anki is running with Omnia's Word Lookup feature switched on." That sentence is about ONE cause
 * and was printed for all of them — including the case that produced this file, where the service
 * address had been typed into the wrong box on the options page. The user was told to go and
 * check a feature that was already on, and the thing that was actually wrong was never mentioned.
 *
 * Plain Node with `assert`, like the rest of tests/.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/** Load shared.js into this realm and hand back what it exports. */
function loadShared() {
  const context = {globalThis: undefined, chrome: {storage: {sync: {}}}, console: console};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'shared.js'), 'utf8'), context);
  return context.OmniaClipper;
}

const {lookupErrorMessage, LOOKUP_UNREACHABLE} = loadShared();
const DEFAULT = 'http://127.0.0.1:8766';

// -- nothing answered: the one case the original sentence was written for --------------------

{
  // `fetch` rejects with a TypeError when the connection never happened at all: Anki closed, the
  // wrong port, the feature switched off.
  const message = lookupErrorMessage(new TypeError('Failed to fetch'), DEFAULT);
  assert.ok(message.startsWith(LOOKUP_UNREACHABLE), 'a dead connection keeps the old sentence');
  assert.ok(
    message.includes(DEFAULT),
    'and now names the address it tried, so a wrong port is visible: ' + message,
  );
}

// -- the address is not an address ------------------------------------------------------------

{
  // The case that produced this file: the token pasted into the Lookup service box. Every fetch
  // fails, and "make sure Word Lookup is on" sends the user to a switch that is already on.
  const message = lookupErrorMessage(new TypeError('Failed to parse URL'), 'a1b2c3d4e5');
  assert.ok(
    message.includes('not a URL'),
    'a non-URL address says so rather than blaming the add-on: ' + message,
  );
  assert.ok(message.includes('options'), 'and says where to fix it: ' + message);
  assert.ok(
    message.includes('http://127.0.0.1:8766'),
    'and what it should say: ' + message,
  );
  assert.ok(
    !message.includes(LOOKUP_UNREACHABLE),
    'and does NOT also claim the service is unreachable',
  );
}

// -- the service answered, and said no ---------------------------------------------------------

{
  // An HTTP status is a fact about a service that IS running. Reporting it as unreachable throws
  // away the only piece of information there was.
  const message = lookupErrorMessage(new Error('Lookup service answered 500.'), DEFAULT);
  assert.ok(message.includes('answered 500'), 'the status survives: ' + message);
  assert.ok(!message.includes(LOOKUP_UNREACHABLE), 'and is not called unreachable');
  assert.ok(message.includes(DEFAULT), 'and names where: ' + message);
}

// -- it took too long ---------------------------------------------------------------------------

{
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  const message = lookupErrorMessage(aborted, DEFAULT);
  assert.ok(message.includes('too long'), 'a timeout says so: ' + message);
  assert.ok(!message.includes(LOOKUP_UNREACHABLE), 'a slow service is not a missing one');
}

// -- a trailing slash is not a different address -------------------------------------------------

{
  const message = lookupErrorMessage(new TypeError('Failed to fetch'), DEFAULT + '/');
  assert.ok(message.includes(DEFAULT + '.'), 'the address is normalised: ' + message);
}

console.log('lookup_error_message.test.js: ok');
