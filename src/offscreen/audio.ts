// Offscreen document: owns the Fish Audio synthesis requests, the narration
// queue, and the <audio> element. Keeps playing while the popup is closed or
// the user switches tabs.
//
// The API key is read from chrome.storage.local only — never from a message —
// and never leaves this trusted extension context.

import { chunkSegments, type NarrationChunk } from '../shared/chunking';
import { isExtensionMessage } from '../shared/messages';
import {
  FishAudioError,
  fishErrorFromUnknown,
  isAbortError,
  messageForKind,
  parseFishErrorBody,
} from '../shared/errors';
import type { PlaybackStatus } from '../shared/playback';
import { loadSettings, type SettingsStorage } from '../shared/settings-storage';
import { clampSpeed } from '../shared/settings';
import type { NarrationSegment } from '../shared/segments';

const localStorageArea: SettingsStorage = chrome.storage.local as unknown as SettingsStorage;

const TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';
const MAX_FETCH_RETRIES = 2;

const audio = new Audio();
audio.preload = 'auto';

let apiKey = '';
let voiceId = '';
let model = 's2.1-pro-free';
let speed = 1;

let queue: NarrationChunk[] = [];
let index = 0;
let phase: PlaybackStatus['phase'] = 'idle';
let errorMessage: string | undefined;

/** Incremented whenever a session starts or stops; stale async work checks it. */
let sessionId = 0;
const activeFetches = new Set<AbortController>();

/** The chunk currently being fetched (-1 when none). A seek supersedes it. */
let pendingIndex = -1;

/** index → object URL, bounded to a few chunks around the current one. */
const urlCache = new Map<number, string>();

let shouldBePlaying = false;

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

function buildStatus(): PlaybackStatus {
  const status: PlaybackStatus = { phase, index, total: queue.length, speed };
  if (phase === 'error' && errorMessage) status.error = errorMessage;
  return status;
}

function reportStatus(): void {
  void chrome.runtime.sendMessage({ target: 'service-worker', type: 'PLAYBACK_STATE', status: buildStatus() }).catch(() => {
    // Service worker may be asleep or shutting down; state is re-requested
    // via PING when the popup reopens.
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchChunk(chunk: NarrationChunk, attempt = 0): Promise<Blob> {
  const controller = new AbortController();
  activeFetches.add(controller);
  try {
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model,
      },
      body: JSON.stringify({
        text: chunk.text,
        reference_id: voiceId,
        format: 'mp3',
        normalize: true,
        prosody: {
          speed,
          volume: 0,
          normalize_loudness: true,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const parsed = parseFishErrorBody(body);
      throw new FishAudioError(response.status, parsed.message ?? undefined);
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error('empty response');
    }
    return blob;
  } catch (error) {
    // Retry transient network/empty-response failures a couple of times.
    // Explicit Fish Audio HTTP errors are not retried so rate limits and
    // balance errors surface immediately.
    if (!isAbortError(error) && !(error instanceof FishAudioError) && attempt < MAX_FETCH_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return fetchChunk(chunk, attempt + 1);
    }
    throw error;
  } finally {
    activeFetches.delete(controller);
  }
}

// ---------------------------------------------------------------------------
// Cache / object URLs
// ---------------------------------------------------------------------------

function pruneUrlCache(): void {
  for (const [cachedIndex, url] of urlCache) {
    if (cachedIndex < index - 1 || cachedIndex > index + 1) {
      URL.revokeObjectURL(url);
      urlCache.delete(cachedIndex);
    }
  }
}

function clearUrlCache(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// ---------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------

function fail(message: string): void {
  phase = 'error';
  errorMessage = message;
  shouldBePlaying = false;
  audio.pause();
  reportStatus();
}

function finish(): void {
  phase = 'idle';
  index = queue.length > 0 ? queue.length - 1 : 0;
  shouldBePlaying = false;
  audio.pause();
  reportStatus();
}

/** Tear down the current session: cancel fetches, release audio and URLs. */
function resetSession(): void {
  sessionId += 1;
  abortAllFetches();
  shouldBePlaying = false;
  pendingIndex = -1;
  phase = 'idle';
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  clearUrlCache();
  queue = [];
  index = 0;
  errorMessage = undefined;
}

function attachAndPlay(chunkIndex: number, url: string, playAfter = true): void {
  index = chunkIndex;
  pendingIndex = -1;
  audio.src = url;
  audio.playbackRate = speed;
  errorMessage = undefined;
  pruneUrlCache();
  if (playAfter) {
    shouldBePlaying = true;
    phase = 'playing';
    reportStatus();
    void audio
      .play()
      .then(() => {
        if (!shouldBePlaying) audio.pause();
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) fail(messageForKind('playback'));
      });
  } else {
    // Seek while paused: load the audio but stay paused.
    shouldBePlaying = false;
    phase = 'paused';
    reportStatus();
  }
}

async function loadChunk(chunkIndex: number, playAfter = true): Promise<void> {
  const chunk = queue[chunkIndex];
  if (!chunk) {
    finish();
    return;
  }
  const mySession = sessionId;
  pendingIndex = chunkIndex;
  const cachedUrl = urlCache.get(chunkIndex);
  if (cachedUrl) {
    attachAndPlay(chunkIndex, cachedUrl, playAfter);
    prefetch(chunkIndex + 1, mySession);
    return;
  }

  phase = 'loading';
  errorMessage = undefined;
  reportStatus();

  try {
    const blob = await fetchChunk(chunk);
    if (mySession !== sessionId) return; // superseded by stop/start
    if (pendingIndex !== chunkIndex) {
      // Superseded by a user seek while this chunk was fetching; the blob is
      // simply discarded (garbage collected).
      return;
    }
    const url = URL.createObjectURL(blob);
    urlCache.set(chunkIndex, url);
    attachAndPlay(chunkIndex, url, playAfter);
    prefetch(chunkIndex + 1, mySession);
  } catch (error) {
    if (mySession !== sessionId) return;
    if (isAbortError(error)) return; // cancelled, not a failure
    const mapped = fishErrorFromUnknown(error, [apiKey]);
    if (mapped) fail(mapped.message);
  }
}

async function prefetch(chunkIndex: number, mySession: number): Promise<void> {
  const chunk = queue[chunkIndex];
  if (!chunk || urlCache.has(chunkIndex) || mySession !== sessionId) return;
  try {
    const blob = await fetchChunk(chunk);
    if (mySession !== sessionId) return;
    const url = URL.createObjectURL(blob);
    urlCache.set(chunkIndex, url);
    pruneUrlCache();
  } catch {
    // Prefetch failures are non-fatal: the chunk is fetched on demand when
    // playback reaches it.
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function startReading(
  segments: readonly NarrationSegment[],
  voiceIdFromMessage: string,
  modelFromMessage: string,
  speedFromMessage: number,
): Promise<void> {
  // Stop and dispose of any previous session first.
  resetSession();

  const settings = await loadSettings(localStorageArea);
  if (!settings.apiKey) {
    fail(messageForKind('missing-api-key'));
    return;
  }
  apiKey = settings.apiKey;
  voiceId = voiceIdFromMessage;
  model = modelFromMessage;
  speed = clampSpeed(speedFromMessage);

  queue = chunkSegments(segments);
  if (queue.length === 0) {
    reportStatus();
    return;
  }
  void loadChunk(0);
}

function togglePlayPause(): void {
  if (phase === 'playing') {
    shouldBePlaying = false;
    audio.pause();
    phase = 'paused';
    reportStatus();
  } else if (phase === 'paused') {
    shouldBePlaying = true;
    phase = 'playing';
    reportStatus();
    void audio.play().catch((error: unknown) => {
      if (!isAbortError(error)) fail(messageForKind('playback'));
    });
  }
}

function previous(): void {
  if (queue.length === 0) return;
  if (index > 0) {
    void loadChunk(index - 1, phase !== 'paused');
  } else {
    // Already at the first chunk: restart it, keeping pause state.
    audio.currentTime = 0;
    if (phase !== 'paused') {
      shouldBePlaying = true;
      void audio.play().catch(() => undefined);
    }
  }
}

function next(): void {
  if (queue.length === 0 || index >= queue.length - 1) return;
  void loadChunk(index + 1, phase !== 'paused');
}

function stop(): void {
  resetSession();
  reportStatus();
}

function setSpeed(newSpeed: number): void {
  speed = clampSpeed(newSpeed);
  audio.playbackRate = speed;
  reportStatus();
}

function abortAllFetches(): void {
  for (const controller of activeFetches) controller.abort();
  activeFetches.clear();
}

audio.addEventListener('ended', () => {
  if (queue.length === 0) return;
  if (index < queue.length - 1) {
    void loadChunk(index + 1);
  } else {
    finish();
  }
});

audio.addEventListener('error', () => {
  if (phase === 'playing' || phase === 'loading') {
    fail(messageForKind('playback'));
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message) || message.target !== 'offscreen') return false;
  switch (message.type) {
    case 'START_READING':
      void startReading(message.segments, message.voiceId, message.model, message.speed);
      sendResponse({ ok: true });
      break;
    case 'PLAY_PAUSE':
      togglePlayPause();
      sendResponse({ ok: true });
      break;
    case 'PREVIOUS':
      previous();
      sendResponse({ ok: true });
      break;
    case 'NEXT':
      next();
      sendResponse({ ok: true });
      break;
    case 'STOP':
      stop();
      sendResponse({ ok: true });
      break;
    case 'UPDATE_SPEED':
      setSpeed(message.speed);
      sendResponse({ ok: true });
      break;
    case 'PING':
      sendResponse({ type: 'PONG', status: buildStatus() });
      break;
  }
  return false;
});
