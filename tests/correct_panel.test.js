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

  'an approved sentence says so, and shows the sentence it approved of': () => {
    // What `already_good` actually looks like on the wire: the add-on derives it from the two
    // sentences matching, so the rewrite is the original echoed back rather than absent.
    const payload = {
      already_good: true,
      changed: false,
      fixes: [],
      mode: 'written',
      rewritten: 'I went to the shop.',
      highlight: [['I went to the shop.', false]],
    };
    const html = view.render(payload, {open: []});

    assert.ok(/nothing to change/i.test(text(html)), 'it said nothing about the verdict');
    assert.ok(text(html).includes('I went to the shop.'), 'it hid the approved sentence');
    assert.ok(!html.includes('<mark'), 'it marked words in a sentence nobody changed');
  },

  'runs that do not spell the rewrite are refused': () => {
    // The panel renders the RUNS and Copy hands over `rewritten`, so runs that disagree put
    // something on the clipboard other than the sentence on screen — to a user who by
    // definition did not proofread it. Better unmarked and honest than marked and wrong.
    //
    // The add-on computes the runs and guarantees they join back, which is why this is cheap:
    // it costs one comparison and closes a version skew. `check.py::_as_runs` in the desktop
    // clipper makes the same call, and the two must not diverge.
    const runs = view.runsOf({
      rewritten: 'I went to the shop.',
      highlight: [['something else entirely', true]],
    });

    assert.deepStrictEqual(runs, [['I went to the shop.', false]]);
  },

  'runs that do spell it are kept whole': () => {
    const runs = view.runsOf({
      rewritten: 'I went.',
      highlight: [['I ', false], ['went.', true]],
    });

    assert.deepStrictEqual(runs, [['I ', false], ['went.', true]]);
  },

  'what is shown and what is copied can never disagree': () => {
    // The property the two rules above exist to hold, asserted directly.
    [
      {rewritten: 'I went.', highlight: [['I ', false], ['went.', true]]},
      {rewritten: 'I went.', highlight: [['wrong', true]]},
      {rewritten: 'I went.', highlight: []},
    ].forEach((payload) => {
      const shown = text(view.render(Object.assign({fixes: []}, payload), {open: []}));
      assert.ok(
        shown.includes(view.copyText(payload)),
        'the panel showed one sentence and Copy would hand over another: ' + shown
      );
    });
  },

  'a payload carrying nothing at all says so': () => {
    const html = view.render({fixes: [], mode: 'written'}, {open: []});

    assert.ok(/did not return a correction/i.test(text(html)), 'an empty panel');
    assert.ok(!html.includes('data-copy'), 'a Copy button with nothing behind it');
  },

  'a rewrite with no fixes still gets its box and its button': () => {
    const html = view.render(
      {rewritten: 'I went.', highlight: [['I went.', false]], fixes: [], mode: 'written'},
      {open: []}
    );
    assert.ok(html.includes('data-copy'), 'there was something to copy and no button for it');
  },

  // -- the display limit -------------------------------------------------------------------
  'only the first few fixes are listed': () => {
    // Omnia decides how many and sends every fix regardless, because the same answer is what a
    // saved card is built from. The slice is the panel's.
    const payload = correction();
    payload.shown = 1;

    const html = view.render(payload, {open: []});

    assert.strictEqual((html.match(/class="omnia-correct-fix"/g) || []).length, 1);
    assert.ok(html.includes('have went'), 'it listed the wrong one');
    assert.ok(!html.includes('for buy'), 'it listed one it was told to hold back');
  },

  'the ones held back are counted out loud': () => {
    // A list that stops without explanation reads as the tool having found that many.
    const payload = correction();
    payload.shown = 1;

    const shown = text(view.render(payload, {open: []}));

    assert.ok(/1 more fix\b/.test(shown), shown);
    assert.ok(/kept if you save/.test(shown), 'it did not say where the rest went');
  },

  'nothing held back says nothing': () => {
    const payload = correction();
    payload.shown = 99;

    assert.ok(!/more fix/.test(text(view.render(payload, {open: []}))));
  },

  'a payload with no limit shows everything': () => {
    // An older add-on, or one that did not say. Showing all of them beats showing none.
    const payload = correction();
    delete payload.shown;

    assert.strictEqual(view.fixesOf(payload).length, 2);
    assert.strictEqual(view.hiddenCount(payload), 0);
  },

  'the limit never touches the rewrite': () => {
    const payload = correction();
    payload.shown = 1;

    const shown = text(view.render(payload, {open: []}));

    assert.ok(shown.includes(payload.rewritten), 'the corrected sentence was cut too');
  },

  // -- saving ---------------------------------------------------------------------------
  'a correction offers to be kept': () => {
    assert.ok(view.render(correction(), {open: []}).includes('data-save'));
  },

  'an approved sentence can be kept too': () => {
    // Being right is worth being asked again.
    const payload = {
      already_good: true, changed: false, fixes: [], mode: 'written',
      rewritten: 'I went to the shop.', highlight: [['I went to the shop.', false]],
    };

    assert.ok(view.render(payload, {open: []}).includes('data-save'));
  },

  'nothing to keep offers no button': () => {
    const html = view.render({fixes: [], mode: 'written'}, {open: []});

    assert.ok(!html.includes('data-save'));
  },

  'there is somewhere for Anki to say where the note went': () => {
    assert.ok(view.render(correction(), {open: []}).includes('omnia-correct-said'));
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

// --- the panel's own stylesheet ------------------------------------------------------
//
// A shadow root blocks the PAGE's styles, not the UA's. There is no bare-element `button` rule
// in either sheet, so every control has to declare its own box or it paints as a native button
// — Arial 13.3px, 2px outset border, grey fill — next to flat 11px outlined siblings. That is
// exactly what shipped for "Save to Anki", and nothing in this suite could see it: the markup
// was right, the text was right, only the rendering was wrong.

/** The two stylesheets content.js injects into the correction panel's shadow root. */
function panelCss() {
  const source = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
  const grab = (name) => {
    const open = 'const ' + name + ' = `';
    const start = source.indexOf(open) + open.length;
    return source.slice(start, source.indexOf('`;', start));
  };
  // Comments stripped: they sit between rules, so a rule preceded by one is not preceded by
  // `}` and the selector matcher below misses it — which it did, silently falling through to
  // the dark-mode rule of the same name and reporting the wrong declarations.
  return (grab('PANEL_CSS') + grab('CORRECT_CSS')).replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations of the first rule whose selector is exactly `.name`.
 *
 * "Exactly" matters: `.omnia-correct-save` and `.omnia-correct-save.omnia-correct-saved` are
 * different rules, and only the first is the base box.
 */
function baseRule(css, name) {
  const match = new RegExp('(^|[,}])\\s*\\.' + name + '\\s*\\{([^}]*)\\}').exec(css);
  return match ? match[2] : '';
}

Object.assign(tests, {
  'there is no bare button rule to fall back on': () => {
    // The premise of the test below. If one is ever added, this stops being load-bearing —
    // and whoever adds it should see that spelled out rather than infer it.
    const css = panelCss();
    assert.ok(
      !/(^|[,}])\s*button\s*\{/.test(css),
      'a bare `button {}` rule exists now; the per-control rules below may be redundant'
    );
  },

  'every button in the panel declares its own box': () => {
    const css = panelCss();
    const buttons = [
      'omnia-correct-save',
      'omnia-correct-copy',
      'omnia-correct-why-btn',
      'omnia-correct-mode',
    ];
    for (const name of buttons) {
      const rule = baseRule(css, name);
      assert.ok(rule, name + ' has no base rule at all');
      for (const property of ['font', 'background', 'border']) {
        assert.ok(
          rule.indexOf(property) !== -1,
          name + ' does not set `' + property + '`, so the UA stylesheet decides it'
        );
      }
    }
  },

  'the dark theme restyles every bordered control': () => {
    // A control left out keeps its light border on a dark panel. `Save to Anki` was omitted.
    const css = panelCss();
    // lastIndexOf, not indexOf: PANEL_CSS has a dark block of its own and CORRECT_CSS is
    // concatenated after it, so slicing from the FIRST one swallows every light rule in
    // between — and the check passed with the control removed from the dark list entirely.
    const dark = css.slice(css.lastIndexOf('prefers-color-scheme: dark'));
    for (const name of [
      'omnia-correct-save',
      'omnia-correct-copy',
      'omnia-correct-why-btn',
      'omnia-correct-mode',
    ]) {
      assert.ok(dark.indexOf(name) !== -1, name + ' is not restyled for dark mode');
    }
  },
});

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
