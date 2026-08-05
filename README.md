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
- Chrome (recent stable; uses `offscreen`, `storage.session`, and
  `chrome.storage.local.setAccessLevel`, which need Chrome 102–116+ depending
  on the feature)

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

## Troubleshooting: "Background audio did not start"

**Root cause.** Creating the offscreen audio document resolves as soon as the
page exists — before its script has finished loading and registered its
message listener. Messages sent in that window fail with "Receiving end does
not exist." This is most visible right after reloading the extension (or on a
cold start), because the offscreen document is recreated from scratch each
time. The failure happens **before any Fish Audio request is made**: the
narration session itself never reached the audio controller.

**Fix (already implemented).** The service worker now runs a readiness
handshake before starting narration:

1. It polls the offscreen document with `PING` until it answers `PONG`
   (bounded, roughly two seconds), tolerating "no receiving end" responses
   while the document warms up.
2. Only then does it send `START_READING`, and it requires a validated
   acknowledgement before reporting success.

The popup shows a distinct, actionable message for each failure stage:

- *"Background audio did not become ready…"* — the document never answered
  `PING` within the budget.
- *"Background audio did not start…"* — the document was ready but never
  acknowledged (or rejected) `START_READING`.
- Controller rejections (for example "No API key saved.") are passed through
  unchanged.

**If you still see an error, in this order:**

1. `brave://extensions` or `chrome://extensions` → find Ishmael → **Inspect
   views** → **service worker** → open the console and look for "Receiving end
does not exist" or other errors.
2. **Inspect views** → the offscreen document (`offscreen.html`) → open its
   console and confirm `offscreen.js` loaded without exceptions.
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
only to Fish Audio's API as a `Bearer` token.

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
    **Alt+Shift+R**: the startup handshake should wait out the offscreen warm-up
    and start narration instead of failing with "Receiving end does not exist."
15. With the popup closed, make a shortcut fail (for example remove the API
    key first): reopen the popup and confirm it explains the failure instead
    of silently showing no session.

## Privacy and API-key limitations

- Extracted page text is sent to Fish Audio to generate speech. This happens
  only after you explicitly click **Read page** or **Read selection**.
- The API key is stored in the browser's local extension storage. That is
  convenient but **not equivalent to a secure backend**: anyone with access to
  your Chrome profile could read it. Avoid narrating sensitive pages with a
  third-party service.
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
  with Readability on a clone           queue, and the <audio> element; reads the
  (never modifies the page)             API key from storage; keeps playing with
                                        the popup closed
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
| `src/background/service-worker.ts`, `src/background/start-reading.ts` | MV3 service worker + offscreen readiness handshake and START_READING acknowledgement |
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
| `public/icons/` | Generated extension icons |
| `scripts/build.mjs` | Orchestrates the three Vite builds |
| `scripts/generate-icons.mjs` | Dependency-free PNG icon generator |
| `vite.config.ts`, `vite.content.config.ts`, `vite.offscreen.config.ts` | Build configs |
| `vitest.config.ts`, `tsconfig.json` | Test and type-check configs |
