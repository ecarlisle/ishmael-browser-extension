import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdleStatus } from '../shared/playback';

const validSegment = { id: 'p-1', kind: 'paragraph', text: 'Hello world.' };

const SAVED_SETTINGS: Record<string, unknown> = {
  'ishmael.apiKey': 'test-key',
  'ishmael.voiceId': 'voice-ref',
  'ishmael.model': 's2.1-pro-free',
  'ishmael.speed': 1,
  'ishmael.mood': 'calm',
};

const OFFSCREEN_URL = 'chrome-extension://test/offscreen.html';

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

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

type ChromeStub = {
  runtime: {
    onMessage: { addListener: (listener: RuntimeListener) => void };
    onInstalled: { addListener: (listener: unknown) => void };
    onStartup: { addListener: (listener: unknown) => void };
    getURL: (path: string) => string;
    getContexts: (filter: unknown) => Promise<unknown[]>;
    ContextType: { OFFSCREEN_DOCUMENT: string };
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
    createDocument: () => Promise<undefined>;
    Reason: { AUDIO_PLAYBACK: string };
  };
};

function makeChrome(
  options: {
    sendMessage?: (message: unknown) => Promise<unknown>;
    createDocument?: () => Promise<undefined>;
  } = {},
): {
  chrome: ChromeStub;
  sessionWrites: unknown[];
  commandListeners: ((command: string) => void)[];
  messageListeners: RuntimeListener[];
  getContextsCalls: unknown[];
  sentMessages: unknown[];
} {
  const sessionWrites: unknown[] = [];
  const commandListeners: ((command: string) => void)[] = [];
  const messageListeners: RuntimeListener[] = [];
  const getContextsCalls: unknown[] = [];
  const sentMessages: unknown[] = [];
  let documentCreated = false;
  const chrome: ChromeStub = {
    runtime: {
      onMessage: {
        addListener: (listener) => {
          messageListeners.push(listener);
        },
      },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async (filter) => {
        getContextsCalls.push(filter);
        return documentCreated
          ? [{ documentUrl: OFFSCREEN_URL, contextType: 'OFFSCREEN_DOCUMENT' }]
          : [];
      },
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      sendMessage: async (message) => {
        sentMessages.push(message);
        return (options.sendMessage ?? defaultSendMessage)(message);
      },
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
      async createDocument() {
        documentCreated = true;
        return options.createDocument ? options.createDocument() : undefined;
      },
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
    },
  };
  return { chrome, sessionWrites, commandListeners, messageListeners, getContextsCalls, sentMessages };
}

async function importBeginReading(): Promise<
  (source: 'page' | 'selection') => Promise<{ ok: boolean; error?: string }>
> {
  vi.resetModules();
  const mod = await import('./service-worker');
  return mod.beginReading;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(result).toEqual({
      ok: false,
      error: 'Background audio did not start. Check the service worker and offscreen consoles, then reload the extension.',
    });
    expect(sessionWrites).toHaveLength(0);
  });

  it('reports a distinct error and logs a safe diagnostic when the offscreen document cannot be created', async () => {
    const { chrome, sessionWrites } = makeChrome({
      createDocument: async () => {
        throw new Error('create failed');
      },
    });
    vi.stubGlobal('chrome', chrome);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({
      ok: false,
      error: 'Could not create the background audio page. Check the service worker console, then reload the extension.',
    });
    expect(sessionWrites).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[ishmael] offscreen startup failed', { problem: 'create-failed' });
  });

  it('checks for an existing offscreen document via runtime.getContexts with the offscreen URL', async () => {
    const { chrome, getContextsCalls } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    await beginReading('page');
    expect(getContextsCalls.length).toBeGreaterThan(0);
    expect(getContextsCalls[0]).toEqual({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: ['chrome-extension://test/offscreen.html'],
    });
  });
});

describe('GET_API_KEY contract', () => {
  it('answers GET_API_KEY with the stored key as a unicast response', async () => {
    const { chrome, messageListeners } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    await importBeginReading();

    const listener = messageListeners[0];
    expect(listener).toBeDefined();
    let response: unknown;
    listener?.({ target: 'service-worker', type: 'GET_API_KEY' }, {}, (value) => {
      response = value;
    });
    await vi.waitFor(() => expect(response).toEqual({ ok: true, apiKey: 'test-key' }));
  });

  it('answers GET_API_KEY with a missing-key error when no key is saved', async () => {
    const { chrome, messageListeners } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = async () => ({ 'ishmael.voiceId': 'voice-ref' });
    await importBeginReading();

    const listener = messageListeners[0];
    let response: unknown;
    listener?.({ target: 'service-worker', type: 'GET_API_KEY' }, {}, (value) => {
      response = value;
    });
    await vi.waitFor(() => expect(response).toEqual({ ok: false, error: 'No Fish Audio API key saved. Add one in the voice settings.' }));
    chrome.storage.local.get = originalGet;
  });

  it('never stores the API key in playback status or any session data', async () => {
    const { chrome, sessionWrites } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: true });
    const serialized = JSON.stringify(sessionWrites);
    expect(serialized).not.toContain('test-key');
  });
});

describe('mood across the message boundary', () => {
  it('passes the saved mood through the START_READING message to the offscreen controller', async () => {
    const { chrome, sentMessages } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: true });
    const start = sentMessages.find((message) => {
      return (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'START_READING'
      );
    }) as { mood?: unknown } | undefined;
    expect(start?.mood).toBe('calm');
  });

  it('sanitizes a stored invalid mood to none before it leaves the service worker', async () => {
    const { chrome, sentMessages } = makeChrome();
    vi.stubGlobal('chrome', chrome);
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = async () => ({ 'ishmael.mood': 'euphoric' });
    const beginReading = await importBeginReading();

    const result = await beginReading('page');
    expect(result).toEqual({ ok: false, error: 'No Fish Audio API key saved. Add one in the voice settings.' });
    expect(
      sentMessages.some((message) => {
        return (
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'START_READING'
        );
      }),
    ).toBe(false); // rejected before any session message (missing key)
    chrome.storage.local.get = originalGet;
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
