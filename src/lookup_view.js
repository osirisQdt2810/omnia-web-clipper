/**
 * @fileoverview Omnia Web Clipper - the lookup panel's view model (pure).
 *
 * No DOM, no chrome.*, no network. This file turns a /lookup payload plus the panel's own
 * interaction state (which note is on screen, what is generating, what came back) into a
 * plain-data model, and that model into the panel's markup. It also folds a /generate answer
 * back into the payload. content.js owns the shadow root, the events and the messaging.
 *
 * The markup is built as a STRING with no handlers attached; content.js binds those by data
 * attribute afterwards, so nothing here can smuggle in an inline `on*` a page's CSP would
 * refuse -- and every branch of it is checkable without a browser.
 *
 * The split exists so the parts that are easy to get wrong -- which note the switcher points
 * at, why a field cannot be regenerated, which fields an answer is allowed to touch, which
 * controls exist at all -- are testable with plain Node (tests/lookup_panel.test.js).
 *
 * Loaded as a content script BEFORE content.js (manifest.json + the re-injection list in
 * background.js), and evaluated as source by the tests. Attaches one global, like shared.js.
 */

(function (root) {
  'use strict';

  // Desktop parity: the switcher's buttons are labelled exactly as
  // omnia_desktop_clipper/ui/lookup_panel.py::_switcher labels them.
  const MAX_SWITCHER_LABEL = 22;

  // Said in ONE place so the button's tooltip, the inert state's explanation and the tests all
  // quote the same sentence. Every one of these names the switch the user has to flip and
  // where it lives -- a reason with no remedy is just a dead end.
  const REGENERATE_OFF_MESSAGE =
    'Regenerating is switched off. Turn on “Regenerate from clippers” in Anki: ' +
    'Tools → Omnia → Smart Notes → Configure → Integrations.';
  const READY_MESSAGE = 'Generate this field with Omnia.';
  const GENERATE_ALL_MESSAGE = 'Generate every field of this note with Omnia.';

  // Why a field cannot be generated, keyed by the state /lookup reports for it. These are
  // shown on a button that is deliberately still THERE: hiding it would answer "why can't I
  // regenerate this?" with silence, which is the question the state is for.
  const FIELD_STATE_MESSAGES = {
    no_rule:
      'Smart Notes has no rule that fills this field. Add one in Anki: ' +
      'Tools → Omnia → Smart Notes → Configure.',
    rule_off:
      'The Smart Notes rule for this field is switched off. Switch it on in Anki: ' +
      'Tools → Omnia → Smart Notes → Configure.',
    not_generatable:
      'Smart Notes does not generate this field — it holds what the clipper captured.',
    blocked: 'Another field has to be generated before this one.',
    unavailable: 'Smart Notes cannot generate this field right now.',
  };
  const UNKNOWN_STATE_MESSAGE = FIELD_STATE_MESSAGES.unavailable;

  // Fallbacks for a per-field /generate status that arrives with an empty message. The
  // server's own message always wins (that IS the feature); these only stop a blank note.
  const STATUS_MESSAGES = {
    skipped: 'Omnia skipped this field.',
    blocked: FIELD_STATE_MESSAGES.blocked,
    error: 'Omnia could not generate this field.',
    no_rule: FIELD_STATE_MESSAGES.no_rule,
    rule_off: FIELD_STATE_MESSAGES.rule_off,
    not_generatable: FIELD_STATE_MESSAGES.not_generatable,
  };

  const GENERATED = 'generated';

  /**
   * Truncate a switcher label the way the desktop panel does.
   * @param {string} text The full label.
   * @param {number=} max Maximum kept length (defaults to the desktop's 22).
   * @return {string} The label, ellipsised when too long.
   */
  function truncateLabel(text, max) {
    const limit = max || MAX_SWITCHER_LABEL;
    const value = String(text == null ? '' : text);
    return value.length <= limit ? value : value.slice(0, limit - 1) + '…';
  }

  /**
   * The button label for one matched note: its title, else its note type, else its id.
   * @param {!Object} card A card from the /lookup payload.
   * @return {string} The (truncated) label.
   */
  function switcherLabel(card) {
    const raw =
      (card && card.title) || (card && card.note_type) || 'note ' + ((card && card.note_id) || '');
    return truncateLabel(raw);
  }

  /**
   * The hover text for one switcher button: which note type, in which deck.
   * @param {!Object} card A card from the /lookup payload.
   * @return {string} The tooltip.
   */
  function switcherTitle(card) {
    const type = (card && card.note_type) || 'note';
    const deck = (card && card.deck) || 'no deck';
    return type + ' — ' + deck;
  }

  /**
   * The audio file names a field references.
   * @param {?Object} field A field from the /lookup payload.
   * @return {!Array<string>} The names (never null).
   */
  function audioOf(field) {
    return (field && Array.isArray(field.audio) ? field.audio : []).slice();
  }

  /**
   * The image file names a field references.
   * @param {?Object} field A field from the /lookup payload.
   * @return {!Array<string>} The names (never null).
   */
  function imagesOf(field) {
    return (field && Array.isArray(field.images) ? field.images : []).slice();
  }

  /**
   * Whether a field holds nothing at all.
   *
   * The add-on says so explicitly (``empty``); the derivation is for a payload from an older
   * add-on, which simply left contentless fields out.
   *
   * @param {?Object} field A field from the /lookup payload.
   * @return {boolean} Whether it has neither text nor media.
   */
  function fieldIsEmpty(field) {
    if (field && typeof field.empty === 'boolean') {
      return field.empty;
    }
    return !((field && field.text) || audioOf(field).length || imagesOf(field).length);
  }

  /**
   * A field's regeneration state, defaulting to "ready" for a payload that carries none.
   * @param {?Object} field A field from the /lookup payload.
   * @return {string} One of ready|no_rule|rule_off|not_generatable|blocked|unavailable.
   */
  function fieldState(field) {
    return field && field.state ? String(field.state) : 'ready';
  }

  /**
   * Whether a field's generate button acts, and what its tooltip says either way.
   *
   * The button is never hidden: a field that cannot be regenerated is exactly the one whose
   * reason the user wants, so the reason rides on the control that would have done it.
   *
   * @param {?Object} field A field from the /lookup payload.
   * @param {boolean} canRegenerate The payload's top-level can_regenerate.
   * @return {{canGenerate: boolean, title: string}} The button's behaviour and tooltip.
   */
  function fieldAction(field, canRegenerate) {
    if (!canRegenerate) {
      return {canGenerate: false, title: REGENERATE_OFF_MESSAGE};
    }
    const state = fieldState(field);
    if (state === 'ready') {
      return {canGenerate: true, title: READY_MESSAGE};
    }
    return {canGenerate: false, title: FIELD_STATE_MESSAGES[state] || UNKNOWN_STATE_MESSAGE};
  }

  /**
   * Whether a spinner belongs on ``name``.
   * @param {(string|boolean|Array<string>|null|undefined)} busy 'all' / true, or field names.
   * @param {string} name The field name.
   * @return {boolean} Whether that field is mid-generation.
   */
  function isBusy(busy, name) {
    if (busy === 'all' || busy === true) {
      return true;
    }
    return Array.isArray(busy) && busy.indexOf(name) !== -1;
  }

  /**
   * The scheduling line under the word: interval, reps, lapses, deck leaf.
   * @param {!Object} card A card from the /lookup payload.
   * @return {string} The joined line ('' when the card carries no scheduling at all).
   */
  function metaLine(card) {
    const bits = [];
    if (card.interval_days) bits.push(card.interval_days + 'd interval');
    if (card.reps) bits.push(card.reps + ' reviews');
    if (card.lapses) bits.push(card.lapses + ' lapses');
    if (card.deck) bits.push(String(card.deck).split('::').pop());
    return bits.join('  ·  ');
  }

  /**
   * Turn a /lookup payload plus the panel's state into everything the renderer needs.
   *
   * @param {?Object} result The /lookup payload.
   * @param {number} index Which matched note to show (out of range falls back to the first).
   * @param {{word: (string|undefined), notes: (!Object<string,string>|undefined),
   *          busy: (string|boolean|Array<string>|null|undefined), error: (string|undefined),
   *          canAdd: (boolean|undefined)}=} options
   *     word: what was looked up (for the not-found state); notes: per-field messages from the
   *     last /generate answer; busy: which fields are generating right now; error: a
   *     panel-wide failure to show; canAdd: whether the not-found state can offer "Add to Anki"
   *     (it needs the capture behind the lookup, which the panel may no longer hold).
   * @return {!Object} The view model.
   */
  function buildPanelModel(result, index, options) {
    const opts = options || {};
    const cards = (result && Array.isArray(result.cards) ? result.cards : []).filter(Boolean);
    const word = opts.word || (result && result.word) || '';
    const canRegenerate = !!(result && result.can_regenerate);
    const notes = opts.notes || {};
    const busy = opts.busy;
    const error = opts.error || '';
    const canAdd = !!opts.canAdd;

    if (!cards.length) {
      return {
        word: word,
        found: false,
        canRegenerate: canRegenerate,
        canAdd: canAdd,
        error: error,
        index: 0,
        noteId: 0,
        title: word,
        state: '',
        meta: '',
        switcher: [],
        fields: [],
        extraNotes: [],
        generateAll: {enabled: false, title: '', busy: false},
      };
    }

    const position = index >= 0 && index < cards.length ? index : 0;
    const card = cards[position];
    const known = {};
    const fields = (card.fields || []).filter(Boolean).map(function (field) {
      const action = fieldAction(field, canRegenerate);
      known[field.name] = true;
      return {
        name: field.name,
        text: field.text || '',
        audio: audioOf(field),
        images: imagesOf(field),
        empty: fieldIsEmpty(field),
        state: fieldState(field),
        canGenerate: action.canGenerate,
        title: action.title,
        note: notes[field.name] || '',
        busy: isBusy(busy, field.name),
      };
    });

    // A note can hold more fields than /lookup shows (it caps the list), so "Generate all" can
    // report on a field that is not on screen. Those messages are surfaced anyway rather than
    // dropped -- the user asked for the whole note and is owed the whole answer.
    const extraNotes = Object.keys(notes)
      .filter(function (name) {
        return !known[name] && notes[name];
      })
      .map(function (name) {
        return {field: name, note: notes[name]};
      });

    return {
      word: word,
      found: true,
      canRegenerate: canRegenerate,
      canAdd: canAdd,
      error: error,
      index: position,
      noteId: card.note_id,
      title: card.title || word,
      state: String(card.state || 'new'),
      meta: metaLine(card),
      // One button per match, never for a single one: a switcher with nothing to switch to is
      // just a second title. The desktop panel makes the same call.
      switcher:
        cards.length > 1
          ? cards.map(function (other, position2) {
              return {
                index: position2,
                label: switcherLabel(other),
                title: switcherTitle(other),
                active: position2 === position,
              };
            })
          : [],
      fields: fields,
      extraNotes: extraNotes,
      generateAll: {
        enabled: canRegenerate,
        title: canRegenerate ? GENERATE_ALL_MESSAGE : REGENERATE_OFF_MESSAGE,
        busy: busy === 'all' || busy === true,
      },
    };
  }

  /**
   * The message to show for one per-field /generate status.
   *
   * The server's own message always wins: it is the only half that knows WHY ("needs
   * Definition"), and surfacing it is the point of the whole status contract.
   *
   * @param {string} status One of generated|skipped|blocked|error|no_rule|rule_off|not_generatable.
   * @param {string=} message The server's message for that field.
   * @return {string} What to show ('' for a successful generation with nothing to say).
   */
  function statusMessage(status, message) {
    const detail = String(message == null ? '' : message).trim();
    if (detail) {
      return detail;
    }
    const key = String(status || '');
    if (key === GENERATED) {
      return '';
    }
    return STATUS_MESSAGES[key] || 'Omnia answered “' + (key || 'unknown') + '” for this field.';
  }

  /**
   * Fold a /generate answer into the lookup payload the panel is already showing.
   *
   * Only the fields the answer NAMES are touched, and only when it names the note on screen:
   * an answer that arrives after the user switched notes must not rewrite the note they are
   * now looking at. Everything else is returned as-is, so the panel re-renders from the same
   * payload rather than re-fetching.
   *
   * @param {?Object} result The /lookup payload currently shown.
   * @param {number} noteId The note the answer is about.
   * @param {?Array<!Object>} results The answer's per-field results.
   * @return {{result: !Object, notes: !Object<string,string>, generated: !Array<string>}}
   *     The updated payload, the per-field messages, and which fields actually changed.
   */
  function applyGenerateResults(result, noteId, results) {
    const list = Array.isArray(results) ? results.filter(Boolean) : [];
    const notes = {};
    const generated = [];
    const updates = {};
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (!entry.field) {
        continue;
      }
      const status = String(entry.status || '');
      if (status === GENERATED) {
        updates[entry.field] = entry;
        generated.push(entry.field);
      } else {
        notes[entry.field] = statusMessage(status, entry.message);
      }
    }

    const cards = (result && Array.isArray(result.cards) ? result.cards : []).slice();
    let position = -1;
    for (let i = 0; i < cards.length; i += 1) {
      if (cards[i] && Number(cards[i].note_id) === Number(noteId)) {
        position = i;
        break;
      }
    }
    if (position === -1 || !generated.length) {
      return {result: result, notes: notes, generated: generated};
    }

    const card = cards[position];
    const nextFields = (card.fields || []).map(function (field) {
      const entry = field && updates[field.name];
      if (!entry) {
        return field;
      }
      const text = typeof entry.text === 'string' ? entry.text : field.text || '';
      const audio = Array.isArray(entry.audio) ? entry.audio.slice() : [];
      const images = Array.isArray(entry.images) ? entry.images.slice() : [];
      return Object.assign({}, field, {
        text: text,
        audio: audio,
        images: images,
        empty: !(text || audio.length || images.length),
        state: 'ready',
      });
    });
    cards[position] = Object.assign({}, card, {fields: nextFields});
    return {
      result: Object.assign({}, result, {cards: cards}),
      notes: notes,
      generated: generated,
    };
  }

  // -- rendering ---------------------------------------------------------------------------
  //
  // A string of markup with NO handlers on it. content.js binds every control afterwards by
  // its data attribute, which is also why each one carries a distinct attribute rather than a
  // class: a class is styling, and styling changes.

  // Card-state pill colours, matching the desktop clipper's panel.
  const STATE_COLORS = {
    new: '#3b82f6',
    learning: '#f59e0b',
    relearning: '#ef4444',
    review: '#22a06b',
  };

  /**
   * Escape text for insertion into the panel's HTML — including into an ATTRIBUTE.
   *
   * Quotes are escaped as well as the markup characters, because field names, deck names and
   * media file names come from the user's own collection and travel in `title` / `data-omnia-*`
   * attributes; a note type with a `"` in a field name would otherwise close the attribute and
   * inject markup into the panel's shadow root.
   *
   * @param {*} text The value to escape.
   * @return {string} The escaped text.
   */
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * The panel's "looking it up" state.
   * @param {string} word The word being looked up.
   * @return {string} The panel's inner HTML.
   */
  function renderLoading(word) {
    return (
      '<div class="hdr"><div class="word">' +
      escapeHtml(word) +
      '</div></div>\n      <div class="muted">Searching your collection…</div>'
    );
  }

  /**
   * A titled message (error / unavailable).
   * @param {string} title The heading.
   * @param {string} detail The explanation.
   * @return {string} The panel's inner HTML.
   */
  function renderMessage(title, detail) {
    return (
      '<div class="hdr"><div class="word">' +
      escapeHtml(title) +
      '</div></div>\n      <div class="muted">' +
      escapeHtml(detail) +
      '</div>'
    );
  }

  /**
   * One field: its name, its generate button, its value, and anything Omnia said about it.
   * @param {!Object} field One entry of the model's `fields`.
   * @return {string} The field card's HTML.
   */
  function renderField(field) {
    // The button is on EVERY field, generatable or not. One that cannot generate keeps its
    // tooltip and its click -- both of which say why -- because "why is this still empty?" is
    // exactly the question an inert control is there to answer.
    const button = field.busy
      ? '<span class="gen" title="Generating…"><span class="spin"></span></span>'
      : '<button class="gen' +
        (field.canGenerate ? '' : ' inert') +
        '" data-omnia-generate="' +
        escapeHtml(field.name) +
        '" title="' +
        escapeHtml(field.title) +
        '" aria-label="Generate ' +
        escapeHtml(field.name) +
        '">⟳</button>';
    const head =
      '<div class="fhead"><div class="fname">' +
      escapeHtml(field.name) +
      '</div>' +
      button +
      '</div>';

    const parts = [];
    if (field.text) {
      parts.push('<div class="fval">' + escapeHtml(field.text).replace(/\n/g, '<br>') + '</div>');
    }
    // Media-only fields (Image, Word (audio)) carry no text. Dropping them left the web panel
    // showing strictly less than the desktop one for the SAME note, which is confusing rather
    // than tidy -- they become buttons instead.
    const media = field.audio
      .map(function (name) {
        return '<button class="media" data-omnia-audio="' + escapeHtml(name) + '">▶ Play</button>';
      })
      .concat(
        field.images.map(function (name) {
          return (
            '<button class="media" data-omnia-image="' +
            escapeHtml(name) +
            '">🖼 Show image</button>'
          );
        })
      )
      .join('');
    if (media) {
      parts.push('<div class="fval media-row">' + media + '</div>');
    }
    if (!parts.length) {
      parts.push('<div class="fval placeholder">— empty —</div>');
    }
    const note = field.note ? '<div class="fnote">' + escapeHtml(field.note) + '</div>' : '';
    return (
      '<div class="field' +
      (field.empty ? ' empty' : '') +
      '">' +
      head +
      parts.join('') +
      note +
      '</div>'
    );
  }

  /**
   * The whole panel: the shown note, or a clear "not in your collection" state.
   * @param {!Object} model The model from {@link buildPanelModel}.
   * @return {string} The panel's inner HTML.
   */
  function renderPanel(model) {
    const error = model.error
      ? '<div class="fnote panel-note">' + escapeHtml(model.error) + '</div>'
      : '';

    if (!model.found) {
      // The obvious next action for a word Anki does not have is to add it -- the same offer
      // the desktop clipper's not-found state makes.
      const add = model.canAdd
        ? '<div class="actions"><button class="action" data-omnia-add="1">' +
          'Add to Anki</button></div>'
        : '';
      return (
        '<div class="hdr"><div class="word">' +
        escapeHtml(model.word) +
        '</div></div>\n      <div class="muted">No card for this word in your collection yet.' +
        '</div>' +
        error +
        add
      );
    }

    // One button per matched note. It replaces the old "+N more note(s)" line, which named a
    // number and then gave you no way to see any of them.
    const switcher = model.switcher.length
      ? '<div class="switcher">' +
        model.switcher
          .map(function (seg) {
            return (
              '<button class="seg' +
              (seg.active ? ' active' : '') +
              '" data-omnia-switch="' +
              seg.index +
              '" title="' +
              escapeHtml(seg.title) +
              '">' +
              escapeHtml(seg.label) +
              '</button>'
            );
          })
          .join('') +
        '</div>'
      : '';
    const generateAll =
      '<button class="genall' +
      (model.generateAll.enabled ? '' : ' inert') +
      '" data-omnia-generate-all="1" title="' +
      escapeHtml(model.generateAll.title) +
      '">' +
      (model.generateAll.busy ? '<span class="spin"></span> Generating…' : '✨ Generate all') +
      '</button>';
    // A "Generate all" answer can name a field this panel does not show (a lookup caps its
    // field list), so those messages get a line of their own rather than being dropped.
    const extras = model.extraNotes
      .map(function (entry) {
        return (
          '<div class="fnote panel-note">' +
          escapeHtml(entry.field) +
          ': ' +
          escapeHtml(entry.note) +
          '</div>'
        );
      })
      .join('');

    return (
      '<div class="hdr">\n        <div class="word">' +
      escapeHtml(model.title) +
      '</div>\n        <div class="pill" style="background:' +
      (STATE_COLORS[model.state] || STATE_COLORS.review) +
      '">' +
      escapeHtml(model.state) +
      '</div>\n      </div>\n      <div class="muted">' +
      escapeHtml(model.meta) +
      '</div>' +
      switcher +
      '<div class="toolbar">' +
      generateAll +
      '</div><div class="fields">' +
      model.fields.map(renderField).join('') +
      '</div>' +
      extras +
      error +
      '<div class="actions"><button class="action" data-omnia-open="' +
      escapeHtml(model.noteId) +
      '">Open in Anki</button></div>'
    );
  }

  root.OmniaLookupView = {
    MAX_SWITCHER_LABEL: MAX_SWITCHER_LABEL,
    REGENERATE_OFF_MESSAGE: REGENERATE_OFF_MESSAGE,
    READY_MESSAGE: READY_MESSAGE,
    GENERATE_ALL_MESSAGE: GENERATE_ALL_MESSAGE,
    FIELD_STATE_MESSAGES: FIELD_STATE_MESSAGES,
    STATUS_MESSAGES: STATUS_MESSAGES,
    STATE_COLORS: STATE_COLORS,
    escapeHtml: escapeHtml,
    renderLoading: renderLoading,
    renderMessage: renderMessage,
    renderField: renderField,
    renderPanel: renderPanel,
    truncateLabel: truncateLabel,
    switcherLabel: switcherLabel,
    switcherTitle: switcherTitle,
    fieldIsEmpty: fieldIsEmpty,
    fieldState: fieldState,
    fieldAction: fieldAction,
    buildPanelModel: buildPanelModel,
    statusMessage: statusMessage,
    applyGenerateResults: applyGenerateResults,
  };
})(typeof self !== 'undefined' ? self : this);
