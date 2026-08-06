import { describe, expect, it } from 'vitest';
import {
  isApiKeyResponse,
  isExtensionMessage,
  isExtractionResult,
  isPongResponse,
  isStartReadingAck,
} from './messages';
import { createIdleStatus } from './playback';

const validSegment = { id: 'p-1', kind: 'paragraph', text: 'Hello.' };

describe('isExtensionMessage', () => {
  it('accepts simple service-worker messages', () => {
    expect(isExtensionMessage({ target: 'service-worker', type: 'GET_SETTINGS' })).toBe(true);
    expect(isExtensionMessage({ target: 'service-worker', type: 'STOP' })).toBe(true);
    expect(isExtensionMessage({ target: 'service-worker', type: 'READ_SELECTION' })).toBe(true);
  });

  it('rejects unknown targets, types, and non-objects', () => {
    expect(isExtensionMessage({ target: 'service-worker', type: 'NOPE' })).toBe(false);
    expect(isExtensionMessage({ target: 'browser', type: 'GET_SETTINGS' })).toBe(false);
    expect(isExtensionMessage('GET_SETTINGS')).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage({})).toBe(false);
  });

  it('validates EXTRACT source values', () => {
    expect(isExtensionMessage({ target: 'content', type: 'EXTRACT', source: 'page' })).toBe(true);
    expect(isExtensionMessage({ target: 'content', type: 'EXTRACT', source: 'selection' })).toBe(true);
    expect(isExtensionMessage({ target: 'content', type: 'EXTRACT', source: 'everything' })).toBe(false);
  });

  it('validates START_READING payloads', () => {
    const good = {
      target: 'offscreen',
      type: 'START_READING',
      segments: [validSegment],
      voiceId: 'v',
      model: 's2.1-pro-free',
      speed: 1,
      mood: 'none',
    };
    expect(isExtensionMessage(good)).toBe(true);
    expect(isExtensionMessage({ ...good, segments: [{ ...validSegment, kind: 'bogus' }] })).toBe(false);
    expect(isExtensionMessage({ ...good, speed: 'fast' })).toBe(false);
    expect(isExtensionMessage({ ...good, segments: 'nope' })).toBe(false);
    expect(isExtensionMessage({ ...good, mood: 'euphoric' })).toBe(false);
    expect(isExtensionMessage({ ...good, mood: undefined })).toBe(false);
  });

  it('accepts segments carrying emphasis and thematic-break metadata', () => {
    const good = {
      target: 'offscreen',
      type: 'START_READING',
      segments: [{ ...validSegment, emphasis: [[0, 5]], thematicBreakBefore: true }],
      voiceId: 'v',
      model: 's2.1-pro-free',
      speed: 1,
      mood: 'calm',
    };
    expect(isExtensionMessage(good)).toBe(true);
    expect(isExtensionMessage({ ...good, segments: [{ ...validSegment, emphasis: [[0, 999]] }] })).toBe(false);
    expect(isExtensionMessage({ ...good, segments: [{ ...validSegment, emphasis: 'x' }] })).toBe(false);
    expect(isExtensionMessage({ ...good, segments: [{ ...validSegment, thematicBreakBefore: 'hr' }] })).toBe(false);
  });

  it('validates PLAYBACK_STATE status', () => {
    const good = { target: 'service-worker', type: 'PLAYBACK_STATE', status: createIdleStatus() };
    expect(isExtensionMessage(good)).toBe(true);
    expect(isExtensionMessage({ ...good, status: { phase: 'warping', index: 0, total: 1 } })).toBe(false);
    expect(isExtensionMessage({ ...good, status: { phase: 'playing', index: -1, total: 1 } })).toBe(false);
  });

  it('validates UPDATE_SPEED', () => {
    expect(isExtensionMessage({ target: 'offscreen', type: 'UPDATE_SPEED', speed: 1.5 })).toBe(true);
    expect(isExtensionMessage({ target: 'offscreen', type: 'UPDATE_SPEED', speed: NaN })).toBe(false);
  });
});

describe('isExtractionResult', () => {
  it('accepts success and failure shapes', () => {
    expect(isExtractionResult({ ok: true, segments: [validSegment] })).toBe(true);
    expect(isExtractionResult({ ok: false, code: 'no-content', message: 'Nope' })).toBe(true);
    expect(isExtractionResult({ ok: true, segments: [{ id: 1 }] })).toBe(false);
    expect(isExtractionResult({ ok: 'yes' })).toBe(false);
  });
});

describe('isPongResponse', () => {
  it('accepts valid PONG responses', () => {
    expect(isPongResponse({ type: 'PONG', status: createIdleStatus() })).toBe(true);
    expect(isPongResponse({ type: 'PONG', status: { phase: 'bogus' } })).toBe(false);
    expect(isPongResponse({ type: 'OTHER' })).toBe(false);
  });
});

describe('isStartReadingAck', () => {
  it('accepts success and failure acknowledgements', () => {
    expect(isStartReadingAck({ ok: true })).toBe(true);
    expect(isStartReadingAck({ ok: false, error: 'No API key saved.' })).toBe(true);
  });

  it('rejects malformed acknowledgements', () => {
    expect(isStartReadingAck({ ok: 'yes' })).toBe(false);
    expect(isStartReadingAck({ ok: false, error: '' })).toBe(false);
    expect(isStartReadingAck({ ok: true, extra: 1 })).toBe(true);
    expect(isStartReadingAck(null)).toBe(false);
    expect(isStartReadingAck({})).toBe(false);
  });
});

describe('isApiKeyResponse', () => {
  it('accepts a success response carrying the key and a redacted failure', () => {
    expect(isApiKeyResponse({ ok: true, apiKey: 'fish-key' })).toBe(true);
    expect(isApiKeyResponse({ ok: false, error: 'No Fish Audio API key saved.' })).toBe(true);
  });

  it('rejects malformed responses', () => {
    expect(isApiKeyResponse({ ok: true, apiKey: '' })).toBe(false);
    expect(isApiKeyResponse({ ok: true })).toBe(false);
    expect(isApiKeyResponse({ ok: false, error: '' })).toBe(false);
    expect(isApiKeyResponse({ ok: 'yes', apiKey: 'x' })).toBe(false);
    expect(isApiKeyResponse(null)).toBe(false);
    expect(isApiKeyResponse({})).toBe(false);
  });

  it('accepts GET_API_KEY as an extension message without any payload', () => {
    expect(isExtensionMessage({ target: 'service-worker', type: 'GET_API_KEY' })).toBe(true);
  });
});
