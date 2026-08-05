// Settings persistence on top of chrome.storage.local.
//
// The storage area is injected so unit tests can use a fake without touching
// browser APIs. The API key is only ever read by trusted extension contexts
// (service worker and offscreen document).

import { redactSettings, sanitizeSettings, type RedactedSettings, type Settings } from './settings';

export interface SettingsStorage {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

const STORAGE_KEYS = ['apiKey', 'voiceId', 'model', 'speed'] as const;

export async function loadSettings(storage: SettingsStorage): Promise<Settings> {
  const raw = await storage.get(STORAGE_KEYS);
  return sanitizeSettings(raw);
}

export async function loadRedactedSettings(storage: SettingsStorage): Promise<RedactedSettings> {
  return redactSettings(await loadSettings(storage));
}

export async function saveSettings(storage: SettingsStorage, patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings(storage);
  const merged = sanitizeSettings({ ...current, ...patch });
  await storage.set({
    apiKey: merged.apiKey,
    voiceId: merged.voiceId,
    model: merged.model,
    speed: merged.speed,
  });
  return merged;
}

export async function removeApiKey(storage: SettingsStorage): Promise<void> {
  await storage.remove(['apiKey']);
}
