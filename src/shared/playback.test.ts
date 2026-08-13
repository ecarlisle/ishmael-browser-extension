import { describe, expect, it } from 'vitest';
import { createIdleStatus, sanitizePlaybackStatus } from './playback';

describe('sanitizePlaybackStatus', () => {
  it('accepts a well-formed status', () => {
    const status = sanitizePlaybackStatus({ phase: 'playing', index: 2, total: 10, speed: 1.2 });
    expect(status).toEqual({ phase: 'playing', index: 2, total: 10, speed: 1.2 });
  });

  it('accepts every documented playback phase', () => {
    for (const phase of ['idle', 'preparing', 'connecting', 'generating', 'buffering', 'playing', 'paused', 'complete', 'stopped', 'error']) {
      expect(sanitizePlaybackStatus({ phase, index: 0, total: 1, speed: 1 })?.phase).toBe(phase);
    }
  });

  it('rejects missing or invalid phases', () => {
    expect(sanitizePlaybackStatus({ phase: 'warping', index: 0, total: 1 })).toBeNull();
    expect(sanitizePlaybackStatus({ phase: 'loading', index: 0, total: 1 })).toBeNull();
    expect(sanitizePlaybackStatus(null)).toBeNull();
    expect(sanitizePlaybackStatus('playing')).toBeNull();
  });

  it('rejects negative or fractional indexes', () => {
    expect(sanitizePlaybackStatus({ phase: 'playing', index: -1, total: 5 })).toBeNull();
    expect(sanitizePlaybackStatus({ phase: 'playing', index: 1.5, total: 5 })).toBeNull();
  });

  it('clamps speed into the supported range', () => {
    const status = sanitizePlaybackStatus({ phase: 'playing', index: 0, total: 1, speed: 9 });
    expect(status?.speed).toBe(2);
  });

  it('carries a truncated error message', () => {
    const status = sanitizePlaybackStatus({ phase: 'error', index: 0, total: 3, error: 'x'.repeat(500) });
    expect(status?.error?.length).toBeLessThanOrEqual(300);
  });

  it('creates a sane idle status', () => {
    expect(createIdleStatus()).toEqual({ phase: 'idle', index: 0, total: 0, speed: 1 });
  });
});
