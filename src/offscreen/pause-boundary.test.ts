// Inter-file pause mechanism tests: the ~250 ms local pause between separate
// audio files at semantic boundaries must be cancellable, never combined with
// synthesized Fish tags, and never able to start audio from a stale session.
//
// Runs under node with the real audio.ts module, stubbed chrome.runtime,
// Audio, URL, and fetch, and Vitest fake timers so the pause delay is fully
// deterministic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the river bank and thinks about the weather.';

const paragraphSeg = (id: string, text: string) => ({ id, kind: 'paragraph' as const, text });
/** Two paragraphs too long to merge (~730 chars each) but under the split limit. */
const twoParagraphs = [
  paragraphSeg('p1', `p1: ${Array.from({ length: 8 }, () => SENTENCE).join(' ')}`),
  paragraphSeg('p2', `p2: ${Array.from({ length: 8 }, () => SENTENCE).join(' ')}`),
];
/** One paragraph long enough to be split into multiple chunks (> 1200 chars). */
const splitParagraph = [paragraphSeg('p1', `p1: ${Array.from({ length: 16 }, () => SENTENCE).join(' ')}`)];

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;
type EventHandler = () => void;

let listeners: Listener[];
let sendMessageStub: ReturnType<typeof vi.fn>;
let fetchStub: ReturnType<typeof vi.fn>;
let audioInstances: AudioStub[];
let urlCounter: number;

class AudioStub {
  preload = '';
  src = '';
  currentTime = 0;
  playbackRate = 1;
  handlers = new Map<string, EventHandler>();
  play = vi.fn(() => {
    // Realistic media elements fire `playing` shortly after play() resolves.
    const result = Promise.resolve();
    void result.then(() => this.handlers.get('playing')?.());
    return result;
  });
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  addEventListener = (type: string, handler: EventHandler): void => {
    this.handlers.set(type, handler);
  };
  removeEventListener = vi.fn();

  constructor() {
    audioInstances.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  audioInstances = [];
  urlCounter = 0;

  sendMessageStub = vi.fn(async (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'GET_API_KEY') {
      return { ok: true, apiKey: 'pause-test-key' };
    }
    return undefined;
  });
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      sendMessage: sendMessageStub,
    },
  });

  vi.stubGlobal('Audio', AudioStub);

  const realUrl = globalThis.URL;
  class UrlStub extends realUrl {
    static override createObjectURL = vi.fn(() => `blob:${urlCounter++}`);
    static override revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', UrlStub);

  fetchStub = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['fake-mp3'], { type: 'audio/mpeg' }) }));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loadController(segments: unknown[]): Promise<{ listener: Listener; audio: AudioStub }> {
  vi.resetModules();
  await import('./audio');
  const listener = listeners[0]!;
  expect(listener).toBeDefined();
  let ack: unknown;
  listener?.(
    {
      target: 'offscreen',
      type: 'START_READING',
      segments,
      voiceId: 'voice-ref',
      model: 's2.1-pro-free',
      speed: 1,
      mood: 'none',
    },
    {},
    (response) => {
      ack = response;
    },
  );
  // Flush the async start: ack, first fetch, attachAndPlay(0), prefetch(1).
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(ack).toEqual({ ok: true });
  return { listener, audio: audioInstances[0]! };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function pingPhase(listener: Listener): string | undefined {
  let pong: { status?: { phase?: string } } | undefined;
  listener?.({ target: 'offscreen', type: 'PING' }, {}, (response) => {
    pong = response as { status?: { phase?: string } };
  });
  return pong?.status?.phase;
}

function fireEnded(audio: AudioStub): void {
  audio.handlers.get('ended')?.();
}

describe('inter-file semantic pause', () => {
  it('holds ~250 ms between two separate paragraph files, then plays the next chunk', async () => {
    const { listener, audio } = await loadController(twoParagraphs);
    expect(audio.src).toBe('blob:0'); // first chunk attached
    expect(fetchStub).toHaveBeenCalledTimes(2); // chunk 0 + prefetch of chunk 1

    fireEnded(audio);
    await flush();
    // Chunk 1 is cached but its audio must not start yet — the pause is pending.
    expect(audio.src).toBe('blob:0');

    await vi.advanceTimersByTimeAsync(250);
    expect(audio.src).toBe('blob:1');
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(pingPhase(listener)).toBe('playing');
  });

  it('does not delay between pieces of the same long paragraph', async () => {
    const { listener, audio } = await loadController(splitParagraph);
    expect(audio.src).toBe('blob:0');
    expect(fetchStub).toHaveBeenCalledTimes(2);

    fireEnded(audio);
    await flush();
    // No timer involved: the next piece starts immediately after the ended event.
    expect(audio.src).toBe('blob:1');
    expect(pingPhase(listener)).toBe('playing');
  });
});

describe('cancelling a pending pause', () => {
  it('STOP cancels the pending delay and the next chunk never begins', async () => {
    const { listener, audio } = await loadController(twoParagraphs);
    fireEnded(audio);
    await flush();
    expect(audio.src).toBe('blob:0'); // pause pending for chunk 1

    listener?.({ target: 'offscreen', type: 'STOP' }, {}, () => undefined);
    await vi.advanceTimersByTimeAsync(1000);

    expect(audio.src).toBe('blob:0'); // chunk 1 never attached
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(pingPhase(listener)).toBe('stopped');
  });

  it('NEXT cancels the pending delay and jumps immediately, skipping the pause', async () => {
    const { listener, audio } = await loadController(twoParagraphs);
    fireEnded(audio);
    await flush();
    expect(audio.src).toBe('blob:0');

    listener?.({ target: 'offscreen', type: 'NEXT' }, {}, () => undefined);
    await flush();
    // No timer advancement needed: user navigation skips the inter-file pause.
    expect(audio.src).toBe('blob:1');
    expect(pingPhase(listener)).toBe('playing');
  });

  it('PREVIOUS at the first chunk cancels the pending delay and restarts the current audio', async () => {
    const { listener, audio } = await loadController(twoParagraphs);
    fireEnded(audio);
    await flush();
    expect(audio.src).toBe('blob:0');
    const playsBefore = audio.play.mock.calls.length;

    listener?.({ target: 'offscreen', type: 'PREVIOUS' }, {}, () => undefined);
    expect(audio.currentTime).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(audio.src).toBe('blob:0'); // still chunk 0, restarted
    expect(audio.play.mock.calls.length).toBe(playsBefore + 1);
    expect(pingPhase(listener)).toBe('playing');
  });

  it('a stale pause from an ended session can never begin audio', async () => {
    const { listener, audio } = await loadController(twoParagraphs);
    fireEnded(audio);
    await flush(); // old session has a pending 250 ms pause for chunk 1

    listener?.({ target: 'offscreen', type: 'STOP' }, {}, () => undefined);

    // A brand-new session starts (single short paragraph).
    let ack: unknown;
    listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: [{ id: 's1', kind: 'paragraph', text: 'A brand new session paragraph.' }],
        voiceId: 'voice-ref',
        model: 's2.1-pro-free',
        speed: 1,
        mood: 'none',
      },
      {},
      (response) => {
        ack = response;
      },
    );
    await flush();
    expect(ack).toEqual({ ok: true });
    expect(audio.src).toBe('blob:2'); // new session's own chunk

    await vi.advanceTimersByTimeAsync(1000);
    expect(audio.src).toBe('blob:2'); // old pause never attaches old chunk 1
    expect(audio.play).toHaveBeenCalledTimes(2); // one per session chunk
  });
});
