// Manifest V3 service worker.
//
// Coordinates popup commands, injects the extraction content script after an
// explicit user action, creates the offscreen document, routes narration
// segments to it, and caches playback state so the popup can reopen and show
// the current status. It never holds the narration queue or audio itself.

import { isExtensionMessage, isExtractionResult, isPongResponse, type ExtensionMessage } from '../shared/messages';
import { createIdleStatus, sanitizePlaybackStatus, type PlaybackStatus } from '../shared/playback';
import {
  loadRedactedSettings,
  loadSettings,
  removeApiKey,
  saveSettings,
  type SettingsStorage,
} from '../shared/settings-storage';
import { messageForKind } from '../shared/errors';
import { startOffscreenSession, type SendOutcome } from './start-reading';
import { sourceForCommand } from './commands';

const OFFSCREEN_URL = 'offscreen.html';
const STATUS_CACHE_KEY = 'ishmael.playbackStatus';

/**
 * Phases whose cached value is truthful without a PING: idle and the
 * terminal outcomes (error, stopped, complete) are display facts, and
 * preparing is extraction-in-progress known only to the service worker
 * (the offscreen would report its previous session's stale phase).
 */
const CACHE_AUTHORITATIVE_PHASES: readonly PlaybackStatus['phase'][] = [
  'idle',
  'error',
  'stopped',
  'complete',
  'preparing',
];

const OFFSCREEN_CREATE_FAILED_MESSAGE =
  'Could not create the background audio page. Check the service worker console, then reload the extension.';
const OFFSCREEN_CONTEXT_MISSING_MESSAGE =
  'The background audio page could not be found. Reload the extension and try again.';

const localStorageArea: SettingsStorage = chrome.storage.local as unknown as SettingsStorage;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void restrictStorageAccess();
  });
  chrome.runtime.onStartup.addListener(() => {
    void restrictStorageAccess();
  });

  chrome.commands.onCommand.addListener((command: string) => {
    void handleShortcut(command);
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExtensionMessage(message) || message.target !== 'service-worker') return false;
    void handleMessage(message, sendResponse);
    return true; // response is sent asynchronously
  });
}

/**
 * Keeps the API key out of untrusted contexts (Chrome 102+). Only the service
 * worker, offscreen document, and popup may read chrome.storage.local.
 */
async function restrictStorageAccess(): Promise<void> {
  try {
    const area = chrome.storage.local as unknown as { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> };
    if (typeof area.setAccessLevel === 'function') {
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  } catch {
    // Older Chrome: the method is absent or restricted; the key stays in
    // storage.local with default access, which is acceptable for this
    // personal prototype.
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

type SimpleResponse = { ok: true } | { ok: false; error: string };

async function handleMessage(message: ExtensionMessage, sendResponse: (response: unknown) => void): Promise<void> {
  switch (message.type) {
    case 'GET_SETTINGS': {
      sendResponse({ settings: await loadRedactedSettings(localStorageArea) });
      return;
    }
    case 'SAVE_SETTINGS': {
      const merged = await saveSettings(localStorageArea, message.patch);
      if (typeof message.patch.speed === 'number') {
        void forwardToOffscreen({ target: 'offscreen', type: 'UPDATE_SPEED', speed: merged.speed });
      }
      sendResponse({ ok: true });
      return;
    }
    case 'REMOVE_API_KEY': {
      await removeApiKey(localStorageArea);
      sendResponse({ ok: true });
      return;
    }
    case 'GET_API_KEY': {
      // The key is delivered only as a unicast response to the requesting
      // offscreen document; it is never part of a broadcast payload, never
      // cached in playback status, and never logged.
      const settings = await loadSettings(localStorageArea);
      if (!settings.apiKey) {
        sendResponse({ ok: false, error: messageForKind('missing-api-key') });
      } else {
        sendResponse({ ok: true, apiKey: settings.apiKey });
      }
      return;
    }
    case 'GET_STATUS': {
      sendResponse({ status: await getFreshStatus() });
      return;
    }
    case 'READ_PAGE':
    case 'READ_SELECTION': {
      const source = message.type === 'READ_PAGE' ? 'page' : 'selection';
      sendResponse(await beginReading(source));
      return;
    }
    case 'PLAY_PAUSE':
    case 'PREVIOUS':
    case 'NEXT':
    case 'STOP': {
      await forwardToOffscreen({ target: 'offscreen', type: message.type });
      sendResponse({ ok: true });
      return;
    }
    case 'PLAYBACK_STATE': {
      const status = sanitizePlaybackStatus(message.status);
      if (status) await cacheStatus(status);
      sendResponse({ ok: true });
      return;
    }
  }
}

/**
 * Sends a message to the offscreen document. Never throws: delivery failures
 * are retained as a safe diagnostic tag (no message contents, credentials,
 * or text) so callers can distinguish "no receiver" from other stages.
 */
async function forwardToOffscreen(message: ExtensionMessage): Promise<SendOutcome> {
  try {
    return { ok: true, value: await chrome.runtime.sendMessage(message) };
  } catch {
    // runtime.sendMessage rejected: no listener was reachable.
    return { ok: false, problem: 'no-receiver' };
  }
}

// ---------------------------------------------------------------------------
// Reading flow
// ---------------------------------------------------------------------------

function isSupportedTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function beginReading(source: 'page' | 'selection'): Promise<SimpleResponse> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    return { ok: false, error: 'No active tab to read.' };
  }
  if (!isSupportedTabUrl(tab.url)) {
    return { ok: false, error: messageForKind('unsupported-page') };
  }

  // Inject on demand; activeTab permission covers the current tab only.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch {
    return { ok: false, error: messageForKind('unsupported-page') };
  }

  // Extraction is committed once the content script is injected: cache
  // 'preparing' so a reopened popup shows extraction in progress, then cache
  // a specific error on any later failure so the next popup open explains it.
  await cachePreparing();

  const response = await withTimeout(
    chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'EXTRACT', source }),
    8000,
    null,
  );
  if (!isExtractionResult(response)) {
    const error = 'The page did not respond to extraction. Reload the page and try again.';
    await cacheError(error);
    return { ok: false, error };
  }
  if (!response.ok) {
    await cacheError(response.message);
    return { ok: false, error: response.message };
  }

  const settings = await loadSettings(localStorageArea);
  if (!settings.apiKey) {
    const error = messageForKind('missing-api-key');
    await cacheError(error);
    return { ok: false, error };
  }
  if (!settings.voiceId) {
    const error = messageForKind('missing-voice');
    await cacheError(error);
    return { ok: false, error };
  }

  try {
    await ensureOffscreenDocument();
  } catch (error) {
    const problem = error instanceof OffscreenDocumentError ? error.problem : 'create-failed';
    logOffscreenProblem(problem);
    const message =
      problem === 'no-context' ? OFFSCREEN_CONTEXT_MISSING_MESSAGE : OFFSCREEN_CREATE_FAILED_MESSAGE;
    await cacheError(message);
    return { ok: false, error: message };
  }

  // PING the controller until it answers PONG (bounded backoff): this
  // verifies the controller actually initialized and registered its listener
  // — a controller whose startup code threw can never be messaged — then send
  // START_READING and require a validated acknowledgement. From here on the
  // offscreen broadcasts drive the cached status (connecting → … → playing).
  const started = await startOffscreenSession(
    {
      target: 'offscreen',
      type: 'START_READING',
      segments: response.segments,
      voiceId: settings.voiceId,
      model: settings.model,
      speed: settings.speed,
      mood: settings.mood,
    },
    (message) => forwardToOffscreen(message),
  );
  if (!started.ok) {
    logOffscreenProblem(started.problem);
    await cacheError(started.error);
    return { ok: false, error: started.error };
  }
  return { ok: true };
}

class OffscreenDocumentError extends Error {
  constructor(readonly problem: 'create-failed' | 'no-context') {
    super(`offscreen document ${problem}`);
  }
}

/**
 * Module-level creation promise: prevents concurrent createDocument() calls.
 */
let creatingOffscreenDocument: Promise<void> | undefined;

/**
 * Ensures the offscreen document exists, following Chrome's documented
 * lifecycle pattern: `runtime.getContexts()` with the exact offscreen URL is
 * checked first (Chrome 116+; `offscreen.hasDocument()` is Chrome 150+), and
 * creation is guarded by a shared module-level promise. Throws
 * `OffscreenDocumentError` with a distinct problem tag on failure.
 */
async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const hasContext = async (): Promise<boolean> => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  };
  if (await hasContext()) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }
  const creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Play Fish Audio narration continuously while the popup is closed or the tab is switched.',
    })
    .then(() => undefined);
  creatingOffscreenDocument = creating;
  try {
    await creating;
    if (!(await hasContext())) throw new OffscreenDocumentError('no-context');
  } catch (error) {
    if (error instanceof OffscreenDocumentError) throw error;
    throw new OffscreenDocumentError('create-failed');
  } finally {
    if (creatingOffscreenDocument === creating) creatingOffscreenDocument = undefined;
  }
}

/**
 * Logs a safe, technical-only offscreen startup diagnostic. Never logs
 * message contents, the API key, narration text, or request headers.
 */
function logOffscreenProblem(problem: string): void {
  console.warn('[ishmael] offscreen startup failed', { problem });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * Routes a manifest command to the same beginReading() flow used by the
 * popup buttons. beginReading() itself caches the error status when a
 * shortcut fails, so the next popup open explains what happened even though
 * the popup was closed.
 */
async function handleShortcut(command: string): Promise<void> {
  const source = sourceForCommand(command);
  if (!source) return; // unknown commands are ignored
  await beginReading(source);
}

// ---------------------------------------------------------------------------
// Status cache
// ---------------------------------------------------------------------------

async function cacheStatus(status: PlaybackStatus): Promise<void> {
  try {
    await chrome.storage.session.set({ [STATUS_CACHE_KEY]: status });
  } catch {
    // Session storage is optional; the popup falls back to live PING data.
  }
}

async function readCachedStatus(): Promise<PlaybackStatus> {
  try {
    const raw = await chrome.storage.session.get(STATUS_CACHE_KEY);
    return sanitizePlaybackStatus(raw[STATUS_CACHE_KEY]) ?? createIdleStatus();
  } catch {
    return createIdleStatus();
  }
}

/**
 * Caches the extraction/preparing state after the content script is injected
 * so a reopened popup can show that a read is in progress.
 */
async function cachePreparing(): Promise<void> {
  const cached = await readCachedStatus();
  await cacheStatus({ phase: 'preparing', index: 0, total: 0, speed: cached.speed });
}

/** Caches a terminal error status (user-facing, already redacted). */
async function cacheError(error: string): Promise<void> {
  const cached = await readCachedStatus();
  await cacheStatus({ phase: 'error', index: 0, total: 0, speed: cached.speed, error });
}

/**
 * Returns the current playback status. Phases that are truthful as cached
 * (no session, terminal outcomes, and extraction-in-progress known only to
 * the service worker) are returned as-is. Live phases (connecting through
 * paused) are verified against the offscreen document with a PING so a dead
 * offscreen context collapses to idle instead of claiming playback.
 */
async function getFreshStatus(): Promise<PlaybackStatus> {
  const cached = await readCachedStatus();
  if (CACHE_AUTHORITATIVE_PHASES.includes(cached.phase)) return cached;
  const outcome = await withTimeout(forwardToOffscreen({ target: 'offscreen', type: 'PING' }), 600, null);
  if (outcome && outcome.ok && isPongResponse(outcome.value)) {
    const status = sanitizePlaybackStatus(outcome.value.status);
    if (status) {
      await cacheStatus(status);
      return status;
    }
  }
  const idle: PlaybackStatus = { phase: 'idle', index: 0, total: 0, speed: cached.speed };
  await cacheStatus(idle);
  return idle;
}

init();
