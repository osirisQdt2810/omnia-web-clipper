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
    // Shared secret for the add-on's WRITE endpoint (/generate). Reading is unauthenticated;
    // regenerating spends the user's LLM credits, so it is not. Typed on the options page, or
    // handed over by Omnia as ?omnia-token=… when it opens Settings. Stored LOCALLY, unlike
    // every other setting here — see LOCAL_KEYS.
    lookupToken: '',
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
  // Everything else is a preference the user would want on their other machines, and sync is
  // exactly right for it. The lookup token is not a preference: it is a credential for a
  // loopback service running on THIS machine, issued by THIS machine's copy of Omnia. Syncing
  // it uploads a secret to Google's servers and copies it into every Chrome profile signed into
  // the account, where it cannot even work — the Omnia over there issued a different one. So the
  // split is not tidiness; it is the difference between a machine-local secret staying local
  // and being replicated to places that have no use for it.
  const LOCAL_KEYS = ['lookupToken'];

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
            const own = local[key];
            const synced = stored[key];
            // A value still in sync was written by a build that stored it there. Adopt it so
            // nobody has to re-enter a token that already works, and move it out of sync.
            merged[key] = own || synced || DEFAULTS[key];
            if (!own && synced) {
              migrateOutOfSync(key, synced);
            }
          });
          resolve(merged);
        });
      });
    });
  }

  /**
   * Move a value an older build left in chrome.storage.sync into chrome.storage.local.
   *
   * Fire-and-forget: the caller already has the value in hand, so a failed write costs nothing
   * but a second attempt on the next read. The sync copy is removed only once the local one is
   * written, so an interrupted migration loses nothing.
   *
   * @param {string} key The settings key being moved.
   * @param {*} value The value found in sync.
   */
  function migrateOutOfSync(key, value) {
    const patch = {};
    patch[key] = value;
    chrome.storage.local.set(patch, () => {
      if (chrome.runtime.lastError) {
        return;
      }
      chrome.storage.sync.remove(key, () => void chrome.runtime.lastError);
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
  const TOKEN_HEADER = 'X-Omnia-Token';
  // How Omnia hands the token to this extension: it opens the options page with the token in
  // the query string (the same route the Reload handshake uses), so nobody has to copy it.
  const TOKEN_PARAM = 'omnia-token';

  const LOOKUP_UNREACHABLE =
    "Can't reach Anki's lookup service. Make sure Anki is running with Omnia's " +
    '“Word Lookup” feature switched on.';

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
   * Read the token Omnia may have put in the options page's query string.
   * @param {string} search The location.search to parse.
   * @return {string} The token, or '' when there is none.
   */
  function readTokenFromSearch(search) {
    try {
      return (new URLSearchParams(search || '').get(TOKEN_PARAM) || '').trim();
    } catch (_e) {
      return ''; // no URLSearchParams / no location: nothing was handed over
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
        'Omnia rejected the access token (401). Copy the token from Anki ' +
        '(Tools → Omnia → Word Lookup → Configure…, “Clipper access token”) into this ' +
        'extension’s Options.',
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
   * @param {string} token The shared secret from settings (sent even when empty, so the
   *     add-on's own 401 explains it rather than this half guessing).
   * @param {number} noteId The note to regenerate.
   * @param {?Array<string>=} fields Which fields, or null/undefined for every field.
   * @return {!Promise<!Object>} `{note_id, results: [{field, status, message, ...}]}`.
   */
  async function requestGenerate(baseUrl, token, noteId, fields) {
    const body = {
      client: LOOKUP_CLIENT,
      note_id: Number(noteId),
      fields: Array.isArray(fields) && fields.length ? fields : null,
    };
    const headers = {'Content-Type': 'application/json'};
    headers[TOKEN_HEADER] = String(token || '');

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
    TOKEN_HEADER: TOKEN_HEADER,
    TOKEN_PARAM: TOKEN_PARAM,
    LOOKUP_UNREACHABLE: LOOKUP_UNREACHABLE,
    GENERATE_TIMEOUT_MS: GENERATE_TIMEOUT_MS,
    GENERATE_TIMED_OUT: GENERATE_TIMED_OUT,
    DEFAULTS: DEFAULTS,
    LOCAL_KEYS: LOCAL_KEYS,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    ankiConnect: ankiConnect,
    buildLookupUrl: buildLookupUrl,
    buildGenerateUrl: buildGenerateUrl,
    readTokenFromSearch: readTokenFromSearch,
    generateErrorMessage: generateErrorMessage,
    requestGenerate: requestGenerate,
  };
})(typeof self !== 'undefined' ? self : this);
