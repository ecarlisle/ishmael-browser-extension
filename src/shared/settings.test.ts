import { describe, expect, it } from 'vitest';
import { clampSpeed, isSettings, redactSettings, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('applies defaults for empty/unknown input', () => {
    const settings = sanitizeSettings(null);
    expect(settings).toEqual({ apiKey: '', voiceId: '', model: 's2.1-pro-free', speed: 1 });
  });

  it('trims apiKey and voiceId', () => {
    const settings = sanitizeSettings({ apiKey: '  key  ', voiceId: '  voice  ' });
    expect(settings.apiKey).toBe('key');
    expect(settings.voiceId).toBe('voice');
  });

  it('falls back to the default model for invalid values', () => {
    expect(sanitizeSettings({ model: 'gpt-4' }).model).toBe('s2.1-pro-free');
    expect(sanitizeSettings({ model: 's2-pro' }).model).toBe('s2-pro');
  });

  it('clamps and rounds speed to one decimal', () => {
    expect(sanitizeSettings({ speed: 9 }).speed).toBe(2);
    expect(sanitizeSettings({ speed: 0 }).speed).toBe(0.5);
    expect(sanitizeSettings({ speed: 1.234 }).speed).toBe(1.2);
    expect(sanitizeSettings({ speed: 'fast' }).speed).toBe(1);
  });
});

describe('clampSpeed', () => {
  it('clamps within 0.5–2 and rounds to one decimal', () => {
    expect(clampSpeed(0.2)).toBe(0.5);
    expect(clampSpeed(2.5)).toBe(2);
    expect(clampSpeed(1.05)).toBe(1.1);
    expect(clampSpeed(1)).toBe(1);
  });
});

describe('redactSettings', () => {
  it('never includes the apiKey value in the redacted shape', () => {
    const redacted = redactSettings({ apiKey: 'super-secret', voiceId: 'v', model: 's2.1-pro-free', speed: 1 });
    expect(redacted).toEqual({ hasApiKey: true, voiceId: 'v', model: 's2.1-pro-free', speed: 1 });
    expect('apiKey' in redacted).toBe(false);
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
  });

  it('reports hasApiKey false for empty keys', () => {
    expect(redactSettings(sanitizeSettings({})).hasApiKey).toBe(false);
  });
});

describe('isSettings', () => {
  it('accepts valid settings and rejects malformed shapes', () => {
    const valid = { apiKey: 'k', voiceId: 'v', model: 's1', speed: 1.2 };
    expect(isSettings(valid)).toBe(true);
    expect(isSettings({ ...valid, model: 'nope' })).toBe(false);
    expect(isSettings({ ...valid, speed: NaN })).toBe(false);
    expect(isSettings({ ...valid, apiKey: 42 })).toBe(false);
    expect(isSettings(null)).toBe(false);
  });
});
