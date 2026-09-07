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
    // handed over by Omnia as ?omnia-token=… when it opens Settings.
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

  /**
   * Read settings from chrome.storage.sync, merged over DEFAULTS.
   * @return {!Promise<!Object>} The merged settings object.
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        // Deep-merge fieldMap so a partial stored map keeps default keys.
        const merged = Object.assign({}, DEFAULTS, stored);
        merged.fieldMap = Object.assign({}, DEFAULTS.fieldMap, stored.fieldMap || {});
        resolve(merged);
      });
    });
  }

  /**
   * Persist a settings object to chrome.storage.sync.
   * @param {!Object} settings The (possibly partial) settings to store.
   * @return {!Promise<void>} Resolves once the write completes.
   */
  function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(settings, () => resolve());
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
        '(Tools → Omnia → Smart Notes → Configure → Integrations) into this extension’s Options.',
      403:
        'Omnia refused the request (403) because the browser attached an Origin header to it. ' +
        'The add-on has to allow this extension explicitly — until it does, regenerate from ' +
        'the desktop clipper or from Anki itself.',
      409:
        'Regenerating is switched off. Turn on “Regenerate from clippers” in Anki ' +
        '(Tools → Omnia → Smart Notes → Configure → Integrations) and try again.',
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

    let response;
    try {
      response = await fetch(buildGenerateUrl(baseUrl), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(LOOKUP_UNREACHABLE);
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
      throw new Error('Omnia returned a non-JSON answer to the regenerate request.');
    }
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
    DEFAULTS: DEFAULTS,
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
