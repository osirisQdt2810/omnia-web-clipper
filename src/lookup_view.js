/**
 * @fileoverview Omnia Web Clipper - the lookup panel's view model (pure).
 *
 * No DOM, no chrome.*, no network. This file OWNS the panel's interaction state (which note is
 * on screen, what is generating on each of them, what came back) and turns it, plus a /lookup
 * payload, into a plain-data model and then into the panel's markup. It also folds a /generate
 * answer back into the payload. content.js owns the shadow root, the events and the messaging.
 *
 * The markup is built as a STRING with no handlers attached; content.js binds those by data
 * attribute afterwards, so nothing here can smuggle in an inline `on*` a page's CSP would
 * refuse -- and every branch of it is checkable without a browser.
 *
 * The split exists so the parts that are easy to get wrong -- which note the switcher points
 * at, why a field cannot be regenerated, which fields an answer is allowed to touch, which note
 * an answer belongs to, which controls exist at all -- are testable with plain Node
 * (tests/lookup_panel.test.js).
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
    'Tools → Omnia → Smart Notes → Configure → Options → General.';
  // The OTHER way regeneration can be unavailable, and the reason the payload carries a
  // `regenerate_reason` at all: with Smart Notes disabled that checkbox does not exist, so
  // sending the user to look for it is a dead end dressed as a remedy.
  const REGENERATE_UNAVAILABLE_MESSAGE =
    'Regenerating needs Smart Notes. Switch it on in Anki: Tools → Omnia.';

  /**
   * Why regeneration is refused, as a sentence naming something the user can actually do.
   * @param {?Object} result The /lookup payload.
   * @return {string}
   */
  function regenerateRefusal(result) {
    const reason = (result && result.regenerate_reason) || '';
    // An older Omnia sends no reason. "Off" is the safer guess there: it names a real control,
    // and a user who does not find it has still been told the feature is a switch.
    return reason === 'unavailable'
      ? REGENERATE_UNAVAILABLE_MESSAGE
      : REGENERATE_OFF_MESSAGE;
  }
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
   * @param {string} refusal The sentence to show when it is false (see regenerateRefusal).
   * @return {{canGenerate: boolean, title: string}} The button's behaviour and tooltip.
   */
  function fieldAction(field, canRegenerate, refusal) {
    if (!canRegenerate) {
      return {canGenerate: false, title: refusal || REGENERATE_OFF_MESSAGE};
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
   * Which of a payload's cards an index points at.
   *
   * Said in ONE place because two halves ask it: the model (what to draw) and the panel state
   * (which note an answer is about). Two copies of the out-of-range rule would eventually
   * disagree, and then a request would be sent for a note other than the one on screen.
   *
   * @param {!Array<!Object>} cards The matched notes.
   * @param {number} index The requested position.
   * @return {number} The position to use (out of range falls back to the first).
   */
  function cardPosition(cards, index) {
    return index >= 0 && index < cards.length ? index : 0;
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
    const refusal = regenerateRefusal(result);
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

    const position = cardPosition(cards, index);
    const card = cards[position];
    const known = {};
    const fields = (card.fields || []).filter(Boolean).map(function (field) {
      const action = fieldAction(field, canRegenerate, refusal);
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
      // Normalised to 0 rather than passed through: a payload without one would otherwise ship
      // an "Open in Anki" carrying `undefined`, which reaches Anki as a search for `nid:NaN`.
      noteId: card.note_id || 0,
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
        title: canRegenerate ? GENERATE_ALL_MESSAGE : refusal,
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

  // -- the panel's own state -----------------------------------------------------------------

  /**
   * The key a note is filed under. Object keys are strings, so a note id has to be one too --
   * otherwise 11 and '11' would be two different notes.
   * @param {(number|string)} noteId The note id.
   * @return {string} Its key.
   */
  function noteKey(noteId) {
    return String(noteId);
  }

  /**
   * What is generating for each note, and what Omnia last said about each one.
   *
   * Keyed by NOTE ID, exactly like the desktop clipper's ``RegenerationState``
   * (omnia_desktop_clipper/lookup/regeneration.py). A lookup can match several notes, the user
   * can step between them with the switcher while one is generating, and an answer that arrives
   * then belongs to the note it NAMED -- not to whatever happens to be on screen.
   *
   * One `busy` marker and one `notes` map for "the panel" got both halves of that wrong.
   * Switching notes cleared the in-flight marker, so a second request could go out while the
   * first was still running and the same generation was paid for twice; and the first note's
   * per-field reasons ("needs Definition") were printed under the second note's fields.
   */
  class RegenerationState {
    constructor() {
      /** @private {!Object<string, {all: boolean, fields: !Object<string, boolean>}>} */
      this._running = {};
      /** @private {!Object<string, !Object<string, string>>} */
      this._messages = {};
      /** @private {!Object<string, string>} */
      this._errors = {};
    }

    /**
     * Whether a regenerate request may start for this note.
     *
     * Per NOTE, not per panel: two different notes may generate at the same time (separate
     * requests against separate notes, and the panel can only be made to send them by switching
     * between the two). What may not happen is a second run of the same field of the same note
     * -- that pays for one generation twice. A whole-note run waits for everything that note
     * already has out, which is what a spinning "Generate all" means.
     *
     * @param {(number|string)} noteId The note the request is about.
     * @param {?Array<string>} fields The fields it asks for, or null for the whole note.
     * @return {boolean} Whether it may be sent.
     */
    canStart(noteId, fields) {
      const run = this._running[noteKey(noteId)];
      if (!run) {
        return true;
      }
      if (run.all) {
        return false;
      }
      const names = fields || [];
      if (!names.length) {
        return !Object.keys(run.fields).length;
      }
      return names.every(function (name) {
        return !run.fields[name];
      });
    }

    /**
     * Mark a request as running.
     *
     * Whatever Omnia said about those fields goes with it: the question is being asked again,
     * and leaving "needs Definition" under a spinner claims an answer that no longer applies.
     *
     * @param {(number|string)} noteId The note the request is about.
     * @param {?Array<string>} fields The fields it asks for, or null for the whole note.
     */
    start(noteId, fields) {
      const id = noteKey(noteId);
      const run = this._running[id] || (this._running[id] = {all: false, fields: {}});
      const names = fields || [];
      if (!names.length) {
        run.all = true;
        this._messages[id] = {};
      } else {
        const messages = this._messagesFor(noteId);
        names.forEach(function (name) {
          run.fields[name] = true;
          delete messages[name];
        });
      }
      delete this._errors[id];
    }

    /**
     * Record an answer and stop the spinners it settles.
     *
     * @param {(number|string)} noteId The note the answer is about.
     * @param {?Array<string>} fields The fields that were asked for (null = the whole note).
     * @param {?Object<string, string>} notes The per-field messages the answer carried.
     */
    settle(noteId, fields, notes) {
      const messages = this._messagesFor(noteId);
      const carried = notes || {};
      Object.keys(carried).forEach(function (name) {
        messages[name] = carried[name];
      });
      this._stop(noteId, fields);
    }

    /**
     * Record that a request never ran, where the user is looking for the reason.
     *
     * On the fields it asked for, or on the panel when it asked for the whole note -- the same
     * split the panel makes when it draws them.
     *
     * @param {(number|string)} noteId The note the request was about.
     * @param {?Array<string>} fields The fields it asked for (null = the whole note).
     * @param {string} message What went wrong.
     */
    fail(noteId, fields, message) {
      const names = fields || [];
      if (names.length) {
        const messages = this._messagesFor(noteId);
        names.forEach(function (name) {
          messages[name] = message;
        });
      } else {
        this._errors[noteKey(noteId)] = message;
      }
      this._stop(noteId, fields);
    }

    /**
     * Say something about one field of one note -- an inert button explaining itself.
     * @param {(number|string)} noteId The note.
     * @param {string} name The field.
     * @param {string} message What to show under it.
     */
    setMessage(noteId, name, message) {
      this._messagesFor(noteId)[name] = message;
    }

    /**
     * Say something about a note as a whole -- an inert "Generate all" explaining itself.
     * @param {(number|string)} noteId The note.
     * @param {string} message What to show on the panel.
     */
    setError(noteId, message) {
      this._errors[noteKey(noteId)] = message;
    }

    /**
     * What {@link buildPanelModel}'s `busy` option should be for this note.
     * @param {(number|string)} noteId The note.
     * @return {(string|!Array<string>)} 'all' for a whole-note run, else the running fields.
     */
    busy(noteId) {
      const run = this._running[noteKey(noteId)];
      if (!run) {
        return [];
      }
      return run.all ? 'all' : Object.keys(run.fields);
    }

    /**
     * The per-field messages for this note.
     * @param {(number|string)} noteId The note.
     * @return {!Object<string, string>} A copy -- the model is a reader, not an owner.
     */
    messages(noteId) {
      return Object.assign({}, this._messages[noteKey(noteId)]);
    }

    /**
     * The panel-wide message for this note.
     * @param {(number|string)} noteId The note.
     * @return {string} The message, or '' when it has none.
     */
    error(noteId) {
      return this._errors[noteKey(noteId)] || '';
    }

    /**
     * The message map for a note, created on demand.
     * @param {(number|string)} noteId The note.
     * @return {!Object<string, string>} The live map.
     * @private
     */
    _messagesFor(noteId) {
      const id = noteKey(noteId);
      if (!this._messages[id]) {
        this._messages[id] = {};
      }
      return this._messages[id];
    }

    /**
     * Drop the running marks a settled request held.
     *
     * A whole-note request asked for everything, so it settles everything that note has out --
     * that is what stops the third field of a "Generate all" spinning when the answer named
     * only two. A single-field request settles only itself, so one answer can never stop a
     * spinner over a field a different request is still generating.
     *
     * @param {(number|string)} noteId The note.
     * @param {?Array<string>} fields The fields the request asked for (null = the whole note).
     * @private
     */
    _stop(noteId, fields) {
      const id = noteKey(noteId);
      const run = this._running[id];
      if (!run) {
        return;
      }
      const names = fields || [];
      if (!names.length) {
        delete this._running[id];
        return;
      }
      names.forEach(function (name) {
        delete run.fields[name];
      });
      if (!run.all && !Object.keys(run.fields).length) {
        delete this._running[id];
      }
    }
  }

  /**
   * What the open lookup panel is showing: the answer in hand, which of its notes is on screen,
   * and -- through {@link RegenerationState} -- what each of those notes is generating.
   *
   * content.js used to hold this as a plain object it mutated in place, and a note switch
   * rewrote that object rather than replacing it. An in-flight request could therefore not tell
   * "the panel moved on" from "nothing changed", because the object it captured was the same
   * one either way. The rule here is that switching notes changes ONE number and nothing else,
   * and that everything an answer touches is filed under the note the answer names.
   */
  class PanelState {
    /**
     * @param {string} word The word that was looked up.
     * @param {?Object} result The /lookup payload.
     * @param {?Object=} capture The capture behind the lookup ("Add to Anki" needs it).
     */
    constructor(word, result, capture) {
      this.word = String(word == null ? '' : word);
      this.result = result;
      this.capture = capture || null;
      this.regeneration = new RegenerationState();
      /** @private {number} */
      this._index = 0;
    }

    /**
     * The matched notes the answer holds.
     * @return {!Array<!Object>} The cards (never null; nothing falsy in it).
     */
    cards() {
      return (this.result && Array.isArray(this.result.cards) ? this.result.cards : []).filter(
        Boolean
      );
    }

    /** @return {number} Which match is on screen, clamped exactly as the model clamps it. */
    get index() {
      return cardPosition(this.cards(), this._index);
    }

    /** @return {number} The id of the note on screen (0 when the answer holds no notes). */
    noteId() {
      const card = this.cards()[this.index];
      return (card && card.note_id) || 0;
    }

    /**
     * Show another matched note.
     *
     * Moves the index and NOTHING else: what note 1 is generating, and what Omnia said about
     * it, belong to note 1 and have to survive being looked away from.
     *
     * @param {number} index Which of the matched notes to show.
     * @return {boolean} Whether the panel moved (a redraw is only needed when it did).
     */
    showNote(index) {
      if (!(index >= 0 && index < this.cards().length) || index === this.index) {
        return false;
      }
      this._index = index;
      return true;
    }

    /** @return {!Object} The view model for the note on screen. */
    model() {
      const noteId = this.noteId();
      return buildPanelModel(this.result, this._index, {
        word: this.word,
        notes: this.regeneration.messages(noteId),
        busy: this.regeneration.busy(noteId),
        error: this.regeneration.error(noteId),
        canAdd: !!this.capture,
      });
    }

    /**
     * Fold a /generate answer into the payload and record what it said.
     *
     * @param {(number|string)} noteId The note the answer is about -- not necessarily the one
     *     on screen, because the user may have switched while it was in flight.
     * @param {?Array<string>} fields The fields that were asked for (null = the whole note).
     * @param {?Array<!Object>} results The answer's per-field results.
     */
    applyAnswer(noteId, fields, results) {
      const applied = applyGenerateResults(this.result, noteId, results);
      this.result = applied.result;
      this.regeneration.settle(noteId, fields, applied.notes);
    }

    /**
     * Adopt a fresher answer for the same word, keeping the reader where they are.
     *
     * Used when a /generate answer is LOST: the generation carries on inside Anki regardless, so
     * asking again is the only way to show what the note actually holds. The note on screen is
     * found again BY ID, because a fresh lookup may order its matches differently or no longer
     * hold that note at all.
     *
     * @param {?Object} result The newer /lookup payload.
     */
    adoptResult(result) {
      const shown = this.noteId();
      this.result = result;
      const cards = this.cards();
      let position = 0;
      for (let i = 0; i < cards.length; i += 1) {
        if (Number(cards[i].note_id) === Number(shown)) {
          position = i;
          break;
        }
      }
      this._index = position;
    }
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

    // Only for a note that HAS an id. "Open in Anki" reveals it by `nid:<id>`, so without one
    // the button can only ask Anki for `nid:NaN` -- a control that is guaranteed to fail is
    // worse than an absent one, because failing is all it teaches.
    const open = model.noteId
      ? '<div class="actions"><button class="action" data-omnia-open="' +
        escapeHtml(model.noteId) +
        '">Open in Anki</button></div>'
      : '';

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
      open
    );
  }

  root.OmniaLookupView = {
    MAX_SWITCHER_LABEL: MAX_SWITCHER_LABEL,
    REGENERATE_OFF_MESSAGE: REGENERATE_OFF_MESSAGE,
    READY_MESSAGE: READY_MESSAGE,
    GENERATE_ALL_MESSAGE: GENERATE_ALL_MESSAGE,
    REGENERATE_UNAVAILABLE_MESSAGE: REGENERATE_UNAVAILABLE_MESSAGE,
    regenerateRefusal: regenerateRefusal,
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
    RegenerationState: RegenerationState,
    PanelState: PanelState,
  };
})(typeof self !== 'undefined' ? self : this);
