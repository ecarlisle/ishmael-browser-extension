// Playback state shared between the offscreen audio controller, the service
// worker cache, and the popup display.

import { clampSpeed, DEFAULT_SPEED, isRecord } from './settings';

export type PlaybackPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export const PLAYBACK_PHASES: readonly PlaybackPhase[] = ['idle', 'loading', 'playing', 'paused', 'error'];

export type PlaybackStatus = {
  phase: PlaybackPhase;
  /** 0-based index of the current narration chunk. */
  index: number;
  total: number;
  speed: number;
  /** Present only when phase is 'error'. User-facing, already redacted. */
  error?: string;
};

export function createIdleStatus(): PlaybackStatus {
  return { phase: 'idle', index: 0, total: 0, speed: DEFAULT_SPEED };
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Validates a playback status crossing an extension-message boundary.
 * Returns `null` when the value is not a usable status. Values are clamped so
 * a slightly-off sender cannot crash the receiver.
 */
export function sanitizePlaybackStatus(raw: unknown): PlaybackStatus | null {
  if (!isRecord(raw)) return null;
  const phase = PLAYBACK_PHASES.includes(raw.phase as PlaybackPhase) ? (raw.phase as PlaybackPhase) : null;
  if (!phase) return null;
  const index = toNonNegativeInt(raw.index);
  const total = toNonNegativeInt(raw.total);
  if (index === null || total === null) return null;
  const speed = typeof raw.speed === 'number' ? clampSpeed(raw.speed) : DEFAULT_SPEED;
  const error = typeof raw.error === 'string' && raw.error.length > 0 ? raw.error.slice(0, 300) : undefined;
  const status: PlaybackStatus = { phase, index, total, speed };
  if (error) status.error = error;
  return status;
}
