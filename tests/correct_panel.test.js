/**
 * @fileoverview The correction panel's view model and the /check transport, with no browser.
 *
 * Same shape as lookup_panel.test.js: plain Node with `assert`, no framework, both modules
 * evaluated as SOURCE in a sandbox because neither is importable — each attaches one global the
 * way a classic script does.
 *
 * What is checked here is the part a screenshot cannot: that a phrase carrying markup cannot
 * reach the panel as markup, that the rewrite shown is always exactly the rewrite that arrived,
 * that "nothing to change" is a different answer from "nothing came back", and that an HTTP
 * failure comes out as a sentence someone can act on — including the one nobody would think to
 * test, an Anki too old to have the endpoint at all.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Evaluate one of the src/ scripts and return what it attached to `self`.
 * @param {string} file The file name inside src/.
 * @return {!Object} The `self` the module wrote onto.
 */
function loadModule(file) {
  const scope = {};
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  vm.compileFunction(source, ['self'], {filename: file})(scope);
  return scope;
}

const view = loadModule('correct_view.js').OmniaCorrectView;
const shared = loadModule('shared.js').OmniaClipper;

/** A correction with two fixes, one of them a deletion. */
function correction(extra) {
  return Object.assign(
    {
      original: 'I have went to the store yesterday for buy milk.',
      rewritten: 'I went to the store yesterday to buy milk.',
      mode: 'written',
      already_good: false,
      changed: true,
      fixes: [
        {
          before: 'have went',
          after: 'went',
          why: 'The simple past is what a finished action at a stated time takes.',
          kind: 'grammar',
          is_deletion: false,
        },
        {
          before: 'for buy',
          after: 'to buy',
          why: '“For” does not introduce a purpose before a verb; “to” does.',
          kind: 'word choice',
          is_deletion: false,
        },
      ],
      highlight: [
        ['I ', false],
        ['went', true],
        [' to the store yesterday ', false],
        ['to buy', true],
        [' milk.', false],
      ],
    },
    extra || {}
  );
}

/** Strip tags, so a test can assert on what a READER sees rather than on markup. */
function text(html) {
  return html.replace(/<[^>]*>/g, '');
}

const tests = {
  // -- what the panel says -------------------------------------------------------------
  'every fix is its own card, in the order they arrived': () => {
    const html = view.render(correction(), {open: []});
    const cards = html.match(/class="omnia-correct-fix"/g) || [];
    assert.strictEqual(cards.length, 2, 'one card per fix');
    assert.ok(
      html.indexOf('have went') < html.indexOf('for buy'),
      'the fixes were reordered'
    );
  },

  'a reason is in the markup but hidden until its button is pressed': () => {
    const shut = view.render(correction(), {open: []});
    assert.ok(/data-why-text="0"[^>]* hidden/.test(shut), 'the reason is showing unasked');
    assert.ok(shut.includes('The simple past'), 'the reason was not sent with the card');
    assert.ok(shut.includes('>Why?<'), 'no button to ask with');

    const open = view.render(correction(), {open: [0]});
    assert.ok(!/data-why-text="0"[^>]* hidden/.test(open), 'the reason stayed hidden');
    assert.ok(open.includes('aria-expanded="true"'), 'the button did not report its state');
    assert.ok(open.includes('>Hide<'), 'an open reason still offers to open');
    // Only the one asked for.
    assert.ok(/data-why-text="1"[^>]* hidden/.test(open), 'opening one opened them all');
  },

  'a fix with no reason gets no button rather than an empty one': () => {
    const payload = correction();
    payload.fixes[0].why = '   ';
    const html = view.render(payload, {open: []});
    assert.ok(!html.includes('data-why="0"'), 'a button that would explain nothing');
    assert.ok(html.includes('data-why="1"'), 'it took the other one down with it');
  },

  'a deletion says the words went, not that they became nothing': () => {
    const payload = correction();
    payload.fixes[0] = {
      before: 'very',
      after: '',
      why: 'It adds nothing.',
      kind: 'naturalness',
      is_deletion: true,
    };
    const html = view.render(payload, {open: []});
    assert.ok(html.includes('omnia-correct-gone'), 'a deletion rendered as an empty box');
    assert.ok(text(html).includes('removed'));
  },

  // -- the rewrite ---------------------------------------------------------------------
  'the marked rewrite reads as exactly the sentence that arrived': () => {
    const payload = correction();
    const shown = text(view.render(payload, {open: []}));
    assert.ok(
      shown.includes(payload.rewritten),
      'the runs did not join back to the rewrite:\n' + shown
    );
  },

  'the changed words, and only those, are marked': () => {
    const html = view.render(correction(), {open: []});
    const marked = (html.match(/<mark class="omnia-correct-new">([^<]*)<\/mark>/g) || []).map(
      (m) => m.replace(/<[^>]*>/g, '')
    );
    assert.deepStrictEqual(marked, ['went', 'to buy']);
  },

  'a payload with no highlight runs shows the plain sentence, not a guess': () => {
    // An older add-on, or one that could not diff. Showing the rewrite unmarked is a smaller
    // failure than inventing which words moved.
    const payload = correction({highlight: []});
    const html = view.render(payload, {open: []});
    assert.ok(!html.includes('<mark'), 'it marked words it could not know about');
    assert.ok(text(html).includes(payload.rewritten));
  },

  'nothing to change is a real answer, not an empty panel': () => {
    const payload = correction({
      already_good: true,
      changed: false,
      fixes: [],
      rewritten: 'I went to the store yesterday to buy milk.',
      highlight: [],
    });
    const shown = text(view.render(payload, {open: []}));
    assert.ok(/nothing to change/i.test(shown), 'a correct sentence produced a blank panel');
    assert.ok(shown.includes('milk.'), 'it did not show the sentence it approved of');
  },

  'an approved sentence marks nothing, even if runs came with it': () => {
    // Nothing changed, so nothing is new; marking here would point at words nobody touched.
    const payload = correction({
      already_good: true,
      fixes: [],
      highlight: [['I went.', true]],
    });
    assert.ok(!view.render(payload, {open: []}).includes('<mark'));
  },

  // -- the register ---------------------------------------------------------------------
  'the toggle lights the register the answer was judged in': () => {
    const html = view.render(correction({mode: 'spoken'}), {open: []});
    assert.ok(
      /data-mode="spoken"[^>]*aria-pressed="true"/.test(html.replace(/\n/g, '')) ||
        /omnia-correct-mode-on"? data-mode="spoken"/.test(html),
      'the spoken answer did not light the spoken button'
    );
    assert.ok(html.includes('data-mode="written"'), 'the other register vanished');
  },

  'a mode nobody recognises falls back rather than lighting nothing': () => {
    assert.strictEqual(view.modeOf({mode: 'shouted'}), 'written');
    assert.strictEqual(view.modeOf({}), 'written');
    assert.strictEqual(view.modeOf(null), 'written');
    assert.strictEqual(view.modeOf({mode: 'spoken'}), 'spoken');
  },

  // -- escaping --------------------------------------------------------------------------
  'a phrase carrying markup cannot reach the panel as markup': () => {
    // The phrase is whatever the user selected on an arbitrary page, and the reasons are a
    // model's prose. Both are interpolated into a string of HTML.
    const payload = correction({
      rewritten: '<img src=x onerror=alert(1)>',
      highlight: [['<img src=x onerror=alert(1)>', true]],
      fixes: [
        {
          before: '<script>a</script>',
          after: '"><b>b</b>',
          why: "it's <i>wrong</i>",
          kind: 'grammar',
          is_deletion: false,
        },
      ],
    });
    const html = view.render(payload, {open: [0]});
    assert.ok(!html.includes('<img'), 'an img tag survived into the panel');
    assert.ok(!html.includes('<script'), 'a script tag survived into the panel');
    assert.ok(!html.includes('<i>wrong</i>'), 'the reason was rendered as markup');
    assert.ok(html.includes('&lt;img'), 'it was dropped rather than escaped');
    // The attribute break is the one that matters: `"` closing data-why early would let the
    // rest be read as attributes.
    assert.ok(!/<b>b<\/b>/.test(html), 'a quote broke out of an attribute');
  },

  'the copy button hands over the sentence, not the marked-up one': () => {
    assert.strictEqual(
      view.copyText(correction()),
      'I went to the store yesterday to buy milk.'
    );
    assert.strictEqual(view.copyText({}), '');
    assert.strictEqual(view.copyText(null), '');
  },

  'an answer with nothing to copy offers no button, and no empty box': () => {
    // `already_good` with no rewrite is plausible: nothing was rewritten. An empty "Corrected"
    // box above a Copy button that does nothing and says nothing is worse than no box.
    const payload = {already_good: true, changed: false, fixes: [], mode: 'written'};
    const html = view.render(payload, {open: []});
    assert.ok(!html.includes('data-copy'), 'a Copy button with nothing to copy');
    assert.ok(!html.includes('omnia-correct-final"'), 'an empty Corrected box');
    assert.ok(/nothing to change/i.test(text(html)), 'and it stopped saying anything at all');
  },

  'runs without a rewrite are still readable, and still offer nothing to copy': () => {
    // The case the empty-box guard does NOT cover: there is a sentence to show (the runs), but
    // `copyText` reads `rewritten`, so a Copy button here would be one that does nothing.
    const html = view.render(
      {highlight: [['I went.', true]], fixes: [], mode: 'written'}, {open: []}
    );
    assert.ok(text(html).includes('I went.'), 'it hid a sentence it could perfectly well show');
    assert.ok(!html.includes('data-copy'), 'a Copy button with nothing behind it');
  },

  'a rewrite with no fixes still gets its box and its button': () => {
    const html = view.render(
      {rewritten: 'I went.', highlight: [['I went.', false]], fixes: [], mode: 'written'},
      {open: []}
    );
    assert.ok(html.includes('data-copy'), 'there was something to copy and no button for it');
  },

  // -- the states before an answer --------------------------------------------------------
  'the pending panel still offers the toggle, so the wait can be redirected': () => {
    const html = view.pending('spoken');
    assert.ok(html.includes('omnia-correct-pending'));
    assert.ok(html.includes('data-mode="written"'), 'no way to switch while waiting');
  },

  'a failure is shown in the words the add-on chose': () => {
    const message = 'Phrase Check is switched off. Turn it on in Anki…';
    const html = view.failed(message, 'written');
    assert.ok(text(html).includes(message), 'the panel reworded the reason');
  },

  'a malformed payload renders a panel rather than throwing': () => {
    // A truthful "nothing useful came back" beats an exception that leaves a spinner forever.
    [null, {}, {fixes: 'no'}, {fixes: [null, 3]}, {highlight: 'no'}].forEach((payload) => {
      assert.doesNotThrow(() => view.render(payload, {open: []}), String(payload));
    });
    assert.deepStrictEqual(view.fixesOf({fixes: [null, 3, {before: 'a'}]}), [{before: 'a'}]);
  },

  'open explanations may be tracked in a Set as readily as an array': () => {
    const html = view.render(correction(), {open: new Set([1])});
    assert.ok(!/data-why-text="1"[^>]* hidden/.test(html), 'a Set was ignored');
    assert.ok(/data-why-text="0"[^>]* hidden/.test(html));
  },

  // -- the transport ----------------------------------------------------------------------
  'the check URL hangs off the configured base, trailing slash or not': () => {
    assert.strictEqual(
      shared.buildCheckUrl('http://127.0.0.1:8766/'),
      'http://127.0.0.1:8766/check'
    );
    assert.strictEqual(
      shared.buildCheckUrl('http://127.0.0.1:8766'),
      'http://127.0.0.1:8766/check'
    );
  },

  'an Anki without Phrase Check is an update, not a setting': () => {
    // The one failure nobody would think to test and everybody will hit: the extension updates
    // from the Web Store on its own, the add-on does not. A 404 here means the endpoint does
    // not exist, and no amount of looking through Omnia's settings will produce it.
    const message = shared.checkErrorMessage(404, null);
    assert.ok(/update the add-on/i.test(message), message);
    assert.ok(!/switched off/i.test(message), 'it sent them hunting for a toggle');
  },

  'off and broken are told apart, and broken keeps the provider s words': () => {
    const off = shared.checkErrorMessage(503, null);
    assert.ok(/switched off/i.test(off) && /Tools/.test(off), off);

    const broke = shared.checkErrorMessage(502, {error: 'HTTP 401: invalid api key'});
    assert.ok(broke.includes('invalid api key'), 'the provider’s reason was swallowed: ' + broke);
    assert.ok(!/switched off/i.test(broke), 'a failed check was reported as a disabled one');
  },

  'an unknown status still says something rather than nothing': () => {
    assert.ok(shared.checkErrorMessage(418, null).includes('418'));
  },

  'the check gets its own budget, far shorter than a whole note s': () => {
    // The user is watching a spinner over a selected phrase; /generate's five minutes would be
    // the panel lying about being busy for four and a half of them.
    assert.ok(
      shared.CHECK_TIMEOUT_MS < shared.GENERATE_TIMEOUT_MS,
      'a phrase check may run as long as a whole note'
    );
    assert.ok(shared.CHECK_TIMEOUT_MS >= 30000, 'too eager to let a slow model answer');
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
