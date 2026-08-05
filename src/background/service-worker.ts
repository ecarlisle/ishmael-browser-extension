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
import { startOffscreenSession } from './start-reading';
import { sourceForCommand } from './commands';

const OFFSCREEN_URL = 'offscreen.html';
const STATUS_CACHE_KEY = 'ishmael.playbackStatus';

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

/** Sends a message to the offscreen document if it exists. Never throws. */
async function forwardToOffscreen(message: ExtensionMessage): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return undefined;
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

  const response = await withTimeout(
    chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'EXTRACT', source }),
    8000,
    null,
  );
  if (!isExtractionResult(response)) {
    return { ok: false, error: 'The page did not respond to extraction. Reload the page and try again.' };
  }
  if (!response.ok) {
    return { ok: false, error: response.message };
  }

  const settings = await loadSettings(localStorageArea);
  if (!settings.apiKey) return { ok: false, error: messageForKind('missing-api-key') };
  if (!settings.voiceId) return { ok: false, error: messageForKind('missing-voice') };

  try {
    await ensureOffscreenDocument();
  } catch {
    return {
      ok: false,
      error: 'Could not create the background audio page. Check the service worker console, then reload the extension.',
    };
  }

  // Do not report success merely because the offscreen document was created:
  // poll it with PING until its controller answers PONG (bounded backoff for
  // the race where createDocument resolves before the listener registers),
  // then send START_READING and require a validated acknowledgement. The
  // loading state is only cached once the session is accepted.
  const started = await startOffscreenSession(
    {
      target: 'offscreen',
      type: 'START_READING',
      segments: response.segments,
      voiceId: settings.voiceId,
      model: settings.model,
      speed: settings.speed,
    },
    (message) => forwardToOffscreen(message),
  );
  if (!started.ok) {
    return { ok: false, error: started.error };
  }
  await cacheStatus({ phase: 'loading', index: 0, total: response.segments.length, speed: settings.speed });
  return { ok: true };
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Play Fish Audio narration continuously while the popup is closed or the tab is switched.',
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * Routes a manifest command to the same beginReading() flow used by the
 * popup buttons. When a shortcut fails while the popup is closed, stores an
 * error playback status so the next popup open explains what happened.
 */
async function handleShortcut(command: string): Promise<void> {
  const source = sourceForCommand(command);
  if (!source) return; // unknown commands are ignored
  const result = await beginReading(source);
  if (result.ok) return;
  const cached = await readCachedStatus();
  await cacheStatus({ phase: 'error', index: 0, total: 0, speed: cached.speed, error: result.error });
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
 * Returns the current playback status. When the cache says something is
 * playing, verifies the offscreen document is still alive with a PING; if it
 * is gone, reports idle (its audio is gone too).
 */
async function getFreshStatus(): Promise<PlaybackStatus> {
  const cached = await readCachedStatus();
  // Idle and error statuses are terminal display information: return them
  // as-is instead of letting a PING failure overwrite a stored error (e.g. a
  // shortcut failure that happened while the popup was closed).
  if (cached.phase === 'idle' || cached.phase === 'error') return cached;
  const pong = await withTimeout(forwardToOffscreen({ target: 'offscreen', type: 'PING' }), 600, null);
  if (isPongResponse(pong)) {
    const status = sanitizePlaybackStatus(pong.status);
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
