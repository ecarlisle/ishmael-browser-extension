import { describe, expect, it } from 'vitest';
import {
  startOffscreenSession,
  OFFSCREEN_NOT_READY_MESSAGE,
  START_READING_FAILED_MESSAGE,
  READY_MAX_ATTEMPTS,
  type SendOutcome,
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
  mood: 'none',
};

const noDelay = async (): Promise<void> => undefined;

const pong: SendOutcome = { ok: true, value: { type: 'PONG', status: createIdleStatus() } };
const accepted: SendOutcome = { ok: true, value: { ok: true } };
const noReceiver: SendOutcome = { ok: false, problem: 'no-receiver' };

/** Records which message types were sent while delegating to `handler`. */
function makeSend(handler: (message: ExtensionMessage) => SendOutcome | Promise<SendOutcome>): {
  send: (message: ExtensionMessage) => Promise<SendOutcome>;
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
  it('succeeds when an existing offscreen controller is already ready and acknowledges', async () => {
    const { send, sentPings, sentStartReading } = makeSend((message) =>
      message.type === 'PING' ? pong : accepted,
    );
    const result: StartReadingResult = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(sentPings()).toBe(1);
    expect(sentStartReading()).toBe(1);
  });

  it('succeeds when the controller becomes ready after a short startup delay', async () => {
    let pings = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') {
        pings += 1;
        // The first two polls arrive while the controller is still warming
        // up; it answers from the third poll on.
        return pings <= 2 ? noReceiver : pong;
      }
      return accepted;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(pings).toBe(3);
  });

  it('reports a no-receiver problem when the controller never becomes ready, without sending START_READING', async () => {
    const { send, sentPings, sentStartReading } = makeSend(() => noReceiver);
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: OFFSCREEN_NOT_READY_MESSAGE,
      problem: 'no-receiver',
    });
    expect(sentPings()).toBe(READY_MAX_ATTEMPTS);
    expect(sentStartReading()).toBe(0);
  });

  it('reports a malformed-pong problem when the controller responds with an invalid payload', async () => {
    const { send, sentStartReading } = makeSend((message) =>
      message.type === 'PING' ? { ok: true, value: 'not-a-pong' } : accepted,
    );
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: OFFSCREEN_NOT_READY_MESSAGE,
      problem: 'malformed-pong',
    });
    expect(sentStartReading()).toBe(0);
  });

  it('treats an undefined response (listener present but silent) as no receiver', async () => {
    const { send } = makeSend((message) =>
      message.type === 'PING' ? { ok: true, value: undefined } : accepted,
    );
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toMatchObject({ ok: false, problem: 'no-receiver' });
  });

  it('succeeds on a valid START_READING acknowledgement after the controller is ready', async () => {
    const { send } = makeSend((message) => (message.type === 'PING' ? pong : accepted));
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a malformed acknowledgement instead of treating it as success', async () => {
    const { send } = makeSend((message) =>
      message.type === 'PING' ? pong : { ok: true, value: { ok: 'yes' } },
    );
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: START_READING_FAILED_MESSAGE,
      problem: 'start-not-acknowledged',
    });
  });

  it('returns the controller error without retrying a rejected session', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      return { ok: true, value: { ok: false, error: 'No API key saved.' } };
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: 'No API key saved.',
      problem: 'controller-rejected',
    });
    expect(calls).toBe(1);
  });

  it('reports start-not-acknowledged when ready but START_READING is never acknowledged (bounded retries)', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      return noReceiver;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: START_READING_FAILED_MESSAGE,
      problem: 'start-not-acknowledged',
    });
    expect(calls).toBe(2);
  });

  it('never reports success for a non-ok result (no false loading state)', async () => {
    const { send } = makeSend((message) => (message.type === 'PING' ? pong : noReceiver));
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({
      ok: false,
      error: START_READING_FAILED_MESSAGE,
      problem: 'start-not-acknowledged',
    });
  });

  it('retries START_READING once after a transient delivery failure once ready', async () => {
    let calls = 0;
    const { send } = makeSend((message) => {
      if (message.type === 'PING') return pong;
      calls += 1;
      if (calls === 1) return noReceiver;
      return accepted;
    });
    const result = await startOffscreenSession(startMessage, send, noDelay);
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
