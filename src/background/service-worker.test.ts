import { describe, expect, it, vi } from 'vitest';
import { createIdleStatus } from '../shared/playback';

const validSegment = { id: 'p-1', kind: 'paragraph', text: 'Hello world.' };

const SAVED_SETTINGS: Record<string, unknown> = {
  'ishmael.apiKey': 'test-key',
  'ishmael.voiceId': 'voice-ref',
  'ishmael.model': 's2.1-pro-free',
  'ishmael.speed': 1,
};

const pong = { type: 'PONG', status: createIdleStatus() } as const;

/** Default controller: ready on the first PING, accepts every session. */
function defaultSendMessage(message: unknown): Promise<unknown> {
  if (message && typeof message === 'object' && 'type' in message) {
    const type = (message as { type: unknown }).type;
    if (type === 'PING') return Promise.resolve(pong);
    if (type === 'START_READING') return Promise.resolve({ ok: true });
  }
  return Promise.resolve(undefined);
}

type ChromeStub = {
  runtime: {
    onMessage: { addListener: (listener: unknown) => void };
    onInstalled: { addListener: (listener: unknown) => void };
    onStartup: { addListener: (listener: unknown) => void };
    sendMessage: (message: unknown) => Promise<unknown>;
  };
  storage: {
    local: {
      get: (keys: readonly string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: readonly string[]) => Promise<void>;
    };
    session: {
      get: (keys: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
  tabs: {
    query: () => Promise<{ id: number; url: string }[]>;
    sendMessage: () => Promise<unknown>;
  };
  scripting: { executeScript: () => Promise<unknown[]> };
  commands: { onCommand: { addListener: (listener: (command: string) => void) => void } };
  offscreen: {
    hasDocument: () => Promise<boolean>;
    createDocument: () => Promise<undefined>;
    Reason: { AUDIO_PLAYBACK: string };
  };
};

function makeChrome(options: { sendMessage?: (message: unknown) => Promise<unknown> } = {}): {
  chrome: ChromeStub;
  sessionWrites: unknown[];
  commandListeners: ((command: string) => void)[];
} {
  const sessionWrites: unknown[] = [];
  const commandListeners: ((command: string) => void)[] = [];
  const chrome: ChromeStub = {
    runtime: {
      onMessage: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      sendMessage: options.sendMessage ?? defaultSendMessage,
    },
    storage: {
      local: {
        async get(keys) {
          const out: Record<string, unknown> = {};
          for (const key of keys) {
            if (key in SAVED_SETTINGS) out[key] = SAVED_SETTINGS[key];
          }
          return out;
        },
        async set() {},
        async remove() {},
      },
      session: {
        async get() {
          return {};
        },
        async set(items) {
          sessionWrites.push(items);
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, url: 'https://example.com/article' }];
      },
      async sendMessage() {
        return { ok: true, segments: [validSegment] };
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    commands: {
      onCommand: {
        addListener: (listener) => {
          commandListeners.push(listener);
        },
      },
    },
    offscreen: {
      async hasDocument() {
        return false;
      },
      async createDocument() {
        return undefined;
      },
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
    },
  };
  return { chrome, sessionWrites, commandListeners };
}

async function importBeginReading(): Promise<
  (source: 'page' | 'selection') => Promise<{ ok: boolean; error?: string }>
> {
  vi.resetModules();
  const mod = await import('./service-worker');
  return mod.beginReading;
}

/** Flushes pending microtasks and the shortest timers used by the flow. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('beginReading startup handshake', () => {
  it('caches a loading state only after the offscreen controller acknowledges (page)', async () => {
    const { chrome, sessionWrites } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: true });
    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0]).toEqual({
      'ishmael.playbackStatus': { phase: 'loading', index: 0, total: 1, speed: 1 },
    });
  });

  it('uses the same corrected startup path for the selection command', async () => {
    const { chrome, sessionWrites } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('selection');
    expect(result).toEqual({ ok: true });
    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0]).toEqual({
      'ishmael.playbackStatus': { phase: 'loading', index: 0, total: 1, speed: 1 },
    });
  });

  it('does not cache a loading state when the controller rejects the session', async () => {
    const { chrome, sessionWrites } = makeChrome({
      sendMessage: async (message) => {
        if (message && typeof message === 'object' && 'type' in message) {
          const type = (message as { type: unknown }).type;
          if (type === 'PING') return pong;
          if (type === 'START_READING') return { ok: false, error: 'Rejected.' };
        }
        return undefined;
      },
    });
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: false, error: 'Rejected.' });
    expect(sessionWrites).toHaveLength(0);
  });

  it('does not cache a loading state when START_READING is never acknowledged', async () => {
    const { chrome, sessionWrites } = makeChrome({
      sendMessage: async (message) => {
        if (message && typeof message === 'object' && 'type' in message) {
          const type = (message as { type: unknown }).type;
          if (type === 'PING') return pong;
        }
        return undefined;
      },
    });
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: false, error: 'Background audio did not start. Check the service worker and offscreen consoles, then reload the extension.' });
    expect(sessionWrites).toHaveLength(0);
  });
});

describe('keyboard shortcuts', () => {
  it('routes read-page through the same startup path', async () => {
    const { chrome, sessionWrites, commandListeners } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    await importBeginReading();

    commandListeners[0]?.('read-page');
    await vi.waitFor(() => expect(sessionWrites).toHaveLength(1));
    expect(sessionWrites[0]).toEqual({
      'ishmael.playbackStatus': { phase: 'loading', index: 0, total: 1, speed: 1 },
    });
  });

  it('routes read-selection through the same startup path', async () => {
    const { chrome, sessionWrites, commandListeners } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    await importBeginReading();

    commandListeners[0]?.('read-selection');
    await vi.waitFor(() => expect(sessionWrites).toHaveLength(1));
    expect(sessionWrites[0]).toEqual({
      'ishmael.playbackStatus': { phase: 'loading', index: 0, total: 1, speed: 1 },
    });
  });

  it('ignores unknown commands without touching the status cache', async () => {
    const { chrome, sessionWrites, commandListeners } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    await importBeginReading();

    commandListeners[0]?.('toggle-feature');
    await flush();
    expect(sessionWrites).toHaveLength(0);
  });

  it('stores an error playback status when a shortcut fails while the popup is closed', async () => {
    const { chrome, sessionWrites, commandListeners } = makeChrome({
      sendMessage: async (message) => {
        if (message && typeof message === 'object' && 'type' in message) {
          const type = (message as { type: unknown }).type;
          if (type === 'PING') return pong;
          if (type === 'START_READING') return { ok: false, error: 'No API key saved.' };
        }
        return undefined;
      },
    });
    vi.stubGlobal('chrome', chrome);
    await importBeginReading();

    commandListeners[0]?.('read-page');
    await vi.waitFor(() => expect(sessionWrites).toHaveLength(1));
    expect(sessionWrites[0]).toEqual({
      'ishmael.playbackStatus': { phase: 'error', index: 0, total: 0, speed: 1, error: 'No API key saved.' },
    });
  });
});
