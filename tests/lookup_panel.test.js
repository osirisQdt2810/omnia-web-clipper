/**
 * @fileoverview The lookup panel's view model and the /generate transport, with no browser.
 *
 * Same shape as reload_handshake.test.js: plain Node with `assert`, no framework, run by the
 * same CI job that syntax-checks src/*.js. Both modules are evaluated as SOURCE in a sandbox
 * rather than imported, because neither is importable -- each attaches one global the way a
 * classic script does.
 *
 * What is checked here is the part a screenshot cannot: which note the switcher points at, why
 * a field says it cannot be regenerated, which fields an answer is allowed to touch, and
 * whether an HTTP failure comes out as a sentence someone can act on.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Evaluate one of the src/ scripts and return what it attached to `self`.
 *
 * Compiled into THIS realm (rather than a vm context) on purpose: a context gets its own
 * Array/Object prototypes, and `assert.deepStrictEqual` compares prototypes -- so every array
 * the module built would fail against a plain literal here for a reason that has nothing to do
 * with the code under test. Both files are written to be loaded as classic scripts, so handing
 * them a `self` is all it takes.
 *
 * @param {string} file The file name inside src/.
 * @return {!Object} The `self` the module wrote onto.
 */
function loadModule(file) {
  const scope = {};
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  vm.compileFunction(source, ['self'], {filename: file})(scope);
  return scope;
}

const view = loadModule('lookup_view.js').OmniaLookupView;
const shared = loadModule('shared.js').OmniaClipper;

/** A two-note answer: one filled note and one whose fields cannot be generated. */
function twoNoteResult() {
  return {
    word: 'run',
    found: true,
    can_regenerate: true,
    cards: [
      {
        note_id: 11,
        note_type: 'Vocabulary',
        deck: 'English::Unit 06',
        title: 'run',
        state: 'review',
        interval_days: 12,
        reps: 4,
        lapses: 1,
        fields: [
          {
            name: 'Definition',
            text: 'to move fast on foot',
            audio: [],
            images: [],
            empty: false,
            state: 'ready',
          },
          {name: 'Audio', text: '', audio: [], images: [], empty: true, state: 'blocked'},
          {name: 'Example', text: '', audio: [], images: [], empty: true, state: 'ready'},
        ],
      },
      {
        note_id: 22,
        note_type: 'Phrasal Verb',
        deck: 'English::Phrasals',
        title: '',
        state: 'new',
        fields: [
          {name: 'Meaning', text: '', audio: [], images: [], empty: true, state: 'no_rule'},
        ],
      },
    ],
  };
}

/** The field of `model` with that name. */
function field(model, name) {
  return model.fields.filter(function (f) {
    return f.name === name;
  })[0];
}

/** How many times `pattern` occurs in `html`. */
function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

/** Render a result the way content.js does: model first, then markup. */
function render(result, index, options) {
  return view.renderPanel(view.buildPanelModel(result, index, options || {}));
}

const tests = {
  'the switcher names every match and marks the one on screen': function () {
    const model = view.buildPanelModel(twoNoteResult(), 0, {});
    assert.strictEqual(model.switcher.length, 2, 'both matches must be reachable');
    assert.deepStrictEqual(
      model.switcher.map(function (s) {
        return s.label;
      }),
      ['run', 'Phrasal Verb'],
      'the label is the title, falling back to the note type (desktop _switcher)'
    );
    assert.deepStrictEqual(
      model.switcher.map(function (s) {
        return s.active;
      }),
      [true, false],
      'without a highlight the switcher cannot say which note you are reading'
    );
  },

  'switching shows THAT note, not the top hit': function () {
    const result = twoNoteResult();
    const model = view.buildPanelModel(result, 1, {});
    assert.strictEqual(model.noteId, 22, 'the panel still rendered the first match');
    assert.strictEqual(model.index, 1);
    assert.deepStrictEqual(
      model.fields.map(function (f) {
        return f.name;
      }),
      ['Meaning'],
      'the fields must come from the SELECTED note; the right note is not always the top hit'
    );
    assert.deepStrictEqual(
      model.switcher.map(function (s) {
        return s.active;
      }),
      [false, true]
    );
  },

  'an out-of-range index falls back to the first note': function () {
    const result = twoNoteResult();
    assert.strictEqual(view.buildPanelModel(result, 7, {}).noteId, 11);
    assert.strictEqual(view.buildPanelModel(result, -1, {}).noteId, 11);
  },

  'a switcher label is truncated exactly as the desktop panel truncates it': function () {
    assert.strictEqual(view.truncateLabel('x'.repeat(22)), 'x'.repeat(22), '22 fits');
    assert.strictEqual(
      view.truncateLabel('x'.repeat(23)),
      'x'.repeat(21) + '…',
      'past 22 the desktop keeps 21 characters and an ellipsis'
    );
    assert.strictEqual(
      view.switcherLabel({note_id: 99}),
      'note 99',
      'a note with neither title nor type still needs a label you can press'
    );
  },

  'a single match gets no switcher': function () {
    const result = twoNoteResult();
    result.cards = [result.cards[0]];
    assert.deepStrictEqual(
      view.buildPanelModel(result, 0, {}).switcher,
      [],
      'a switcher with nothing to switch to is just a second title'
    );
  },

  'a field with no content is rendered, not dropped': function () {
    const model = view.buildPanelModel(twoNoteResult(), 0, {});
    const example = field(model, 'Example');
    assert.ok(example, 'a never-filled field is the main thing anyone wants to regenerate');
    assert.strictEqual(example.empty, true, 'it must be marked so the panel can look hollow');
    assert.strictEqual(field(model, 'Definition').empty, false);
  },

  'a field that cannot be generated keeps its button and says why': function () {
    const model = view.buildPanelModel(twoNoteResult(), 0, {});
    const audio = field(model, 'Audio');
    assert.strictEqual(audio.canGenerate, false, 'state "blocked" must not fire a request');
    assert.strictEqual(audio.title, view.FIELD_STATE_MESSAGES.blocked);
    assert.ok(/before this one/.test(audio.title), 'the tooltip has to explain the block');

    const meaning = field(view.buildPanelModel(twoNoteResult(), 1, {}), 'Meaning');
    assert.strictEqual(meaning.canGenerate, false);
    assert.strictEqual(meaning.title, view.FIELD_STATE_MESSAGES.no_rule);
    assert.ok(
      /Smart Notes/.test(meaning.title) && /Configure/.test(meaning.title),
      'a reason with no remedy is a dead end: name where the rule is added'
    );
    assert.notStrictEqual(
      view.FIELD_STATE_MESSAGES.no_rule,
      view.FIELD_STATE_MESSAGES.rule_off,
      '"there is no rule" and "the rule is off" have different fixes'
    );
  },

  'a ready field is the only one that acts': function () {
    const model = view.buildPanelModel(twoNoteResult(), 0, {});
    assert.strictEqual(field(model, 'Definition').canGenerate, true);
    assert.strictEqual(field(model, 'Example').canGenerate, true, 'empty but generatable');
    assert.strictEqual(model.generateAll.enabled, true);
  },

  'an unknown field state does not silently become generatable': function () {
    const action = view.fieldAction({name: 'X', state: 'something-new'}, true);
    assert.strictEqual(action.canGenerate, false);
    assert.ok(action.title.length > 0, 'an inert button with no tooltip explains nothing');
  },

  'can_regenerate: false makes every control inert, with the remedy': function () {
    const result = twoNoteResult();
    result.can_regenerate = false;
    const model = view.buildPanelModel(result, 0, {});
    assert.strictEqual(model.canRegenerate, false);
    assert.ok(
      model.fields.every(function (f) {
        return f.canGenerate === false;
      }),
      'with the option off NOTHING may fire a request, not even a "ready" field'
    );
    assert.ok(
      model.fields.every(function (f) {
        return f.title === view.REGENERATE_OFF_MESSAGE;
      }),
      'every button must say which switch to flip'
    );
    assert.strictEqual(model.generateAll.enabled, false);
    assert.strictEqual(model.generateAll.title, view.REGENERATE_OFF_MESSAGE);
    assert.ok(
      /Regenerate from clippers/.test(view.REGENERATE_OFF_MESSAGE),
      'the tooltip has to NAME the Smart Notes option, or it cannot be found'
    );
  },

  'a payload from an older add-on degrades to inert rather than to a broken request': function () {
    const legacy = {
      word: 'run',
      found: true,
      cards: [{note_id: 5, fields: [{name: 'Definition', text: 'x'}]}],
    };
    const model = view.buildPanelModel(legacy, 0, {});
    assert.strictEqual(model.canRegenerate, false, 'no can_regenerate means no regenerating');
    assert.strictEqual(field(model, 'Definition').canGenerate, false);
    assert.strictEqual(field(model, 'Definition').empty, false, 'derived when not stated');
  },

  'a spinner shows only on the fields that are running': function () {
    const model = view.buildPanelModel(twoNoteResult(), 0, {busy: ['Definition']});
    assert.strictEqual(field(model, 'Definition').busy, true);
    assert.strictEqual(field(model, 'Audio').busy, false);
    assert.strictEqual(model.generateAll.busy, false);
    const all = view.buildPanelModel(twoNoteResult(), 0, {busy: 'all'});
    assert.ok(
      all.fields.every(function (f) {
        return f.busy;
      }),
      '"Generate all" puts a spinner on every field'
    );
    assert.strictEqual(all.generateAll.busy, true);
  },

  'a generate answer updates ONLY the fields it names': function () {
    const before = twoNoteResult();
    const applied = view.applyGenerateResults(before, 11, [
      {field: 'Example', status: 'generated', message: '', text: 'I run home.', audio: ['a.mp3']},
    ]);
    const model = view.buildPanelModel(applied.result, 0, {notes: applied.notes});
    assert.strictEqual(field(model, 'Example').text, 'I run home.');
    assert.deepStrictEqual(field(model, 'Example').audio, ['a.mp3']);
    assert.strictEqual(field(model, 'Example').empty, false, 'it has content now');
    assert.strictEqual(
      field(model, 'Definition').text,
      'to move fast on foot',
      'a field the answer never mentioned must survive untouched'
    );
    assert.strictEqual(field(model, 'Audio').text, '');
    assert.strictEqual(
      before.cards[0].fields[2].text,
      '',
      'the payload in hand must not be mutated underneath the panel'
    );
  },

  'a generate answer for a different note is not applied to the one on screen': function () {
    const before = twoNoteResult();
    const applied = view.applyGenerateResults(before, 999, [
      {field: 'Definition', status: 'generated', text: 'WRONG NOTE'},
    ]);
    assert.strictEqual(
      applied.result.cards[0].fields[0].text,
      'to move fast on foot',
      'an answer that arrives after a note switch must not rewrite the note now shown'
    );
  },

  'every non-generated status surfaces its message': function () {
    const applied = view.applyGenerateResults(twoNoteResult(), 11, [
      {field: 'Definition', status: 'generated', text: 'ok'},
      {field: 'Audio', status: 'blocked', message: 'needs Definition'},
    ]);
    assert.strictEqual(
      applied.notes.Audio,
      'needs Definition',
      "the server's own message is the feature: it is the only half that knows WHY"
    );
    assert.deepStrictEqual(applied.generated, ['Definition']);
    assert.strictEqual(applied.notes.Definition, undefined, 'a success has nothing to report');

    const model = view.buildPanelModel(applied.result, 0, {notes: applied.notes});
    assert.strictEqual(field(model, 'Audio').note, 'needs Definition');
    assert.strictEqual(field(model, 'Definition').note, '');
  },

  'a status that arrives with no message still says something': function () {
    assert.strictEqual(view.statusMessage('error', ''), view.STATUS_MESSAGES.error);
    assert.strictEqual(view.statusMessage('generated', ''), '', 'nothing to report on success');
    assert.ok(
      view.statusMessage('brand-new-status', '').length > 0,
      'an unknown status must not render as an empty note the user cannot interpret'
    );
  },

  'a message about a field the panel does not show is still surfaced': function () {
    // "Generate all" runs over the whole note; a lookup only shows the top few fields.
    const model = view.buildPanelModel(twoNoteResult(), 0, {
      notes: {Definition: 'kept', 'Hidden Field': 'no rule for this one'},
    });
    assert.deepStrictEqual(model.extraNotes, [
      {field: 'Hidden Field', note: 'no rule for this one'},
    ]);
    assert.strictEqual(field(model, 'Definition').note, 'kept');
  },

  'the not-found state carries the word and no controls': function () {
    const model = view.buildPanelModel({word: 'zzz', found: false, cards: []}, 0, {word: 'zzz'});
    assert.strictEqual(model.found, false);
    assert.strictEqual(model.word, 'zzz');
    assert.deepStrictEqual(model.fields, []);
    assert.deepStrictEqual(model.switcher, []);
  },

  'EVERY field gets a generate button, generatable or not': function () {
    const html = render(twoNoteResult(), 0, {});
    assert.strictEqual(
      count(html, /data-omnia-generate="/g),
      3,
      'a field whose state is not "ready" must still show the button — hiding it answers ' +
        '"why is this empty?" with silence'
    );
    assert.ok(
      html.indexOf('data-omnia-generate="Audio"') !== -1,
      'the blocked field lost its button'
    );
    assert.strictEqual(
      count(html, /data-omnia-generate-all="/g),
      1,
      'exactly one "Generate all" for the note'
    );
  },

  'an inert control looks inert and carries its reason': function () {
    const result = twoNoteResult();
    result.can_regenerate = false;
    const html = render(result, 0, {});
    assert.strictEqual(
      count(html, /class="gen inert"/g),
      3,
      'with the option off every field button must render blurred/dimmed'
    );
    assert.ok(/class="genall inert"/.test(html), '"Generate all" must be inert too');
    assert.strictEqual(
      count(html, /Regenerate from clippers/g),
      4,
      'each control carries the tooltip naming the switch to flip'
    );
  },

  'an empty field renders hollow, a filled one does not': function () {
    const html = render(twoNoteResult(), 0, {});
    assert.strictEqual(count(html, /class="field empty"/g), 2, 'Audio and Example are empty');
    assert.strictEqual(count(html, /class="fval placeholder"/g), 2);
    assert.ok(html.indexOf('to move fast on foot') !== -1, 'a filled field still shows its text');
  },

  'a busy field shows a spinner instead of a button': function () {
    const html = render(twoNoteResult(), 0, {busy: ['Definition']});
    assert.strictEqual(
      count(html, /class="spin"/g),
      1,
      'the spinner belongs on the field that is running, in place'
    );
    assert.ok(
      html.indexOf('data-omnia-generate="Definition"') === -1,
      'a field mid-generation must not offer to start a second run'
    );
    assert.ok(
      html.indexOf('data-omnia-generate="Audio"') !== -1,
      'the other fields stay as they were'
    );
  },

  'the switcher and "Open in Anki" are wired by data attribute': function () {
    const html = render(twoNoteResult(), 1, {});
    assert.strictEqual(count(html, /data-omnia-switch="/g), 2);
    assert.ok(/class="seg active" data-omnia-switch="1"/.test(html), 'the shown note is filled');
    assert.ok(
      html.indexOf('data-omnia-open="22"') !== -1,
      '"Open in Anki" must carry the note on screen, not the top hit'
    );
    assert.ok(
      html.indexOf('+1 more note') === -1,
      'the old "+N more note(s)" line named a number and offered no way to see any of them'
    );
  },

  'the not-found state offers to add the word, but only with a capture in hand': function () {
    const missing = {word: 'zzz', found: false, cards: []};
    const offered = render(missing, 0, {word: 'zzz', canAdd: true});
    assert.ok(offered.indexOf('data-omnia-add="1"') !== -1, 'the obvious next action is missing');
    const bare = render(missing, 0, {word: 'zzz', canAdd: false});
    assert.ok(
      bare.indexOf('data-omnia-add') === -1,
      'a button that cannot capture anything must not be offered'
    );
  },

  'a panel-wide failure is shown, not swallowed': function () {
    const html = render(twoNoteResult(), 0, {error: 'Smart Notes is not available right now.'});
    assert.ok(html.indexOf('Smart Notes is not available right now.') !== -1);
  },

  'a field name that would break out of an attribute is escaped': function () {
    const result = twoNoteResult();
    result.cards[0].fields = [
      {name: '" onmouseover="x', text: '<b>hi</b>', audio: [], images: [], state: 'ready'},
    ];
    const html = render(result, 0, {});
    assert.ok(html.indexOf('onmouseover="x') === -1, 'a note type can name a field anything');
    assert.ok(html.indexOf('&quot; onmouseover=&quot;x') !== -1, 'it must be escaped, not dropped');
    assert.ok(html.indexOf('<b>hi</b>') === -1, 'field text is text, never markup');
  },

  'the lookup URL names the client': function () {
    const url = shared.buildLookupUrl('http://127.0.0.1:8766/', 'give up');
    assert.ok(
      url.indexOf('client=web_clipper') !== -1,
      'the add-on keys its per-clipper settings on this; without it the web clipper is anonymous'
    );
    assert.ok(url.indexOf('word=give%20up') !== -1, 'the word must be encoded');
    assert.strictEqual(
      url.indexOf('http://127.0.0.1:8766/lookup?'),
      0,
      'a configured URL with a trailing slash must not produce a double slash'
    );
    assert.strictEqual(shared.LOOKUP_CLIENT, 'web_clipper');
  },

  'the generate URL is the same service, a different path': function () {
    assert.strictEqual(
      shared.buildGenerateUrl('http://127.0.0.1:8766/'),
      'http://127.0.0.1:8766/generate'
    );
  },

  '409 and 503 are different sentences, each naming its own remedy': function () {
    const conflict = shared.generateErrorMessage(409, null);
    const unavailable = shared.generateErrorMessage(503, null);
    assert.notStrictEqual(conflict, unavailable, 'two different problems, two different fixes');
    assert.ok(
      /Regenerate from clippers/.test(conflict),
      '409 means ONE checkbox in Anki; the message has to name it'
    );
    assert.ok(
      /Smart Notes/.test(unavailable) && /Anki/.test(unavailable),
      '503 means the Smart Notes plugin is off (or Anki is busy) — say so'
    );
    assert.ok(!/409/.test(conflict), 'a bare status code is not something a person can act on');
  },

  '401 and 403 explain themselves too': function () {
    assert.ok(
      /token/i.test(shared.generateErrorMessage(401, null)),
      '401 is the token; the message must say where to get one'
    );
    assert.ok(
      /Origin/.test(shared.generateErrorMessage(403, null)),
      '403 is the Origin header the browser attaches — the one failure the user cannot fix ' +
        'in this extension, so it must say who can'
    );
  },

  "the server's own detail is kept alongside the mapped sentence": function () {
    const message = shared.generateErrorMessage(503, {error: 'collection is busy'});
    assert.ok(/Smart Notes/.test(message), 'the actionable sentence still leads');
    assert.ok(/collection is busy/.test(message), 'and the detail is not thrown away');
  },

  'the token can be handed over in the options URL': function () {
    assert.strictEqual(shared.readTokenFromSearch('?omnia-token=abc123'), 'abc123');
    assert.strictEqual(
      shared.readTokenFromSearch('?omnia-reload=1&omnia-token=abc123'),
      'abc123',
      'Omnia hands the token over on the same URL that asks for a reload'
    );
    assert.strictEqual(shared.readTokenFromSearch(''), '');
    assert.strictEqual(shared.readTokenFromSearch('?other=1'), '');
  },

  'the token has a default, so storage.sync.get always returns one': function () {
    assert.strictEqual(
      shared.DEFAULTS.lookupToken,
      '',
      'a key missing from DEFAULTS never comes back from chrome.storage.sync.get(DEFAULTS)'
    );
  },

  'the panel never talks to the network itself': function () {
    const content = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
    assert.ok(
      !/\bfetch\s*\(/.test(content) && !/XMLHttpRequest/.test(content),
      'a page-context request to 127.0.0.1 carries an Origin header and the add-on refuses ' +
        'it by design: /generate mutates notes and spends LLM credits, so anything a web ' +
        'page could have initiated is refused. Every request goes through the service worker.'
    );
  },

  'the two halves share ONE definition of the panel messages': function () {
    const content = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
    assert.ok(
      content.indexOf('Regenerate from clippers') === -1,
      'the renderer re-worded the reason instead of showing the one lookup_view.js defines; ' +
        'two copies drift, and the tests only pin one of them'
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
