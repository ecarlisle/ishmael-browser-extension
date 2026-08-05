import { describe, expect, it, vi } from 'vitest';

const validSegment = { id: 'p-1', kind: 'paragraph', text: 'Hello world.' };

const SAVED_SETTINGS: Record<string, unknown> = {
  'ishmael.apiKey': 'test-key',
  'ishmael.voiceId': 'voice-ref',
  'ishmael.model': 's2.1-pro-free',
  'ishmael.speed': 1,
};

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
  offscreen: {
    hasDocument: () => Promise<boolean>;
    createDocument: () => Promise<undefined>;
    Reason: { AUDIO_PLAYBACK: string };
  };
};

function makeChrome(options: { sendMessage?: (message: unknown) => Promise<unknown> } = {}): {
  chrome: ChromeStub;
  sessionWrites: unknown[];
} {
  const sessionWrites: unknown[] = [];
  const chrome: ChromeStub = {
    runtime: {
      onMessage: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      sendMessage: options.sendMessage ?? (async () => ({ ok: true })),
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
  return { chrome, sessionWrites };
}

async function importBeginReading(): Promise<(source: 'page' | 'selection') => Promise<{ ok: boolean; error?: string }>> {
  vi.resetModules();
  const mod = await import('./service-worker');
  return mod.beginReading;
}

describe('beginReading acknowledgement contract', () => {
  it('caches a loading state only after the offscreen controller acknowledges', async () => {
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

  it('does not cache a loading state and reports an error when the controller never acknowledges', async () => {
    const { chrome, sessionWrites } = makeChrome({ sendMessage: async () => undefined });
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result.ok).toBe(false);
    expect(sessionWrites).toHaveLength(0);
  });

  it('does not cache a loading state when the controller rejects the session', async () => {
    const { chrome, sessionWrites } = makeChrome({
      sendMessage: async () => ({ ok: false, error: 'Background narration did not start.' }),
    });
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: false, error: 'Background narration did not start.' });
    expect(sessionWrites).toHaveLength(0);
  });
});
