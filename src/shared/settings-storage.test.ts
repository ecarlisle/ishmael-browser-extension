import { describe, expect, it } from 'vitest';
import { loadRedactedSettings, loadSettings, removeApiKey, saveSettings, type SettingsStorage } from './settings-storage';

/** In-memory fake of chrome.storage.local. */
function fakeStorage(initial: Record<string, unknown> = {}): SettingsStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in data) result[key] = data[key];
      }
      return result;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of keys) delete data[key];
    },
  };
}

describe('settings storage', () => {
  it('loads defaults when storage is empty', async () => {
    const storage = fakeStorage();
    expect(await loadSettings(storage)).toEqual({ apiKey: '', voiceId: '', model: 's2.1-pro-free', speed: 1 });
  });

  it('round-trips saved settings', async () => {
    const storage = fakeStorage();
    await saveSettings(storage, { apiKey: 'key-123', voiceId: 'voice-456', model: 's2-pro', speed: 1.5 });
    const loaded = await loadSettings(storage);
    expect(loaded).toEqual({ apiKey: 'key-123', voiceId: 'voice-456', model: 's2-pro', speed: 1.5 });
  });

  it('merges partial patches without losing existing values', async () => {
    const storage = fakeStorage();
    await saveSettings(storage, { voiceId: 'voice-1' });
    await saveSettings(storage, { speed: 1.3 });
    const loaded = await loadSettings(storage);
    expect(loaded.voiceId).toBe('voice-1');
    expect(loaded.speed).toBe(1.3);
  });

  it('sanitizes junk stored directly in storage', async () => {
    const storage = fakeStorage({ 'ishmael.speed': 99, 'ishmael.model': 'bogus' });
    const loaded = await loadSettings(storage);
    expect(loaded.speed).toBe(2);
    expect(loaded.model).toBe('s2.1-pro-free');
  });

  it('stores settings under the ishmael.* key namespace', async () => {
    const storage = fakeStorage();
    await saveSettings(storage, { voiceId: 'v' });
    expect(storage.data).toHaveProperty('ishmael.voiceId', 'v');
    expect(storage.data).not.toHaveProperty('voiceId');
  });

  it('removeApiKey removes only the api key', async () => {
    const storage = fakeStorage({ 'ishmael.apiKey': 'k', 'ishmael.voiceId': 'v' });
    await removeApiKey(storage);
    expect(storage.data).not.toHaveProperty('ishmael.apiKey');
    expect(storage.data).toHaveProperty('ishmael.voiceId', 'v');
  });

  it('loadRedactedSettings hides the key value', async () => {
    const storage = fakeStorage({ 'ishmael.apiKey': 'top-secret', 'ishmael.voiceId': 'v' });
    const redacted = await loadRedactedSettings(storage);
    expect(redacted).toEqual({ hasApiKey: true, voiceId: 'v', model: 's2.1-pro-free', speed: 1 });
    expect(JSON.stringify(redacted)).not.toContain('top-secret');
  });
});
