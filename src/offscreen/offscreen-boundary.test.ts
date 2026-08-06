// Browser-boundary regression test for the offscreen document.
//
// Chrome documents that offscreen documents support only the chrome.runtime
// extension API. The controller previously read chrome.storage.local at
// module scope, which threw during startup (no chrome.storage in offscreen
// documents) and prevented the runtime message listener from ever
// registering — matching the observed "Background audio did not become
// ready." This test imports the real entry point with chrome.storage
// deliberately absent and proves the listener registers and answers PING,
// and that the API key arrives only via the GET_API_KEY unicast response.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS_ENDPOINT } from './audio-core';

const BOUNDARY_KEY = 'boundary-test-key';

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

let listeners: Listener[];
let sendMessageStub: ReturnType<typeof vi.fn>;
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners = [];

  // chrome.runtime only — chrome.storage must be absent, exactly like a real
  // offscreen document.
  sendMessageStub = vi.fn(async (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'GET_API_KEY') {
      return { ok: true, apiKey: BOUNDARY_KEY };
    }
    return undefined;
  });
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      sendMessage: sendMessageStub,
    },
  });

  vi.stubGlobal(
    'Audio',
    class AudioStub {
      preload = '';
      src = '';
      currentTime = 0;
      playbackRate = 1;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      pause = vi.fn();
      play = vi.fn(() => Promise.resolve());
      load = vi.fn();
      removeAttribute = vi.fn();
    },
  );

  const realUrl = globalThis.URL;
  class UrlStub extends realUrl {
    static override createObjectURL = vi.fn(() => 'blob:boundary-test');
    static override revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', UrlStub);

  fetchStub = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['fake-mp3'], { type: 'audio/mpeg' }) }));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offscreen entry point without chrome.storage', () => {
  it('registers the runtime message listener even though chrome.storage is absent', async () => {
    const chromeStub = globalThis.chrome as unknown as Record<string, unknown>;
    expect(chromeStub.storage).toBeUndefined();

    vi.resetModules();
    await import('./audio');

    expect(listeners).toHaveLength(1);
  });

  it('answers PING with a valid PONG without touching storage', async () => {
    vi.resetModules();
    await import('./audio');

    const listener = listeners[0];
    expect(listener).toBeDefined();
    let pong: unknown;
    const handled = listener?.({ target: 'offscreen', type: 'PING' }, {}, (response) => {
      pong = response;
    });
    expect(handled).toBe(false);
    expect(pong).toMatchObject({ type: 'PONG', status: { phase: 'idle' } });
  });

  it('starts a session using the API key from the GET_API_KEY unicast response', async () => {
    vi.resetModules();
    await import('./audio');

    const listener = listeners[0];
    expect(listener).toBeDefined();
    let ack: unknown;
    const handled = listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: [{ id: 'p-1', kind: 'paragraph', text: 'Hello from the boundary test.' }],
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
    expect(handled).toBe(true);

    await vi.waitFor(() => expect(ack).toEqual({ ok: true }));

    // The key reached the Fish request via runtime messaging only.
    expect(fetchStub).toHaveBeenCalled();
    const [url, init] = fetchStub.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(TTS_ENDPOINT);
    expect(init.headers.Authorization).toBe(`Bearer ${BOUNDARY_KEY}`);
    expect(init.body).not.toContain(BOUNDARY_KEY);
  });

  it('never puts the API key in playback status messages', async () => {
    vi.resetModules();
    await import('./audio');

    const listener = listeners[0];
    let ack: unknown;
    listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: [{ id: 'p-1', kind: 'paragraph', text: 'Hello from the boundary test.' }],
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
    await vi.waitFor(() => expect(ack).toEqual({ ok: true }));

    for (const call of sendMessageStub.mock.calls) {
      const payload = JSON.stringify(call[0]);
      expect(payload).not.toContain(BOUNDARY_KEY);
    }
  });

  it('sends decorated request text: mood cue before structural cues, never duplicated', async () => {
    vi.resetModules();
    await import('./audio');

    const listener = listeners[0];
    let ack: unknown;
    listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: [
          { id: 't-1', kind: 'title', text: 'Fixture title' },
          { id: 'p-1', kind: 'paragraph', text: 'Body paragraph.' },
        ],
        voiceId: 'voice-ref',
        model: 's2.1-pro-free',
        speed: 1,
        mood: 'happy',
      },
      {},
      (response) => {
        ack = response;
      },
    );
    await vi.waitFor(() => expect(ack).toEqual({ ok: true }));

    expect(fetchStub).toHaveBeenCalled();
    const [url, init] = fetchStub.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(TTS_ENDPOINT);
    const body = JSON.parse(init.body) as { text: string };
    expect(body.text).toBe('[happy] [emphasis] Fixture title. [long-break]');
    expect(body.text).not.toContain(BOUNDARY_KEY);
  });

  it('omits the mood cue entirely for none', async () => {
    vi.resetModules();
    await import('./audio');

    const listener = listeners[0];
    let ack: unknown;
    listener?.(
      {
        target: 'offscreen',
        type: 'START_READING',
        segments: [{ id: 'p-1', kind: 'paragraph', text: 'Neutral narration.' }],
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
    await vi.waitFor(() => expect(ack).toEqual({ ok: true }));

    const [_, init] = fetchStub.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { text: string };
    expect(body.text).toBe('Neutral narration.');
    expect(body.text).not.toContain('[none]');
  });
});
