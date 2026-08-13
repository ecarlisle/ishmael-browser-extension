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

import { chunkSegments } from '../shared/chunking';
import { decorateChunks, type DecoratedChunk } from '../shared/decorate';
import { isApiKeyResponse, isExtensionMessage, type StartReadingAck } from '../shared/messages';
import {
  FishAudioError,
  fishErrorFromUnknown,
  isAbortError,
  messageForKind,
  parseFishErrorBody,
} from '../shared/errors';
import type { PlaybackStatus } from '../shared/playback';
import { clampSpeed, type Mood } from '../shared/settings';
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

let queue: DecoratedChunk[] = [];
let index = 0;
let phase: PlaybackStatus['phase'] = 'idle';
let errorMessage: string | undefined;

/** Incremented whenever a session starts or stops; stale async work checks it. */
let sessionId = 0;
/** At most one Fish request per chunk index, shared by prefetch and load. */
const inflight = new ChunkFetchRegistry();

/** The chunk currently being fetched (-1 when none). A seek supersedes it. */
let pendingIndex = -1;

/** Cancellable holder for the inter-file semantic pause. */
let pauseController: AbortController | undefined;

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
 * Reads a response body as a stream so the controller can observe when the
 * API has actually started sending audio bytes (the generating → buffering
 * transition) instead of guessing from timing. Falls back to `blob()` in
 * environments without a readable body.
 */
async function readResponseBody(response: Response, onFirstBytes: () => void): Promise<Blob> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > 0) onFirstBytes();
    return blob;
  }
  const parts: BlobPart[] = [];
  let first = true;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        onFirstBytes();
        first = false;
      }
      if (value) parts.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new Blob(parts, { type: response.headers.get('content-type') ?? 'audio/mpeg' });
}

/**
 * Fetches one narration chunk from Fish Audio. A single AbortController is
 * shared across retries so a session reset cancels the whole sequence. The
 * user's narration speed is never sent to Fish: `prosody.speed` stays 1 and
 * playback speed is applied via `audio.playbackRate` only.
 *
 * `onFetchPhase` reports the fetch pipeline's observable stages: the request
 * is initiated (connecting), the API accepted it (generating), and the first
 * audio bytes have arrived (buffering). Retries keep the phase at connecting.
 */
async function fetchChunk(
  chunk: DecoratedChunk,
  controller: AbortController,
  onFetchPhase?: (phase: 'connecting' | 'generating' | 'buffering') => void,
  attempt = 0,
): Promise<Blob> {
  try {
    onFetchPhase?.('connecting');
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

    onFetchPhase?.('generating');
    const blob = await readResponseBody(response, () => onFetchPhase?.('buffering'));
    if (blob.size === 0) {
      throw new Error('empty response');
    }
    return blob;
  } catch (error) {
    // Retry transient network/empty-response failures a couple of times.
    // Explicit Fish Audio HTTP errors are not retried so rate limits and
    // balance errors surface immediately.
    if (!isAbortError(error) && !(error instanceof FishAudioError) && attempt < MAX_FETCH_RETRIES) {
      // The attempt failed and the next one goes back to the network:
      // report connecting before the retry delay so the state never lingers
      // on generating from an attempt that produced nothing.
      onFetchPhase?.('connecting');
      await abortableDelay(RETRY_DELAY_BASE_MS * (attempt + 1), controller.signal);
      return fetchChunk(chunk, controller, onFetchPhase, attempt + 1);
    }
    throw error;
  }
}

/**
 * Returns the shared in-flight fetch for `chunkIndex` (starting one if
 * needed), or null when the index is out of range. Prefetch and foreground
 * loading both go through here so the same text is never requested twice.
 * The optional callback reports the fetch's observable stages but is only
 * attached when this call starts the fetch: a prefetch-started request stays
 * silent so it never clobbers the phase of a different foreground chunk.
 */
function pendingFetchFor(
  chunkIndex: number,
  onFetchPhase?: (phase: 'connecting' | 'generating' | 'buffering') => void,
): { promise: Promise<Blob>; controller: AbortController } | null {
  const chunk = queue[chunkIndex];
  if (!chunk) return null;
  const controller = new AbortController();
  return inflight.getOrStart(chunkIndex, () => ({
    promise: fetchChunk(chunk, controller, onFetchPhase),
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
  phase = 'complete';
  index = queue.length > 0 ? queue.length - 1 : 0;
  shouldBePlaying = false;
  audio.pause();
  reportStatus();
}

/** Tear down the current session: cancel fetches, release audio and URLs. */
function resetSession(): void {
  sessionId += 1;
  inflight.abortAll();
  pauseController?.abort();
  pauseController = undefined;
  shouldBePlaying = false;
  pendingIndex = -1;
  phase = 'stopped';
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
    // Attached but not yet playing: the `playing` media event flips this to
    // playing, and `waiting` may report buffering while the pipeline waits
    // for playable audio.
    phase = 'buffering';
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

function phaseIs(pending: PlaybackStatus['phase']): boolean {
  return phase === pending;
}

async function loadChunk(chunkIndex: number, playAfter = true, opts: { skipInterChunkPause?: boolean } = {}): Promise<void> {
  const chunk = queue[chunkIndex];
  if (!chunk) {
    finish();
    return;
  }
  const mySession = sessionId;
  pendingIndex = chunkIndex;
  const cachedUrl = urlCache.get(chunkIndex);
  if (cachedUrl) {
    if (!(await interChunkPause(chunkIndex, mySession, opts))) return;
    if (mySession !== sessionId || pendingIndex !== chunkIndex) return;
    if (phaseIs('paused')) playAfter = false;
    attachAndPlay(chunkIndex, cachedUrl, playAfter);
    prefetch(chunkIndex + 1, mySession);
    return;
  }

  phase = 'connecting';
  errorMessage = undefined;
  reportStatus();

  const pending = pendingFetchFor(chunkIndex, (fetchPhase) => {
    // Only this chunk's foreground fetch may change the phase: a superseded
    // load (the user seeked away) or a stale session must not clobber the
    // current state.
    if (mySession === sessionId && pendingIndex === chunkIndex) {
      phase = fetchPhase;
      reportStatus();
    }
  });
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
    if (!(await interChunkPause(chunkIndex, mySession, opts))) return;
    if (mySession !== sessionId || pendingIndex !== chunkIndex) return;
    if (phaseIs('paused')) playAfter = false;
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

/**
 * Holds playback for the inter-file semantic pause before `chunkIndex`'s
 * audio starts (see `INTER_CHUNK_PAUSE_MS`). The pause is cancellable: Stop,
 * Previous, Next, a new session, or a user seek abort it, and an aborted
 * pause never begins audio. Returns false when superseded so the caller backs
 * off. No pause is applied between pieces of the same long paragraph, nor
 * where the previous chunk's own audio already ends with a synthesized tag.
 */
async function interChunkPause(
  chunkIndex: number,
  mySession: number,
  opts: { skipInterChunkPause?: boolean },
): Promise<boolean> {
  if (opts.skipInterChunkPause) return true;
  const ms = queue[chunkIndex]?.pauseBeforeMs ?? 0;
  if (ms <= 0 || mySession !== sessionId) return true;
  pauseController?.abort();
  const controller = new AbortController();
  pauseController = controller;
  try {
    await abortableDelay(ms, controller.signal);
  } catch {
    return false;
  }
  // Superseded while waiting (a newer command replaced the controller or the
  // session moved on): never begin audio from a stale timer.
  return pauseController === controller && mySession === sessionId && pendingIndex === chunkIndex;
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
 * service worker validates before reporting success. The session reports
 * its own phases from here on (preparing → connecting → … → playing).
 */
async function startReading(
  segments: readonly NarrationSegment[],
  voiceIdFromMessage: string,
  modelFromMessage: string,
  speedFromMessage: number,
  moodFromMessage: Mood,
): Promise<StartReadingAck> {
  // Stop and dispose of any previous session first.
  resetSession();

  // The session is accepted and being prepared (API key handshake, chunk
  // division). This phase never claims playback is happening.
  phase = 'preparing';
  reportStatus();

  const keyResult = await requestApiKey();
  if (!keyResult.ok) {
    fail(keyResult.error);
    return { ok: false, error: keyResult.error };
  }
  apiKey = keyResult.apiKey;
  voiceId = voiceIdFromMessage;
  model = modelFromMessage;
  speed = clampSpeed(speedFromMessage);

  // Chunk the extracted segments, then decorate each chunk with the Mood cue
  // (applied to every independently synthesized request) and structural cues
  // derived from page semantics. Source text is never altered.
  queue = decorateChunks(chunkSegments(segments), moodFromMessage);
  if (queue.length === 0) {
    // Nothing could be narrated: no session is in progress.
    phase = 'idle';
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
    // Resume does not claim "playing" optimistically: the media element's
    // `playing` event (or a `waiting` → `playing` chain) reports the phase.
    void audio.play().catch((error: unknown) => {
      if (!isAbortError(error)) fail(messageForKind('playback'));
    });
  }
}

function previous(): void {
  if (queue.length === 0) return;
  pauseController?.abort();
  if (index > 0) {
    void loadChunk(index - 1, phase !== 'paused', { skipInterChunkPause: true });
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
  pauseController?.abort();
  void loadChunk(index + 1, phase !== 'paused', { skipInterChunkPause: true });
}

function stop(): void {
  resetSession();
  reportStatus();
}

function setSpeed(newSpeed: number): void {
  speed = applyPlaybackRate(audio, newSpeed);
  reportStatus();
}

audio.addEventListener('playing', () => {
  // The only truthful source of "playing": the media element actually
  // started playback. The shouldBePlaying guard absorbs a pause/play race
  // where play() resolved after the user already paused.
  if (queue.length === 0 || !shouldBePlaying || phase === 'playing') return;
  phase = 'playing';
  reportStatus();
});

audio.addEventListener('waiting', () => {
  // The media pipeline is genuinely waiting for playable audio.
  if (queue.length === 0 || !shouldBePlaying || phase === 'buffering') return;
  phase = 'buffering';
  reportStatus();
});

audio.addEventListener('ended', () => {
  if (queue.length === 0) return;
  if (index < queue.length - 1) {
    void loadChunk(index + 1);
  } else {
    finish();
  }
});

audio.addEventListener('error', () => {
  // A decode/load failure can surface while a file is attached (playing,
  // buffering, or seek-while-paused); an ended/complete session is excluded.
  if (queue.length === 0 || phase === 'complete') return;
  if (phase === 'playing' || phase === 'buffering' || phase === 'paused') {
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
          const ack = await startReading(message.segments, message.voiceId, message.model, message.speed, message.mood);
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
