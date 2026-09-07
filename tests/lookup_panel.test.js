/**
 * @fileoverview The lookup panel's view model and the /generate transport, with no browser.
 *
 * Same shape as reload_handshake.test.js: plain Node with `assert`, no framework, run by the
 * same CI job that syntax-checks src/*.js. Both modules are evaluated as SOURCE in a sandbox
 * rather than imported, because neither is importable -- each attaches one global the way a
 * classic script does.
 *
 * What is checked here is the part a screenshot cannot: which note the switcher points at, why
 * a field says it cannot be regenerated, which fields an answer is allowed to touch, which NOTE
 * an answer belongs to when the user has moved on, and whether an HTTP failure comes out as a
 * sentence someone can act on.
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

/**
 * Two matches that share a field name.
 *
 * The cruel case for note-keyed state: when both notes have an "Audio", a message that leaks
 * from one to the other does not look like a bug at all — it looks like an answer.
 */
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

  // -- the panel's state, which is where the note switch used to lose track of a request -----

  'an answer for the note you left does not land on the note you are reading': function () {
    const state = new view.PanelState('run', twinNoteResult(), null);
    state.regeneration.start(11, ['Audio']);
    assert.strictEqual(state.showNote(1), true, 'the switcher must move to the second match');

    // Note 11's answer arrives NOW, while note 22 is the one on screen. Both have an "Audio".
    state.applyAnswer(11, ['Audio'], [
      {field: 'Audio', status: 'blocked', message: 'needs Definition'},
    ]);

    const shown = state.model();
    assert.strictEqual(shown.noteId, 22, 'the panel moved off the note that was generating');
    assert.strictEqual(
      field(shown, 'Audio').note,
      '',
      'note 11 was told its Audio needs a Definition, and the reason was printed under note ' +
        "22's Audio — a sentence about a note the user is not even looking at"
    );
    assert.deepStrictEqual(shown.extraNotes, [], 'nor as a loose line under the note');
    assert.strictEqual(shown.error, '', 'nor as a panel-wide failure');

    state.showNote(0);
    assert.strictEqual(
      field(state.model(), 'Audio').note,
      'needs Definition',
      'the answer still has to be there for the note it was actually about'
    );
  },

  "a note's in-flight run survives being switched away from": function () {
    const state = new view.PanelState('run', twinNoteResult(), null);
    state.regeneration.start(11, ['Audio']);
    state.showNote(1);

    assert.deepStrictEqual(
      state.regeneration.busy(11),
      ['Audio'],
      'switching notes cleared the marker of a request that is still in flight'
    );
    assert.strictEqual(
      state.regeneration.canStart(11, ['Audio']),
      false,
      'with the marker gone the button comes back to life, and a second press pays for the ' +
        'same generation twice'
    );
    assert.strictEqual(
      field(state.model(), 'Audio').busy,
      false,
      "note 22 is not generating, so its Audio must not spin on note 11's account"
    );

    state.showNote(0);
    assert.strictEqual(
      field(state.model(), 'Audio').busy,
      true,
      'and the spinner is still there on the note that IS generating'
    );
  },

  'two notes may generate at once; one field of one note may not run twice': function () {
    const regen = new view.RegenerationState();
    regen.start(11, ['Audio']);

    assert.strictEqual(
      regen.canStart(22, ['Audio']),
      true,
      'two notes are two requests against two notes; the panel can only send them by ' +
        'switching, and refusing the second would make the switcher a trap'
    );
    assert.strictEqual(
      regen.canStart(11, ['Audio']),
      false,
      'the same field of the same note is ONE generation — a second request pays twice'
    );
    assert.strictEqual(
      regen.canStart(11, ['Example']),
      true,
      'a different field of the same note is a different generation'
    );
    assert.strictEqual(
      regen.canStart(11, null),
      false,
      '"Generate all" covers the field already running, so it waits for the note'
    );

    regen.settle(11, ['Audio'], {});
    assert.strictEqual(regen.canStart(11, ['Audio']), true, 'an answered field may be asked again');
  },

  'a whole-note run holds the note, and settles all of it': function () {
    const regen = new view.RegenerationState();
    regen.start(11, null);
    assert.strictEqual(regen.busy(11), 'all', 'every field of the note spins for "Generate all"');
    assert.strictEqual(regen.canStart(11, ['Audio']), false);
    assert.strictEqual(regen.canStart(22, null), true, 'a different note is untouched');

    regen.settle(11, null, {Audio: 'needs Definition'});
    assert.deepStrictEqual(
      regen.busy(11),
      [],
      'a whole-note request asked for every field, so a field the answer never named has to ' +
        'stop spinning too — otherwise it spins for ever'
    );
    assert.strictEqual(regen.messages(11).Audio, 'needs Definition');
  },

  'a failed request reports on its own note, in the right place': function () {
    const regen = new view.RegenerationState();
    regen.start(11, ['Audio']);
    regen.start(22, null);

    regen.fail(11, ['Audio'], 'Omnia did not answer.');
    assert.strictEqual(regen.messages(11).Audio, 'Omnia did not answer.');
    assert.strictEqual(regen.error(11), '', 'a single-field failure belongs under that field');
    assert.deepStrictEqual(
      regen.messages(22),
      {},
      "note 22 must learn nothing about a request that was not about it"
    );
    assert.strictEqual(regen.busy(22), 'all', "and its own run must not be settled by note 11's");

    regen.fail(22, null, 'Smart Notes is not available right now.');
    assert.strictEqual(
      regen.error(22),
      'Smart Notes is not available right now.',
      'a whole-note failure has nowhere to sit but the note'
    );
    assert.strictEqual(regen.error(11), '', 'and not on any other note');
  },

  'asking again drops the reason the last answer gave': function () {
    const regen = new view.RegenerationState();
    regen.setMessage(11, 'Audio', 'needs Definition');
    regen.setError(11, 'Regenerating is switched off.');
    regen.start(11, ['Audio']);
    assert.deepStrictEqual(
      regen.messages(11),
      {},
      'leaving "needs Definition" under a spinner claims an answer that no longer applies'
    );
    assert.strictEqual(regen.error(11), '', 'and the same goes for the note-wide reason');
  },

  'the model draws the note on screen, with that note\'s state': function () {
    const state = new view.PanelState('run', twinNoteResult(), {selection: 'run'});
    state.regeneration.setMessage(11, 'Audio', 'note 11 says so');
    state.regeneration.setError(22, 'note 22 says so');

    const first = state.model();
    assert.strictEqual(field(first, 'Audio').note, 'note 11 says so');
    assert.strictEqual(first.error, '', "note 22's panel message is not note 11's");
    assert.strictEqual(first.canAdd, true, 'the capture is in hand, so "Add to Anki" is offered');

    state.showNote(1);
    const second = state.model();
    assert.strictEqual(second.error, 'note 22 says so');
    assert.strictEqual(field(second, 'Audio').note, '', 'and note 11\'s message stayed behind');
  },

  'switching to nowhere is not a switch': function () {
    const state = new view.PanelState('run', twinNoteResult(), null);
    assert.strictEqual(state.showNote(0), false, 'the note already on screen has not changed');
    assert.strictEqual(state.showNote(9), false, 'there is no ninth match to show');
    assert.strictEqual(state.showNote(-1), false);
    assert.strictEqual(state.index, 0, 'and none of that moved the panel');
    assert.strictEqual(state.noteId(), 11);
  },

  'a fresher answer keeps the reader on the same NOTE, not the same slot': function () {
    const state = new view.PanelState('run', twinNoteResult(), null);
    state.showNote(1);
    assert.strictEqual(state.noteId(), 22);

    // The lookup is run again (a lost /generate answer) and comes back ordered differently.
    const fresher = twinNoteResult();
    fresher.cards.reverse();
    state.adoptResult(fresher);
    assert.strictEqual(
      state.noteId(),
      22,
      'the reader was moved to a different note by a refresh they did not ask for'
    );

    // And a note that has GONE falls back to the first match rather than to nothing.
    const without = twinNoteResult();
    without.cards = [without.cards[0]];
    state.adoptResult(without);
    assert.strictEqual(state.noteId(), 11);
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

  'a note with no id is not offered an "Open in Anki" that cannot work': function () {
    const result = twoNoteResult();
    delete result.cards[0].note_id;
    const html = render(result, 0, {});
    assert.ok(
      html.indexOf('data-omnia-open') === -1,
      '"Open in Anki" reveals the note by `nid:<id>`, so without one the button can only ask ' +
        'Anki for `nid:NaN`. A control guaranteed to fail teaches nothing but that it fails.'
    );
    assert.ok(html.indexOf('data-omnia-generate="Definition"') !== -1, 'the rest still renders');
    assert.ok(
      render(twoNoteResult(), 0, {}).indexOf('data-omnia-open="11"') !== -1,
      'and a real note still gets the button'
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

  '401 sends the user where the token actually IS': function () {
    const message = shared.generateErrorMessage(401, null);
    assert.ok(/token/i.test(message), '401 is the token; the message must say so');
    assert.ok(
      /Word Lookup/.test(message),
      'the token is shown in Anki under Tools → Omnia → Word Lookup → Configure…, and NOWHERE ' +
        'else. Smart Notes → Integrations holds Lookup…/Install/Reload and no token at all, ' +
        'so sending someone there is sending them to look for something that is not there: ' +
        message
    );
  },

  '403 says something that is true, and something that can be done': function () {
    const message = shared.generateErrorMessage(403, null);
    assert.ok(
      !/allow this extension/.test(message),
      'the add-on allows EVERY chrome-extension:// origin, by scheme and deliberately (the id ' +
        'differs between an unpacked load and a Web Store install). "The add-on has to allow ' +
        'this extension explicitly" describes an allowlist that does not exist: ' + message
    );
    assert.ok(
      /background worker|service worker/.test(message),
      'a 403 reaching this extension means the request was not the one the service worker ' +
        'makes — that is what the message has to say, because it is the only true thing ' +
        'about it: ' + message
    );
  },

  'no message sends anyone to Integrations for the token': function () {
    // Three files and a README repeated the same wrong route, and each looked plausible alone.
    // options.html is in the list because it is where the token is actually typed: a hint that
    // names the wrong menu there is the one the user reads at exactly the wrong moment.
    const sources = ['shared.js', 'lookup_view.js', 'content.js', 'options.html'].map(
      function (name) {
        return {name: name, text: fs.readFileSync(path.join(SRC, name), 'utf8')};
      }
    );
    sources.push({
      name: 'README.md',
      text: fs.readFileSync(path.join(SRC, '..', 'README.md'), 'utf8'),
    });
    sources.forEach(function (source) {
      // `&rarr;` too, or the HTML page — the one place the token is actually typed — would
      // sail through a check written for the arrow character.
      const flat = source.text.replace(/&rarr;/g, '→').replace(/\s+/g, ' ');
      assert.ok(
        !/token[\s\S]{0,200}?Smart Notes → Configure → Integrations/.test(flat),
        source.name + ' tells the user to fetch the token from the Smart Notes Integrations ' +
          'tab. That card has Lookup… / Install / Reload on it and nothing else; the token is ' +
          'in Tools → Omnia → Word Lookup → Configure….'
      );
    });
  },

  'the "Regenerate from clippers" remedy names the tab that holds it': function () {
    // The switch is on the GENERAL tab of Smart Notes' options (sn-opt-regen-clippers sits in
    // the general pane, and omnia's own word_lookup message says "Smart Notes → General"). The
    // Integrations tab holds the per-clipper integration toggles and nothing else, so a user
    // sent there finds a list of clippers with no switch of that name anywhere on it.
    [view.REGENERATE_OFF_MESSAGE, shared.generateErrorMessage(409, null)].forEach(
      function (message) {
        assert.ok(/Regenerate from clippers/.test(message), message);
        assert.ok(
          /General/.test(message) && !/Integrations/.test(message),
          'the remedy points at the wrong tab: ' + message
        );
      }
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

  'the token has a default, so a fresh profile reads "" and not undefined': function () {
    assert.strictEqual(
      shared.DEFAULTS.lookupToken,
      '',
      'a key missing from DEFAULTS never comes back from chrome.storage.get(DEFAULTS)'
    );
    assert.deepStrictEqual(
      shared.LOCAL_KEYS,
      ['lookupToken'],
      'the token is the one setting that must NOT be synced: it authenticates against a ' +
        "loopback service on this machine, issued by this machine's Omnia, so syncing it " +
        'uploads a secret to Google and copies it into profiles where it cannot work'
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

  'every control the panel wires is a control the panel draws': function () {
    // Wiring an attribute the renderer never emits is a promise to a reader that some control
    // exists. [data-omnia-close] was wired for a close button that was never drawn.
    const content = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
    const markup =
      view.renderPanel(view.buildPanelModel(twoNoteResult(), 0, {canAdd: true})) +
      view.renderPanel(view.buildPanelModel({word: 'zzz', cards: []}, 0, {canAdd: true})) +
      view.renderField({name: 'X', text: '', audio: ['a.mp3'], images: ['b.png'], busy: false,
        canGenerate: true, title: '', note: '', empty: false});
    const wired = (content.match(/\[data-omnia-[a-z-]+\]/g) || []).map(function (selector) {
      return selector.slice(1, -1);
    });
    assert.ok(wired.length >= 6, 'the panel wires its controls by data attribute: ' + wired);
    wired.forEach(function (attribute) {
      assert.ok(
        markup.indexOf(attribute + '=') !== -1,
        'content.js binds a handler to [' + attribute + '], which renderPanel never emits'
      );
    });
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
