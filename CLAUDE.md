# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ishmael is a personal Chrome extension (Manifest V3) that extracts the meaningful content of a webpage and reads it aloud via the Fish Audio TTS API. It's an intentionally focused prototype — see "Scope" below before adding anything not already listed.

**Read `AGENTS.md` before making changes.** It is the authoritative, detailed rulebook (technology constraints, TypeScript conventions, extraction/narration rules, security rules, testing rules, git workflow, completion-report format). This file is a shorter orientation on top of it. `README.md` has full user-facing behavior docs (playback states, narration tags/Mood, popup layout, troubleshooting).

## Commands

```sh
pnpm install                          # install deps (pnpm ^11.4.0, per devEngines)
pnpm build                            # 3 Vite builds -> dist/ (the unpacked extension)
pnpm test                             # vitest run (all tests, once)
pnpm test:watch                       # vitest watch mode
pnpm exec vitest run src/shared/chunking.test.ts   # run a single test file
pnpm exec vitest run -t "test name"                # run tests matching a name
pnpm typecheck                        # tsc --noEmit
pnpm icons                            # regenerate public/icons/ from design/ishmael-icon.svg
```

Load the built extension: `pnpm build`, then `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`. After rebuilding, click the extension's reload button.

Before reporting work complete, run `pnpm typecheck && pnpm test && pnpm build` (per `AGENTS.md`).

## Architecture

Four isolated extension contexts communicate only through validated messages (`src/shared/messages.ts`). Each has a hard responsibility boundary — moving logic across it is usually wrong:

```
popup (index.html + src/popup)
  │  user controls, settings, live status display — no extraction, no Fish calls, no long-running playback
  ▼
service worker (src/background)
  │  coordinates commands, injects the content script on demand, creates/manages the offscreen
  │  document (chrome.runtime.getContexts lifecycle + readiness handshake), caches playback status
  ▼
content script (src/content)          offscreen document (src/offscreen)
  extracts page/selection segments      owns Fish Audio requests, the narration queue, and the
  with Readability on a cloned doc      <audio> element; keeps playing after the popup closes
  (never modifies the page,             (chrome.storage is unavailable there — see gotcha below)
   never sees the API key)
```

`src/shared/` holds message types/validators, segment types, normalization, sentence-aware chunking (`chunking.ts`), the decoration layer (`decorate.ts` — mood cue + structural tags + cross-file pause logic), playback-state types (`playback.ts`), Fish error mapping (`errors.ts`), and settings/storage (`settings.ts`, `settings-storage.ts`). No circular dependencies between contexts.

**Critical gotcha:** the offscreen document supports *only* the `chrome.runtime` API — `chrome.storage` and other `chrome.*` namespaces throw there. This caused a real, documented outage (see README's "Troubleshooting" section). The API key reaches the offscreen controller as the **unicast response** to a `GET_API_KEY` runtime message it sends to the service worker on startup — never via storage, never via broadcast, never to the content script.

**Playback state** is entirely event-driven (`Preparing → Connecting → Generating → Buffering → Playing/Paused → Complete/Stopped/Error`) — never from timers or optimistic guessing. See README's "Playback states" table before touching status rendering (`src/popup/status-tone.ts`, `src/popup/popup.ts`).

**Narration text** goes through `normalize.ts` → `segments.ts` (dedupe, emphasis ranges, thematic-break metadata) → `chunking.ts` (sentence-aware, ~500–1200 chars/request, boundary metadata preserved across merges/splits) → `decorate.ts` (adds the Mood cue + structural Fish tags, e.g. `[happy] [emphasis] Page title. [long-break]`) before becoming a Fish Audio request.

## Conventions specific to this repo

- Vanilla TS/HTML/CSS + Vite only — no React/Vue/Svelte/Tailwind/component libraries/remotely hosted JS (MV3 forbids the latter anyway).
- `type` over `interface`; discriminated unions for messages and playback state; avoid `any`, narrow `unknown`; validate everything crossing an extension-message boundary.
- `tsconfig.json` is strict (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc.) — expect the compiler to catch a lot.
- Tests are pure/deterministic and never call the live Fish API; mock `chrome.*` and network at the context boundary. Default vitest environment is `node` (`vitest.config.ts`); `src/popup/popup.test.ts` overrides to `jsdom` via a per-file `// @vitest-environment jsdom` pragma since it drives real DOM/`chrome.runtime` stubs.
- Chrome permissions must stay minimal (`activeTab`, `scripting`, `storage`, `offscreen`, host access limited to `https://api.fish.audio/*`).
- Git: no rebase, no force-push, no amending existing commits unless asked, no merging/closing PRs unless asked. Don't modify `AGENTS.md` without explicit permission.

## Scope

In scope: Chrome MV3, page/selection extraction, Fish Audio TTS, user-provided API key + voice ID, MP3 narration with full transport controls, speed control, background playback, local settings storage. Out of scope unless explicitly requested: Firefox/Safari, Web Store publication, hosted backends, accounts/payments, analytics/telemetry, WebSocket streaming, voice cloning, cloud history, LLM-based extraction/summarization, synchronized highlighting. Full list in `AGENTS.md`.
