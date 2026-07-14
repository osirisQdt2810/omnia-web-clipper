# Omnia Web Clipper

A **Chrome/Edge (Manifest V3) extension** that captures a **word or phrase plus its
sentence/context** from any web page and sends it to your running Anki via
[AnkiConnect](https://ankiweb.net/shared/info/2055492159) — where the
[Omnia](https://github.com/osirisQdt2810/omnia) add-on's **Smart Notes / integration gateway**
auto-generates the rest of the card. It is the browser sibling of the
[Omnia Desktop Clipper](https://github.com/osirisQdt2810/omnia-desktop-clipper) and speaks the
same AnkiConnect contract.

- **Double-click** a word (or **select** a phrase) on any page → a floating **"+"** appears.
- Click it → the word + the surrounding sentence are read from the page DOM and sent to Anki.
- Or **right-click a selection → "Send to Anki (Omnia)"** via the context menu.
- The note is tagged so Omnia **auto-generates** definition / example / TTS / image fields.

---

## Install (load unpacked)

1. Open **`chrome://extensions`** (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. **Load unpacked** → select this `omnia-web-clipper/` folder.
4. Pin the **Omnia Web Clipper** icon if you like (puzzle-piece menu → pin).

To build a distributable zip instead, run `./package.sh` (produces a packaged extension you can
drag onto `chrome://extensions`).

> The extension needs no build step — it is plain MV3 JS/HTML.

### On each of your machines
Repeat the four steps above on every computer (the extension is per-browser-profile). Two ways to
avoid re-doing it by hand:
- **Chrome Sync** — sign into Chrome with the same Google account and an installed extension
  follows you; or
- **Publish once as an _Unlisted_ Chrome Web Store item** and open the install link on each machine.

An unpacked install gets a **random extension ID per machine**, so its `chrome-extension://<id>`
origin differs everywhere. If you whitelist the ID (the strict CORS option below) rather than `*`,
**pin the ID** with a manifest `"key"` so it is identical on every machine and you configure
AnkiConnect only once.

---

## AnkiConnect setup (required)

1. Install **AnkiConnect** in Anki (add-on code `2055492159`) and **restart Anki**.
2. Keep **Anki running** while you clip.
3. **Let AnkiConnect accept the extension's origin.** The desktop app works with no config because
   `urllib` sends **no `Origin` header**, and AnkiConnect allows origin-less requests. A browser
   always attaches `Origin: chrome-extension://<id>`, so AnkiConnect's `webCorsOriginList` gate
   applies. (The clipper calls AnkiConnect from its *service worker*, which — with the
   `host_permissions` this manifest declares — is exempt from *Chrome-side* CORS; the only gate left
   is AnkiConnect's own allowlist.) So you must change AnkiConnect config in **one** of two ways
   (**Tools → Add-ons → AnkiConnect → Config**, then restart Anki):

   - **Simplest, ID-free (recommended for local use):** allow any origin. AnkiConnect binds to
     `127.0.0.1` only, so a remote page still can't reach it.

     ```json
     { "webCorsOriginList": ["http://localhost", "*"] }
     ```

   - **Strict:** whitelist this one extension. You do *not* have to use the ID if you prefer `*`;
     the ID is only for pinning down exactly one extension:

     ```json
     { "webCorsOriginList": ["http://localhost", "chrome-extension://<YOUR_EXTENSION_ID>"] }
     ```

     Find `<YOUR_EXTENSION_ID>` on `chrome://extensions`. Note it **changes on every unpacked
     re-install** unless you pin it with a manifest `"key"`; for dev use, `*` avoids that churn.

   If the origin isn't allowed, the clipper shows an actionable error pointing here.
4. If you set an AnkiConnect **`apiKey`**, enter the same key in the extension **Options**.

---

## Options

Click the extension icon → **Options** (or right-click → Options). Everything is populated live
from AnkiConnect:

- **AnkiConnect URL** — default `http://127.0.0.1:8765`.
- **API key** — only if your AnkiConnect config sets one.
- **Deck** — dropdown from `deckNames` (created if missing on add).
- **Note type** — dropdown from `modelNames`; changing it reloads the field list.
- **Field map** — for the note type's fields, choose which capture value (`word` / `context`) fills
  each (or *skip*). If the first field is left empty, the word auto-fills it so Anki never rejects
  an "empty" note.
- **Tags** — extra tags added to every note (comma-separated).
- **Auto-generate (Omnia)** — when on, tags the note `omnia-autogen` so the add-on's gateway
  generates the remaining fields. On by default.

---

## Usage

- **Double-click** a word → "+" appears near it → click to send just that word (with its sentence
  as context).
- **Select** a phrase → "+" appears → click to send the phrase (+ surrounding context).
- **Right-click a selection → "Send to Anki (Omnia)"** — same flow via the context menu.
- The extension **popup** (toolbar icon) shows status and a quick enable/disable toggle.

The word becomes Omnia's **base field**; the sentence/context goes into the mapped context field.

---

## How the note flows into Omnia auto-generation (the tags)

The clipper tags each note with its **source tag `omnia-web-clipper`** plus **`omnia-autogen`**
(when Auto-generate is on):

```
["omnia-web-clipper", "omnia-autogen"]
```

The Omnia add-on ships a `web_clipper` integration keyed on that source tag; enable its toggle
under **Omnia → Smart Notes → Integrations**. The add-on's gateway then auto-generates the card
from the base word + context. (The desktop clipper uses `omnia-desktop-clipper` with its own
toggle.)

---

## Troubleshooting

- **"Failed to reach Anki" / CORS error** → Anki isn't running, or your extension origin is not in
  `webCorsOriginList` (see AnkiConnect setup). Restart Anki after editing its config.
- **"cannot create note because it is empty"** → the note type's first field wasn't mapped; the
  clipper auto-fills it with the word, but double-check the field map in Options.
- **No card fields generated** → enable the *Omnia Web Clipper* integration in
  Omnia → Smart Notes → Integrations, and configure Smart Notes for that note type.
- **"+" doesn't appear** → the extension can't inject into some pages (e.g. `chrome://` pages, the
  Web Store, PDFs opened in the built-in viewer). Reload the page after installing/updating.

---

## Files

```
omnia-web-clipper/
├── manifest.json         # MV3 manifest (must stay at the root; paths point into src/ + assets/)
├── src/
│   ├── background.js     # service worker: context menu + the addNote flow to AnkiConnect
│   ├── content.js        # in-page: double-click/select detection, floating "+", context read
│   ├── shared.js         # AnkiConnect fetch helper + error messages
│   ├── options.html/js   # options page (deck/note-type/field-map/tags/autogen/url/key)
│   └── popup.html/js     # toolbar popup (status + enable toggle)
├── assets/
│   └── icons/            # extension icons
└── package.sh            # build a distributable zip
```
