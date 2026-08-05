import { describe, expect, it } from 'vitest';
import {
  FishAudioError,
  fishErrorFromStatus,
  fishErrorFromUnknown,
  isAbortError,
  messageForKind,
  parseFishErrorBody,
  sanitizeServerMessage,
} from './errors';

const SECRET_KEY = 'fish-live-key-1234567890';

describe('fishErrorFromStatus', () => {
  it('maps 401 to unauthorized', () => {
    const result = fishErrorFromStatus(401);
    expect(result.kind).toBe('unauthorized');
    expect(result.message).toContain('API key');
  });

  it('maps 402 to insufficient balance', () => {
    expect(fishErrorFromStatus(402).kind).toBe('insufficient-balance');
  });

  it('maps 429 to rate limit', () => {
    expect(fishErrorFromStatus(429).kind).toBe('rate-limit');
  });

  it('maps 400/422 mentioning a reference/model to invalid voice', () => {
    const result = fishErrorFromStatus(422, 'reference_id not found: abc');
    expect(result.kind).toBe('invalid-voice');
  });

  it('maps other 4xx to invalid request', () => {
    expect(fishErrorFromStatus(422, 'malformed payload').kind).toBe('invalid-request');
  });

  it('maps 5xx to server error', () => {
    expect(fishErrorFromStatus(503).kind).toBe('server-error');
  });

  it('maps unknown statuses to unknown', () => {
    expect(fishErrorFromStatus(418).kind).toBe('unknown');
  });
});

describe('fishErrorFromUnknown', () => {
  it('maps network failures to network', () => {
    const result = fishErrorFromUnknown(new TypeError('Failed to fetch'));
    expect(result?.kind).toBe('network');
  });

  it('maps FishAudioError through the status mapping', () => {
    const result = fishErrorFromUnknown(new FishAudioError(401));
    expect(result?.kind).toBe('unauthorized');
  });

  it('returns null for abort errors (callers treat them as cancellation)', () => {
    expect(fishErrorFromUnknown(new DOMException('Aborted', 'AbortError'))).toBeNull();
    expect(fishErrorFromUnknown({ name: 'AbortError' })).toBeNull();
  });

  it('maps unknown errors to unknown', () => {
    expect(fishErrorFromUnknown(new Error('boom'))?.kind).toBe('unknown');
  });
});

describe('secrets and detail handling', () => {
  it('never includes the API key in mapped messages', () => {
    const mapped = fishErrorFromUnknown(new FishAudioError(422, `bad token ${SECRET_KEY} here`), [SECRET_KEY]);
    expect(mapped?.message).not.toContain(SECRET_KEY);
    expect(mapped?.message).not.toContain('fish-live-key');
  });

  it('sanitizeServerMessage redacts secrets, collapses whitespace, and truncates', () => {
    const message = sanitizeServerMessage(`long detail with ${SECRET_KEY} and   spaces`, [SECRET_KEY]);
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain('  ');
    const long = sanitizeServerMessage('x'.repeat(1000));
    expect(long.length).toBeLessThanOrEqual(160);
  });

  it('does not include server detail for auth/balance/rate-limit errors', () => {
    const message = fishErrorFromStatus(401, 'some internal detail');
    expect(message.message).not.toContain('internal detail');
  });
});

describe('parseFishErrorBody and helpers', () => {
  it('parses Fish error JSON bodies', () => {
    expect(parseFishErrorBody('{"status": 402, "message": "no balance"}')).toEqual({
      status: 402,
      message: 'no balance',
    });
  });

  it('tolerates non-JSON bodies', () => {
    expect(parseFishErrorBody('<html>gateway error</html>')).toEqual({});
  });

  it('isAbortError recognizes DOMException and plain objects', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError(new Error('nope'))).toBe(false);
  });

  it('messageForKind appends detail when provided', () => {
    expect(messageForKind('no-content', 'Nothing here.')).toContain('Nothing here.');
  });
});
