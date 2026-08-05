import { describe, expect, it } from 'vitest';
import {
  startOffscreenSession,
  OFFSCREEN_NOT_READY_MESSAGE,
  START_READING_FAILED_MESSAGE,
  READY_MAX_ATTEMPTS,
  type StartReadingResult,
} from './start-reading';
import { createIdleStatus } from '../shared/playback';
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

const pong = { type: 'PONG', status: createIdleStatus() } as const;
const accepted = { ok: true } as const;

/** Records which message types were sent while delegating to `handler`. */
function makeSend(handler: (message: ExtensionMessage) => unknown | Promise<unknown>): {
  send: (message: ExtensionMessage) => Promise<unknown>;
  sentPings: () => number;
  sentStartReading: () => number;
} {
  let pings = 0;
  let startReadings = 0;
  return {
    send: async (message) => {
      if (message.type === 'PING') pings += 1;
      if (message.type === 'START_READING') startReadings += 1;
      return handler(message);
    },
    sentPings: () => pings,
    sentStartReading: () => startReadings,
  };
}

describe('startOffscreenSession readiness handshake', () => {
  it('succeeds when an existing offscreen document is already ready and acknowledges', async () => {
    const { send, sentPings, sentStartReading } = makeSend((message) =>
      message.type === 'PING' ? pong : accepted,
    );
    const result: StartReadingResult = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(sentPings()).toBe(1);
    expect(sentStartReading()).toBe(1);
  });

  it('succeeds when a newly created document becomes ready after a short delay', async () => {
    let pings = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') {
        pings += 1;
        // First two polls hit the race where createDocument resolved before
        // the controller registered its listener.
        return pings <= 2 ? undefined : pong;
      }
      return accepted;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(pings).toBe(3);
  });

  it('returns a specific error when the document never becomes ready, without sending START_READING', async () => {
    const { send, sentPings, sentStartReading } = makeSend(() => undefined);
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: OFFSCREEN_NOT_READY_MESSAGE });
    expect(sentPings()).toBe(READY_MAX_ATTEMPTS);
    expect(sentStartReading()).toBe(0);
  });

  it('treats a missing receiver (delivery rejection) as not ready', async () => {
    const { send, sentStartReading } = makeSend(() => {
      throw new Error('Receiving end does not exist.');
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: OFFSCREEN_NOT_READY_MESSAGE });
    expect(sentStartReading()).toBe(0);
  });

  it('succeeds on a valid START_READING acknowledgement after the controller is ready', async () => {
    const { send } = makeSend((message) => (message.type === 'PING' ? pong : accepted));
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a malformed acknowledgement instead of treating it as success', async () => {
    const { send } = makeSend((message) => (message.type === 'PING' ? pong : { ok: 'yes' }));
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: START_READING_FAILED_MESSAGE });
  });

  it('returns the controller error without retrying a rejected session', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      return { ok: false, error: 'No API key saved.' };
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: 'No API key saved.' });
    expect(calls).toBe(1);
  });

  it('returns a distinct error when ready but START_READING is never acknowledged (bounded retries)', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      return undefined;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: START_READING_FAILED_MESSAGE });
    expect(calls).toBe(2);
  });

  it('never reports success for a non-ok result (no false loading state)', async () => {
    const { send } = makeSend((message) => (message.type === 'PING' ? pong : undefined));
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: false, error: START_READING_FAILED_MESSAGE });
  });

  it('retries START_READING once after a transient delivery failure once ready', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      if (calls === 1) throw new Error('Receiving end does not exist.');
      return accepted;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
