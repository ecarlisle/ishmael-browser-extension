// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyPlaybackRate,
  buildTtsRequestBody,
  buildTtsRequestHeaders,
  ChunkFetchRegistry,
  ObjectUrlCache,
} from './audio-core';

function deferred(): {
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Blob>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('buildTtsRequestBody', () => {
  it('pins prosody.speed to 1 for any user speed setting (0.5 and 2)', () => {
    expect(buildTtsRequestBody('Text.', 'v').prosody.speed).toBe(1);
    const atHalf = buildTtsRequestBody('Text.', 'v');
    const atDouble = buildTtsRequestBody('Text.', 'v');
    expect(atHalf).toEqual(atDouble);
    expect(atDouble.prosody.speed).toBe(1);
  });

  it('places the voice reference ID in reference_id', () => {
    expect(buildTtsRequestBody('Hello.', 'voice-ref-123').reference_id).toBe('voice-ref-123');
  });

  it('never carries the model, the API key, or any authorization value', () => {
    const body = buildTtsRequestBody('Hello.', 'voice-ref-123') as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('Authorization');
  });

  it('keeps mp3 format, normalize, volume 0, and normalize_loudness unchanged', () => {
    const body = buildTtsRequestBody('Hello.', 'v');
    expect(body.format).toBe('mp3');
    expect(body.normalize).toBe(true);
    expect(body.prosody.volume).toBe(0);
    expect(body.prosody.normalize_loudness).toBe(true);
  });
});

describe('buildTtsRequestHeaders', () => {
  it('sends the model as a header — never the voice reference ID', () => {
    const headers = buildTtsRequestHeaders('secret-key', 's2.1-pro-free');
    expect(headers.model).toBe('s2.1-pro-free');
    expect(headers.model).not.toContain('voice-ref');
  });

  it('sends the API key as a Bearer token and no reference_id', () => {
    const headers = buildTtsRequestHeaders('secret-key', 's2.1-pro-free');
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(JSON.stringify(headers)).not.toContain('reference_id');
  });
});

describe('applyPlaybackRate', () => {
  it('applies the user speed to the audio element through playbackRate only', () => {
    const audio = new Audio();
    expect(applyPlaybackRate(audio, 2)).toBe(2);
    expect(audio.playbackRate).toBe(2);
    expect(applyPlaybackRate(audio, 0.5)).toBe(0.5);
    expect(audio.playbackRate).toBe(0.5);
  });

  it('clamps out-of-range speeds to the 0.5–2.0 range', () => {
    const audio = new Audio();
    expect(applyPlaybackRate(audio, 99)).toBe(2);
    expect(audio.playbackRate).toBe(2);
    expect(applyPlaybackRate(audio, 0.1)).toBe(0.5);
    expect(audio.playbackRate).toBe(0.5);
  });
});

describe('ChunkFetchRegistry', () => {
  it('shares one in-flight request between a prefetch and a foreground load of the same chunk', async () => {
    const registry = new ChunkFetchRegistry();
    const { promise, resolve } = deferred();
    let startCount = 0;
    const start = () => {
      startCount += 1;
      return { promise, controller: new AbortController() };
    };

    const prefetch = registry.getOrStart(0, start);
    const foreground = registry.getOrStart(0, start);
    expect(startCount).toBe(1);
    expect(foreground).toBe(prefetch);
    expect(registry.has(0)).toBe(true);

    resolve(new Blob(['audio']));
    await promise;
    expect(registry.has(0)).toBe(false);
  });

  it('keeps requests for different chunk indexes independent', () => {
    const registry = new ChunkFetchRegistry();
    const first = deferred();
    const second = deferred();
    registry.getOrStart(1, () => ({ promise: first.promise, controller: new AbortController() }));
    registry.getOrStart(2, () => ({ promise: second.promise, controller: new AbortController() }));
    expect(registry.has(1)).toBe(true);
    expect(registry.has(2)).toBe(true);
    expect(registry.size).toBe(2);
  });

  it('removes failed entries so the same chunk can be retried later', async () => {
    const registry = new ChunkFetchRegistry();
    let current = deferred();
    let startCount = 0;
    const start = () => {
      startCount += 1;
      return { promise: current.promise, controller: new AbortController() };
    };

    registry.getOrStart(0, start);
    current.reject(new Error('network down'));
    await current.promise.catch(() => undefined);
    expect(registry.has(0)).toBe(false);

    // A later attempt for the same chunk starts a fresh request.
    current = deferred();
    registry.getOrStart(0, start);
    expect(startCount).toBe(2);
    expect(registry.has(0)).toBe(true);
  });

  it('aborts and clears all pending work on session reset', () => {
    const registry = new ChunkFetchRegistry();
    const controller = new AbortController();
    registry.getOrStart(0, () => ({ promise: deferred().promise, controller }));
    expect(registry.size).toBe(1);
    registry.abortAll();
    expect(controller.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('a stale settled request cannot evict a newer request for the same index', async () => {
    const registry = new ChunkFetchRegistry();
    const stale = deferred();
    registry.getOrStart(0, () => ({ promise: stale.promise, controller: new AbortController() }));
    registry.abortAll();

    const fresh = deferred();
    registry.getOrStart(0, () => ({ promise: fresh.promise, controller: new AbortController() }));
    expect(registry.has(0)).toBe(true);

    // The stale (previous session) request settles late: it must not evict
    // the newer entry for the same index.
    stale.resolve(new Blob(['stale']));
    await stale.promise;
    expect(registry.has(0)).toBe(true);

    fresh.resolve(new Blob(['fresh']));
    await fresh.promise;
    expect(registry.has(0)).toBe(false);
  });
});

describe('ObjectUrlCache', () => {
  it('creates exactly one object URL per chunk and reuses it', () => {
    const created: string[] = [];
    const cache = new ObjectUrlCache(
      () => {
        const url = `blob:${created.length}`;
        created.push(url);
        return url;
      },
      () => undefined,
    );
    const first = cache.getOrCreate(3, new Blob(['x']));
    const second = cache.getOrCreate(3, new Blob(['x']));
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
  });

  it('prunes and revokes URLs outside the keep window', () => {
    const revoked: string[] = [];
    const cache = new ObjectUrlCache(() => 'blob:url', (url) => revoked.push(url));
    cache.getOrCreate(0, new Blob(['a']));
    cache.getOrCreate(4, new Blob(['b']));
    cache.prune(1, 3);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(4)).toBe(false);
    expect(revoked).toEqual(['blob:url', 'blob:url']);
  });

  it('clear revokes every cached URL', () => {
    const revoked: string[] = [];
    const cache = new ObjectUrlCache(() => 'blob:u', (url) => revoked.push(url));
    cache.getOrCreate(0, new Blob(['a']));
    cache.getOrCreate(1, new Blob(['b']));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(revoked).toHaveLength(2);
  });
});
