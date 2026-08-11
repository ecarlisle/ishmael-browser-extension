// @vitest-environment jsdom
//
// Popup DOM tests. The full popup markup comes from index.html, chrome.* is
// stubbed at the runtime-message boundary, and the popup controller is
// imported for real — so these assert the actual rendered controls, state
// transitions, accessible names, tooltips, and click wiring.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIdleStatus, type PlaybackStatus } from '../shared/playback';

/** The <body> contents of index.html, without the module script tag. */
function popupBodyHtml(): string {
  // vitest runs from the repository root; jsdom rewrites import.meta.url, so
  // resolve fixtures from the process working directory instead.
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const match = /<body>([\s\S]*)<\/body>/.exec(html);
  const body = match?.[1];
  if (body === undefined) throw new Error('index.html <body> not found');
  return body.replace(/<script[\s\S]*?<\/script>/g, '');
}

type RuntimeListener = (message: unknown) => void;

let stateListeners: RuntimeListener[] = [];
let sentMessages: unknown[] = [];

function messageType(message: unknown): string {
  return typeof message === 'object' && message !== null && 'type' in message
    ? String((message as { type: unknown }).type)
    : '';
}

/** Responds to the service-worker message types the popup actually sends. */
function respond(message: unknown): unknown {
  switch (messageType(message)) {
    case 'GET_SETTINGS':
      return { settings: { hasApiKey: true, voiceId: 'voice-ref', model: 's2.1-pro-free', speed: 1, mood: 'calm' } };
    case 'GET_STATUS':
      return { status: createIdleStatus() };
    case 'READ_PAGE':
    case 'READ_SELECTION':
      return { ok: true };
    default:
      return undefined;
  }
}

const chromeStub = {
  runtime: {
    sendMessage: vi.fn((message: unknown): Promise<unknown> => {
      sentMessages.push(message);
      return Promise.resolve(respond(message));
    }),
    onMessage: {
      addListener: (listener: RuntimeListener) => {
        stateListeners.push(listener);
      },
    },
  },
};

/** Broadcasts a PLAYBACK_STATE status the way the offscreen controller does. */
function emitStatus(status: PlaybackStatus): void {
  for (const listener of stateListeners) {
    listener({ target: 'service-worker', type: 'PLAYBACK_STATE', status });
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zm8 0h4v14h-4z';

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub);
  document.body.innerHTML = popupBodyHtml();
  // The controller wires itself and runs init() at import time.
  await import('./popup');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

afterEach(() => {
  emitStatus(createIdleStatus());
  const status = byId('status');
  status.hidden = true;
  status.textContent = '';
  status.className = 'status';
  sentMessages = [];
  vi.clearAllMocks();
});

function playPause(): HTMLButtonElement {
  return byId<HTMLButtonElement>('play-pause');
}

function iconPath(button: HTMLButtonElement): string | null {
  return button.querySelector('svg path')?.getAttribute('d') ?? null;
}

describe('player rendering by playback state', () => {
  it('renders an idle, fully disabled player', () => {
    const status = byId('player-status');
    expect(status.textContent).toBe('No active session');
    expect(byId('player-meta').textContent).toBe('');

    expect(playPause().disabled).toBe(true);
    expect(byId<HTMLButtonElement>('prev').disabled).toBe(true);
    expect(byId<HTMLButtonElement>('next').disabled).toBe(true);
    expect(byId<HTMLButtonElement>('stop').disabled).toBe(true);
    expect(byId<HTMLButtonElement>('read-page').disabled).toBe(false);
    expect(byId<HTMLButtonElement>('read-selection').disabled).toBe(false);
  });

  it('renders a playing session with enabled transport and section meta', () => {
    emitStatus({ phase: 'playing', index: 1, total: 5, speed: 1 });

    expect(byId('player-status').textContent).toBe('Reading');
    expect(byId('player-meta').textContent).toBe('Section 2 of 5');
    expect(playPause().disabled).toBe(false);
    expect(byId<HTMLButtonElement>('prev').disabled).toBe(false);
    expect(byId<HTMLButtonElement>('next').disabled).toBe(false);
    expect(byId<HTMLButtonElement>('stop').disabled).toBe(false);
  });

  it('renders a loading session as preparing and disables play/pause', () => {
    emitStatus({ phase: 'loading', index: 0, total: 0, speed: 1 });
    expect(byId('player-status').textContent).toBe('Preparing narration…');
    expect(byId('player-meta').textContent).toBe('');
    expect(playPause().disabled).toBe(true);
    expect(byId<HTMLButtonElement>('prev').disabled).toBe(true);

    // A known queue during loading makes the transport navigable.
    emitStatus({ phase: 'loading', index: 0, total: 4, speed: 1 });
    expect(byId<HTMLButtonElement>('next').disabled).toBe(false);
    expect(byId<HTMLButtonElement>('stop').disabled).toBe(false);
  });

  it('renders a paused session and swaps the Play/Pause icon and label', () => {
    emitStatus({ phase: 'paused', index: 2, total: 5, speed: 1 });

    expect(byId('player-status').textContent).toBe('Paused');
    expect(byId('player-meta').textContent).toBe('Section 3 of 5');
    expect(playPause().disabled).toBe(false);
    expect(iconPath(playPause())).toBe(PLAY_PATH);
    expect(playPause().getAttribute('aria-label')).toBe('Resume narration');
    expect(playPause().dataset.tooltip).toBe('Resume narration');

    // Back to playing: icon, label, and tooltip flip again.
    emitStatus({ phase: 'playing', index: 2, total: 5, speed: 1 });
    expect(iconPath(playPause())).toBe(PAUSE_PATH);
    expect(playPause().getAttribute('aria-label')).toBe('Pause narration');
    expect(playPause().dataset.tooltip).toBe('Pause narration');
  });

  it('renders an error session, reports the message, and recovers', () => {
    emitStatus({ phase: 'error', index: 0, total: 3, speed: 1, error: 'No API key saved.' });

    expect(byId('player-status').textContent).toBe('Narration error');
    expect(byId('player-meta').textContent).toBe('Section 1 of 3');
    expect(playPause().disabled).toBe(true);
    expect(byId<HTMLButtonElement>('stop').disabled).toBe(false);

    const status = byId('status');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Error: No API key saved.');
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.getAttribute('aria-live')).toBe('assertive');

    // A recovered session clears the stale error banner.
    emitStatus({ phase: 'playing', index: 0, total: 3, speed: 1 });
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe('');
  });
});

describe('starting narration', () => {
  it('Read page sends READ_PAGE and tracks the source through to playing', async () => {
    byId<HTMLButtonElement>('read-page').click();
    expect(sentMessages).toContainEqual({ target: 'service-worker', type: 'READ_PAGE' });
    expect(byId('player-status').textContent).toBe('Preparing page…');

    await new Promise((resolve) => setTimeout(resolve, 0));
    emitStatus({ phase: 'loading', index: 0, total: 0, speed: 1 });
    expect(byId('player-status').textContent).toBe('Preparing page…');

    emitStatus({ phase: 'playing', index: 0, total: 3, speed: 1 });
    expect(byId('player-status').textContent).toBe('Reading page');
    expect(byId('player-meta').textContent).toBe('Section 1 of 3');
  });

  it('Read selection sends READ_SELECTION and tracks its own source', async () => {
    byId<HTMLButtonElement>('read-selection').click();
    expect(sentMessages).toContainEqual({ target: 'service-worker', type: 'READ_SELECTION' });
    expect(byId('player-status').textContent).toBe('Preparing selection…');

    await new Promise((resolve) => setTimeout(resolve, 0));
    emitStatus({ phase: 'playing', index: 1, total: 4, speed: 1 });
    expect(byId('player-status').textContent).toBe('Reading selection');
  });

  it('shows a success confirmation after narration starts', async () => {
    byId<HTMLButtonElement>('read-page').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(byId('status').textContent).toBe('Narration started.');
  });
});

describe('transport click wiring', () => {
  it('sends the matching service-worker command for each control', () => {
    emitStatus({ phase: 'playing', index: 0, total: 3, speed: 1 });

    playPause().click();
    byId<HTMLButtonElement>('prev').click();
    byId<HTMLButtonElement>('next').click();
    byId<HTMLButtonElement>('stop').click();

    expect(sentMessages).toEqual([
      { target: 'service-worker', type: 'PLAY_PAUSE' },
      { target: 'service-worker', type: 'PREVIOUS' },
      { target: 'service-worker', type: 'NEXT' },
      { target: 'service-worker', type: 'STOP' },
    ]);
  });
});

describe('accessible names, tooltips, and structure', () => {
  const iconOnly = () => [
    ['prev', 'Previous section'],
    ['play-pause', 'Pause narration'],
    ['next', 'Next section'],
    ['stop', 'Stop narration'],
  ] as const;

  it('gives every icon-only control an accurate aria-label and tooltip', () => {
    for (const [id, hint] of iconOnly()) {
      const button = byId<HTMLButtonElement>(id);
      expect(button.getAttribute('aria-label')).toBe(hint);
      expect(button.dataset.tooltip).toBe(hint);
    }
  });

  it('keeps the Play/Pause tooltip in sync with its accessible label', () => {
    emitStatus({ phase: 'paused', index: 0, total: 1, speed: 1 });
    expect(playPause().getAttribute('aria-label')).toBe('Resume narration');
    expect(playPause().dataset.tooltip).toBe('Resume narration');
  });

  it('gives the labelled start buttons their tooltip hints', () => {
    expect(byId<HTMLButtonElement>('read-page').dataset.tooltip).toBe('Read this page');
    expect(byId<HTMLButtonElement>('read-selection').dataset.tooltip).toBe('Read selected text');
  });

  it('marks every inline SVG as decorative and non-focusable', () => {
    const svgs = document.querySelectorAll('#panel-listen svg');
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.hasAttribute('tabindex')).toBe(false);
    }
  });

  it('uses semantic buttons in the expected tab order', () => {
    const panel = byId('panel-listen');
    const buttons = [...panel.querySelectorAll('button')];
    expect(buttons.every((button) => button instanceof HTMLButtonElement)).toBe(true);
    expect(buttons.map((button) => button.id)).toEqual([
      'read-page',
      'read-selection',
      'prev',
      'play-pause',
      'next',
      'stop',
    ]);
  });

  it('groups the start and transport actions for assistive tech', () => {
    expect(byId('panel-listen').querySelector('.player__start')?.getAttribute('aria-label')).toBe('Start narration');
    expect(byId('panel-listen').querySelector('.player__transport')?.getAttribute('aria-label')).toBe(
      'Playback controls',
    );
    expect(byId('player-status').closest('.player__session')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('tooltip presentation', () => {
  it('renders tooltips from data-tooltip on hover and keyboard focus', () => {
    const css = readFileSync(join(process.cwd(), 'src/popup/popup.css'), 'utf8');
    expect(css).toMatch(/content:\s*attr\(data-tooltip\)/);
    expect(css).toMatch(/button\[data-tooltip\]:hover::after/);
    expect(css).toMatch(/button\[data-tooltip\]:focus::after/);
    expect(css).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/button\[data-tooltip\]:disabled::after/);
  });
});
