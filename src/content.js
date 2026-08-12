/**
 * @fileoverview Omnia Web Clipper - content script.
 *
 * Runs on every page (<all_urls>). Two capture paths live here:
 *
 *   1. Double-click "+" (single words / quick selections). When the user selects
 *      text or double-clicks a word AND the extension is enabled with the mouse
 *      toggle on, a small floating "+" tooltip appears near the selection.
 *      Clicking it sends the capture to the background worker.
 *
 *   2. Right-click "Send to Anki (Omnia)" (phrases). The background worker owns
 *      the menu; it messages this script with "omnia-get-context" to read the
 *      sentence/context surrounding the current selection, then runs the same
 *      addNote flow. This script also renders the toast for that path.
 *
 * A capture payload is:
 *   - selection: the selected text (a single word OR a multi-word phrase),
 *   - sentence:  the sentence that contains the selection,
 *   - context:   a larger snippet (the containing paragraph/block),
 *   - pageTitle, url.
 *
 * Pure vanilla JS, no libraries, no build step. Self-contained.
 */

(() => {
  'use strict';

  // Double-injection guard. On extension reload the background re-injects this script into open
  // tabs (chrome.scripting) — which, for a reload (same extension id), runs in the SAME isolated
  // world as the previous instance. Tear that stale instance's listeners down before we re-init so
  // we don't end up with two "+" handlers fighting over one page.
  if (window.__omniaClipperTeardown) {
    try {
      window.__omniaClipperTeardown();
    } catch (_e) {
      // ignore — the previous instance may already be dead
    }
  }

  const TOOLTIP_ID = 'omnia-clipper-tooltip';
  const PANEL_ID = 'omnia-clipper-lookup-panel';
  // The desktop clipper puts its pill down-right of the POINTER, which reads better than
  // hanging it off the selection's top-right corner; the two clippers now match.
  const CURSOR_OFFSET = 12;
  let lastPointer = {x: 0, y: 0};
  // The magnifier glyph, drawn inline so the button needs no packaged asset.
  // Panel styling lives in the shadow root, so the host page's CSS cannot reach it. Mirrors the
  // desktop clipper's panel: a soft header band, one quiet meta line, then translucent field
  // cards with an accent spine.
  const PANEL_CSS = `
    .omnia-panel {
      width: 360px; max-height: 460px; overflow-y: auto;
      background: #ffffff; color: #16191d;
      border: 1px solid #dfe3e8; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.18);
      padding: 14px 16px 16px;
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .hdr {
      display: flex; align-items: flex-start; gap: 8px;
      background: linear-gradient(135deg, rgba(47,129,247,0.10), rgba(0,0,0,0));
      border: 1px solid rgba(47,129,247,0.22); border-radius: 10px;
      padding: 10px 12px; margin-bottom: 6px;
    }
    .word { flex: 1; font-size: 19px; font-weight: 600; word-break: break-word; }
    .pill {
      color: #fff; font-size: 11px; font-weight: 600;
      padding: 2px 9px; border-radius: 9px; text-transform: capitalize; white-space: nowrap;
    }
    .muted { color: #6b727c; font-size: 11px; margin: 2px 2px 8px; }
    .fields { display: flex; flex-direction: column; gap: 8px; }
    .field {
      background: rgba(246,247,249,0.75);
      border: 1px solid #dfe3e8; border-left: 3px solid rgba(47,129,247,0.22);
      border-radius: 8px; padding: 8px 10px 9px;
    }
    .fname {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.4px; color: #6b727c; margin-bottom: 7px;
    }
    .fval { font-size: 13px; color: #16191d; }
    .media-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .media {
      font: inherit; font-size: 12px; cursor: pointer;
      background: transparent; color: inherit;
      border: 1px solid #dfe3e8; border-radius: 7px; padding: 4px 10px;
    }
    .media:hover { border-color: #2f81f7; color: #2f81f7; }
    .media[disabled] { opacity: 0.6; cursor: default; }
    .media-img { max-width: 100%; max-height: 220px; border-radius: 6px; display: block; }
    @media (prefers-color-scheme: dark) {
      .omnia-panel { background: #1e2127; color: #e8eaed; border-color: #363b44; }
      .muted, .fname { color: #9aa1ac; }
      .field { background: rgba(38,42,49,0.75); border-color: #363b44; }
      .media { border-color: #363b44; }
      .fval { color: #e8eaed; }
    }
  `;

  const LOOKUP_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
    'stroke="#ffffff" stroke-width="2.4" stroke-linecap="round">' +
    '<circle cx="10.5" cy="10.5" r="6.5"></circle>' +
    '<line x1="15.5" y1="15.5" x2="21" y2="21"></line></svg>';
  const TOAST_ID = 'omnia-clipper-toast';
  // Cap the context snippet so we never ship a whole article into a note field.
  const MAX_CONTEXT_CHARS = 600;
  const MAX_SENTENCE_CHARS = 400;

  // The most recent capture payload, frozen at the moment the selection was made.
  // We snapshot here (not on click) because clicking the tooltip can clear the
  // browser selection before we read it.
  let pendingCapture = null;

  // Cached enable flags so the (frequent) selection handler stays synchronous.
  // Seeded from storage on load and kept fresh via chrome.storage.onChanged.
  let enabled = true;
  let mouseEnabled = true;
  let lookupEnabled = true;

  // When the extension is reloaded/updated/disabled, THIS content script keeps running in an
  // already-open tab but loses its extension context: any chrome.* call then throws
  // "Extension context invalidated". Without guarding, clicking "+" hangs forever on the
  // "Sending…" toast (the callback never fires) and throws an uncaught error. We detect the dead
  // context, tell the user to reload the page, and stop reacting.
  let contextGone = false;

  /** Whether this content script's extension context is still valid (chrome.* usable). */
  function extensionAlive() {
    if (contextGone) {
      return false;
    }
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  /** Detach on a dead context: remove the "+" and stop the selection handlers firing. */
  function handleContextGone() {
    if (contextGone) {
      return;
    }
    contextGone = true;
    removeTooltip();
    document.removeEventListener('mouseup', onSelectionEvent, true);
    document.removeEventListener('dblclick', onSelectionEvent, true);
    document.removeEventListener('scroll', removeTooltip, true);
    // Also detach the remaining listeners so a re-injection (extension reload) leaves no orphans.
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    document.removeEventListener('keydown', onEscapeKeydown);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_e) {
      // The context may already be torn down (chrome.* unusable) — nothing left to detach.
    }
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (_e) {
      // The context may already be torn down (chrome.* unusable) — nothing left to detach.
    }
  }

  const RELOAD_MSG = 'Omnia was updated — reload this page (F5) to keep clipping.';

  // -------------------------------------------------------------------------
  // Enable flags (master toggle + double-click toggle)
  // -------------------------------------------------------------------------

  /** Load the enable flags from storage into the module-level cache. */
  function refreshFlags() {
    if (!extensionAlive()) {
      handleContextGone();
      return;
    }
    try {
      chrome.storage.sync.get(
        {enabled: true, mouseEnabled: true, lookupEnabled: true},
        (stored) => {
        if (chrome.runtime.lastError) {
          return;
        }
        enabled = stored.enabled !== false;
        mouseEnabled = stored.mouseEnabled !== false;
        lookupEnabled = stored.lookupEnabled !== false;
        if (!enabled || !mouseEnabled) {
          removeTooltip();
        }
      });
    } catch (_e) {
      handleContextGone();
    }
  }

  /** storage.onChanged handler (named so handleContextGone can removeListener it). */
  function onStorageChanged(changes, area) {
    if (area !== 'sync') {
      return;
    }
    if (changes.enabled || changes.mouseEnabled) {
      refreshFlags();
    }
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  // -------------------------------------------------------------------------
  // Selection -> capture payload
  // -------------------------------------------------------------------------

  /**
   * Build the capture payload from the current window selection.
   * @return {?Object} The capture payload, or null when there is no usable
   *     (non-whitespace) selection.
   */
  function buildCapture() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const selectedText = collapseWhitespace(selection.toString());
    if (!selectedText) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const block = nearestBlockElement(range.commonAncestorContainer);
    const blockText = block ? collapseWhitespace(block.innerText || block.textContent || '') : '';

    const sentence = clip(
      extractSentence(blockText, selectedText) || selectedText,
      MAX_SENTENCE_CHARS,
    );
    const context = clip(blockText || selectedText, MAX_CONTEXT_CHARS);

    return {
      selection: selectedText,
      sentence: sentence,
      context: context,
      // Combined disambiguation input: the exact sentence first (precise usage), then the
      // surrounding paragraph — map THIS single key to one note field to give the generator
      // both without needing two fields. Deduped when the block is just the sentence.
      context_full: combineContext(sentence, context),
      pageTitle: document.title || '',
      url: location.href,
    };
  }

  /**
   * Merge the exact sentence and the surrounding context into one snippet, sentence first for
   * emphasis. Falls back to whichever exists; avoids duplicating the sentence when it already
   * equals the context.
   * @param {string} sentence The exact containing sentence.
   * @param {string} context The surrounding paragraph/block.
   * @return {string} The combined snippet.
   */
  function combineContext(sentence, context) {
    if (sentence && context && sentence !== context) {
      return sentence + '\n\n' + context;
    }
    return context || sentence || '';
  }

  /**
   * Collapse runs of whitespace/newlines into single spaces and trim.
   * @param {string} text The raw text.
   * @return {string} The normalised text.
   */
  function collapseWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Truncate to a max length on a word boundary, adding an ellipsis.
   * @param {string} text The text to clip.
   * @param {number} maxChars The maximum length.
   * @return {string} The clipped text.
   */
  function clip(text, maxChars) {
    if (text.length <= maxChars) {
      return text;
    }
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
  }

  /**
   * Walk up from a DOM node to the nearest block-level element so the "context"
   * snippet is a meaningful paragraph rather than an inline fragment.
   * @param {?Node} node The starting node.
   * @return {!Element} The nearest block-level ancestor (or document.body).
   */
  function nearestBlockElement(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const blockTags = new Set([
      'P', 'DIV', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
      'PRE', 'DD', 'DT', 'FIGCAPTION', 'ASIDE', 'MAIN', 'BODY',
    ]);
    while (el && el !== document.body) {
      if (blockTags.has(el.tagName)) {
        return el;
      }
      el = el.parentElement;
    }
    return el || document.body;
  }

  /**
   * Find the sentence inside `blockText` that contains `needle`.
   * Splits on sentence boundaries (., !, ?, and common CJK terminators).
   * Falls back to a windowed slice around the needle, then to the needle itself.
   * @param {string} blockText The containing block's text.
   * @param {string} needle The selected text to locate.
   * @return {string} The best-effort containing sentence.
   */
  function extractSentence(blockText, needle) {
    if (!blockText) {
      return '';
    }
    const idx = blockText.indexOf(needle);
    if (idx === -1) {
      // Selection text was normalised differently from the block; window around
      // a best-effort midpoint instead of failing outright.
      return windowAround(blockText, Math.floor(blockText.length / 2), needle.length);
    }

    // Sentence terminators followed by whitespace/quote/closing bracket.
    const boundary = /[.!?。！？]+["'”’\)\]]?\s+/g;
    let start = 0;
    let match;
    let sentenceStart = 0;
    let sentenceEnd = blockText.length;

    // Find the boundary immediately before the needle (sentence start) ...
    while ((match = boundary.exec(blockText)) !== null) {
      const boundaryEnd = match.index + match[0].length;
      if (boundaryEnd <= idx) {
        sentenceStart = boundaryEnd;
      } else {
        // ... and the first boundary at/after the needle (sentence end).
        sentenceEnd = boundaryEnd;
        break;
      }
      start = boundaryEnd;
    }
    void start;

    return collapseWhitespace(blockText.slice(sentenceStart, sentenceEnd));
  }

  /**
   * Fallback: a character window centred on `center` widened by the selection.
   * @param {string} text The block text.
   * @param {number} center The midpoint to window around.
   * @param {number} selLen The selection length, used to widen the window.
   * @return {string} The windowed, whitespace-collapsed text.
   */
  function windowAround(text, center, selLen) {
    const half = Math.max(120, selLen + 80);
    const from = Math.max(0, center - half);
    const to = Math.min(text.length, center + half);
    return collapseWhitespace(text.slice(from, to));
  }

  // -------------------------------------------------------------------------
  // Floating "+" tooltip
  // -------------------------------------------------------------------------

  /** Remove the "+" tooltip and clear the pending capture. */
  function removeTooltip() {
    const existing = document.getElementById(TOOLTIP_ID);
    if (existing) {
      existing.remove();
    }
    pendingCapture = null;
  }

  /** Remove the lookup panel, if one is open. */
  function removePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
    }
  }

  /**
   * Show the "+" button near the selection's bounding rectangle.
   * @param {!Object} capture The capture payload to attach to the button.
   */
  function showTooltip(capture) {
    removeTooltip();
    removePanel();  // a new selection makes any open answer stale
    pendingCapture = capture;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const pill = document.createElement('div');
    pill.id = TOOLTIP_ID;
    Object.assign(pill.style, {
      position: 'fixed',
      // Down-right of the pointer, clamped to the viewport — the desktop clipper's placement.
      top: Math.min(window.innerHeight - 30, lastPointer.y + CURSOR_OFFSET) + 'px',
      left: Math.min(window.innerWidth - 60, lastPointer.x + CURSOR_OFFSET) + 'px',
      zIndex: '2147483647',
      display: 'flex',
      gap: '4px',
      padding: '0',
      background: 'transparent',
      userSelect: 'none',
    });

    // Use mousedown (not click) so the selection is still alive when we read it, and
    // preventDefault so pressing the button does not clear it.
    const arm = (el, handler) => {
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    };

    let lookupButton = null;
    const add = makeCircleButton('+', '#2d6cdf', 'Add to Anki (Omnia)');
    add.setAttribute('aria-label', 'Add to Anki with Omnia');
    arm(add, sendCapture);
    pill.appendChild(add);

    if (lookupEnabled) {
      const look = makeCircleButton('', '#5b6472', 'Look this word up in your Anki collection');
      look.setAttribute('aria-label', 'Look up in Anki with Omnia');
      look.innerHTML = LOOKUP_SVG;
      look.style.position = 'relative';
      arm(look, () => sendLookup(capture.selection || ''));
      pill.appendChild(look);
      lookupButton = look;
    }

    document.body.appendChild(pill);
    if (lookupButton) {
      // Only now that the pill is IN the document: the probe's guard checks isConnected, and a
      // fast reply would otherwise arrive while the button is still detached and be dropped.
      probeLookup(capture.selection || '', lookupButton);
    }
  }

  /**
   * Build one round icon button of the floating pill.
   * @param {string} label Text glyph (empty when an SVG icon is set by the caller).
   * @param {string} background CSS background colour.
   * @param {string} title Tooltip text.
   * @return {!HTMLElement}
   */
  function makeCircleButton(label, background, title) {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    el.title = title;
    el.textContent = label;
    Object.assign(el.style, {
      width: '22px',
      height: '22px',
      lineHeight: '20px',
      textAlign: 'center',
      fontSize: '14px',
      fontWeight: '700',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      color: '#ffffff',
      background: background,
      border: 'none',
      borderRadius: '50%',
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
    });
    return el;
  }

  // Card-state pill colours, matching the desktop clipper's panel.
  const STATE_COLORS = {
    new: '#3b82f6',
    learning: '#f59e0b',
    relearning: '#ef4444',
    review: '#22a06b',
  };

  /**
   * Ask in the background how many cards match, and mark the magnifier accordingly.
   *
   * A count badge means "you already have this"; a muted glyph means "not in your collection
   * yet" — both answer the common question without opening anything. A failed probe leaves the
   * button in its neutral state rather than showing an error nobody asked for.
   *
   * @param {string} word The captured word.
   * @param {!HTMLElement} button The magnifier button to annotate.
   */
  function probeLookup(word, button) {
    if (!word.trim()) {
      return;
    }
    try {
      chrome.runtime.sendMessage({type: 'omnia-lookup', word: word}, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          return;  // unknown -> stay neutral
        }
        // The pill may have been replaced by a newer selection while this was in flight.
        if (!button.isConnected) {
          return;
        }
        const count = ((response.result || {}).cards || []).length;
        const quoted = `“${word}”`;
        if (count > 0) {
          button.title = `${count} card(s) match ${quoted} — click to see them`;
          button.appendChild(makeCountBadge(count));
        } else {
          button.style.background = '#8b93a1';
          button.title = `No card for ${quoted} yet — click to confirm`;
        }
      });
    } catch (_e) {
      // Extension context gone; the neutral button is still perfectly usable.
    }
  }

  /**
   * Build the small green count badge that rides on the magnifier.
   * @param {number} count Matching notes.
   * @return {!HTMLElement}
   */
  function makeCountBadge(count) {
    const badge = document.createElement('div');
    badge.textContent = count > 9 ? '9+' : String(count);
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-4px',
      right: '-4px',
      minWidth: '13px',
      height: '13px',
      lineHeight: '13px',
      padding: '0 3px',
      boxSizing: 'border-box',
      borderRadius: '7px',
      background: '#22a06b',
      color: '#ffffff',
      fontSize: '9px',
      fontWeight: '700',
      textAlign: 'center',
      pointerEvents: 'none',
    });
    return badge;
  }

  /**
   * Ask the background worker to look ``word`` up and render the answer in a panel.
   * @param {string} word The captured word.
   */
  function sendLookup(word) {
    if (!word.trim()) {
      return;
    }
    showPanel(renderLoading(word), word);
    try {
      chrome.runtime.sendMessage({type: 'omnia-lookup', word: word}, (response) => {
        if (chrome.runtime.lastError) {
          showPanel(renderMessage('Lookup unavailable', chrome.runtime.lastError.message), word);
          return;
        }
        if (!response || !response.ok) {
          showPanel(
            renderMessage('Lookup unavailable', (response && response.error) || 'Unknown error.'),
            word
          );
          return;
        }
        showPanel(renderResult(response.result, word), word);
      });
    } catch (err) {
      showPanel(renderMessage('Lookup unavailable', String(err)), word);
    }
  }

  /**
   * Show ``inner`` in the floating lookup panel, anchored beside the pointer.
   *
   * Rendered in a shadow root so the host page's CSS cannot restyle it — a content script's UI
   * is otherwise at the mercy of whatever the page's stylesheet does to divs.
   *
   * @param {string} inner The panel's inner HTML.
   * @param {string} word The word being shown (for the aria label).
   */
  function showPanel(inner, word) {
    removePanel();
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.setAttribute('aria-label', `Omnia lookup: ${word}`);
    // Anchor beside the pointer, then keep the whole panel on screen: flip to the left of the
    // pointer when it would run off the right edge, and lift it when it would run off the bottom.
    const width = 362;
    const height = Math.min(460, Math.round(window.innerHeight * 0.8));
    let left = lastPointer.x + CURSOR_OFFSET;
    let top = lastPointer.y + CURSOR_OFFSET;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, lastPointer.x - width - CURSOR_OFFSET);
    }
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - height - 8);
    }
    Object.assign(host.style, {
      position: 'fixed',
      top: top + 'px',
      left: left + 'px',
      zIndex: '2147483647',
    });
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${PANEL_CSS}</style><div class="omnia-panel">${inner}</div>`;
    root.querySelectorAll('[data-omnia-close]').forEach((el) => {
      el.addEventListener('click', removePanel);
    });
    root.querySelectorAll('[data-omnia-audio]').forEach((el) => {
      el.addEventListener('click', () => playMedia(el, el.dataset.omniaAudio));
    });
    root.querySelectorAll('[data-omnia-image]').forEach((el) => {
      el.addEventListener('click', () => showMedia(el, el.dataset.omniaImage));
    });
    document.body.appendChild(host);
  }

  /** @return {string} The loading state's HTML. */
  function renderLoading(word) {
    return `<div class="hdr"><div class="word">${escapeHtml(word)}</div></div>
      <div class="muted">Searching your collection…</div>`;
  }

  /** @return {string} A titled message (error / unavailable). */
  function renderMessage(title, detail) {
    return `<div class="hdr"><div class="word">${escapeHtml(title)}</div></div>
      <div class="muted">${escapeHtml(detail)}</div>`;
  }

  /**
   * Render the lookup payload: the top card, or a clear "not in your collection" state.
   * @param {!Object} result The payload from the add-on.
   * @param {string} word The looked-up word.
   * @return {string}
   */
  function renderResult(result, word) {
    const cards = (result && result.cards) || [];
    if (!cards.length) {
      return `<div class="hdr"><div class="word">${escapeHtml(word)}</div></div>
        <div class="muted">No card for this word in your collection yet.</div>`;
    }
    const card = cards[0];
    const state = String(card.state || 'new');
    const bits = [];
    if (card.interval_days) bits.push(`${card.interval_days}d interval`);
    if (card.reps) bits.push(`${card.reps} reviews`);
    if (card.lapses) bits.push(`${card.lapses} lapses`);
    if (card.deck) bits.push(String(card.deck).split('::').pop());
    // Media-only fields (Image, Word (audio)) carry no text. Dropping them left the web panel
    // showing strictly less than the desktop one for the SAME note, which is confusing rather
    // than tidy — they become buttons instead.
    const fields = (card.fields || [])
      .filter((f) => f && (f.text || (f.audio || []).length || (f.images || []).length))
      .map((f) => {
        const head = `<div class="fname">${escapeHtml(f.name)}</div>`;
        if (f.text) {
          const body = escapeHtml(f.text).replace(/\n/g, '<br>');
          return `<div class="field">${head}<div class="fval">${body}</div></div>`;
        }
        const buttons = []
          .concat(
            (f.audio || []).map(
              (name) =>
                `<button class="media" data-omnia-audio="${escapeHtml(name)}">▶ Play</button>`
            )
          )
          .concat(
            (f.images || []).map(
              (name) =>
                `<button class="media" data-omnia-image="${escapeHtml(name)}">🖼 Show image</button>`
            )
          )
          .join('');
        return `<div class="field">${head}<div class="fval media-row">${buttons}</div></div>`;
      })
      .join('');
    const more =
      cards.length > 1 ? `<div class="muted">+${cards.length - 1} more note(s)</div>` : '';
    return `<div class="hdr">
        <div class="word">${escapeHtml(card.title || word)}</div>
        <div class="pill" style="background:${STATE_COLORS[state] || STATE_COLORS.review}">
          ${escapeHtml(state)}
        </div>
      </div>
      <div class="muted">${escapeHtml(bits.join('  ·  '))}</div>
      <div class="fields">${fields}</div>${more}`;
  }

  /**
   * Fetch a media file's bytes through the background worker.
   * @param {string} filename The media file name as stored in the collection.
   * @return {!Promise<?Blob>} The bytes, or null when unavailable.
   */
  function fetchMedia(filename) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({type: 'omnia-media', filename: filename}, (response) => {
          if (chrome.runtime.lastError || !response || !response.ok) {
            resolve(null);
            return;
          }
          try {
            const binary = atob(response.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i);
            }
            resolve(new Blob([bytes]));
          } catch (_e) {
            resolve(null);
          }
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  /** Play a note's audio clip in place. */
  async function playMedia(button, filename) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '…';
    const blob = await fetchMedia(filename);
    if (!blob) {
      button.textContent = 'unavailable';
      return;
    }
    const audio = new Audio(URL.createObjectURL(blob));
    // Free the object URL once the clip finishes; a panel left open all day must not leak.
    audio.addEventListener('ended', () => URL.revokeObjectURL(audio.src));
    audio.play().catch(() => {
      button.textContent = 'unavailable';
    });
    button.textContent = original;
    button.disabled = false;
  }

  /** Replace the button with the fetched image. */
  async function showMedia(button, filename) {
    button.disabled = true;
    button.textContent = 'Loading…';
    const blob = await fetchMedia(filename);
    if (!blob) {
      button.textContent = 'unavailable';
      return;
    }
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.className = 'media-img';
    img.addEventListener('load', () => URL.revokeObjectURL(img.src));
    button.replaceWith(img);
  }

  /** Escape text for safe insertion into the panel's HTML. */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
  }

  /** Send the pending capture to the background worker and report the result. */
  function sendCapture() {
    if (!pendingCapture) {
      return;
    }
    const capture = pendingCapture;
    removeTooltip();
    // The extension may have been reloaded since this script was injected — check BEFORE the
    // "Sending…" toast so a dead context shows an actionable message, not a permanent "Sending…".
    if (!extensionAlive()) {
      showToast(RELOAD_MSG, 'error');
      handleContextGone();
      return;
    }
    showToast('Sending to Anki…', 'pending');

    try {
      chrome.runtime.sendMessage({type: 'omnia-capture', payload: capture}, (response) => {
        if (chrome.runtime.lastError) {
          showToast('Extension error: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (!response) {
          showToast('No response from background worker.', 'error');
          return;
        }
        if (response.ok) {
          showToast('Added to Anki: “' + truncateForToast(capture.selection) + '”', 'success');
        } else {
          showToast(response.error || 'Failed to add note.', 'error');
        }
      });
    } catch (_e) {
      // The context died between the check and the call (or sendMessage threw synchronously).
      showToast(RELOAD_MSG, 'error');
      handleContextGone();
    }
  }

  /**
   * Truncate a string for display inside a toast.
   * @param {string} text The text to truncate.
   * @return {string} The truncated text.
   */
  function truncateForToast(text) {
    return text.length > 40 ? text.slice(0, 39) + '…' : text;
  }

  // -------------------------------------------------------------------------
  // Toast (success / error feedback)
  // -------------------------------------------------------------------------

  /**
   * Show a transient toast in the bottom-right corner.
   * @param {string} message The message text.
   * @param {string} kind One of "success" | "error" | "pending".
   */
  function showToast(message, kind) {
    const existing = document.getElementById(TOAST_ID);
    if (existing) {
      existing.remove();
    }
    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.textContent = message;
    const palette = {
      success: {bg: '#1f8a4c', fg: '#ffffff'},
      error: {bg: '#c0392b', fg: '#ffffff'},
      pending: {bg: '#444b54', fg: '#ffffff'},
    };
    const colors = palette[kind] || palette.pending;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '2147483647',
      maxWidth: '320px',
      padding: '10px 14px',
      background: colors.bg,
      color: colors.fg,
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      borderRadius: '6px',
      boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
      lineHeight: '1.4',
    });
    document.body.appendChild(toast);

    // Errors linger longer so the user can read them.
    const ttl = kind === 'error' ? 6000 : kind === 'pending' ? 8000 : 3500;
    setTimeout(() => {
      if (toast.isConnected) {
        toast.remove();
      }
    }, ttl);
  }

  // -------------------------------------------------------------------------
  // Messages from the background worker (context-menu path)
  // -------------------------------------------------------------------------

  /** Background-worker message handler (named so handleContextGone can removeListener it). */
  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message) {
      return false;
    }
    if (message.type === 'omnia-get-context') {
      // The right-click path: report the surrounding text for the current
      // selection so the background worker can build the same capture payload.
      const capture = buildCapture();
      if (!capture) {
        sendResponse({ok: false});
      } else {
        sendResponse({ok: true, context: capture});
      }
      return false;
    }
    if (message.type === 'omnia-toast') {
      // The background worker renders its feedback through our toast UI.
      showToast(message.message, message.kind);
      sendResponse({ok: true});
      return false;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  // Debounce so dragging a selection does not spawn a tooltip on every mousemove.
  let debounceTimer = null;

  /** Selection-change handler: (re)build the capture and show/hide the "+". */
  function onSelectionEvent() {
    // The "+" tooltip is gated by BOTH the master toggle and the mouse toggle.
    if (!enabled || !mouseEnabled) {
      removeTooltip();
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const capture = buildCapture();
      if (capture) {
        showTooltip(capture);
      } else {
        removeTooltip();
      }
    }, 10);
  }

  document.addEventListener(
    'mousedown',
    (event) => {
      lastPointer = {x: event.clientX, y: event.clientY};
    },
    true
  );
  document.addEventListener(
    'mouseup',
    (event) => {
      lastPointer = {x: event.clientX, y: event.clientY};
    },
    true
  );
  document.addEventListener('mouseup', onSelectionEvent, true);
  document.addEventListener('dblclick', onSelectionEvent, true);

  // Dismiss the tooltip on an outside click or Escape. Named (not anonymous) so
  // handleContextGone can removeEventListener them on a re-injection.
  function onOutsideMousedown(event) {
    const tooltip = document.getElementById(TOOLTIP_ID);
    if (tooltip && !tooltip.contains(event.target)) {
      removeTooltip();
    }
    // The panel is a popover: clicking anywhere outside it must close it. event.target is the
    // shadow HOST for a click inside the panel, so a plain identity check is enough.
    const panel = document.getElementById(PANEL_ID);
    if (panel && event.target !== panel && !panel.contains(event.target)) {
      removePanel();
    }
  }
  function onEscapeKeydown(event) {
    if (event.key === 'Escape') {
      removeTooltip();
      removePanel();
    }
  }
  document.addEventListener('mousedown', onOutsideMousedown, true);
  document.addEventListener('keydown', onEscapeKeydown);
  document.addEventListener('scroll', removeTooltip, true);

  // Expose this instance's teardown so a later re-injection (extension reload) can detach us first.
  window.__omniaClipperTeardown = handleContextGone;

  // Seed the enable flags as soon as the script loads.
  refreshFlags();
})();
