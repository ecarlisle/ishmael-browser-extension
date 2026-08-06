// Pure offscreen-controller helpers: deterministic Fish request shaping and
// the small registries that keep playback correct. No chrome.* APIs and no
// network here, so the module is unit-testable in isolation.

import { clampSpeed } from '../shared/settings';

export const TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';

// ---------------------------------------------------------------------------
// Fish request shaping
// ---------------------------------------------------------------------------

export type TtsRequestBody = {
  text: string;
  reference_id: string;
  format: 'mp3';
  normalize: true;
  prosody: {
    /** Pinned to 1: playback speed is applied by the browser only. */
    speed: 1;
    volume: 0;
    normalize_loudness: true;
  };
};

/**
 * Builds the JSON body for a Fish Audio TTS request. The user's narration
 * speed is deliberately NOT applied here: `prosody.speed` stays at 1 and the
 * browser's audio `playbackRate` (see `applyPlaybackRate`) is the single
 * speed-control mechanism, so the two never compound. Volume and
 * loudness-normalization behavior are unchanged.
 */
export function buildTtsRequestBody(text: string, referenceId: string): TtsRequestBody {
  return {
    text,
    reference_id: referenceId,
    format: 'mp3',
    normalize: true,
    prosody: { speed: 1, volume: 0, normalize_loudness: true },
  };
}

/**
 * Builds the HTTP headers for a Fish Audio TTS request. The model travels in
 * a header (per Fish's API); the voice/reference ID never appears here and is
 * never substituted for the API key.
 */
export function buildTtsRequestHeaders(apiKey: string, model: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    model,
  };
}

/**
 * Applies the user's narration speed to an audio element through browser
 * playback only, clamped to the supported 0.5–2.0 range. Returns the clamped
 * value.
 */
export function applyPlaybackRate(audio: HTMLAudioElement, speed: number): number {
  const clamped = clampSpeed(speed);
  audio.playbackRate = clamped;
  return clamped;
}

// ---------------------------------------------------------------------------
// In-flight Fish request registry
// ---------------------------------------------------------------------------

export type PendingFetch = {
  promise: Promise<Blob>;
  controller: AbortController;
};

/**
 * Tracks at most one in-flight Fish Audio fetch per narration-chunk index so
 * prefetch and foreground loading share a single request. Entries remove
 * themselves once their promise settles — resolved, rejected, or aborted — so
 * a later attempt for the same chunk starts a fresh request. `abortAll()`
 * cancels every outstanding request on session reset.
 */
export class ChunkFetchRegistry {
  private readonly pending = new Map<number, PendingFetch>();

  get size(): number {
    return this.pending.size;
  }

  has(index: number): boolean {
    return this.pending.has(index);
  }

  /**
   * Returns the pending fetch for `index`, or starts one via `start` and
   * registers it. `start` is invoked at most once per index while a request
   * is in flight.
   */
  getOrStart(index: number, start: () => PendingFetch): PendingFetch {
    const existing = this.pending.get(index);
    if (existing) return existing;
    const created = start();
    this.pending.set(index, created);
    void created.promise.then(
      () => this.removeIfOurs(index, created),
      () => this.removeIfOurs(index, created),
    );
    return created;
  }

  private removeIfOurs(index: number, created: PendingFetch): void {
    // Only remove the entry if it is still ours: a stale request settling
    // after `abortAll()` (e.g. from an earlier session) must not evict a
    // newer request registered for the same index.
    if (this.pending.get(index) === created) this.pending.delete(index);
  }

  /** Aborts and drops every outstanding request (session reset). */
  abortAll(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Object URL cache
// ---------------------------------------------------------------------------

/**
 * Bounded cache of blob object URLs keyed by chunk index. Guarantees exactly
 * one object URL per chunk, revokes URLs that fall outside the keep window,
 * and revokes everything on `clear()` so temporary resources are released.
 */
export class ObjectUrlCache {
  private readonly urls = new Map<number, string>();

  constructor(
    private readonly create: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
  ) {}

  get size(): number {
    return this.urls.size;
  }

  get(index: number): string | undefined {
    return this.urls.get(index);
  }

  has(index: number): boolean {
    return this.urls.has(index);
  }

  /** Returns the cached URL for `index` or creates exactly one for `blob`. */
  getOrCreate(index: number, blob: Blob): string {
    const existing = this.urls.get(index);
    if (existing) return existing;
    const url = this.create(blob);
    this.urls.set(index, url);
    return url;
  }

  /** Revokes URLs outside the keep window [minIndex, maxIndex]. */
  prune(minIndex: number, maxIndex: number): void {
    for (const [index, url] of this.urls) {
      if (index < minIndex || index > maxIndex) {
        this.revoke(url);
        this.urls.delete(index);
      }
    }
  }

  /** Revokes every cached URL. */
  clear(): void {
    for (const url of this.urls.values()) this.revoke(url);
    this.urls.clear();
  }
}
