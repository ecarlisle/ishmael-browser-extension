// User settings and their storage representation.
//
// The Fish Audio API key is stored in chrome.storage.local (see README for
// the privacy trade-off) and must never appear in messages back to the popup,
// logs, or error strings.

// fallow-ignore-next-line unused-export
export const MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'] as const;
export type Model = (typeof MODELS)[number];

// fallow-ignore-next-line unused-export
export const DEFAULT_MODEL: Model = 's2.1-pro-free';
// fallow-ignore-next-line unused-export
export const MIN_SPEED = 0.5;
// fallow-ignore-next-line unused-export
export const MAX_SPEED = 2;
export const DEFAULT_SPEED = 1;

/**
 * Optional emotional delivery applied to the entire reading. `none` (the
 * default) preserves the page's natural tone; every other value maps to a
 * square-bracket Fish Audio cue such as `[calm]` or `[happy]`.
 */
export const MOODS = [
  'none',
  'calm',
  'happy',
  'sad',
  'excited',
  'confident',
  'curious',
  'empathetic',
  'relaxed',
  'hopeful',
  'nostalgic',
  'serious',
  'nervous',
  'worried',
  'angry',
  'sarcastic',
] as const;
export type Mood = (typeof MOODS)[number];

// fallow-ignore-next-line unused-export
export const DEFAULT_MOOD: Mood = 'none';

export type Settings = {
  apiKey: string;
  voiceId: string;
  model: Model;
  speed: number;
  mood: Mood;
};

/** Shape safe to return to the popup: the API key itself is never included. */
export type RedactedSettings = {
  hasApiKey: boolean;
  voiceId: string;
  model: Model;
  speed: number;
  mood: Mood;
};

export function clampSpeed(value: number): number {
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
  return Math.round(clamped * 10) / 10;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates and normalizes settings read from storage. Unknown fields are
 * dropped, invalid values fall back to defaults. Never throws. Missing or
 * invalid mood values sanitize to `none`.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const record = isRecord(raw) ? raw : {};
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
  const voiceId = typeof record.voiceId === 'string' ? record.voiceId.trim() : '';
  const model: Model = MODELS.includes(record.model as Model) ? (record.model as Model) : DEFAULT_MODEL;
  const speed =
    typeof record.speed === 'number' && Number.isFinite(record.speed) ? clampSpeed(record.speed) : DEFAULT_SPEED;
  const mood: Mood = MOODS.includes(record.mood as Mood) ? (record.mood as Mood) : DEFAULT_MOOD;
  return { apiKey, voiceId, model, speed, mood };
}

export function isSettings(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  if (typeof value.apiKey !== 'string') return false;
  if (typeof value.voiceId !== 'string') return false;
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed)) return false;
  if (!MOODS.includes(value.mood as Mood)) return false;
  return MODELS.includes(value.model as Model);
}

export function redactSettings(settings: Settings): RedactedSettings {
  return {
    hasApiKey: settings.apiKey.length > 0,
    voiceId: settings.voiceId,
    model: settings.model,
    speed: settings.speed,
    mood: settings.mood,
  };
}
