/**
 * @fileoverview Omnia Web Clipper - the correction panel's view model (pure).
 *
 * No DOM, no chrome.*, no network. It turns a /check answer into the panel's markup, and owns the
 * one piece of interaction state the panel has: which explanations are open.
 *
 * The shape is the feature. A correction is a LIST of small fixes, each with its own reason, and
 * then the whole phrase rewritten with the changed words marked. "Your sentence should be X"
 * teaches nothing, and one paragraph explaining six unrelated problems is read by nobody — so the
 * reasons sit behind a button per fix rather than inline, and the rewrite shows exactly which
 * words moved.
 *
 * Built as a STRING with no handlers attached; content.js binds those by data attribute, so
 * nothing here can smuggle in an inline `on*` a page's CSP would refuse — and every branch is
 * checkable with plain Node (tests/correct_panel.test.js).
 *
 * Loaded as a content script before content.js, and evaluated as source by the tests. Attaches
 * one global, like shared.js and lookup_view.js.
 */

(function (root) {
  'use strict';

  const MODES = ['written', 'spoken'];

  // What each register means, in the words the toggle shows. Short because it is a two-item
  // switch and a sentence on each would be longer than the thing it labels.
  const MODE_LABELS = {written: 'Writing', spoken: 'Speaking'};
  const MODE_TITLES = {
    written: 'Judge it as writing — essays, email, anything read',
    spoken: 'Judge it as speech — conversation, where contractions are correct',
  };

  // Said in ONE place so the badge, its colour and the tests quote the same word.
  const KIND_LABELS = {
    grammar: 'grammar',
    'word choice': 'word choice',
    naturalness: 'naturalness',
    spelling: 'spelling',
    punctuation: 'punctuation',
  };

  /**
   * HTML-escape one value.
   *
   * Everything here comes from a model's answer or from text the user selected on a page, and
   * both reach the panel's markup — so this is applied to every interpolation without exception
   * rather than where it "obviously" matters.
   *
   * @param {*} value
   * @return {string}
   */
  function escape(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Which register a payload was judged in, defaulting rather than guessing.
   * @param {!Object} correction
   * @return {string}
   */
  function modeOf(correction) {
    const mode = (correction && correction.mode) || '';
    return MODES.indexOf(mode) === -1 ? 'written' : mode;
  }

  /**
   * The fixes worth rendering.
   *
   * The add-on already drops the ones that change nothing, so this only guards against a payload
   * that is not shaped like one — a panel is not the place to re-litigate what a fix is.
   *
   * @param {!Object} correction
   * @return {!Array<!Object>}
   */
  function fixesOf(correction) {
    const fixes = (correction && correction.fixes) || [];
    const kept = Array.isArray(fixes)
      ? fixes.filter((fix) => fix && typeof fix === 'object')
      : [];
    // The panel lists the first few, most important first; Omnia decides how many and sends
    // every fix regardless, because the same answer is what a saved card is built from. So the
    // slice is HERE and nothing is dropped upstream.
    const limit = Number((correction && correction.shown) || 0);
    return limit > 0 ? kept.slice(0, limit) : kept;
  }

  /**
   * How many fixes were left out of the list.
   * @param {!Object} correction The payload.
   * @return {number} Zero when everything is on screen.
   */
  function hiddenCount(correction) {
    const all = (correction && correction.fixes) || [];
    const total = Array.isArray(all)
      ? all.filter((fix) => fix && typeof fix === 'object').length
      : 0;
    return Math.max(0, total - fixesOf(correction).length);
  }

  /**
   * The rewrite as runs, marked where it differs from what the user wrote.
   *
   * Computed by the ADD-ON and sent, never derived here: two implementations of "which words
   * changed" is two answers to a question with one right one, and the web and desktop panels
   * would slowly disagree. A payload without them falls back to the plain sentence rather than
   * to a guess.
   *
   * @param {!Object} correction
   * @return {!Array<!Array>} `[[text, isNew], …]`
   */
  function runsOf(correction) {
    const rewritten = (correction && correction.rewritten) || '';
    const runs = (correction && correction.highlight) || [];
    if (!Array.isArray(runs) || !runs.length) {
      // With no rewrite either, this is [['', false]] -- one empty run, which finalBlock reads
      // as "there is nothing here" rather than as a sentence.
      return [[rewritten, false]];
    }
    const kept = runs.filter((run) => Array.isArray(run) && run.length >= 1);
    // Refused unless they spell EXACTLY the sentence Copy would hand over. The panel renders
    // the runs and the button copies `rewritten`, so runs that disagree put something on the
    // clipboard other than what is on screen -- to a user who by definition did not proofread
    // it, which is who this feature is for. Better unmarked and honest than marked and wrong.
    //
    // The add-on computes the runs and guarantees this, which is exactly why it is cheap to
    // check: a version skew or a bug upstream should not reach someone's clipboard. The desktop
    // panel makes the same call in `check.py::_as_runs`, and the two must not diverge.
    if (kept.map((run) => run[0]).join('') !== rewritten) {
      return [[rewritten, false]];
    }
    return kept;
  }

  /**
   * One fix, as a card.
   *
   * The reason is IN the markup but hidden, not fetched on demand: it already arrived with the
   * answer, and a button that had to ask for it would be a spinner on a string that is already
   * in memory.
   *
   * @param {!Object} fix
   * @param {number} index
   * @param {boolean} open Whether its explanation is showing.
   * @return {string}
   */
  function fixCard(fix, index, open) {
    const kind = KIND_LABELS[String(fix.kind || '').toLowerCase()] || String(fix.kind || '');
    const after = fix.is_deletion
      ? '<span class="omnia-correct-gone">removed</span>'
      : '<span class="omnia-correct-after">' + escape(fix.after) + '</span>';
    const why = String(fix.why || '').trim();
    return (
      '<li class="omnia-correct-fix" data-fix="' + index + '">' +
        '<div class="omnia-correct-change">' +
          '<span class="omnia-correct-before">' + escape(fix.before) + '</span>' +
          '<span class="omnia-correct-arrow" aria-hidden="true">→</span>' +
          after +
        '</div>' +
        '<div class="omnia-correct-meta">' +
          (kind ? '<span class="omnia-correct-kind">' + escape(kind) + '</span>' : '') +
          (why
            ? '<button type="button" class="omnia-correct-why-btn" data-why="' + index + '"' +
              ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
              (open ? 'Hide' : 'Why?') + '</button>'
            : '') +
        '</div>' +
        (why
          ? '<p class="omnia-correct-why" data-why-text="' + index + '"' +
            (open ? '' : ' hidden') + '>' + escape(why) + '</p>'
          : '') +
      '</li>'
    );
  }

  /**
   * The register toggle.
   * @param {string} mode The one currently shown.
   * @return {string}
   */
  function modeToggle(mode) {
    return (
      '<div class="omnia-correct-modes" role="group" aria-label="Judge it as">' +
        MODES.map((name) =>
          '<button type="button" class="omnia-correct-mode' +
            (name === mode ? ' omnia-correct-mode-on' : '') +
            '" data-mode="' + name + '" title="' + escape(MODE_TITLES[name]) + '"' +
            (name === mode ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
            escape(MODE_LABELS[name]) +
          '</button>'
        ).join('') +
      '</div>'
    );
  }

  /**
   * The whole panel for one correction.
   *
   * @param {!Object} correction A /check payload.
   * @param {{open: (Set|Array|undefined), saved: (string|undefined),
   *          saving: (boolean|undefined), saveError: (string|undefined)}=} state
   *     What is on screen beyond the answer itself: which fixes have their reason showing, and
   *     where the save has got to. Every part of it is rendered FROM here rather than written
   *     into the DOM afterwards, because this subtree is rebuilt on every redraw.
   * @return {string} Markup for the panel body.
   */
  function render(correction, state) {
    const open = openSet(state);
    const mode = modeOf(correction);
    const fixes = fixesOf(correction);
    const header =
      '<div class="omnia-correct-head">' +
        '<span class="omnia-correct-title">Correction</span>' +
        modeToggle(mode) +
      '</div>';

    if (!copyText(correction) && !fixes.length) {
      // Neither a correction nor an approval: the payload carries nothing to show. Saying so
      // beats an empty panel under a "Correction" heading, which reads as the tool being broken
      // rather than as the answer being empty. The desktop panel says the same thing.
      return (
        header +
        '<p class="omnia-correct-error">Omnia did not return a correction for that phrase.</p>'
      );
    }

    if (correction && correction.already_good && !fixes.length) {
      // A real answer, and a different one from "nothing came back". Saying "no changes" beside
      // the sentence is what stops the reader wondering whether it worked.
      return (
        header +
        '<p class="omnia-correct-good">This reads correctly as ' +
          escape(MODE_LABELS[mode].toLowerCase()) + '. Nothing to change.</p>' +
        finalBlock(correction, false, state)
      );
    }

    const hidden = hiddenCount(correction);
    return (
      header +
      '<ul class="omnia-correct-fixes">' +
        fixes.map((fix, index) => fixCard(fix, index, open.indexOf(index) !== -1)).join('') +
      '</ul>' +
      // Said out loud rather than silently cut: a list that stops without explanation reads as
      // the tool having found that many, and the rest are on the card.
      (hidden
        ? '<p class="omnia-correct-more">' +
            hidden + (hidden === 1 ? ' more fix' : ' more fixes') +
            ' — all of them are kept if you save this.</p>'
        : '') +
      finalBlock(correction, true, state)
    );
  }

  /**
   * The rewritten phrase, with the changed words marked, and the Copy/Save controls.
   *
   * @param {!Object} correction
   * @param {boolean} marked Whether to bold the differences.
   * @param {{saved: (string|undefined), saving: (boolean|undefined),
   *          saveError: (string|undefined)}=} state Where the save has got to. Every part of
   *     it is rendered FROM here rather than poked into the DOM afterwards, because this whole
   *     subtree is rebuilt whenever an explanation opens or the register changes — a label
   *     written onto the button is wiped by the next redraw, and a re-enabled Save button is a
   *     second note in somebody's collection.
   * @return {string}
   */
  function finalBlock(correction, marked, state) {
    // Nothing to show. An `already_good` answer may legitimately omit the rewrite -- nothing was
    // rewritten -- and an empty "Corrected" box above a Copy button that does nothing and says
    // nothing is worse than no box at all.
    if (!copyText(correction) && !runsOf(correction).some((run) => run[0])) {
      return '';
    }
    const body = runsOf(correction)
      .map((run) =>
        marked && run[1]
          ? '<mark class="omnia-correct-new">' + escape(run[0]) + '</mark>'
          : escape(run[0])
      )
      .join('');
    // The button only when there is something for it to put on the clipboard. `copyText` hands
    // over `rewritten`, so a payload with runs but no rewrite can still be READ and simply has
    // nothing to copy.
    const copy = copyText(correction)
      ? '<button type="button" class="omnia-correct-copy" data-copy="1">Copy</button>'
      : '';
    // Keeping it is offered whenever there is a correction to keep — including one that was
    // already correct, which is a perfectly good card to be asked again.
    // All three of "Save to Anki" / "Saving…" / "Saved" are drawn from STATE. `Saved` was from
    // the start; `Saving…` was not, and that was the hole: it was written onto the button at
    // press time, so opening any explanation mid-save rebuilt this subtree, brought the button
    // back enabled, and a second press wrote a second note for one phrase.
    const kept = !!(state && state.saved);
    const saving = !kept && !!(state && state.saving);
    const label = kept ? 'Saved' : saving ? 'Saving…' : 'Save to Anki';
    const save = copyText(correction)
      ? '<button type="button" class="omnia-correct-save' +
        (kept ? ' omnia-correct-saved' : '') + '" data-save="1"' +
        (kept || saving ? ' disabled' : '') +
        '>' + label + '</button>'
      : '';
    return (
      '<div class="omnia-correct-final">' +
        '<div class="omnia-correct-final-head">' +
          '<span class="omnia-correct-final-label">Corrected</span>' +
          save +
          copy +
        '</div>' +
        '<p class="omnia-correct-text">' + body + '</p>' +
        // Where a save reports what it did. Empty until then, and hidden while empty — Omnia's
        // sentence names the deck, and says when the note type had to be renamed, which is the
        // one thing about a save nobody can see for themselves.
        //
        // A FAILED save reports here too, rather than replacing the panel: the correction is
        // what the user asked for and it is still correct, so throwing away six fixes and the
        // explanations they had opened to show one sentence about Anki being busy costs them
        // the answer and the button they would retry with.
        (state && state.saveError
          ? '<p class="omnia-correct-said omnia-correct-said-bad">' +
              escape(state.saveError) + '</p>'
          : '<p class="omnia-correct-said">' + escape((state && state.saved) || '') + '</p>') +
      '</div>'
    );
  }

  /**
   * What the panel shows while it is waiting.
   * @param {string} mode
   * @return {string}
   */
  function pending(mode) {
    return (
      '<div class="omnia-correct-head">' +
        '<span class="omnia-correct-title">Correction</span>' +
        modeToggle(MODES.indexOf(mode) === -1 ? 'written' : mode) +
      '</div>' +
      '<p class="omnia-correct-pending">Checking…</p>'
    );
  }

  /**
   * What the panel shows when the check could not run.
   *
   * The message comes from the add-on and is shown AS-IS: it names the thing only the user can
   * fix — a switch to turn on, a key to check, credit to top up — and rewording it here would
   * flatten three different problems into one.
   *
   * @param {string} message
   * @param {string} mode
   * @return {string}
   */
  function failed(message, mode) {
    return (
      '<div class="omnia-correct-head">' +
        '<span class="omnia-correct-title">Correction</span>' +
        modeToggle(MODES.indexOf(mode) === -1 ? 'written' : mode) +
      '</div>' +
      '<p class="omnia-correct-error">' + escape(message) + '</p>'
    );
  }

  /**
   * The open-explanation indexes as a plain array, whatever the caller keeps them in.
   * @param {!Object=} state
   * @return {!Array<number>}
   */
  function openSet(state) {
    const open = (state && state.open) || [];
    if (Array.isArray(open)) {
      return open;
    }
    return typeof open.forEach === 'function' ? Array.from(open) : [];
  }

  /**
   * The text a Copy button should put on the clipboard.
   *
   * The rewrite, plain — not the marked-up version. What the user wants is the sentence they can
   * paste somewhere, and markers pasted into an email are worse than no button at all.
   *
   * @param {!Object} correction
   * @return {string}
   */
  function copyText(correction) {
    return String((correction && correction.rewritten) || '');
  }

  root.OmniaCorrectView = {
    MODES: MODES,
    MODE_LABELS: MODE_LABELS,
    copyText: copyText,
    hiddenCount: hiddenCount,
    escape: escape,
    failed: failed,
    fixesOf: fixesOf,
    modeOf: modeOf,
    pending: pending,
    render: render,
    runsOf: runsOf,
  };
})(typeof self !== 'undefined' ? self : this);
