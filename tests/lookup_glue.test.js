/**
 * @fileoverview content.js itself, driven against a fake DOM and a fake `chrome`.
 *
 * The other test files exercise the pure halves. This one exercises the GLUE, because that is
 * where the panel's worst bug lived: a regenerate request whose answer came back after the user
 * had switched to another matched note landed on whichever note was on screen. Nothing about
 * that is visible from lookup_view.js alone -- it is a property of how content.js holds the
 * state, sends the request and folds the answer back in -- and it cannot be seen in a
 * screenshot either, because the wrong message looks exactly like a right one.
 *
 * Plain Node with `assert`, like the other three files, and no framework. content.js is
 * compiled with `vm.compileFunction` into THIS realm (as tests/lookup_panel.test.js does) so
 * everything it builds is comparable with a plain literal here, with the globals it reaches for
 * passed in as arguments -- which is also what keeps the fake DOM to the few dozen lines below.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const PANEL_ID = 'omnia-clipper-lookup-panel';
const TOOLTIP_ID = 'omnia-clipper-tooltip';

// -- the smallest DOM the content script can run against -------------------------------------

/** One element: enough of the surface content.js touches, and nothing more. */
class FakeElement {
  /** @param {string} tag The tag name. */
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.title = '';
    this.id = '';
    this.disabled = false;
    this.shadowRoot = null;
    this.isConnected = false;
    this._listeners = {};
  }

  setAttribute(name, value) {
    if (name === 'id') {
      this.id = String(value);
    }
  }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    markConnected(child, this.isConnected);
    return child;
  }

  replaceWith(other) {
    const parent = this.parentElement;
    if (!parent) {
      return;
    }
    parent.children[parent.children.indexOf(this)] = other;
    other.parentElement = parent;
    markConnected(other, parent.isConnected);
    markConnected(this, false);
    this.parentElement = null;
  }

  remove() {
    const parent = this.parentElement;
    if (parent) {
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    }
    markConnected(this, false);
  }

  contains(node) {
    if (node === this) {
      return true;
    }
    return this.children.some(function (child) {
      return child.contains(node);
    });
  }

  attachShadow() {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }

  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }

  /** Fire one event at this element (the test's stand-in for a real click). */
  fire(type, event) {
    (this._listeners[type] || []).slice().forEach(function (handler) {
      handler(event || {preventDefault: function () {}, stopPropagation: function () {}});
    });
  }
}

/** Flip `isConnected` down a subtree, so probeLookup's guard means what it means. */
function markConnected(element, connected) {
  element.isConnected = connected;
  element.children.forEach(function (child) {
    markConnected(child, connected);
  });
}

/**
 * The panel's shadow root.
 *
 * `querySelectorAll` reads the markup content.js just assigned, exactly as the real one does --
 * so a control the renderer stopped emitting simply stops being wired, and the test can press
 * only what a user could press. The elements handed out are remembered until the next render,
 * which is what lets a test click them.
 */
class FakeShadowRoot {
  constructor() {
    this._html = '';
    this.bound = [];
  }

  set innerHTML(html) {
    this._html = String(html);
    this.bound = [];
  }

  get innerHTML() {
    return this._html;
  }

  querySelector(selector) {
    return selector === '.omnia-panel' && this._html ? {scrollTop: 0} : null;
  }

  querySelectorAll(selector) {
    const attribute = selector.replace(/^\[|\]$/g, '');
    const pattern = new RegExp(attribute + '="([^"]*)"', 'g');
    const found = [];
    let match;
    while ((match = pattern.exec(this._html)) !== null) {
      const element = new FakeElement('button');
      element.attribute = attribute;
      element.value = match[1];
      element.dataset[datasetKey(attribute)] = match[1];
      found.push(element);
      this.bound.push(element);
    }
    return found;
  }
}

/** `data-omnia-generate-all` -> `omniaGenerateAll`, the way a real dataset key reads. */
function datasetKey(attribute) {
  return attribute
    .replace(/^data-/, '')
    .replace(/-([a-z])/g, function (_all, letter) {
      return letter.toUpperCase();
    });
}

/** The document, with a body, a listener registry and getElementById over the real tree. */
function makeDocument() {
  const body = new FakeElement('body');
  body.isConnected = true;
  body.textContent = 'I run home every day. It was a good run.';
  const listeners = {};
  return {
    title: 'A page about running',
    body: body,
    createElement: function (tag) {
      return new FakeElement(tag);
    },
    getElementById: function (id) {
      return findById(body, id);
    },
    addEventListener: function (type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    removeEventListener: function (type, handler) {
      const kept = (listeners[type] || []).filter(function (fn) {
        return fn !== handler;
      });
      listeners[type] = kept;
    },
    /** Fire a document-level event at every listener registered for it. */
    fire: function (type, event) {
      (listeners[type] || []).slice().forEach(function (handler) {
        handler(event);
      });
    },
  };
}

/** Depth-first search for an element by id, like getElementById. */
function findById(element, id) {
  if (element.id === id) {
    return element;
  }
  for (let i = 0; i < element.children.length; i += 1) {
    const found = findById(element.children[i], id);
    if (found) {
      return found;
    }
  }
  return null;
}

// -- the fake extension ----------------------------------------------------------------------

/** A `chrome` that records every message and lets the test answer them in any order. */
function makeChrome() {
  const sent = [];
  return {
    sent: sent,
    runtime: {
      id: 'omnia-test-extension',
      lastError: null,
      sendMessage: function (message, callback) {
        sent.push({message: message, callback: callback, answered: false});
      },
      onMessage: {addListener: function () {}, removeListener: function () {}},
    },
    storage: {
      sync: {
        get: function (defaults, callback) {
          callback(Object.assign({}, defaults));
        },
      },
      onChanged: {addListener: function () {}, removeListener: function () {}},
    },
  };
}

/**
 * The first message of `type` nobody has answered yet.
 * @param {!Object} chrome The fake chrome.
 * @param {string} type The message type.
 * @param {?number=} noteId Only a request about this note, when given.
 * @return {?Object} The pending entry.
 */
function pending(chrome, type, noteId) {
  return (
    chrome.sent.filter(function (entry) {
      if (entry.answered || entry.message.type !== type) {
        return false;
      }
      return noteId === undefined || entry.message.noteId === noteId;
    })[0] || null
  );
}

/** Answer a pending message, as the service worker eventually would. */
function answer(chrome, entry, response) {
  assert.ok(entry, 'nothing was waiting for an answer');
  entry.answered = true;
  chrome.runtime.lastError = null; // a delivered answer leaves none behind
  entry.callback(response);
}

/** Answer a pending message with a dropped channel (a terminated service worker). */
function loseAnswer(chrome, entry) {
  assert.ok(entry, 'nothing was waiting for an answer');
  entry.answered = true;
  chrome.runtime.lastError = {message: 'The message port closed before a response was received.'};
  try {
    entry.callback(undefined);
  } finally {
    chrome.runtime.lastError = null;
  }
}

// -- loading content.js ----------------------------------------------------------------------

/**
 * Load lookup_view.js + content.js against a fresh fake page.
 * @return {!Object} `{document, chrome, window}` — the page the content script now drives.
 */
function loadContentScript() {
  const scope = {};
  vm.compileFunction(fs.readFileSync(path.join(SRC, 'lookup_view.js'), 'utf8'), ['self'], {
    filename: 'lookup_view.js',
  })(scope);

  const document = makeDocument();
  const chrome = makeChrome();
  const win = scope;
  win.innerWidth = 1280;
  win.innerHeight = 800;
  win.getSelection = function () {
    return {
      rangeCount: 1,
      isCollapsed: false,
      toString: function () {
        return 'run';
      },
      getRangeAt: function () {
        return {commonAncestorContainer: document.body};
      },
    };
  };

  vm.compileFunction(
    fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'),
    ['self', 'window', 'document', 'chrome', 'location', 'Node'],
    {filename: 'content.js'}
  )(scope, win, document, chrome, {href: 'https://example.test/running'}, {TEXT_NODE: 3});

  return {document: document, chrome: chrome, window: win};
}

/** Let the selection debounce (10ms) and any promise chain settle. */
function settle() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 30);
  });
}

/** The open panel's shadow root, or null. */
function panel(page) {
  const host = page.document.getElementById(PANEL_ID);
  return host ? host.shadowRoot : null;
}

/** Press the control carrying `attribute="value"` in the open panel. */
function press(page, attribute, value) {
  const root = panel(page);
  assert.ok(root, 'no panel is open');
  const control = root.bound.filter(function (element) {
    return element.attribute === attribute && (value === undefined || element.value === value);
  })[0];
  assert.ok(control, 'the panel has no ' + attribute + '="' + value + '" to press');
  control.fire('click');
}

/**
 * Select a word and press the magnifier, then answer the pill's own probe.
 * @param {!Object} page The loaded page.
 * @return {!Promise<void>} Resolves with the panel open on "Searching…".
 */
async function openLookup(page) {
  page.document.fire('mouseup', {clientX: 40, clientY: 60, target: page.document.body});
  await settle();
  const pill = page.document.getElementById(TOOLTIP_ID);
  assert.ok(pill, 'no "+" pill appeared for the selection');
  assert.strictEqual(pill.children.length, 2, 'the pill should carry "+" and the magnifier');
  // The magnifier probes on its own ("2 cards match"); answer it so it is out of the way.
  answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: {cards: []}});
  pill.children[1].fire('mousedown');
}

/** Two matches that share a field name, so a leaked message reads as an answer. */
function twinNoteResult() {
  return {
    word: 'run',
    found: true,
    can_regenerate: true,
    cards: [
      {
        note_id: 11,
        note_type: 'Vocabulary',
        deck: 'English::Verbs',
        title: 'run (verb)',
        state: 'review',
        fields: [
          {name: 'Audio', text: '', audio: [], images: [], empty: true, state: 'ready'},
          {name: 'Example', text: '', audio: [], images: [], empty: true, state: 'ready'},
        ],
      },
      {
        note_id: 22,
        note_type: 'Vocabulary',
        deck: 'English::Nouns',
        title: 'run (noun)',
        state: 'new',
        fields: [{name: 'Audio', text: '', audio: [], images: [], empty: true, state: 'ready'}],
      },
    ],
  };
}

/** Open a panel on the two-note answer, ready to regenerate. */
async function openPanel() {
  const page = loadContentScript();
  await openLookup(page);
  answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: twinNoteResult()});
  assert.ok(panel(page), 'the lookup answer did not open a panel');
  return page;
}

const tests = {
  'the panel opens on the note the lookup found': async function () {
    const page = await openPanel();
    const html = panel(page).innerHTML;
    assert.ok(html.indexOf('run (verb)') !== -1, 'the first match should be on screen: ' + html);
    assert.ok(html.indexOf('data-omnia-switch="1"') !== -1, 'the second match must be reachable');
  },

  'a regenerate answer for the note you LEFT does not touch the note on screen':
    async function () {
      const page = await openPanel();
      press(page, 'data-omnia-generate', 'Audio');
      const first = pending(page.chrome, 'omnia-generate');
      assert.ok(first, 'pressing ⟳ sent no request');
      assert.strictEqual(first.message.noteId, 11);

      press(page, 'data-omnia-switch', '1');
      assert.ok(
        panel(page).innerHTML.indexOf('run (noun)') !== -1,
        'the switcher did not move to the second match'
      );

      // Note 11's answer comes back NOW, while note 22 is the one being read. Both have "Audio".
      answer(page.chrome, first, {
        ok: true,
        result: {
          note_id: 11,
          results: [{field: 'Audio', status: 'blocked', message: 'needs Definition'}],
        },
      });

      const html = panel(page).innerHTML;
      assert.ok(
        html.indexOf('needs Definition') === -1,
        'a reason Omnia gave about note 11 was printed under note 22: ' + html
      );
      assert.ok(html.indexOf('run (noun)') !== -1, 'and the panel stayed on the note being read');

      press(page, 'data-omnia-switch', '0');
      assert.ok(
        panel(page).innerHTML.indexOf('needs Definition') !== -1,
        'the answer must still be there for the note it was actually about'
      );
    },

  'switching notes does not cancel the run you left behind': async function () {
    const page = await openPanel();
    press(page, 'data-omnia-generate', 'Audio');
    press(page, 'data-omnia-switch', '1');
    press(page, 'data-omnia-switch', '0');

    const html = panel(page).innerHTML;
    assert.ok(
      html.indexOf('class="spin"') !== -1,
      'the spinner was lost while the request was still in flight, so the field sits there ' +
        'looking idle: ' + html
    );
    assert.ok(
      html.indexOf('data-omnia-generate="Audio"') === -1,
      'and the button came back with it, offering a second run of a generation already in ' +
        'flight — the same work, paid for twice'
    );
    assert.ok(
      html.indexOf('data-omnia-generate="Example"') !== -1,
      'only the field that is running is held; the rest of the note stays usable'
    );
  },

  'a different note may generate while the first one is still running': async function () {
    const page = await openPanel();
    press(page, 'data-omnia-generate', 'Audio');
    press(page, 'data-omnia-switch', '1');
    press(page, 'data-omnia-generate', 'Audio');

    const requests = page.chrome.sent
      .filter(function (entry) {
        return entry.message.type === 'omnia-generate';
      })
      .map(function (entry) {
        return entry.message.noteId;
      });
    assert.deepStrictEqual(
      requests,
      [11, 22],
      'the second note was refused because the FIRST one was busy; they are different notes, ' +
        'and the switcher is the only way to reach the second at all'
    );

    answer(page.chrome, pending(page.chrome, 'omnia-generate', 22), {
      ok: true,
      result: {note_id: 22, results: [{field: 'Audio', status: 'generated', text: 'rʌn (noun)'}]},
    });
    assert.ok(
      panel(page).innerHTML.indexOf('rʌn (noun)') !== -1,
      "note 22's own answer must land on note 22"
    );
    assert.ok(
      panel(page).innerHTML.indexOf('class="spin"') === -1,
      'and stop its spinner'
    );
  },

  'a lost /generate answer says so, and goes to find out what the note holds':
    async function () {
      const page = await openPanel();
      press(page, 'data-omnia-generate', 'Audio');
      loseAnswer(page.chrome, pending(page.chrome, 'omnia-generate'));

      const html = panel(page).innerHTML;
      assert.ok(
        html.indexOf('reload this page') === -1,
        'the page is fine and the extension was not updated: the service worker was terminated ' +
          'mid-fetch, and Omnia carries on generating. Sending the user to reload the page ' +
          'tells them to fix nothing: ' + html
      );
      assert.ok(
        /still be generating/.test(html),
        'the work may well be running right now, and the message has to say so: ' + html
      );

      const refresh = pending(page.chrome, 'omnia-lookup');
      assert.ok(
        refresh,
        'nothing asked what the note holds now, so the panel keeps showing the stale copy of a ' +
          'note Omnia may have finished writing'
      );
      const fresher = twinNoteResult();
      fresher.cards[0].fields[0] = {
        name: 'Audio',
        text: 'rʌn',
        audio: ['run.mp3'],
        images: [],
        empty: false,
        state: 'ready',
      };
      answer(page.chrome, refresh, {ok: true, result: fresher});
      assert.ok(
        panel(page).innerHTML.indexOf('run.mp3') !== -1,
        'the refreshed answer was not drawn'
      );
    },

  'an answer that arrives after the panel is dismissed does not resurrect it': async function () {
    const page = loadContentScript();
    await openLookup(page);
    assert.ok(panel(page), 'the loading panel should be up while the lookup is in flight');

    page.document.fire('keydown', {key: 'Escape'});
    assert.strictEqual(panel(page), null, 'Escape must close the panel');

    answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: twinNoteResult()});
    assert.strictEqual(
      page.document.getElementById(PANEL_ID),
      null,
      'the answer built a NEW panel at the pointer, resurrecting one the user had dismissed — ' +
        'and this panel carries buttons that rewrite notes'
    );
  },

  'a failed lookup does not resurrect a dismissed panel either': async function () {
    const page = loadContentScript();
    await openLookup(page);
    page.document.fire('mousedown', {target: page.document.body, clientX: 5, clientY: 5});
    assert.strictEqual(panel(page), null, 'a click outside must close the panel');

    answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: false, error: 'nope'});
    assert.strictEqual(page.document.getElementById(PANEL_ID), null, 'an error state was drawn');
  },

  'a dead extension context takes the panel down with it': async function () {
    const page = await openPanel();
    assert.ok(page.document.getElementById(PANEL_ID), 'expected an open panel to tear down');

    // What a re-injection does first: tear the previous instance down (content.js's own
    // double-injection guard calls exactly this).
    page.window.__omniaClipperTeardown();

    assert.strictEqual(
      page.document.getElementById(PANEL_ID),
      null,
      'the panel outlived the instance that built it. ensurePanelHost ADOPTS an existing host ' +
        'by id, so the next instance inherits this one whole — handlers, shadow root and all — ' +
        'and draws live answers into a node wired to a context that can no longer reach Anki.'
    );
    assert.strictEqual(page.document.getElementById(TOOLTIP_ID), null, 'the pill goes too');
  },

  'an inert control still explains itself, on its own note': async function () {
    const page = loadContentScript();
    await openLookup(page);
    const off = twinNoteResult();
    off.can_regenerate = false;
    answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: off});

    press(page, 'data-omnia-generate', 'Audio');
    assert.strictEqual(
      pending(page.chrome, 'omnia-generate'),
      null,
      'a request went out for a note Omnia has said it will refuse'
    );
    // The reason rides on a panel note. (Every button's TOOLTIP carries it too, on every note,
    // which is why the printed line is what has to be counted here.)
    assert.ok(
      /class="fnote panel-note"/.test(panel(page).innerHTML),
      'the click has to print the reason; saying nothing is what the inert button exists to avoid'
    );

    press(page, 'data-omnia-switch', '1');
    assert.ok(
      !/class="fnote panel-note"/.test(panel(page).innerHTML),
      'the explanation belonged to the note it was asked about, not to the panel'
    );
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
