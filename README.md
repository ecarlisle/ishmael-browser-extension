# Ishmael

Ishmael is a personal Chrome extension that extracts the meaningful content of
the current webpage and reads it aloud using the
[Fish Audio](https://fish.audio) text-to-speech API.

> Why the name? Ishmael is the narrator of Herman Melville's *Moby-Dick* — an
> apt namesake for something that reads aloud — and the whaling voyage gives a
> playful nod to Fish Audio.

Ishmael is an intentionally focused prototype: no accounts, no payments, no
analytics, no hosted backend, no voice cloning, no cloud history.

## What it does

1. Open a webpage, click the extension icon.
2. Enter and save your personal Fish Audio API key.
3. Enter and save a Fish Audio voice/reference ID.
4. Click **Read page** or **Read selection**.
5. Listen with a natural Fish Audio voice.
6. Play, pause, resume, stop, and move to the previous or next text segment.
7. Adjust narration speed — applied instantly through the browser's playback
   rate to current and upcoming audio.
8. Switch tabs or close the popup — playback continues in a background
   offscreen document.
9. See the current segment number and a concise, live status/error message.
10. Use the keyboard shortcuts **Alt+Shift+R** (read page) and **Alt+Shift+S**
    (read selection) — even with the popup closed; see
    [Keyboard shortcuts](#keyboard-shortcuts).

## Current prototype limitations

- Chrome only (Manifest V3). No Firefox or Safari support.
- Not published to the Chrome Web Store; load it as an unpacked extension.
- `chrome://` pages, the Web Store, and other restricted pages cannot be read.
- Extraction is heuristic: very unusual page structures may extract poorly.
  No LLM is used for extraction, cleaning, or chunking.
- Cookie banners and some repeated UI can occasionally survive extraction.
- Narration chunks are generated as ordinary MP3 files over HTTP. There is no
  WebSocket streaming, no synchronized webpage highlighting, and no voice
  cloning.
- Audio caching is temporary and in-memory only; no narration history is kept.
- The API key is stored in the browser's local extension storage, which is
  convenient but not equivalent to a secure backend (see
  [Privacy and API-key limitations](#privacy-and-api-key-limitations)).

## Prerequisites

- Node.js 20.19+ (or 22.12+)
- pnpm (the repository's `devEngines` pins pnpm `^11.4.0`)
- Chrome 116+ (recent stable; uses `chrome.runtime.getContexts()` (116+),
  the `offscreen` API (109+), `storage.session`, and
  `chrome.storage.local.setAccessLevel` (102+))

## Install dependencies

```sh
pnpm install
```

## Build

```sh
pnpm build
```

This runs three Vite builds into `dist/`:

1. The popup page and service worker (ES modules, shared chunks).
2. The content script (a single IIFE file — Chrome content scripts cannot use
   ES module imports).
3. The offscreen audio controller (a single IIFE file loaded by
   `public/offscreen.html`).

The build also copies `public/` (manifest, icons, offscreen page) into `dist/`,
so `dist/` is the unpacked extension directory.

## Icon

The extension icon is an original white sperm-whale silhouette (broad squared
head, raised fluked tail) on a deep ocean-teal circle, in the same flat palette
as the popup (`#115e59` field, `#ffffff` whale). It is the same mark at every
size; the small sizes are produced by area-average downsampling of the design,
so there is nothing to blur away.

* Editable source: `design/ishmael-icon.svg`
* Rasterized 512px master: `design/ishmael-icon-master.png` (committed)
* Generated files: `public/icons/icon{16,32,48,128}.png`
* Preview sheet: `design/ishmael-icon-contact-sheet.png`
* Regenerate after changing the design:

```sh
magick -background none -density 144 design/ishmael-icon.svg \
  -resize 512x512 -depth 8 design/ishmael-icon-master.png
pnpm icons
```

The generated PNGs are committed, so the extension build does not require
ImageMagick or any icon step.

## Run tests

```sh
pnpm test        # one run
pnpm test:watch  # watch mode
```

## Type check

```sh
pnpm typecheck
```

## Load the unpacked extension in Chrome

1. Run `pnpm build`.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right).
4. Click **Load unpacked**.
5. Select the `dist/` directory in this repository.
6. Pin the extension to the toolbar and click its icon to open the popup.

## Load in Brave

Brave loads unpacked extensions the same way as Chrome:

1. Run `pnpm build`.
2. Open `brave://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` directory.
4. After every rebuild, click the extension's reload button (circular arrow)
   at `brave://extensions`, or remove and re-add it.

## Keyboard shortcuts

Ishmael registers two manifest commands that reuse the exact same startup flow
as the popup buttons, so they work with the popup closed:

- **Alt+Shift+R** — read the current page aloud
- **Alt+Shift+S** — read the current text selection aloud

The same defaults apply on macOS (Option+Shift+R / Option+Shift+S). Customize
them, or fix conflicts with other extensions, at:

- Brave: `brave://extensions/shortcuts`
- Chrome: `chrome://extensions/shortcuts`

If a browser reserves one of the defaults for itself, assign an available
combination there — the command stays registered and routes through the same
handshake.

## Popup layout

The popup is ordered: header/tagline → **Listen** card (Read page, Read
selection, transport controls, segment status) → status line → collapsible
**Voice settings** → privacy note. Voice settings use a native disclosure
(`<details>/<summary>`): they start collapsed when an API key and reference ID
are already saved, and open automatically when either is missing. Click
**Voice settings** to expand and edit them at any time.

## Troubleshooting: "Background audio did not become ready"

**Root cause (resolved).** Offscreen documents support only the
`chrome.runtime` extension API — other `chrome.*` namespaces, including
`chrome.storage`, are not available there. The controller previously executed
`chrome.storage.local` at module startup; that threw as soon as `offscreen.js`
loaded, so the runtime message listener was never registered and the
controller could never answer `PING`. The service worker's handshake then
correctly reported "Background audio did not become ready." The failure
happened **before any Fish Audio request**: the narration session never
reached the audio controller.

(The earlier theory that `chrome.offscreen.createDocument()` resolves before
the page finishes loading was wrong: Chrome's documentation says it resolves
after the document completes its initial page load.)

**Fix (already implemented).**

1. The offscreen controller no longer touches `chrome.storage` (or any
   extension API other than `chrome.runtime`). The Fish Audio API key is
   delivered over runtime messaging as the **unicast response** to a
   `GET_API_KEY` request the controller sends to the service worker — runtime
   message responses reach only the requesting context, so the key never
   travels in a broadcast payload and never reaches content scripts. The key
   is held only in the controller's memory for the session, never stored,
   logged, or included in errors.
2. The service worker follows Chrome's documented offscreen lifecycle
   pattern: it checks for an existing document with
   `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
   documentUrls: [offscreenUrl] })` (Chrome 116+; `offscreen.hasDocument()`
   is Chrome 150+) and guards concurrent creation with a module-level
   promise.
3. A readiness handshake remains as a verification step: the service worker
   polls `PING` until the controller answers a validated `PONG` (bounded,
   roughly two seconds), then sends `START_READING` and requires a validated
   acknowledgement. Startup failures are logged with a safe technical tag
   (`create-failed`, `no-context`, `no-receiver`, `malformed-pong`,
   `not-ready`, `start-not-acknowledged`, `controller-rejected`) — never
   message contents, the API key, or narrated text.

The popup shows a distinct, actionable message for each failure stage:

- *"Background audio did not become ready…"* — the controller never answered
  `PING` within the budget (its startup code may have thrown).
- *"Background audio did not start…"* — the controller was ready but never
  acknowledged (or rejected) `START_READING`.
- *"Could not create the background audio page…"* — `createDocument()`
  failed.
- *"The background audio page could not be found…"* — the offscreen context
  disappeared after creation.
- Controller rejections (for example "No API key saved.") are passed through
  unchanged.

**If you still see an error, in this order:**

1. `brave://extensions` or `chrome://extensions` → find Ishmael → **Inspect
   views** → the offscreen document (`offscreen.html`) → open its console and
   look for the startup exception (historically
   `TypeError: Cannot read properties of undefined (reading 'local')`).
2. **Inspect views** → **service worker** → open the console and look for the
   `[ishmael] offscreen startup failed` diagnostic and its `problem` tag.
3. Confirm `dist/offscreen.html` and `dist/offscreen.js` both exist after
   `pnpm build`.
4. Reload the extension and retry. If it still fails, the console output from
   steps 1–2 is the information to report.

## Create a Fish Audio API key

1. Sign up at <https://fish.audio>.
2. Go to your account settings → **API keys** (see the
   [getting started guide](https://docs.fish.audio/developer-guide/getting-started/api-key)).
3. Create a key. It looks like a long token and is only shown once.
4. Paste it into the popup's **Fish Audio API key** field and click **Save key**.

The key is stored in `chrome.storage.local` in your Chrome profile. It is sent
only to Fish Audio's API as a `Bearer` token. Internally it travels from the
service worker to the offscreen controller as the unicast response to a
`GET_API_KEY` runtime message — it never appears in broadcast messages,
playback status, session history, or logs, and it is never sent to content
scripts.

## Obtain and enter a Fish voice/reference ID

The popup's **Voice / reference ID** field accepts either:

- A public voice ID from the [Fish Audio voice library](https://fish.audio/voices)
  — no cloning or VoiceLab model needed — or
- The model/reference ID of a voice you are authorized to use (for example a
  voice you created from reference audio in VoiceLab; see the
  [models overview](https://docs.fish.audio/developer-guide/models-pricing/models-overview)).

Paste the ID into the field, pick a model (default `s2.1-pro-free`), and click
**Save voice settings**. Ishmael does not browse or pre-validate the voice
library: Fish Audio validates the ID when narration starts, and a rejected ID
produces a clear, actionable error. The reference ID is sent to Fish Audio as
`reference_id` in the request body; it is never used as the API key or as the
`model` header.

Ishmael sends the request to Fish Audio's TTS endpoint using the request shape
from the [official documentation](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech):
`POST https://api.fish.audio/v1/tts` with an `Authorization: Bearer` header, a
`model` header, and a JSON body containing `text`, `reference_id`, `format: "mp3"`,
`normalize`, and a `prosody` object (`speed`, `volume`, `normalize_loudness`).
`prosody.speed` is always `1`: narration speed is controlled solely by the
browser's audio `playbackRate` (0.5×–2×), so the two mechanisms never
compound.

## Manual verification steps

Unit tests cover extraction, chunking, message validation, error mapping, and
settings handling. Extension runtime behavior is best verified manually:

1. Open a conventional article page (e.g. a Wikipedia article) and click
   **Read page**. Playback should start from the title and read the article in
   order, pausing around headings.
2. Select some text on a page and click **Read selection**. Only the selection
   should be read.
3. Click **Pause**, **Resume**, **Previous**, **Next**, and **Stop** and confirm
   the segment counter and status text stay accurate.
4. Close the popup and switch tabs: narration should continue.
5. Open `chrome://extensions` (an unsupported page) and click **Read page**:
   you should get a concise "cannot be read" error.
6. Visit a page with little or no readable content: you should get a
   "no readable content" error.
7. Remove the API key and click **Read page**: you should get a
   "missing API key" error.
8. Enter an invalid voice/reference ID and read a page: you should get a Fish
   error explaining the voice was rejected.
9. Check the extension's service worker console (`chrome://extensions` →
   *inspect views* → *service worker*) for errors while reading. Errors should
   never contain your API key or the full article text.
10. Move the speed slider and verify 0.5×, 1×, and 2× playback apply
    immediately to current and upcoming audio, and never sound compounded
    (Fish `prosody.speed` is pinned to 1).
11. Open a page with a hidden nested subtree followed by visible content (for
    example a `<section>` whose last child is `hidden`, followed by a visible
    `<p>`): the later visible content must still be narrated.
12. Start and stop narration repeatedly, and rapidly press **Next** several
    times: no duplicate Fish requests should be sent for the same text segment
    (at most one in-flight request per chunk).
13. Press **Alt+Shift+R** / **Alt+Shift+S** with the popup closed: narration
    starts through the same path as the popup buttons. Assign a different
    shortcut if a browser conflicts at `chrome://extensions/shortcuts` or
    `brave://extensions/shortcuts`.
14. Reload the extension (or restart the browser) and immediately press
    **Alt+Shift+R**: narration should start normally; the handshake verifies
    the controller initialized, and the offscreen document's console should
    show no startup exception.
15. With the popup closed, make a shortcut fail (for example remove the API
    key first): reopen the popup and confirm it explains the failure instead
    of silently showing no session.

## Privacy and API-key limitations

- Extracted page text is sent to Fish Audio to generate speech. This happens
  only after you explicitly click **Read page** or **Read selection**.
- The API key is stored in the browser's local extension storage. That is
  convenient but **not equivalent to a secure backend**: anyone with access to
  your Chrome profile could read it. Avoid narrating sensitive pages with a
  third-party service. Within the extension the key travels only through
  extension-internal runtime messaging (a unicast response to the offscreen
  controller's `GET_API_KEY` request), is never written to playback status or
  session history, is never logged, and is never sent to content scripts.
- Ishmael keeps no narration history. Audio caching is temporary and in-memory
  (a small window around the current segment) and is released when narration
  stops.
- The extension requests only the permissions it needs: `activeTab`,
  `scripting`, `storage`, and `offscreen`, plus the single Fish Audio host
  permission (`https://api.fish.audio/*`). No analytics or telemetry.

## Remove the saved key

Open the popup → in the **Fish Audio API key** section click **Remove key**.
The key is deleted from `chrome.storage.local`. You can also clear all
extension data at `chrome://extensions` → *Details* → *Remove*.

## Why HTTP MP3 generation before streaming

The first version uses ordinary `POST /v1/tts` MP3 responses because they are
simple, robust, and well-suited to paragraph-sized narration chunks. WebSocket
streaming reduces time-to-first-audio for very long articles but adds
connection lifecycle, reconnection, and concurrency complexity that the
prototype does not need yet. Streaming (and synchronized highlighting) remain
possible future work, not current behavior.

## Architecture

```
popup (index.html + src/popup)
  │  user controls, settings, live status display
  ▼
service worker (src/background)
  │  coordinates commands, injects content script on demand, creates the
  │  offscreen document, caches playback status in chrome.storage.session
  ▼
content script (src/content)          offscreen document (src/offscreen)
  extracts page/selection segments      owns Fish Audio requests, the narration
  with Readability on a clone           queue, and the <audio> element; receives
  (never modifies the page)             the API key over runtime messaging and
                                        keeps playing with the popup closed
```

Shared modules (`src/shared`) contain message types and validators, segment
types, whitespace normalization, sentence-aware chunking, playback-state types,
Fish error mapping, and settings handling. Contexts exchange only validated
messages; the content script never sees the API key.

### File map

| Path | Purpose |
| --- | --- |
| `index.html`, `src/popup/popup.ts`, `src/popup/popup.css` | Popup UI |
| `src/popup/status-tone.ts` | Status → tone/ARIA-role mapping for popup status text |
| `src/background/service-worker.ts`, `src/background/start-reading.ts` | MV3 service worker + offscreen lifecycle (`runtime.getContexts`), readiness handshake, and validated START_READING acknowledgement |
| `src/offscreen/offscreen-boundary.test.ts` | Regression test proving the offscreen entry point works without `chrome.storage` |
| `src/background/commands.ts` | Keyboard-command → narration-source mapping |
| `src/content/extract.ts`, `src/content/extract-core.ts` | Content script + pure extraction logic |
| `src/offscreen/audio.ts`, `src/offscreen/audio-core.ts` | Offscreen audio controller + pure helpers (request shaping, in-flight registry, URL cache) |
| `src/shared/messages.ts` | Message contract + validators |
| `src/shared/segments.ts`, `src/shared/normalize.ts` | Segment types, dedupe, normalization |
| `src/shared/chunking.ts` | Sentence-aware chunking |
| `src/shared/playback.ts` | Playback-state types |
| `src/shared/errors.ts` | Fish error mapping |
| `src/shared/settings.ts`, `src/shared/settings-storage.ts` | Settings + storage wrapper |
| `public/manifest.json` | Extension manifest |
| `public/offscreen.html` | Offscreen document shell |
| `public/icons/` | Generated extension icons (16/32/48/128) |
| `design/ishmael-icon.svg` | Editable source for the Ishmael white-whale icon |
| `design/ishmael-icon-master.png` | Committed 512px rasterization of the icon source |
| `design/ishmael-icon-contact-sheet.png` | 16/32/48/128 previews at true size and zoomed, on light and dark panels |
| `scripts/build.mjs` | Orchestrates the three Vite builds |
| `scripts/render-icons.mjs` | Dependency-free icon renderer (area-average downsample + PNG encode) |
| `scripts/png-encode.mjs` | Dependency-free PNG encoder shared by icon scripts |
| `vite.config.ts`, `vite.content.config.ts`, `vite.offscreen.config.ts` | Build configs |
| `vitest.config.ts`, `tsconfig.json` | Test and type-check configs |
