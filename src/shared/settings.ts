// User settings and their storage representation.
//
// The Fish Audio API key is stored in chrome.storage.local (see README for
// the privacy trade-off) and must never appear in messages back to the popup,
// logs, or error strings.

export const MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'] as const;
export type Model = (typeof MODELS)[number];

export const DEFAULT_MODEL: Model = 's2.1-pro-free';
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const DEFAULT_SPEED = 1;

export type Settings = {
  apiKey: string;
  voiceId: string;
  model: Model;
  speed: number;
};

/** Shape safe to return to the popup: the API key itself is never included. */
export type RedactedSettings = {
  hasApiKey: boolean;
  voiceId: string;
  model: Model;
  speed: number;
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
 * dropped, invalid values fall back to defaults. Never throws.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const record = isRecord(raw) ? raw : {};
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
  const voiceId = typeof record.voiceId === 'string' ? record.voiceId.trim() : '';
  const model: Model = MODELS.includes(record.model as Model) ? (record.model as Model) : DEFAULT_MODEL;
  const speed =
    typeof record.speed === 'number' && Number.isFinite(record.speed) ? clampSpeed(record.speed) : DEFAULT_SPEED;
  return { apiKey, voiceId, model, speed };
}

export function isSettings(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  if (typeof value.apiKey !== 'string') return false;
  if (typeof value.voiceId !== 'string') return false;
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed)) return false;
  return MODELS.includes(value.model as Model);
}

export function redactSettings(settings: Settings): RedactedSettings {
  return {
    hasApiKey: settings.apiKey.length > 0,
    voiceId: settings.voiceId,
    model: settings.model,
    speed: settings.speed,
  };
}
