/**
 * @fileoverview Omnia Web Clipper - shared settings + AnkiConnect client.
 *
 * Loaded by both the service worker (via importScripts) and the options/popup
 * pages (via <script>). It must NOT touch the DOM. Everything is attached to a
 * single global `OmniaClipper` so the two load styles work the same way.
 */

(function (root) {
  'use strict';

  // Default settings. The field mapping maps a CAPTURE KEY to an Anki note FIELD
  // NAME. The defaults assume an Omnia-friendly note type with these fields; the
  // user can remap any of them on the options page. A blank target means "do not
  // send this capture key".
  const DEFAULTS = {
    ankiConnectUrl: 'http://127.0.0.1:8765',
    // Where the Omnia add-on's "Word Lookup" service listens. Its own loopback port, separate
    // from AnkiConnect, and reached from the background worker (see background.js lookupWord).
    lookupUrl: 'http://127.0.0.1:8766',
    lookupEnabled: true, // Show the magnifier next to the "+".
    apiKey: '', // AnkiConnect "apiKey" option; empty when AnkiConnect apiKey is null.
    enabled: true, // Master on/off. When false, no "+" and no context-menu action.
    mouseEnabled: true, // Double-click "+" tooltip on/off (the right-click menu is unaffected).
    autogen: true, // Caller guard: tag clipped notes "omnia-autogen" so Omnia can auto-generate.
    deckName: 'Omnia Capture',
    modelName: 'Basic',
    allowDuplicate: true,
    tags: ['omnia-web-clipper'],
    // capture key -> Anki note field name
    fieldMap: {
      selection: 'Front', // the base field (the word OR phrase Omnia generates from)
      sentence: '', // e.g. "Sentence" or "Context"
      context: '', // e.g. "Context"
      context_full: '', // sentence + context combined — map to ONE "Context" field (recommended)
      url: '', // e.g. "Source"
      pageTitle: '', // e.g. "Title"
    },
  };

  // The settings that live in chrome.storage.LOCAL rather than chrome.storage.sync.
  //
  // EMPTY, and correctly so: every setting the clipper has is a preference the user would want
  // on their other machines, and sync is exactly right for all of them. The list existed for the
  // lookup token — a machine-local credential that syncing would have replicated to profiles
  // where it could not work — and that is gone.
  //
  // Kept rather than deleted because the RULE is what matters, and it is not obvious: anything
  // issued by this machine's copy of Omnia, or true only of this machine, belongs here and not
  // in sync. Adding a key here routes it to local in both directions and is the whole of it --
  // there is no migration helper standing by, because a key that has never been synced does not
  // need moving. One that HAS been (the token was) needs a one-time removal instead, of the
  // shape background.js::forgetTheToken uses.
  const LOCAL_KEYS = [];

  /**
   * Whether a settings key belongs in chrome.storage.local.
   * @param {string} key The settings key.
   * @return {boolean} True when it is machine-local.
   */
  function isLocalKey(key) {
    return LOCAL_KEYS.indexOf(key) !== -1;
  }

  /** @return {!Object} The DEFAULTS for the locally-stored keys only. */
  function localDefaults() {
    const defaults = {};
    LOCAL_KEYS.forEach((key) => {
      defaults[key] = DEFAULTS[key];
    });
    return defaults;
  }

  /**
   * Read settings from both stores, merged over DEFAULTS.
   * @return {!Promise<!Object>} The merged settings object.
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        chrome.storage.local.get(localDefaults(), (local) => {
          // Deep-merge fieldMap so a partial stored map keeps default keys.
          const merged = Object.assign({}, DEFAULTS, stored);
          merged.fieldMap = Object.assign({}, DEFAULTS.fieldMap, stored.fieldMap || {});
          LOCAL_KEYS.forEach((key) => {
            merged[key] = local[key] === undefined ? DEFAULTS[key] : local[key];
          });
          resolve(merged);
        });
      });
    });
  }

  /**
   * Persist a (possibly partial) settings object, each key to the store it belongs in.
   * @param {!Object} settings The settings to store.
   * @return {!Promise<void>} Resolves once both writes complete.
   */
  function saveSettings(settings) {
    const synced = {};
    const local = {};
    Object.keys(settings).forEach((key) => {
      if (isLocalKey(key)) {
        local[key] = settings[key];
      } else {
        synced[key] = settings[key];
      }
    });
    return Promise.all([
      writeArea(chrome.storage.sync, synced),
      writeArea(chrome.storage.local, local),
    ]).then(() => undefined);
  }

  /**
   * Write a patch to one storage area, skipping the call when there is nothing to write.
   * @param {!Object} area The chrome.storage area.
   * @param {!Object} values The keys to write.
   * @return {!Promise<void>} Resolves once the write completes.
   */
  function writeArea(area, values) {
    return new Promise((resolve) => {
      if (!Object.keys(values).length) {
        resolve();
        return;
      }
      area.set(values, () => resolve());
    });
  }

  /**
   * Low-level AnkiConnect call. Returns the `result` field or throws an Error
   * carrying AnkiConnect's `error` string or a transport/CORS explanation.
   * @param {string} url The AnkiConnect endpoint URL.
   * @param {string} action The AnkiConnect action name.
   * @param {?Object=} params The action params (defaults to {}).
   * @param {string=} apiKey Optional AnkiConnect API key.
   * @return {!Promise<*>} The AnkiConnect `result` value.
   */
  async function ankiConnect(url, action, params, apiKey) {
    const body = {action: action, version: 6, params: params || {}};
    if (apiKey) {
      body.key = apiKey;
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A failed fetch here is almost always one of: Anki not running, the
      // AnkiConnect add-on not installed, or a CORS rejection (the extension's
      // origin is not in webCorsOriginList).
      throw new Error(
        'Could not reach AnkiConnect at ' +
          url +
          '. Make sure Anki is running with the AnkiConnect add-on, and that this ' +
          "extension's origin is allowed in AnkiConnect's webCorsOriginList " +
          '(see the README). Underlying error: ' +
          (err && err.message ? err.message : String(err)),
      );
    }

    if (!response.ok) {
      throw new Error('AnkiConnect HTTP ' + response.status + ' ' + response.statusText);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error('AnkiConnect returned a non-JSON response.');
    }

    // AnkiConnect v6 always returns {result, error}; error is non-null on failure.
    if (data && data.error) {
      throw new Error(data.error);
    }
    return data ? data.result : undefined;
  }

  // -- Omnia lookup service (the add-on's own loopback port, NOT AnkiConnect) ---------------
  //
  // Both calls happen in the SERVICE WORKER. The write one has to: the add-on refuses any
  // /generate request that carries an `Origin` header, because a request a web page could have
  // initiated must never be able to spend the user's LLM credits. See README.

  // Which clipper is asking. The add-on keys its per-clipper integration settings on this, so
  // every request carries it -- the web and desktop clippers can be configured separately.
  const LOOKUP_CLIENT = 'web_clipper';
  const GENERATE_PATH = '/generate';
  const LOOKUP_PATH = '/lookup';
  const CHECK_PATH = '/check';
  const SAVE_PATH = '/check/save';

  const LOOKUP_UNREACHABLE =
    "Can't reach Anki's lookup service. Make sure Anki is running with Omnia's " +
    '“Word Lookup” feature switched on.';

  /**
   * What actually went wrong looking a word up.
   *
   * Every failure used to come back as LOOKUP_UNREACHABLE, which is a sentence about ONE cause
   * and was printed for all of them. A service address typed into the wrong box on the options
   * page, a stale port, an answer that is not JSON — each told the user to go and check that
   * Word Lookup was switched on, and it already was. "Could not reach it" is only true when
   * nothing answered, and `fetch` says so by rejecting with a TypeError; anything else got an
   * answer and has something more useful to report.
   *
   * @param {*} err Whatever the lookup threw.
   * @param {string} baseUrl The address it tried, so the message can name it.
   * @return {string} A sentence naming what to do about it.
   */
  function lookupErrorMessage(err, baseUrl) {
    const url = normaliseBase(baseUrl);
    if (!/^https?:\/\//i.test(url)) {
      return (
        'The lookup service address is not a URL: “' + url + '”. Open this extension\'s ' +
        'options and check the Lookup service box — it should read http://127.0.0.1:8766.'
      );
    }
    if (err && err.name === 'AbortError') {
      return 'The lookup took too long. Anki may be busy — try again in a moment.';
    }
    // By NAME rather than `instanceof`: this module is loaded into its own realm by the tests
    // (and a service worker is a realm of its own too), where `TypeError` is a different
    // constructor and `instanceof` is quietly false for a genuine TypeError.
    if (err && err.name === 'TypeError') {
      // fetch rejects with a TypeError when nothing answered at all: wrong port, Anki closed,
      // the feature switched off. This is the one case the original sentence was written for.
      return LOOKUP_UNREACHABLE + ' It is being asked at ' + url + '.';
    }
    return (err && err.message ? err.message : String(err)) +
      ' (asked at ' + url + ')';
  }

  // How long one /generate may take. The same budget the desktop clipper gives it
  // (omnia_desktop_clipper/lookup/generate.py::_TIMEOUT_SECONDS) and generous on purpose: an
  // LLM field plus a TTS clip regularly takes half a minute, and a whole note asks for several
  // in one request. Being too patient costs a spinner; being too eager fails every request
  // while Omnia happily finishes the work. What is NOT acceptable is no limit at all — a fetch
  // nobody ever settles holds the service worker awake and the panel spinning for ever.
  const GENERATE_TIMEOUT_MS = 300000;
  const GENERATE_TIMED_OUT =
    'Omnia did not finish this request within 5 minutes. It may still be generating — look ' +
    'the word up again to see what the note holds.';

  /**
   * Strip a trailing slash so a base URL concatenates cleanly.
   * @param {string} baseUrl The configured service URL.
   * @return {string} The normalised base.
   */
  function normaliseBase(baseUrl) {
    return String(baseUrl || '').replace(/\/+$/, '');
  }

  /**
   * The URL for one word lookup.
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @param {string} word The word to look up.
   * @return {string} The full GET URL.
   */
  function buildLookupUrl(baseUrl, word) {
    return (
      normaliseBase(baseUrl) +
      LOOKUP_PATH +
      '?word=' +
      encodeURIComponent(word) +
      '&client=' +
      encodeURIComponent(LOOKUP_CLIENT)
    );
  }

  /**
   * The URL of the regeneration endpoint.
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @return {string} The full POST URL.
   */
  function buildGenerateUrl(baseUrl) {
    return normaliseBase(baseUrl) + GENERATE_PATH;
  }

  /**
   * The URL of the phrase-correction endpoint.
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @return {string} The full POST URL.
   */
  function buildCheckUrl(baseUrl) {
    return normaliseBase(baseUrl) + CHECK_PATH;
  }

  /**
   * The URL for saving a correction as a note.
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @return {string} The full POST URL.
   */
  function buildSaveUrl(baseUrl) {
    return normaliseBase(baseUrl) + SAVE_PATH;
  }

  // How long one save may take. Short, and nothing like the check's budget: this asks Anki to
  // write a note, which is fast, and the only slow part is waiting for a busy main thread —
  // which Omnia itself gives up on and answers, so waiting longer here buys nothing.
  const SAVE_TIMEOUT_MS = 20000;
  const SAVE_TIMED_OUT =
    'Anki did not answer within 20 seconds. The correction may not have been saved — ' +
    'check the deck before saving it again.';

  /**
   * Turn a /check/save HTTP failure into a sentence naming the remedy.
   *
   * 503 is the interesting one and it means two different things: Phrase Check is off, or Anki
   * was too busy to write. Omnia sends its own sentence for both, which is why the body wins
   * here — the difference matters and only Omnia knows which happened.
   *
   * @param {number} status The HTTP status.
   * @param {?Object=} payload The parsed error body, when there was one.
   * @return {string} What went wrong and what to do about it.
   */
  function saveErrorMessage(status, payload) {
    const detail = payload && payload.error ? String(payload.error).trim() : '';
    const fallbacks = {
      400: 'Omnia could not read the save request (400).',
      403:
        'Omnia refused the request (403) because it did not come from this extension’s ' +
        'background worker.',
      // An Omnia that has Phrase Check but predates saving. Not a setting — an update.
      404: 'The Omnia add-on in Anki cannot save corrections yet.',
      500: 'Omnia could not save that correction.',
      502: 'Omnia could not save that correction.',
      503: 'Phrase Check is switched off, or Anki is busy.',
    };
    const remedies = {
      400: 'This is a bug in the clipper — please report it.',
      403: 'Reload the extension (or the page) and try again.',
      404: 'Update it (Tools → Add-ons → Check for Updates), then try again.',
    };
    const said = detail || fallbacks[status] || 'Omnia answered ' + status + '.';
    const remedy = remedies[status] || '';
    if (!remedy || said.indexOf(remedy) !== -1) {
      return said;
    }
    return (/[.!?…]$/.test(said) ? said : said + '.') + ' ' + remedy;
  }

  /**
   * Ask Omnia to keep a correction as a note.
   *
   * From the SERVICE WORKER, like the check and for a stronger reason: this one writes to the
   * user's collection, and the add-on refuses anything a web page could have started.
   *
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @param {string} text The phrase, as it was checked.
   * @param {string=} mode The register it was checked in, so the card records the right one.
   * @return {!Promise<!Object>} `{note_id, deck, note_type, renamed, summary}`.
   */
  async function requestSave(baseUrl, text, mode) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    try {
      return await sendSave(
        buildSaveUrl(baseUrl),
        {text: String(text || ''), mode: String(mode || '')},
        controller.signal
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST one /check/save request and read its answer.
   * @param {string} url The /check/save URL.
   * @param {!Object} body The request body (serialised here).
   * @param {!AbortSignal} signal The timeout's signal.
   * @return {!Promise<!Object>} The parsed answer.
   */
  async function sendSave(url, body, signal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: signal,
      });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? SAVE_TIMED_OUT : LOOKUP_UNREACHABLE);
    }
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_e) {
        payload = null;
      }
      throw new Error(saveErrorMessage(response.status, payload));
    }
    try {
      return await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(SAVE_TIMED_OUT);
      }
      throw new Error('Omnia returned a non-JSON answer to the save request.');
    }
  }

  // How long one /check may take. Much shorter than /generate's five minutes, and deliberately:
  // this is ONE model call on a phrase the user has selected and is watching a spinner for,
  // where /generate is several calls filling a whole note and may reasonably be left running.
  // A minute and a half is past the point where anything is coming back, and waiting longer
  // just leaves the panel lying about being busy.
  const CHECK_TIMEOUT_MS = 90000;
  const CHECK_TIMED_OUT =
    'Omnia did not finish checking that phrase within 90 seconds. The model may be slow or ' +
    'unreachable — try again, or pick a shorter phrase.';

  /**
   * Turn a /check HTTP failure into a sentence naming the remedy.
   *
   * The two that matter are told apart on purpose. 503 means Phrase Check is switched OFF —
   * answered by a toggle in Anki. 502 means it ran and failed, and the add-on puts the
   * provider's own words in the body, which is the difference between "check your key" and
   * "you are out of credit". Flattening those into one sentence sends the user hunting through
   * settings for a problem that was never there.
   *
   * @param {number} status The HTTP status.
   * @param {?Object=} payload The parsed error body ({error: "..."}), when there was one.
   * @return {string} What went wrong and what to do about it.
   */
  function checkErrorMessage(status, payload) {
    const detail = payload && payload.error ? String(payload.error).trim() : '';
    // What went wrong, when the add-on did not say. Omnia's own sentence is preferred whenever
    // there is one: it is the accurate half, and for 502 it carries the provider's words.
    const fallbacks = {
      400: 'Omnia could not read the correction request (400).',
      403:
        'Omnia refused the request (403) because it did not come from this extension’s ' +
        'background worker.',
      // An Omnia that predates Phrase Check has no such endpoint, and sends no body to explain
      // it. Not a setting — an update.
      404: 'The Omnia running in Anki does not have Phrase Check.',
      502: 'Omnia could not check that phrase.',
      503: 'Phrase Check is switched off.',
    };
    // Where to go, which is what this side knows and the add-on does not. APPENDED rather than
    // substituted: Omnia's 503 already says "turn it on", so a message that also said it would
    // be the same instruction twice in different words, which reads as a bug.
    const remedies = {
      400: 'This is a bug in the clipper — please report it.',
      403: 'Reload the extension (or the page) and try again.',
      404: 'Update the add-on (Tools → Add-ons → Check for Updates), then try again.',
      503: 'You will find it in Anki under Tools → Omnia.',
    };
    const said = detail || fallbacks[status] || 'Omnia answered ' + status + '.';
    const remedy = remedies[status] || '';
    if (!remedy || said.indexOf(remedy) !== -1) {
      return said;
    }
    // Omnia's sentences do not always end in one, and two run together without a full stop read
    // as a single mangled thought.
    return (/[.!?…]$/.test(said) ? said : said + '.') + ' ' + remedy;
  }

  /**
   * Ask Omnia to correct a phrase. Returns the parsed correction or throws an
   * already-actionable Error.
   *
   * Made from the SERVICE WORKER, like /generate and for the same reason: the add-on refuses
   * anything a web page could have initiated, because this side effect spends the user's LLM
   * credits and a page must never be able to spend them.
   *
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @param {string} text The selected phrase.
   * @param {string=} mode 'written' or 'spoken'. Empty means "whatever Omnia is set to" — the
   *     configured default lives in the add-on, and guessing here would override a setting.
   * @param {boolean=} refresh True to ignore the remembered answer and ask again.
   * @return {!Promise<!Object>} `{original, rewritten, mode, fixes, highlight, …}`.
   */
  async function requestCheck(baseUrl, text, mode, refresh) {
    const body = {
      text: String(text || ''),
      mode: String(mode || ''),
      refresh: Boolean(refresh),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      return await sendCheck(buildCheckUrl(baseUrl), body, controller.signal);
    } finally {
      // Covers the body read as well as the fetch, so nothing leaves a timer armed behind a
      // request that already finished.
      clearTimeout(timer);
    }
  }

  /**
   * POST one /check request and read its answer.
   *
   * Split out of {@link requestCheck} so the timeout is set up and torn down in exactly one
   * place, whichever way this half exits.
   *
   * @param {string} url The /check URL.
   * @param {!Object} body The request body (serialised here).
   * @param {!AbortSignal} signal The timeout's signal.
   * @return {!Promise<!Object>} The parsed correction.
   */
  async function sendCheck(url, body, signal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: signal,
      });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? CHECK_TIMED_OUT : LOOKUP_UNREACHABLE);
    }

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_e) {
        payload = null; // an error body is a courtesy, not a guarantee
      }
      throw new Error(checkErrorMessage(response.status, payload));
    }

    try {
      return await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(CHECK_TIMED_OUT);
      }
      throw new Error('Omnia returned a non-JSON answer to the correction request.');
    }
  }

  /**
   * Turn a /generate HTTP failure into a sentence naming the remedy.
   *
   * A status code on its own is not actionable, and these two in particular have a specific
   * fix that lives somewhere the user would never think to look: 409 means one checkbox in
   * Anki, 503 means the Smart Notes plugin is off.
   *
   * The 403 is the odd one out: the add-on allows EVERY ``chrome-extension://`` origin, by
   * scheme and deliberately (an id differs between an unpacked load and a Web Store install).
   * So a 403 arriving here does not mean "this extension is not on a list" — it means the
   * request was not the one the service worker makes, which is not something a setting fixes.
   *
   * @param {number} status The HTTP status.
   * @param {?Object=} payload The parsed error body ({error: "..."}), when there was one.
   * @return {string} What went wrong and what to do about it.
   */
  function generateErrorMessage(status, payload) {
    const detail = payload && payload.error ? String(payload.error).trim() : '';
    const messages = {
      400:
        'Omnia could not read the request (400). This is a bug in the clipper — ' +
        'please report it.',
      401:
        'Omnia asked this request to authenticate (401), which this clipper no longer does and ' +
        'current versions no longer ask for. The Omnia running in Anki is older than this ' +
        'extension — update the add-on (Tools → Add-ons → Check for Updates).',
      403:
        'Omnia refused the request (403) because it did not come from this extension’s ' +
        'background worker — the add-on accepts /generate only from an extension, never from ' +
        'a web page. Reload the extension (or the page) and try again; if it keeps happening, ' +
        'regenerate from Anki itself and report it.',
      409:
        'Regenerating is switched off. Turn on “Regenerate from clippers” in Anki ' +
        '(Tools → Omnia → Smart Notes → Configure → Options → General) and try again.',
      503:
        'Smart Notes is not available right now. Enable the Smart Notes plugin in Anki ' +
        '(Tools → Omnia) and make sure Anki is not busy, then try again.',
    };
    const base = messages[status] || 'Omnia answered ' + status + '.';
    return detail && detail !== base ? base + ' (' + detail + ')' : base;
  }

  /**
   * Ask Omnia to regenerate fields of a note. Returns the parsed answer or throws an
   * already-actionable Error.
   *
   * @param {string} baseUrl Where the add-on's lookup service listens.
   * @param {number} noteId The note to regenerate.
   * @param {?Array<string>=} fields Which fields, or null/undefined for every field.
   * @return {!Promise<!Object>} `{note_id, results: [{field, status, message, ...}]}`.
   */
  async function requestGenerate(baseUrl, noteId, fields) {
    const body = {
      client: LOOKUP_CLIENT,
      note_id: Number(noteId),
      fields: Array.isArray(fields) && fields.length ? fields : null,
    };
    const headers = {'Content-Type': 'application/json'};

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    try {
      return await sendGenerate(buildGenerateUrl(baseUrl), headers, body, controller.signal);
    } finally {
      // Covers the body read as well as the fetch, so nothing can leave a five-minute timer
      // armed behind a request that already finished.
      clearTimeout(timer);
    }
  }

  /**
   * POST one /generate request and read its answer.
   *
   * Split out of {@link requestGenerate} so the timeout is set up and torn down in exactly one
   * place, whichever way this half exits.
   *
   * @param {string} url The /generate URL.
   * @param {!Object<string, string>} headers The request headers.
   * @param {!Object} body The request body (serialised here).
   * @param {!AbortSignal} signal The timeout's signal.
   * @return {!Promise<!Object>} The parsed answer.
   */
  async function sendGenerate(url, headers, body, signal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: signal,
      });
    } catch (err) {
      throw new Error(transportFailure(err));
    }

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_e) {
        payload = null; // an error body is a courtesy, not a guarantee
      }
      throw new Error(generateErrorMessage(response.status, payload));
    }

    try {
      return await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(GENERATE_TIMED_OUT);
      }
      throw new Error('Omnia returned a non-JSON answer to the regenerate request.');
    }
  }

  /**
   * Which failure a rejected fetch was.
   *
   * An abort is OUR timer firing, not an unreachable service: telling someone to make sure Anki
   * is running, about a request Anki has been working on for five minutes, sends them to fix a
   * machine that is working perfectly.
   *
   * @param {*} err Whatever fetch rejected with.
   * @return {string} The sentence to raise.
   */
  function transportFailure(err) {
    return err && err.name === 'AbortError' ? GENERATE_TIMED_OUT : LOOKUP_UNREACHABLE;
  }

  // -- Omnia reload handshake ------------------------------------------------------------
  // Both halves live in different files (options.js asks, background.js answers) and are
  // loaded into different contexts, so the key is defined ONCE here: a typo in either copy
  // would break the handshake silently, with each half looking correct on its own.
  const REOPEN_OPTIONS_KEY = 'omniaReopenOptionsAfterReload';
  // How long the request stays valid. If the handoff is missed -- the reload never happened,
  // or the worker did not start -- the flag must DECAY rather than lie in wait and reopen
  // Settings out of nowhere the next time the browser happens to start the worker.
  const REOPEN_OPTIONS_TTL_MS = 30000;

  root.OmniaClipper = {
    REOPEN_OPTIONS_KEY: REOPEN_OPTIONS_KEY,
    REOPEN_OPTIONS_TTL_MS: REOPEN_OPTIONS_TTL_MS,
    LOOKUP_CLIENT: LOOKUP_CLIENT,
    LOOKUP_UNREACHABLE: LOOKUP_UNREACHABLE,
    lookupErrorMessage: lookupErrorMessage,
    GENERATE_TIMEOUT_MS: GENERATE_TIMEOUT_MS,
    GENERATE_TIMED_OUT: GENERATE_TIMED_OUT,
    DEFAULTS: DEFAULTS,
    LOCAL_KEYS: LOCAL_KEYS,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    ankiConnect: ankiConnect,
    buildLookupUrl: buildLookupUrl,
    buildGenerateUrl: buildGenerateUrl,
    generateErrorMessage: generateErrorMessage,
    requestGenerate: requestGenerate,
    CHECK_TIMEOUT_MS: CHECK_TIMEOUT_MS,
    CHECK_TIMED_OUT: CHECK_TIMED_OUT,
    buildCheckUrl: buildCheckUrl,
    checkErrorMessage: checkErrorMessage,
    requestCheck: requestCheck,
    SAVE_TIMEOUT_MS: SAVE_TIMEOUT_MS,
    SAVE_TIMED_OUT: SAVE_TIMED_OUT,
    buildSaveUrl: buildSaveUrl,
    saveErrorMessage: saveErrorMessage,
    requestSave: requestSave,
  };
})(typeof self !== 'undefined' ? self : this);
