// Extension message contract and validators.
//
// chrome.runtime.sendMessage broadcasts to every extension context, so every
// message carries a `target` field naming the context that owns it. All other
// contexts ignore it. Data crossing a context boundary is re-validated by the
// receiver.

import { isNarrationSegments, type NarrationSegment } from './segments';
import { MOODS, type Mood, type Settings } from './settings';
import { sanitizePlaybackStatus, type PlaybackStatus } from './playback';
import { isRecord } from './settings';

export type ExtensionMessage =
  // Popup → service worker
  | { target: 'service-worker'; type: 'GET_SETTINGS' }
  | { target: 'service-worker'; type: 'SAVE_SETTINGS'; patch: Partial<Settings> }
  | { target: 'service-worker'; type: 'REMOVE_API_KEY' }
  | { target: 'service-worker'; type: 'GET_STATUS' }
  | { target: 'service-worker'; type: 'READ_PAGE' }
  | { target: 'service-worker'; type: 'READ_SELECTION' }
  | { target: 'service-worker'; type: 'PLAY_PAUSE' }
  | { target: 'service-worker'; type: 'PREVIOUS' }
  | { target: 'service-worker'; type: 'NEXT' }
  | { target: 'service-worker'; type: 'STOP' }
  // Offscreen → service worker (and popup, for live UI updates)
  | { target: 'service-worker'; type: 'PLAYBACK_STATE'; status: PlaybackStatus }
  // Offscreen → service worker. The Fish Audio API key is delivered only as
  // the unicast response to this request — never inside a broadcast payload —
  // so content scripts (which receive every runtime message) never see it.
  | { target: 'service-worker'; type: 'GET_API_KEY' }
  // Service worker → offscreen
  | {
      target: 'offscreen';
      type: 'START_READING';
      segments: NarrationSegment[];
      voiceId: string;
      model: string;
      speed: number;
      mood: Mood;
    }
  | { target: 'offscreen'; type: 'PLAY_PAUSE' }
  | { target: 'offscreen'; type: 'PREVIOUS' }
  | { target: 'offscreen'; type: 'NEXT' }
  | { target: 'offscreen'; type: 'STOP' }
  | { target: 'offscreen'; type: 'UPDATE_SPEED'; speed: number }
  | { target: 'offscreen'; type: 'PING' }
  // Service worker → content script (tab-scoped, sent with tabs.sendMessage)
  | { target: 'content'; type: 'EXTRACT'; source: 'page' | 'selection' };

const SERVICE_WORKER_SIMPLE_TYPES: readonly string[] = [
  'GET_SETTINGS',
  'REMOVE_API_KEY',
  'GET_STATUS',
  'READ_PAGE',
  'READ_SELECTION',
  'PLAY_PAUSE',
  'PREVIOUS',
  'NEXT',
  'STOP',
  'GET_API_KEY',
];

const OFFSCREEN_SIMPLE_TYPES: readonly string[] = ['PLAY_PAUSE', 'PREVIOUS', 'NEXT', 'STOP', 'PING'];

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value)) return false;
  const target = value.target;
  const type = value.type;
  if (typeof target !== 'string' || typeof type !== 'string') return false;

  if (target === 'content') {
    return type === 'EXTRACT' && (value.source === 'page' || value.source === 'selection');
  }
  if (target === 'offscreen') {
    if (OFFSCREEN_SIMPLE_TYPES.includes(type)) return true;
    if (type === 'UPDATE_SPEED') {
      return typeof value.speed === 'number' && Number.isFinite(value.speed);
    }
    if (type === 'START_READING') {
      return (
        isNarrationSegments(value.segments) &&
        typeof value.voiceId === 'string' &&
        typeof value.model === 'string' &&
        typeof value.speed === 'number' &&
        Number.isFinite(value.speed) &&
        MOODS.includes(value.mood as Mood)
      );
    }
    return false;
  }
  if (target === 'service-worker') {
    if (SERVICE_WORKER_SIMPLE_TYPES.includes(type)) return true;
    if (type === 'SAVE_SETTINGS') {
      return isRecord(value.patch);
    }
    if (type === 'PLAYBACK_STATE') {
      return sanitizePlaybackStatus(value.status) !== null;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type ExtractionResult =
  | { ok: true; segments: NarrationSegment[] }
  | { ok: false; code: string; message: string };

export function isExtractionResult(value: unknown): value is ExtractionResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isNarrationSegments(value.segments);
  if (value.ok === false) {
    return typeof value.code === 'string' && typeof value.message === 'string';
  }
  return false;
}

export type PongResponse = { type: 'PONG'; status: PlaybackStatus };

export function isPongResponse(value: unknown): value is PongResponse {
  if (!isRecord(value)) return false;
  return value.type === 'PONG' && sanitizePlaybackStatus(value.status) !== null;
}

/**
 * Acknowledgement sent by the offscreen controller for START_READING. Success
 * means the controller accepted the narration session, so the service worker
 * can safely cache a loading state; failure carries a concise, redacted,
 * user-facing error.
 */
export type StartReadingAck = { ok: true } | { ok: false; error: string };

export function isStartReadingAck(value: unknown): value is StartReadingAck {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && typeof value.error === 'string' && value.error.length > 0;
}

/**
 * Service worker's response to a GET_API_KEY request. The key is delivered
 * only to the requesting offscreen document (runtime-message responses are
 * unicast to the sender), is never stored in playback status or session
 * history, and is never included in error messages.
 */
export type ApiKeyResponse = { ok: true; apiKey: string } | { ok: false; error: string };

export function isApiKeyResponse(value: unknown): value is ApiKeyResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return typeof value.apiKey === 'string' && value.apiKey.length > 0;
  return value.ok === false && typeof value.error === 'string' && value.error.length > 0;
}
