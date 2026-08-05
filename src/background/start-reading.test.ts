import { describe, expect, it } from 'vitest';
import {
  sendStartReading,
  START_READING_FAILED_MESSAGE,
  type StartReadingResult,
} from './start-reading';
import type { ExtensionMessage } from '../shared/messages';

const startMessage: Extract<ExtensionMessage, { type: 'START_READING' }> = {
  target: 'offscreen',
  type: 'START_READING',
  segments: [{ id: 'p-1', kind: 'paragraph', text: 'Hello.' }],
  voiceId: 'voice-ref',
  model: 's2.1-pro-free',
  speed: 1,
};

const noDelay = async (): Promise<void> => undefined;

describe('sendStartReading', () => {
  it('reports success when the controller acknowledges', async () => {
    const result: StartReadingResult = await sendStartReading(startMessage, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('retries once after an initial delivery failure and succeeds', async () => {
    let calls = 0;
    const result = await sendStartReading(
      startMessage,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('Receiving end does not exist.');
        return { ok: true };
      },
      noDelay,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('returns an error when delivery keeps failing (bounded retries)', async () => {
    let calls = 0;
    const result = await sendStartReading(
      startMessage,
      async () => {
        calls += 1;
        return undefined;
      },
      noDelay,
    );
    expect(result).toEqual({ ok: false, error: START_READING_FAILED_MESSAGE });
    expect(calls).toBe(2);
  });

  it('returns the controller error without retrying a rejected session', async () => {
    let calls = 0;
    const result = await sendStartReading(
      startMessage,
      async () => {
        calls += 1;
        return { ok: false, error: 'No API key saved.' };
      },
      noDelay,
    );
    expect(result).toEqual({ ok: false, error: 'No API key saved.' });
    expect(calls).toBe(1);
  });

  it('rejects malformed acknowledgements instead of treating them as success', async () => {
    const result = await sendStartReading(startMessage, async () => ({ ok: 'yes' }), noDelay);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(START_READING_FAILED_MESSAGE);
  });

  it('rejects an empty-error acknowledgement as malformed', async () => {
    const result = await sendStartReading(startMessage, async () => ({ ok: false, error: '' }), noDelay);
    expect(result.ok).toBe(false);
  });

  it('never reports success for a non-ok result (no false loading state)', async () => {
    const result = await sendStartReading(startMessage, async () => undefined, noDelay);
    expect(result).toEqual({ ok: false, error: START_READING_FAILED_MESSAGE });
  });
});
