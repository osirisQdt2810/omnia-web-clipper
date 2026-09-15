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
const CORRECT_PANEL_ID = 'omnia-clipper-correct-panel';
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
    // Enough of a classList for code that marks a control as having succeeded. A Set rather
    // than a string, because `toggle(name, force)` is what the code calls and re-implementing
    // its two-argument form over a string is how a harness starts lying.
    this._classes = new Set();
    this.classList = {
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : !!force;
        if (on) {
          this._classes.add(name);
        } else {
          this._classes.delete(name);
        }
        return on;
      },
    };
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
      // The label the renderer gave it. Blank would hide the bug where a retry restores the
      // button to whatever it said at the top of the click — i.e. to "unavailable".
      element.textContent = attribute === 'data-omnia-audio' ? '▶ Play' : '';
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
 * A Web Audio stack that records what it was asked to do.
 *
 * `decode` decides whether `decodeAudioData` resolves, which is how a test says "this build
 * cannot decode that container" and makes the element fallback the only way through.
 *
 * @param {{decode: boolean}} options How it should behave.
 * @return {!Object} `{Ctx, plays, contexts}`.
 */
function makeWebAudio(options) {
  const plays = [];
  const contexts = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.destination = {};
      this.closed = false;
      contexts.push(this);
    }

    resume() {
      this.state = 'running';
      return Promise.resolve();
    }

    decodeAudioData(buffer) {
      return options.decode
        ? Promise.resolve({duration: 1.5, bytes: buffer.byteLength})
        : Promise.reject(new Error('unsupported container'));
    }

    createBufferSource() {
      const source = {
        buffer: null,
        connect: function () {},
        start: function () {
          plays.push(source.buffer);
        },
      };
      return source;
    }

    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  return {Ctx: FakeAudioContext, plays: plays, contexts: contexts};
}

/** An `<audio>` element that records every URL it was asked to play. */
function makeAudioElement(options) {
  const played = [];
  function FakeAudio(url) {
    this.src = url;
    played.push(url);
    this.addEventListener = function () {};
    this.play = function () {
      return options.play
        ? Promise.resolve()
        : Promise.reject(new Error('NotSupportedError: blocked by the page'));
    };
  }
  return {Audio: FakeAudio, played: played};
}

/**
 * Load both view models + content.js against a fresh fake page.
 *
 * In the SAME order the manifest lists them: content.js reads both globals at load time, so a
 * view model loaded after it would leave that binding undefined and every panel dead.
 *
 * @param {{audio: ?Object, element: ?Object}=} media What the page can play, if anything.
 * @return {!Object} `{document, chrome, window}` — the page the content script now drives.
 */
function loadContentScript(media) {
  const scope = {};
  ['lookup_view.js', 'correct_view.js'].forEach((file) => {
    vm.compileFunction(fs.readFileSync(path.join(SRC, file), 'utf8'), ['self'], {
      filename: file,
    })(scope);
  });

  const document = makeDocument();
  const chrome = makeChrome();
  const win = scope;
  win.innerWidth = 1280;
  win.innerHeight = 800;
  if (media && media.audio) {
    win.AudioContext = media.audio.Ctx;
  }
  if (media && media.element) {
    win.Audio = media.element.Audio;
  }
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

/** The open CORRECTION panel's shadow root, or null. */
function correctPanel(page) {
  const host = page.document.getElementById(CORRECT_PANEL_ID);
  return host ? host.shadowRoot : null;
}

/**
 * The Save button's opening tag, exactly as rendered.
 *
 * Asserting `disabled` against the panel's whole innerHTML is not a test: the shadow root
 * carries the stylesheet too, and that contains `.omnia-correct-save[disabled] { ... }`. A
 * naive /omnia-correct-save[^>]*disabled/ matches the CSS and passes whatever the button says.
 */
function saveButtonTag(page) {
  const match = /<button[^>]*data-save="1"[^>]*>/.exec(correctPanel(page).innerHTML);
  assert.ok(match, 'the panel has no Save button');
  return match[0];
}

/** Press the control carrying `attribute="value"` in the open correction panel. */
function pressCorrect(page, attribute, value) {
  const root = correctPanel(page);
  assert.ok(root, 'no correction panel is open');
  const control = root.bound.filter(function (element) {
    return element.attribute === attribute && (value === undefined || element.value === value);
  })[0];
  assert.ok(control, 'the panel has no ' + attribute + '="' + value + '" to press');
  control.fire('click');
}

/**
 * Select a phrase and press the wand, then answer the pill's own probe.
 * @param {!Object} page The loaded page.
 * @return {!Promise<void>} Resolves with the correction panel open on "Checking…".
 */
async function openCorrect(page) {
  page.document.fire('mouseup', {clientX: 40, clientY: 60, target: page.document.body});
  await settle();
  const pill = page.document.getElementById(TOOLTIP_ID);
  assert.ok(pill, 'no pill appeared for the selection');
  answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: {cards: []}});
  pill.children[2].fire('mousedown');
}

/**
 * The unanswered /check request for `text` (and `mode`, when two are in flight for one phrase).
 *
 * `pending` only ever offers the OLDEST unanswered request, which is precisely the wrong one
 * whenever the point of the test is that an older request is still outstanding.
 */
function checkFor(chrome, text, mode) {
  return (
    chrome.sent.filter(function (entry) {
      return (
        !entry.answered &&
        entry.message.type === 'omnia-check' &&
        entry.message.text === text &&
        (mode === undefined || entry.message.mode === mode)
      );
    })[0] || null
  );
}

/** A correction the add-on might send back. */
function correctionPayload(mode) {
  return {
    original: 'I have went.',
    rewritten: 'I went.',
    mode: mode || 'written',
    already_good: false,
    changed: true,
    fixes: [
      {
        before: 'have went',
        after: 'went',
        why: 'The simple past is what a finished action takes.',
        kind: 'grammar',
        is_deletion: false,
      },
    ],
    highlight: [['I ', false], ['went.', true]],
  };
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
  assert.strictEqual(
    pill.children.length, 3, 'the pill should carry "+", the magnifier and the wand'
  );
  // The magnifier probes on its own ("2 cards match"); answer it so it is out of the way.
  answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: {cards: []}});
  pill.children[1].fire('mousedown');
}

/** One note whose field carries a clip, so the panel renders a ▶ Play button. */
function clipResult() {
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
          {
            name: 'Word (audio)',
            text: '',
            audio: ['run.mp3'],
            images: [],
            empty: false,
            state: 'ready',
          },
        ],
      },
    ],
  };
}

/**
 * Open a panel on a note with a clip and press its ▶ Play.
 * @param {!Object} media What the page can play (see makeWebAudio / makeAudioElement).
 * @return {!Promise<!Object>} The page, with the media request pending.
 */
async function pressPlay(media) {
  const page = loadContentScript(media);
  await openLookup(page);
  answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {ok: true, result: clipResult()});
  press(page, 'data-omnia-audio', 'run.mp3');
  return page;
}

/** The ▶ Play button the panel is currently showing. */
function playButton(page) {
  return panel(page).bound.filter(function (element) {
    return element.attribute === 'data-omnia-audio';
  })[0];
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
  'a clip is decoded and played, never loaded from a URL': async function () {
    // The bug this exists for: an <audio> element pointed at a blob: URL is a RESOURCE LOAD,
    // and a page with `default-src 'self'` refuses it — so every sound on such a site failed
    // with NotSupportedError and the panel said "unavailable". Web Audio decodes bytes we
    // already hold, and a CSP has nothing to refuse.
    const audio = makeWebAudio({decode: true});
    const element = makeAudioElement({play: false});
    const page = await pressPlay({audio: audio, element: element});

    answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
    await settle();

    assert.strictEqual(audio.plays.length, 1, 'the clip was not played through Web Audio');
    assert.deepStrictEqual(element.played, [], 'it must not fall back while decoding worked');
    // The label is restored to whatever it was (the fake button starts blank) and the control
    // is live again — what matters is that it is not the failure state.
    assert.notStrictEqual(playButton(page).textContent, 'unavailable');
    assert.strictEqual(playButton(page).disabled, false, 'the button was left disabled');
  },

  'a container Web Audio cannot decode still plays through the element': async function () {
    const audio = makeWebAudio({decode: false});
    const element = makeAudioElement({play: true});
    const page = await pressPlay({audio: audio, element: element});

    answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
    await settle();

    assert.strictEqual(element.played.length, 1, 'the fallback never ran');
    assert.notStrictEqual(playButton(page).textContent, 'unavailable');
    assert.strictEqual(playButton(page).disabled, false);
  },

  'a clip nothing can play says so, once, on the button': async function () {
    const audio = makeWebAudio({decode: false});
    const element = makeAudioElement({play: false});
    const page = await pressPlay({audio: audio, element: element});

    answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
    await settle();

    const button = playButton(page);
    assert.strictEqual(button.textContent, 'unavailable');
    assert.ok(button.title.indexOf('would not play') !== -1, 'no reason on the button: ' + button.title);
  },

  "a missing file names ANKI's reason, not a bare \"unavailable\"": async function () {
    // "unavailable" alone sent the user looking for a problem the worker had already named.
    const page = await pressPlay({audio: makeWebAudio({decode: true}), element: makeAudioElement({play: true})});

    answer(page.chrome, pending(page.chrome, 'omnia-media'), {
      ok: false,
      error: 'Media file not found.',
    });
    await settle();

    assert.strictEqual(playButton(page).title, 'Media file not found.');
  },

  'a button that failed and then worked stops saying it is broken': async function () {
    // Anki closed, then opened. The retry plays — and the button used to be restored to the
    // label it carried at the top of THAT click, which was "unavailable", with the stale
    // tooltip still on it. It then claimed to be broken for the life of the panel while
    // playing sound on every press.
    const audio = makeWebAudio({decode: true});
    const page = await pressPlay({audio: audio, element: makeAudioElement({play: true})});
    answer(page.chrome, pending(page.chrome, 'omnia-media'), {
      ok: false,
      error: 'Anki did not answer.',
    });
    await settle();
    assert.strictEqual(playButton(page).textContent, 'unavailable', 'the first failure');

    press(page, 'data-omnia-audio', 'run.mp3');
    answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
    await settle();

    const button = playButton(page);
    assert.strictEqual(audio.plays.length, 1, 'the retry never played');
    assert.strictEqual(button.textContent, '▶ Play', 'the retry restored the failure label');
    assert.strictEqual(button.title, '', 'the stale reason is still on the button');
  },

  'a worker Chrome killed mid-request does not send the user to reload the page':
    async function () {
      // lastError in the CALLBACK means the MV3 worker was terminated while the fetch was in
      // flight. The page is fine; pressing again wakes it. "Omnia was updated — reload this
      // page" would destroy the panel and the selection to fix nothing.
      const page = await pressPlay({
        audio: makeWebAudio({decode: true}),
        element: makeAudioElement({play: true}),
      });

      loseAnswer(page.chrome, pending(page.chrome, 'omnia-media'));
      await settle();

      const title = playButton(page).title;
      assert.ok(title.indexOf('press it again') !== -1, 'unhelpful reason: ' + title);
      assert.ok(title.indexOf('reload') === -1, 'it told the user to reload: ' + title);
    },

  'the panel keeps ONE audio context, and closes it when the extension goes':
    async function () {
      // A browser allows a page only a handful; one per click runs out after a few plays.
      const audio = makeWebAudio({decode: true});
      const page = await pressPlay({audio: audio, element: makeAudioElement({play: true})});
      answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
      await settle();
      press(page, 'data-omnia-audio', 'run.mp3');
      answer(page.chrome, pending(page.chrome, 'omnia-media'), {ok: true, base64: 'AAEC'});
      await settle();

      assert.strictEqual(audio.contexts.length, 1, 'a context per click');
      page.window.__omniaClipperTeardown();
      assert.strictEqual(audio.contexts[0].closed, true, 'the context outlived the panel');
    },

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

  // -- correcting a phrase ---------------------------------------------------------------
  // What correct_view.js cannot see: which panel is open, whether an answer still belongs to
  // the phrase on screen, and what a second press of the register toggle actually does.

  'the wand opens the correction panel and asks the worker, not the page': async () => {
    const page = loadContentScript();
    await openCorrect(page);

    assert.ok(correctPanel(page), 'the wand opened nothing');
    assert.ok(
      /<p class="omnia-correct-pending">/.test(correctPanel(page).innerHTML),
      'it did not say it was working'
    );
    const asked = pending(page.chrome, 'omnia-check');
    assert.ok(asked, 'the check never left the page');
    assert.strictEqual(asked.message.text, 'run');
    assert.strictEqual(asked.message.mode, '', 'the page overrode Omnia’s configured register');
  },

  'the answer replaces the spinner, in the register Omnia judged it in': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true,
      result: correctionPayload('spoken'),
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(
      !/<p class="omnia-correct-pending">/.test(html), 'the spinner outlived the answer'
    );
    assert.ok(html.indexOf('have went') !== -1, 'the fix never made it to the panel');
    assert.ok(
      /omnia-correct-mode-on" data-mode="spoken"/.test(html),
      'the panel lit the register it ASKED for rather than the one that came back'
    );
  },

  'the explanation button opens only its own reason, without asking again': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    assert.ok(/data-why-text="0"[^>]* hidden/.test(correctPanel(page).innerHTML));

    pressCorrect(page, 'data-why', '0');
    await settle();

    assert.ok(
      !/data-why-text="0"[^>]* hidden/.test(correctPanel(page).innerHTML),
      'the reason stayed shut'
    );
    assert.strictEqual(
      pending(page.chrome, 'omnia-check'), null,
      'opening a reason that was already in hand cost another request'
    );
  },

  'switching register asks again, because it is a different question': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('written'),
    });
    await settle();

    pressCorrect(page, 'data-mode', 'spoken');
    await settle();

    const second = pending(page.chrome, 'omnia-check');
    assert.ok(second, 'the toggle re-rendered instead of asking');
    assert.strictEqual(second.message.mode, 'spoken');
    assert.strictEqual(second.message.text, 'run', 'it checked something other than the phrase');
  },

  'pressing the register already showing does nothing at all': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('written'),
    });
    await settle();

    pressCorrect(page, 'data-mode', 'written');
    await settle();

    assert.strictEqual(
      pending(page.chrome, 'omnia-check'), null,
      'the panel re-asked for the answer it was already showing'
    );
  },

  'the register the panel remembers is the one that came back, not the one asked for': async () => {
    // Nothing on screen shows this: the answer's own mode is what gets rendered either way. It
    // surfaces one press later -- the toggle compares against what the panel THINKS it is in,
    // so a stale value makes the lit button do nothing and the unlit one re-ask for what is
    // already up.
    const page = loadContentScript();
    await openCorrect(page);  // asks with mode '' -- Omnia decides
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('spoken'),
    });
    await settle();

    pressCorrect(page, 'data-mode', 'written');
    await settle();

    const second = checkFor(page.chrome, 'run');
    assert.ok(second, 'pressing the OTHER register did nothing');
    assert.strictEqual(second.message.mode, 'written');
  },

  'a slow answer cannot revert a panel the user has since switched': async () => {
    // Two requests for the SAME phrase, which is what the register toggle makes. The phrase
    // guard passes for both, so without a per-request ticket the slow first answer lands
    // twenty seconds late, overwrites the second, and flips the toggle back under the reader.
    const page = loadContentScript();
    await openCorrect(page);
    const slow = checkFor(page.chrome, 'run', '');     // request A, mode '' -- still in flight

    pressCorrect(page, 'data-mode', 'spoken');         // request B, same phrase
    await settle();
    answer(page.chrome, checkFor(page.chrome, 'run', 'spoken'), {
      ok: true,
      result: Object.assign(correctionPayload('spoken'), {
        rewritten: 'SPOKEN ANSWER', highlight: [['SPOKEN ANSWER', false]],
      }),
    });
    await settle();
    assert.ok(correctPanel(page).innerHTML.indexOf('SPOKEN ANSWER') !== -1, 'B never landed');

    answer(page.chrome, slow, {
      ok: true,
      result: Object.assign(correctionPayload('written'), {
        rewritten: 'WRITTEN ANSWER', highlight: [['WRITTEN ANSWER', false]],
      }),
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(html.indexOf('WRITTEN ANSWER') === -1, 'the abandoned answer took the panel back');
    assert.ok(html.indexOf('SPOKEN ANSWER') !== -1, 'it lost the answer the user was reading');
    assert.ok(
      /omnia-correct-mode-on" data-mode="spoken"/.test(html),
      'the toggle flipped back to the register the user had left'
    );
  },

  'a late FAILURE cannot overwrite the answer on screen either': async () => {
    // The same trap on the error path: an abandoned request that times out would replace a
    // perfectly good correction with a red message about a request nobody is waiting for.
    const page = loadContentScript();
    await openCorrect(page);
    const slow = checkFor(page.chrome, 'run', '');

    pressCorrect(page, 'data-mode', 'spoken');
    await settle();
    answer(page.chrome, checkFor(page.chrome, 'run', 'spoken'), {
      ok: true, result: correctionPayload('spoken'),
    });
    await settle();

    answer(page.chrome, slow, {ok: false, error: 'Omnia did not finish checking that phrase'});
    await settle();

    assert.ok(
      !/<p class="omnia-correct-error">/.test(correctPanel(page).innerHTML),
      'a failure from an abandoned request wiped the answer on screen'
    );
  },

  'opening an explanation keeps the scroll and settles the animation': async () => {
    // The panel scrolls, and every redraw rebuilds the subtree. Without this, pressing Why? on
    // a fix far down the list throws the reader back to the top of a list that just flashed.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    assert.ok(
      !/class="omnia-panel correct settled"/.test(correctPanel(page).innerHTML),
      'a fresh answer came up pre-settled, so its cards never animated in'
    );

    pressCorrect(page, 'data-why', '0');
    await settle();

    assert.ok(
      /class="omnia-panel correct settled"/.test(correctPanel(page).innerHTML),
      'opening an explanation replayed the entry animation over what was being read'
    );
  },

  'saving sends the phrase, not the correction': async () => {
    // Omnia looks it up again (a cache hit) and builds the note itself. Letting a page post
    // note content into somebody's collection is a different feature with a different risk.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('spoken'),
    });
    await settle();

    pressCorrect(page, 'data-save', '1');
    await settle();

    const sent = page.chrome.sent.filter((e) => e.message.type === 'omnia-save-check');
    assert.strictEqual(sent.length, 1, 'the save never left the page');
    assert.strictEqual(sent[0].message.text, 'run');
    assert.strictEqual(sent[0].message.mode, 'spoken', 'the card would record the wrong register');
    assert.ok(!('fixes' in sent[0].message), 'the page posted note content');
  },

  'a saved correction says where Anki put it': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    pressCorrect(page, 'data-save', '1');

    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: true,
      result: {summary: 'Saved to Omnia::Phrase Check.', deck: 'Omnia::Phrase Check'},
    });
    await settle();

    assert.ok(
      correctPanel(page).innerHTML.indexOf('Saved to Omnia::Phrase Check.') !== -1,
      'the deck it went to was never said'
    );
  },

  'a save that failed says why and lets you try again': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    pressCorrect(page, 'data-save', '1');

    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: false, error: 'Anki was busy — nothing was saved. Try again.',
    });
    await settle();

    assert.ok(
      correctPanel(page).innerHTML.indexOf('nothing was saved') !== -1,
      'the reason was swallowed'
    );
  },

  'what Anki said survives a redraw': async () => {
    // The panel re-renders for its own reasons — opening an explanation, for one. A label poked
    // onto the button, or a sentence written straight into the DOM, is wiped by the next one of
    // those without anybody noticing, so both live in the panel's state.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    pressCorrect(page, 'data-save', '1');
    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: true, result: {summary: 'Saved to Omnia::Phrase Check.'},
    });
    await settle();

    pressCorrect(page, 'data-why', '0');
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(html.indexOf('Saved to Omnia::Phrase Check.') !== -1, 'the sentence was wiped');
    assert.ok(html.indexOf('>Saved<') !== -1, 'the button forgot it had saved');
  },

  'switching register clears what the last answer saved': async () => {
    // A different answer is a different card. A disabled "Saved" button over a correction
    // nobody has kept would be a lie about the collection.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('written'),
    });
    await settle();
    pressCorrect(page, 'data-save', '1');
    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: true, result: {summary: 'Saved.'},
    });
    await settle();

    pressCorrect(page, 'data-mode', 'spoken');
    await settle();
    answer(page.chrome, checkFor(page.chrome, 'run', 'spoken'), {
      ok: true, result: correctionPayload('spoken'),
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(html.indexOf('>Save to Anki<') !== -1, 'it still claimed to be saved');
    assert.ok(html.indexOf('Saved.') === -1);
  },

  'a redraw during a save does not re-arm the button': async () => {
    // "Saving…" used to be written ONTO the button. This subtree is rebuilt whenever an
    // explanation opens, so the label went with it and the button came back enabled — and the
    // second press wrote a second note for one phrase. It is the one control in this panel
    // that writes to the collection, so it is the one where a double-fire costs something.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();

    pressCorrect(page, 'data-save', '1');
    await settle();
    pressCorrect(page, 'data-why', '0');  // redraw while Anki is still writing
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(html.indexOf('Saving…') !== -1, 'the redraw forgot a save was in flight');
    assert.ok(/disabled/.test(saveButtonTag(page)), 'the button came back live');

    pressCorrect(page, 'data-save', '1');
    await settle();
    const sent = page.chrome.sent.filter((e) => e.message.type === 'omnia-save-check');
    assert.strictEqual(sent.length, 1, 'one phrase became two notes');
  },

  'a failed save reports beside the correction instead of replacing it': async () => {
    // `correctState.error` is the FATAL channel — rerenderCorrect short-circuits on it and
    // renders the failure alone. Routing a failed SAVE through it threw away the fixes, the
    // explanations the reader had opened, and the button they would retry with, to show one
    // sentence about Anki being busy.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    const before = correctPanel(page).innerHTML;
    assert.ok(before.indexOf('omnia-correct-fixes') !== -1, 'the fixture had no fixes to lose');

    pressCorrect(page, 'data-save', '1');
    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: false, error: 'Anki was busy — nothing was saved. Try again.',
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(html.indexOf('nothing was saved') !== -1, 'the reason was swallowed');
    assert.ok(html.indexOf('omnia-correct-fixes') !== -1, 'the correction was thrown away');
    assert.ok(html.indexOf('>Save to Anki<') !== -1, 'there was no button left to retry with');
    assert.ok(!/disabled/.test(saveButtonTag(page)), 'the retry button was dead');
  },

  'a save answering after a register switch does not stamp the new correction': async () => {
    // The ticket covers what the phrase cannot: switching register re-asks about the SAME
    // phrase, so matching on text alone let this answer write "Saved" onto the spoken state
    // that replaced it — a disabled Saved button over a correction nobody kept.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload('written'),
    });
    await settle();

    pressCorrect(page, 'data-save', '1');   // in flight...
    await settle();
    pressCorrect(page, 'data-mode', 'spoken');  // ...and the question changes underneath it
    await settle();
    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: true, result: {summary: 'Saved to Omnia::Phrase Check.'},
    });
    await settle();
    answer(page.chrome, checkFor(page.chrome, 'run', 'spoken'), {
      ok: true, result: correctionPayload('spoken'),
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(
      html.indexOf('Saved to Omnia::Phrase Check.') === -1,
      'it claimed to have saved the correction that replaced the one it saved'
    );
    assert.ok(html.indexOf('>Save to Anki<') !== -1, 'the spoken correction could not be saved');
  },

  'a save answering after the panel is dismissed does not reopen it': async () => {
    // The note is written either way; this only decides whether anyone is told.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    pressCorrect(page, 'data-save', '1');
    page.document.fire('keydown', {key: 'Escape'});

    answer(page.chrome, pending(page.chrome, 'omnia-save-check'), {
      ok: true, result: {summary: 'Saved.'},
    });
    await settle();

    assert.strictEqual(page.document.getElementById(CORRECT_PANEL_ID), null);
  },

  'a correction that arrives after the panel is dismissed does not resurrect it': async () => {
    // The same trap the lookup panel has, and worse: ensurePanelHost would BUILD a host at
    // wherever the pointer has since moved, putting a panel back that the user closed.
    const page = loadContentScript();
    await openCorrect(page);
    page.document.fire('keydown', {key: 'Escape'});
    assert.strictEqual(correctPanel(page), null, 'Escape did not close the correction panel');

    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();

    assert.strictEqual(
      page.document.getElementById(CORRECT_PANEL_ID), null,
      'a dismissed correction panel came back'
    );
  },

  'an answer for a phrase the user has moved on from is dropped': async () => {
    // Two checks in flight and the slow one lands last. Without the phrase guard it would
    // overwrite the newer answer with a correction of something else entirely.
    const page = loadContentScript();
    await openCorrect(page);
    const first = pending(page.chrome, 'omnia-check');

    // A new selection, then the wand again: this is now a different phrase.
    page.window.getSelection = function () {
      return {
        rangeCount: 1,
        isCollapsed: false,
        toString: function () { return 'walked'; },
        getRangeAt: function () { return {commonAncestorContainer: page.document.body}; },
      };
    };
    await openCorrect(page);
    // By phrase, not by `pending`: that hands back the OLDEST unanswered request, which is the
    // one still in flight -- answering THAT here would never exercise the guard.
    answer(page.chrome, checkFor(page.chrome, 'walked'), {
      ok: true,
      result: Object.assign(correctionPayload(), {
        rewritten: 'I walked.', fixes: [], highlight: [['I walked.', false]],
      }),
    });
    await settle();
    assert.ok(correctPanel(page).innerHTML.indexOf('I walked.') !== -1, 'the new answer is not up');

    const stale = correctionPayload();
    stale.rewritten = 'STALE ANSWER';
    stale.highlight = [['STALE ANSWER', false]];
    answer(page.chrome, first, {ok: true, result: stale});
    await settle();

    assert.ok(
      correctPanel(page).innerHTML.indexOf('STALE ANSWER') === -1,
      'an answer to the previous phrase overwrote the one on screen'
    );
  },

  'a failed check says why, in the words the worker sent': async () => {
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: false,
      error: 'Phrase Check is switched off. Turn it on in Anki (Tools → Omnia → Phrase Check).',
    });
    await settle();

    const html = correctPanel(page).innerHTML;
    assert.ok(
      /<p class="omnia-correct-error">/.test(html), 'a failure rendered as an answer'
    );
    assert.ok(html.indexOf('switched off') !== -1, 'the panel reworded the reason');
    assert.ok(!/omnia-correct-fixes">\s*<li/.test(html), 'it showed fixes it never received');
  },

  'a new selection clears the correction panel, not just the lookup one': async () => {
    // An open panel is an answer about the text that WAS selected. Left up over a new
    // selection it is not stale decoration -- it is a wrong answer to the question on screen.
    const page = loadContentScript();
    await openCorrect(page);
    answer(page.chrome, pending(page.chrome, 'omnia-check'), {
      ok: true, result: correctionPayload(),
    });
    await settle();
    assert.ok(correctPanel(page), 'nothing was open to clear');

    page.document.fire('mouseup', {clientX: 90, clientY: 90, target: page.document.body});
    await settle();

    assert.strictEqual(
      page.document.getElementById(CORRECT_PANEL_ID), null,
      'the correction outlived the selection it was about'
    );
  },

  'the pill stays on screen at the right edge, whatever it carries': async () => {
    // The clamp was tuned for two buttons. A third put 14 of its 22px past the edge, where a
    // fixed element is clipped rather than scrollable-to -- and the right-hand column is a
    // common place to be selecting text.
    const page = loadContentScript();
    page.window.innerWidth = 400;

    page.document.fire('mouseup', {clientX: 399, clientY: 60, target: page.document.body});
    await settle();

    const pill = page.document.getElementById(TOOLTIP_ID);
    assert.ok(pill, 'no pill appeared');
    const left = parseInt(pill.style.left, 10);
    const width = 22 * pill.children.length + 4 * (pill.children.length - 1);
    assert.ok(
      left + width <= page.window.innerWidth,
      'the pill runs ' + (left + width - page.window.innerWidth) + 'px off the right edge ' +
        '(left ' + left + ', ' + pill.children.length + ' buttons)'
    );
  },

  'the two panels never share the screen': async () => {
    // They answer different questions about the same selection, and both carry controls. Two
    // stacked popovers at the pointer is not a layout anybody meant.
    const page = loadContentScript();
    await openLookup(page);
    answer(page.chrome, pending(page.chrome, 'omnia-lookup'), {
      ok: true, result: {word: 'run', found: false, cards: []},
    });
    await settle();
    assert.ok(panel(page), 'the lookup panel did not open');

    await openCorrect(page);

    assert.ok(correctPanel(page), 'the correction panel did not open');
    assert.strictEqual(
      page.document.getElementById(PANEL_ID), null,
      'the lookup panel was left underneath the correction panel'
    );
  },

  'a dead extension context takes the correction panel down too': async () => {
    // Not tidiness: ensurePanelHost ADOPTS a host by id, so one left behind would be inherited
    // whole by the instance a re-injection starts -- wired to a context that cannot talk to Anki.
    const page = loadContentScript();
    await openCorrect(page);
    assert.ok(correctPanel(page));

    page.window.__omniaClipperTeardown();

    assert.strictEqual(page.document.getElementById(CORRECT_PANEL_ID), null);
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
