// Offscreen document: owns the Fish Audio synthesis requests, the narration
// queue, and the <audio> element. Keeps playing while the popup is closed or
// the user switches tabs.
//
// Offscreen documents support only the chrome.runtime extension API (per the
// Chrome docs), so this controller uses no other chrome.* namespace — in
// particular no chrome.storage. The Fish Audio API key is delivered over
// runtime messaging as the unicast response to a GET_API_KEY request sent to
// the service worker; it never travels inside a broadcast message, is never
// stored or logged, and never leaves this trusted extension context.

import { chunkSegments, type NarrationChunk } from '../shared/chunking';
import { isApiKeyResponse, isExtensionMessage, type StartReadingAck } from '../shared/messages';
import {
  FishAudioError,
  fishErrorFromUnknown,
  isAbortError,
  messageForKind,
  parseFishErrorBody,
} from '../shared/errors';
import type { PlaybackStatus } from '../shared/playback';
import { clampSpeed } from '../shared/settings';
import type { NarrationSegment } from '../shared/segments';
import {
  applyPlaybackRate,
  buildTtsRequestBody,
  buildTtsRequestHeaders,
  ChunkFetchRegistry,
  ObjectUrlCache,
  TTS_ENDPOINT,
} from './audio-core';

const MAX_FETCH_RETRIES = 2;
const RETRY_DELAY_BASE_MS = 500;

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
/** At most one Fish request per chunk index, shared by prefetch and load. */
const inflight = new ChunkFetchRegistry();

/** The chunk currently being fetched (-1 when none). A seek supersedes it. */
let pendingIndex = -1;

/** index → object URL, bounded to a few chunks around the current one. */
const urlCache = new ObjectUrlCache();

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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetches one narration chunk from Fish Audio. A single AbortController is
 * shared across retries so a session reset cancels the whole sequence. The
 * user's narration speed is never sent to Fish: `prosody.speed` stays 1 and
 * playback speed is applied via `audio.playbackRate` only.
 */
async function fetchChunk(chunk: NarrationChunk, controller: AbortController, attempt = 0): Promise<Blob> {
  try {
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: buildTtsRequestHeaders(apiKey, model),
      body: JSON.stringify(buildTtsRequestBody(chunk.text, voiceId)),
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
      await abortableDelay(RETRY_DELAY_BASE_MS * (attempt + 1), controller.signal);
      return fetchChunk(chunk, controller, attempt + 1);
    }
    throw error;
  }
}

/**
 * Returns the shared in-flight fetch for `chunkIndex` (starting one if
 * needed), or null when the index is out of range. Prefetch and foreground
 * loading both go through here so the same text is never requested twice.
 */
function pendingFetchFor(chunkIndex: number): { promise: Promise<Blob>; controller: AbortController } | null {
  const chunk = queue[chunkIndex];
  if (!chunk) return null;
  const controller = new AbortController();
  return inflight.getOrStart(chunkIndex, () => ({
    promise: fetchChunk(chunk, controller),
    controller,
  }));
}

// ---------------------------------------------------------------------------
// Cache / object URLs
// ---------------------------------------------------------------------------

function pruneUrlCache(): void {
  urlCache.prune(index - 1, index + 1);
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
  inflight.abortAll();
  shouldBePlaying = false;
  pendingIndex = -1;
  phase = 'idle';
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  urlCache.clear();
  queue = [];
  index = 0;
  errorMessage = undefined;
}

function attachAndPlay(chunkIndex: number, url: string, playAfter = true): void {
  index = chunkIndex;
  pendingIndex = -1;
  audio.src = url;
  applyPlaybackRate(audio, speed);
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

  const pending = pendingFetchFor(chunkIndex);
  if (!pending) {
    finish();
    return;
  }
  try {
    const blob = await pending.promise;
    if (mySession !== sessionId) return; // superseded by stop/start
    if (pendingIndex !== chunkIndex) {
      // Superseded by a user seek while this chunk was fetching; the blob is
      // simply discarded (garbage collected). A prefetch sharing this request
      // caches the URL for later.
      return;
    }
    const url = urlCache.getOrCreate(chunkIndex, blob);
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
  const pending = pendingFetchFor(chunkIndex);
  if (!pending) return;
  try {
    const blob = await pending.promise;
    if (mySession !== sessionId) return;
    urlCache.getOrCreate(chunkIndex, blob);
    pruneUrlCache();
  } catch {
    // Prefetch failures are non-fatal: the chunk is fetched on demand when
    // playback reaches it. If a foreground load shares this request, it
    // reports the failure.
  }
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

/**
 * Requests the Fish Audio API key from the service worker. The key arrives as
 * a unicast runtime-message response addressed to this offscreen document;
 * the broadcast request payload carries no secret. Never logs or stores the
 * key.
 */
async function requestApiKey(): Promise<{ ok: true; apiKey: string } | { ok: false; error: string }> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'GET_API_KEY',
    });
    return isApiKeyResponse(response) ? response : { ok: false, error: messageForKind('unknown') };
  } catch {
    return { ok: false, error: messageForKind('unknown') };
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Starts a new narration session. Returns the acknowledgement that the
 * service worker validates before caching any loading state.
 */
async function startReading(
  segments: readonly NarrationSegment[],
  voiceIdFromMessage: string,
  modelFromMessage: string,
  speedFromMessage: number,
): Promise<StartReadingAck> {
  // Stop and dispose of any previous session first.
  resetSession();

  const keyResult = await requestApiKey();
  if (!keyResult.ok) {
    fail(keyResult.error);
    return { ok: false, error: keyResult.error };
  }
  apiKey = keyResult.apiKey;
  voiceId = voiceIdFromMessage;
  model = modelFromMessage;
  speed = clampSpeed(speedFromMessage);

  queue = chunkSegments(segments);
  if (queue.length === 0) {
    reportStatus();
    return { ok: true };
  }
  void loadChunk(0);
  return { ok: true };
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
  speed = applyPlaybackRate(audio, newSpeed);
  reportStatus();
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
      // Acknowledge only after the session has been accepted so the service
      // worker never reports success for a request that was never received.
      // Exactly one response is sent.
      void (async () => {
        try {
          const ack = await startReading(message.segments, message.voiceId, message.model, message.speed);
          sendResponse(ack);
        } catch {
          sendResponse({ ok: false, error: messageForKind('unknown') });
        }
      })();
      return true; // response is sent asynchronously
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
