// Playback phase provenance tests: every phase shown to the user must be
// driven by a genuinely observable event, never a timer or optimistic guess.
//
// The harness drives the real audio.ts module with a controllable fetch and
// stream, so each phase transition below is traced to its event: session
// acceptance (preparing), fetch initiation (connecting), a 2xx HTTP response
// (generating), first audio bytes / media waiting (buffering), the media
// element's `playing` event (playing), explicit user actions (paused,
// stopped), the final `ended` event (complete), and the failure paths
// (error). No call to a real Fish Audio endpoint is ever made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the river bank and thinks.';

const oneParagraph = [{ id: 'p1', kind: 'paragraph' as const, text: SENTENCE }];

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

class StreamStub {
  /** Queue of read results; `{ done: true }` is returned when exhausted. */
  reads: Array<Promise<{ done: boolean; value?: Uint8Array }>> = [];
  read = vi.fn(() => this.reads.shift() ?? Promise.resolve({ done: true }));
  releaseLock = vi.fn();
}

class ResponseStub {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  readonly stream: StreamStub;
  readonly text: ReturnType<typeof vi.fn>;

  constructor(opts: { status?: number; contentType?: string; stream?: StreamStub } = {}) {
    const status = opts.status ?? 200;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.contentType = opts.contentType ?? 'audio/mpeg';
    this.stream = opts.stream ?? new StreamStub();
    this.text = vi.fn(async () => '{}');
  }

  get body(): { getReader: () => StreamStub } {
    return { getReader: () => this.stream };
  }

  get headers(): { get: (name: string) => string | null } {
    return { get: () => this.contentType };
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fetchGate: Deferred<ResponseStub>;

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  audioInstances = [];
  urlCounter = 0;
  fetchGate = deferred<ResponseStub>();

  sendMessageStub = vi.fn(async (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'GET_API_KEY') {
      return { ok: true, apiKey: 'phase-test-key' };
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

  fetchStub = vi.fn(() => fetchGate.promise);
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

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
  // Flush the async start: ack is sent once the session is accepted and the
  // first fetch is in flight.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(ack).toEqual({ ok: true });
  return { listener, audio: audioInstances[0]! };
}

/** Consecutive unique phases broadcast via PLAYBACK_STATE messages. */
function reportedPhaseChain(): string[] {
  const phases = sendMessageStub.mock.calls
    .map(([message]) => message as { type?: unknown; status?: { phase?: unknown } })
    .filter((message) => message.type === 'PLAYBACK_STATE')
    .map((message) => String(message.status?.phase));
  return phases.filter((phase, i) => phase !== phases[i - 1]);
}

function pingPhase(listener: Listener): string {
  let pong: { status?: { phase?: string; error?: string } } | undefined;
  listener?.({ target: 'offscreen', type: 'PING' }, {}, (response) => {
    pong = response as { status?: { phase?: string; error?: string } };
  });
  return pong?.status?.phase ?? '';
}

function pingError(listener: Listener): string {
  let pong: { status?: { phase?: string; error?: string } } | undefined;
  listener?.({ target: 'offscreen', type: 'PING' }, {}, (response) => {
    pong = response as { status?: { phase?: string; error?: string } };
  });
  return pong?.status?.error ?? '';
}

function fire(audio: AudioStub, event: string): void {
  audio.handlers.get(event)?.();
}

describe('phase provenance from observable events', () => {
  it('traces preparing → connecting → generating → buffering → playing from real events', async () => {
    const { listener, audio } = await loadController(oneParagraph);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    // Connecting: the fetch is in flight and no HTTP response has arrived.
    expect(pingPhase(listener)).toBe('connecting');

    // A 2xx response arrives with audio bytes queued in its stream.
    const response = new ResponseStub({
      stream: Object.assign(new StreamStub(), {
        reads: [Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) })],
      }),
    });
    fetchGate.resolve(response);
    await flush();

    // The media element reports it is actually playing.
    expect(pingPhase(listener)).toBe('playing');
    expect(reportedPhaseChain()).toEqual(['preparing', 'connecting', 'generating', 'buffering', 'playing']);
    // The attached buffer made it to the audio element and plays resolve.
    expect(audio.src).toBe('blob:0');
    expect(audio.play).toHaveBeenCalled();
  });

  it('never reports generating without a 2xx response, nor buffering without bytes', async () => {
    const { listener } = await loadController(oneParagraph);

    // The in-flight request answers with HTTP 401: the session fails while
    // connecting, without ever claiming the API accepted the request.
    fetchGate.resolve(new ResponseStub({ status: 401 }));
    await flush();

    expect(pingPhase(listener)).toBe('error');
    expect(reportedPhaseChain()).toEqual(['preparing', 'connecting', 'error']);
    expect(reportedPhaseChain()).not.toContain('generating');
    expect(reportedPhaseChain()).not.toContain('buffering');
    // The mapped error is user-facing and never contains the API key.
    expect(pingError(listener)).toBe(
      'Fish Audio rejected the API key (HTTP 401). Check the key in the voice settings.',
    );
    expect(pingError(listener)).not.toContain('phase-test-key');
  });

  it('retries empty responses without ever showing buffering', async () => {
    const { listener } = await loadController(oneParagraph);
    // Every attempt returns a 2xx response whose stream yields zero bytes.
    fetchGate.resolve(new ResponseStub());
    await flush();
    expect(pingPhase(listener)).toBe('connecting'); // first empty attempt → retry delay

    await vi.advanceTimersByTimeAsync(500); // retry 1
    await vi.advanceTimersByTimeAsync(1000); // retry 2
    await flush();

    expect(fetchStub.mock.calls.length).toBe(3);
    expect(pingPhase(listener)).toBe('error');
    const chain = reportedPhaseChain();
    expect(chain[0]).toBe('preparing');
    expect(chain[chain.length - 1]).toBe('error');
    expect(chain).toContain('connecting');
    expect(chain).toContain('generating');
    // No audio bytes ever arrived, so buffering must never be claimed.
    expect(chain).not.toContain('buffering');
  });

  it('reports buffering while audio bytes are pending and errors on media failure', async () => {
    const { listener, audio } = await loadController(oneParagraph);

    // First bytes arrive, then the stream stalls on the second read.
    const stalledRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const response = new ResponseStub({
      stream: Object.assign(new StreamStub(), {
        reads: [Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) }), stalledRead.promise],
      }),
    });
    fetchGate.resolve(response);
    await flush();

    // Bytes are in hand but the media pipeline is waiting for playable audio.
    expect(pingPhase(listener)).toBe('buffering');

    // The media element reports a decode/load failure while buffering.
    fire(audio, 'error');
    expect(pingPhase(listener)).toBe('error');
    expect(pingError(listener)).toBe('The generated audio could not be played.');
  });

  it('reports waiting → buffering → playing from the media element events', async () => {
    const { listener, audio } = await loadController(oneParagraph);
    const response = new ResponseStub({
      stream: Object.assign(new StreamStub(), {
        reads: [Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) })],
      }),
    });
    fetchGate.resolve(response);
    await flush();
    expect(pingPhase(listener)).toBe('playing');

    fire(audio, 'waiting');
    expect(pingPhase(listener)).toBe('buffering');

    fire(audio, 'playing');
    expect(pingPhase(listener)).toBe('playing');
  });
});

describe('user action phases', () => {
  it('pause reports paused, resume only claims playing from the media event', async () => {
    const { listener } = await loadController(oneParagraph);
    const response = new ResponseStub({
      stream: Object.assign(new StreamStub(), {
        reads: [Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) })],
      }),
    });
    fetchGate.resolve(response);
    await flush();
    expect(pingPhase(listener)).toBe('playing');

    listener?.({ target: 'offscreen', type: 'PLAY_PAUSE' }, {}, () => undefined);
    expect(pingPhase(listener)).toBe('paused');

    // Resume: no optimistic report — the media element must confirm.
    listener?.({ target: 'offscreen', type: 'PLAY_PAUSE' }, {}, () => undefined);
    expect(pingPhase(listener)).toBe('paused');
    await flush();
    expect(pingPhase(listener)).toBe('playing');
    expect(reportedPhaseChain().slice(-2)).toEqual(['paused', 'playing']);
  });

  it('reports complete from the final ended event, then stopped from STOP', async () => {
    const { listener, audio } = await loadController(oneParagraph);
    const response = new ResponseStub({
      stream: Object.assign(new StreamStub(), {
        reads: [Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) })],
      }),
    });
    fetchGate.resolve(response);
    await flush();

    fire(audio, 'ended'); // final chunk of a single-chunk session
    expect(pingPhase(listener)).toBe('complete');

    listener?.({ target: 'offscreen', type: 'STOP' }, {}, () => undefined);
    expect(pingPhase(listener)).toBe('stopped');
  });

  it('STOP while connecting cancels the fetch and reports stopped', async () => {
    const { listener } = await loadController(oneParagraph);
    expect(pingPhase(listener)).toBe('connecting');

    listener?.({ target: 'offscreen', type: 'STOP' }, {}, () => undefined);
    expect(pingPhase(listener)).toBe('stopped');

    // Even if the stale fetch later resolves, the superseded session stays
    // stopped (the sessionId guard discards it).
    fetchGate.resolve(new ResponseStub());
    await flush();
    expect(pingPhase(listener)).toBe('stopped');
  });

  it('a new session resets to preparing without ever claiming the old phase', async () => {
    const { listener } = await loadController(oneParagraph);
    expect(pingPhase(listener)).toBe('connecting');

    let ack: unknown;
    listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: oneParagraph,
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
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(ack).toEqual({ ok: true });
    expect(pingPhase(listener)).toBe('connecting');
    expect(reportedPhaseChain().slice(-2)).toEqual(['preparing', 'connecting']);
  });
});