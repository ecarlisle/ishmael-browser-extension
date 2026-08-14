# AGENTS.md

## Purpose

This repository contains Ishmael, a personal Chrome extension that extracts
meaningful webpage content and reads it aloud using the Fish Audio text-to-speech
API.

The current goal is a focused, understandable personal prototype. Prefer the smallest complete implementation that satisfies the documented requirements.

## Startup procedure

Before making changes:

1. Read this entire file.
2. Read the current task or implementation prompt.
3. Inspect the repository structure and existing documentation.
4. Check `git status` and the current branch.
5. Identify existing project conventions before introducing new ones.
6. Preserve unrelated user changes.

If instructions conflict or a required decision would materially change the scope, stop and ask for clarification.

## Current scope

The prototype supports:

* Chrome Manifest V3
* Current-page article extraction
* Selected-text extraction
* Fish Audio text-to-speech
* User-provided Fish API key
* User-provided Fish voice/reference ID
* MP3 narration
* Play, pause, resume, stop, previous, and next
* Narration-speed control
* Continued playback after the popup closes
* Local settings storage
* Focused automated tests

The following are explicitly out of scope unless requested:

* Firefox or Safari support
* Chrome Web Store publication
* Hosted backend services
* Accounts, payments, or subscriptions
* Analytics or telemetry
* WebSocket streaming
* Voice cloning
* Cloud narration history
* Permanent audio storage
* AI-generated summarization
* Synchronized webpage highlighting

Do not expand the implementation into out-of-scope features merely because they might be useful later.

## Technology

Use:

* TypeScript
* Chrome Manifest V3
* Vite
* Vitest
* Plain semantic HTML
* Plain CSS
* Mozilla Readability where appropriate
* A Chrome offscreen document for audio playback

Do not introduce React, Vue, Svelte, Tailwind, a component library, or remotely hosted JavaScript without explicit approval.

## TypeScript conventions

* Prefer `type` over `interface`.
* Avoid `any`. Use `unknown` and narrow it safely.
* Validate data received across extension-message boundaries.
* Use discriminated unions for commands and playback state.
* Keep types close to their owning feature unless genuinely shared.
* Prefer small, explicit functions over broad utility abstractions.
* Do not add abstractions for hypothetical future requirements.
* Handle rejected promises deliberately.
* Do not suppress TypeScript errors without documenting a concrete reason.

Example message structure:

```ts
type ExtensionMessage =
  | {
      type: "START_READING";
      source: "page" | "selection";
    }
  | {
      type: "PAUSE";
    }
  | {
      type: "RESUME";
    }
  | {
      type: "STOP";
    };
```

## Extension architecture

Maintain clear responsibility boundaries.

### Popup

The popup owns user controls and presentation. It should not extract webpage content, call Fish Audio, or own long-running playback.

### Service worker

The service worker coordinates extension activity, injects the extraction script after explicit user action, validates messages, creates the offscreen document, and maintains shared playback status.

Do not rely on the service worker remaining alive indefinitely.

### Content script

The content script reads the current page or selection and returns structured narration segments. It must not receive the Fish API key or make Fish API requests.

Avoid modifying the host page unless a requested feature explicitly requires it.

### Offscreen document

The offscreen document owns Fish API requests, the narration queue, and audio playback. It may access trusted extension storage but must never expose credentials to webpage contexts.

### Shared modules

Shared modules may contain:

* Message types and validators
* Narration-segment types
* Deterministic text normalization and chunking
* Playback-state types
* Fish error mapping

Do not create circular dependencies between extension contexts.

## Extraction rules

Extraction must be deterministic.

* Prefer the current user selection when “Read selection” is requested.
* Use Mozilla Readability on a cloned document for article extraction.
* Fall back conservatively to `main`, `article`, or document content.
* Preserve meaningful reading order.
* Recognize titles, headings, paragraphs, blockquotes, list items, and captions.
* Normalize whitespace.
* Remove empty and duplicate segments.
* Exclude scripts, styles, navigation, forms, advertisements, cookie notices, hidden content, and repeated interface text.
* Never silently truncate extracted content.
* Do not use an LLM to extract, clean, summarize, or restructure webpage content.

## Narration rules

* Preserve sentence boundaries whenever possible.
* Prefer paragraph-sized requests.
* Aim for approximately 500–1,200 characters per request.
* Split long text at sentence boundaries.
* Combine short adjacent segments only when doing so preserves meaning.
* Preserve the original reading order.
* Starting a new narration session must stop and dispose of the existing session.
* Stop must abort pending network requests.
* Release object URLs and other temporary resources when they are no longer needed.

Use ordinary Fish Audio MP3 responses during this phase. Do not introduce WebSocket streaming without an explicit task.

## Security and privacy

The Fish Audio API key is sensitive.

Never:

* Hard-code an API key
* Commit an API key
* Print an API key
* Include it in fixtures or screenshots
* Put it in query parameters
* Send it to a content script
* Insert it into the webpage DOM
* Return it in extension messages
* Include it in error messages
* Retain it in test output

Store the user-provided key in `chrome.storage.local`. Restrict storage access to trusted extension contexts when supported.

The extension must send webpage text to Fish Audio only after an explicit user action.

Do not add analytics, telemetry, remote logging, or narration history.

Request the minimum Chrome permissions necessary. Prefer:

* `activeTab`
* `scripting`
* `storage`
* `offscreen`
* Host access limited to `https://api.fish.audio/*`

Do not request `<all_urls>`, browsing history, cookies, identity, clipboard access, or unrelated host permissions.

Manifest V3 prohibits remotely hosted executable code. All executable application code must be included in the built extension.

## Accessibility

All user-facing work must include:

* Semantic HTML
* Explicit form labels
* Keyboard-operable controls
* Visible focus indicators
* Sufficient contrast
* An accessible live region for status and errors
* Disabled states for unavailable actions
* Status communication that does not rely only on color
* Respect for `prefers-reduced-motion`

Keep the popup compact, legible, and calm.

## Error handling

Handle expected failures explicitly, including:

* Missing API key
* Missing voice/reference ID
* Unsupported browser pages
* Empty selections
* Missing readable content
* Network failures
* Fish API authentication failures
* Insufficient balance
* Rate limiting
* Invalid voice IDs
* Malformed API responses
* Audio playback failures

User-facing errors should be concise and actionable. Logs must not contain credentials or complete extracted articles.

## Responding to static-analysis findings

When `fallow` (or any other static-analysis tool) flags dead code — an unused export, an unused file, an unresolved import — treat it as a real signal about the code, not noise to silence. Suppressing a finding is not a fix.

* If the code is truly dead, delete it.
* If a symbol is exported but only ever used inside the file that defines it, remove `export` rather than adding a suppression comment. Verify first with a repository-wide search (production and test files) that nothing else imports it. This is usually the correct fix and carries no risk, since nothing else can depend on a symbol that was never imported.
* Only suppress a finding after confirming no real fix applies — for example, a file that is a build entry point referenced by a config string rather than an `import` (Vite configs, content-script/offscreen entry points). Prefer a config-level fix (`.fallowrc.json`'s `entry` or `ignoreUnresolvedImports`) over an inline comment.
* Never use a whole-file suppression (e.g. `fallow-ignore-file`). Suppress the specific finding kind so unrelated future issues in that file are not silently hidden.
* Before trusting that a suppression or config entry actually works, verify it by running the tool — do not assume a comment or config pattern takes effect just because it looks plausible.

## Testing

Tests must be deterministic and must never call the live Fish Audio API.

Add or update tests for behavior being changed. Important coverage includes:

* Text normalization
* Duplicate removal
* Extraction ordering
* Sentence-aware chunking
* Long-segment splitting
* Short-segment combination
* Empty-content handling
* Message validation
* Fish error mapping
* API-key redaction
* Playback state transitions

Mock browser APIs and network requests at clear boundaries.

Do not weaken or delete valid tests merely to make a change pass.

## Verification

Before reporting work as complete, run the project’s documented equivalents of:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Also verify:

* The generated manifest is valid.
* The requested permissions remain minimal.
* Built files contain no API key or placeholder secret.
* Built files load no remote executable code.
* The unpacked-extension directory contains all required assets.
* Documentation matches actual commands and behavior.

If browser testing is available, load the built extension and test it on:

* A conventional article page
* A page with selected text
* A page with little or no readable content
* An unsupported Chrome page
* A Fish API error response
* Playback while switching tabs

Never claim browser testing was performed unless it was actually performed.

## Git workflow

* Do not use Git rebase.
* Do not force-push.
* Do not amend existing commits unless explicitly requested.
* Do not discard unrelated working-tree changes.
* Keep commits focused and intentional.
* Do not commit generated secrets, local configuration, or personal API credentials.
* Do not merge a branch or close a pull request unless explicitly requested.

Before creating a commit, review the complete diff and confirm that it contains only intended changes.

Do not modify this `AGENTS.md` file without explicit permission.

## Documentation

Update documentation when behavior, configuration, permissions, commands, architecture, or limitations change.

Documentation must clearly explain:

* How to install dependencies
* How to build and test
* How to load the unpacked extension
* How Fish Audio is used
* How to configure and remove the API key
* What webpage data leaves the browser
* Current prototype limitations
* Which behaviors were automatically or manually verified

Do not document unimplemented features as though they exist.

## Completion reports

Conclude implementation work with:

1. A concise outcome summary
2. Files created and modified
3. Important architectural decisions
4. Permissions added or changed
5. Commands run and their results
6. Tests added or updated
7. Whether real browser testing occurred
8. Remaining limitations or risks
9. The smallest sensible next step

Be precise about anything that could not be verified.

