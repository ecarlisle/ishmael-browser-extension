// Settings persistence on top of chrome.storage.local.
//
// The storage area is injected so unit tests can use a fake without touching
// browser APIs. The API key is only ever read by trusted extension contexts
// (service worker and offscreen document). All keys are namespaced under
// `ishmael.` so they read clearly in storage inspection.

import { redactSettings, sanitizeSettings, type RedactedSettings, type Settings } from './settings';

export type SettingsStorage = {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

const KEY_PREFIX = 'ishmael.';
const SETTING_KEYS = ['apiKey', 'voiceId', 'model', 'speed', 'mood'] as const;

export async function loadSettings(storage: SettingsStorage): Promise<Settings> {
  const raw = await storage.get(SETTING_KEYS.map((key) => `${KEY_PREFIX}${key}`));
  const normalized: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    normalized[key] = raw[`${KEY_PREFIX}${key}`];
  }
  return sanitizeSettings(normalized);
}

export async function loadRedactedSettings(storage: SettingsStorage): Promise<RedactedSettings> {
  return redactSettings(await loadSettings(storage));
}

export async function saveSettings(storage: SettingsStorage, patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings(storage);
  const merged = sanitizeSettings({ ...current, ...patch });
  await storage.set({
    [`${KEY_PREFIX}apiKey`]: merged.apiKey,
    [`${KEY_PREFIX}voiceId`]: merged.voiceId,
    [`${KEY_PREFIX}model`]: merged.model,
    [`${KEY_PREFIX}speed`]: merged.speed,
    [`${KEY_PREFIX}mood`]: merged.mood,
  });
  return merged;
}

export async function removeApiKey(storage: SettingsStorage): Promise<void> {
  await storage.remove([`${KEY_PREFIX}apiKey`]);
}
