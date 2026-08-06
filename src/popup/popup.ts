// Popup controller: settings, actions, and live playback status display.
// The API key is never rendered back into the DOM after being saved.

import './popup.css';
import { isExtensionMessage, type ExtensionMessage } from '../shared/messages';
import type { Mood, RedactedSettings } from '../shared/settings';
import { createIdleStatus, type PlaybackStatus } from '../shared/playback';
import { applyStatusTone, type StatusKind } from './status-tone';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const elements = {
  apiKey: byId<HTMLInputElement>('api-key'),
  saveKey: byId<HTMLButtonElement>('save-key'),
  keyState: byId<HTMLSpanElement>('key-state'),
  keyActions: byId<HTMLDivElement>('key-actions'),
  replaceKey: byId<HTMLButtonElement>('replace-key'),
  removeKey: byId<HTMLButtonElement>('remove-key'),
  voiceId: byId<HTMLInputElement>('voice-id'),
  model: byId<HTMLSelectElement>('model'),
  mood: byId<HTMLSelectElement>('mood'),
  speed: byId<HTMLInputElement>('speed'),
  speedValue: byId<HTMLOutputElement>('speed-value'),
  saveVoice: byId<HTMLButtonElement>('save-voice'),
  tabListen: byId<HTMLButtonElement>('tab-listen'),
  tabSettings: byId<HTMLButtonElement>('tab-settings'),
  panelListen: byId<HTMLElement>('panel-listen'),
  panelSettings: byId<HTMLElement>('panel-settings'),
  settingsSummaryNote: byId<HTMLSpanElement>('settings-summary-note'),
  readPage: byId<HTMLButtonElement>('read-page'),
  readSelection: byId<HTMLButtonElement>('read-selection'),
  playPause: byId<HTMLButtonElement>('play-pause'),
  prev: byId<HTMLButtonElement>('prev'),
  next: byId<HTMLButtonElement>('next'),
  stop: byId<HTMLButtonElement>('stop'),
  segmentInfo: byId<HTMLParagraphElement>('segment-info'),
  status: byId<HTMLParagraphElement>('status'),
};

/** The two popup views in tab order (roving tabindex, see selectTab). */
const tabs: ReadonlyArray<HTMLButtonElement> = [elements.tabListen, elements.tabSettings];

/** True once the API key and reference ID are both saved (drives the default view). */
let setupComplete = false;

/**
 * Switches the popup to the given view. Inactive tabs stay in the tab order
 * only via arrow keys (WAI-ARIA tabs pattern); panels are hidden/shown.
 */
function selectTab(tab: HTMLButtonElement): void {
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }
  elements.panelListen.hidden = tab !== elements.tabListen;
  elements.panelSettings.hidden = tab !== elements.tabSettings;
}

/** Arrow/Home/End navigation between the Listen and Voice Settings tabs. */
function onTabKeyDown(event: KeyboardEvent): void {
  const activeIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (activeIndex === -1) return;
  let next = activeIndex;
  if (event.key === 'ArrowRight') next = (activeIndex + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (activeIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  const target = tabs[next];
  if (!target) return;
  selectTab(target);
  target.focus();
}

function send<T>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

let statusKind: StatusKind | null = null;

function setStatus(text: string, kind: StatusKind = 'info'): void {
  statusKind = kind;
  elements.status.textContent = text;
  elements.status.hidden = false;
  applyStatusTone(elements.status, kind);
}

function showError(text: string): void {
  setStatus(`Error: ${text}`, 'error');
}

/** Hides the status container so it does not consume popup space when empty. */
function clearStatus(): void {
  statusKind = null;
  elements.status.textContent = '';
  elements.status.hidden = true;
  elements.status.classList.remove('status--error', 'status--success', 'status--info');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSettings(settings: RedactedSettings): void {
  elements.voiceId.value = settings.voiceId;
  elements.model.value = settings.model;
  elements.mood.value = settings.mood;
  elements.speed.value = String(settings.speed);
  elements.speedValue.value = `${settings.speed}×`;

  // The tab note mirrors setup state: the popup defaults to Voice Settings
  // when the key or reference ID is still missing (see init).
  setupComplete = settings.hasApiKey && settings.voiceId.trim().length > 0;
  elements.settingsSummaryNote.textContent = setupComplete ? 'Configured' : 'Setup required';

  if (settings.hasApiKey) {
    elements.apiKey.placeholder = 'Key is saved — enter a new one to replace it';
    elements.apiKey.value = '';
    elements.saveKey.disabled = true;
    elements.keyState.textContent = 'API key is saved locally.';
    elements.keyActions.hidden = false;
  } else {
    elements.apiKey.placeholder = 'Paste your API key';
    elements.saveKey.disabled = true;
    elements.keyState.textContent = 'No API key saved yet.';
    elements.keyActions.hidden = true;
  }
}

function phaseLabel(phase: PlaybackStatus['phase']): string {
  switch (phase) {
    case 'loading':
      return 'Loading';
    case 'playing':
      return 'Playing';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
  }
}

function renderStatus(status: PlaybackStatus): void {
  const active = status.phase !== 'idle' && status.total > 0;

  elements.playPause.disabled = !(status.phase === 'playing' || status.phase === 'paused');
  elements.playPause.textContent = status.phase === 'paused' ? 'Resume' : 'Pause';
  elements.prev.disabled = !active;
  elements.next.disabled = !active;
  elements.stop.disabled = !active;

  if (status.total > 0) {
    const shownIndex = Math.min(status.index + 1, status.total);
    elements.segmentInfo.textContent = `Segment ${shownIndex} of ${status.total} — ${phaseLabel(status.phase)}`;
  } else {
    elements.segmentInfo.textContent = 'No active session';
  }

  if (status.phase === 'error' && status.error) {
    showError(status.error);
  } else if (status.phase === 'loading') {
    setStatus('Preparing narration…', 'info');
  } else if (statusKind === 'error') {
    // A non-error state arrived after an error: do not leave the error
    // visible once the action recovered or was superseded.
    clearStatus();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function readWithSource(source: 'page' | 'selection', label: string): Promise<void> {
  setStatus(`${label} — extracting and preparing narration…`);
  try {
    const response = await send<{ ok: boolean; error?: string }>(
      source === 'page'
        ? { target: 'service-worker', type: 'READ_PAGE' }
        : { target: 'service-worker', type: 'READ_SELECTION' },
    );
    if (!response.ok) {
      showError(response.error ?? 'Could not start narration.');
      return;
    }
    setStatus('Narration started.', 'success');
  } catch {
    showError('Could not reach the extension. Reopen the popup and try again.');
  }
}

async function saveKey(): Promise<void> {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) return;
  try {
    await send({ target: 'service-worker', type: 'SAVE_SETTINGS', patch: { apiKey } });
    elements.apiKey.value = '';
    setStatus('API key saved.', 'success');
    await refreshSettings();
  } catch {
    showError('Could not save the API key. Try again.');
  }
}

async function removeKey(): Promise<void> {
  try {
    await send({ target: 'service-worker', type: 'REMOVE_API_KEY' });
    setStatus('API key removed.', 'success');
    await refreshSettings();
  } catch {
    showError('Could not remove the API key. Try again.');
  }
}

async function saveVoice(): Promise<void> {
  const voiceId = elements.voiceId.value.trim();
  if (!voiceId) {
    showError('Enter a voice/reference ID first.');
    return;
  }
  try {
    await send({
      target: 'service-worker',
      type: 'SAVE_SETTINGS',
      patch: {
        voiceId,
        model: elements.model.value as RedactedSettings['model'],
        mood: elements.mood.value as Mood,
      },
    });
    setStatus('Voice settings saved.', 'success');
  } catch {
    showError('Could not save the voice settings. Try again.');
  }
}

async function applySpeed(): Promise<void> {
  const speed = Number(elements.speed.value);
  elements.speedValue.value = `${speed.toFixed(1)}×`;
  try {
    await send({ target: 'service-worker', type: 'SAVE_SETTINGS', patch: { speed } });
    setStatus('Narration speed saved.', 'success');
  } catch {
    showError('Could not save the narration speed. Try again.');
  }
}

async function control(type: 'PLAY_PAUSE' | 'PREVIOUS' | 'NEXT' | 'STOP'): Promise<void> {
  try {
    await send({ target: 'service-worker', type });
    clearStatus();
  } catch {
    showError('Could not reach the extension. Try again.');
  }
}

async function refreshSettings(): Promise<void> {
  const response = await send<{ settings: RedactedSettings }>({ target: 'service-worker', type: 'GET_SETTINGS' });
  renderSettings(response.settings);
}

async function refreshStatus(): Promise<void> {
  const response = await send<{ status: PlaybackStatus }>({ target: 'service-worker', type: 'GET_STATUS' });
  renderStatus(response.status);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire(): void {
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', onTabKeyDown);
  }
  elements.apiKey.addEventListener('input', () => {
    elements.saveKey.disabled = elements.apiKey.value.trim().length === 0;
  });
  elements.saveKey.addEventListener('click', () => void saveKey());
  elements.replaceKey.addEventListener('click', () => {
    elements.apiKey.focus();
    elements.apiKey.placeholder = 'Paste a new API key';
  });
  elements.removeKey.addEventListener('click', () => void removeKey());
  elements.saveVoice.addEventListener('click', () => void saveVoice());
  elements.speed.addEventListener('change', () => void applySpeed());

  elements.readPage.addEventListener('click', () => void readWithSource('page', 'Reading page'));
  elements.readSelection.addEventListener('click', () => void readWithSource('selection', 'Reading selection'));
  elements.playPause.addEventListener('click', () => void control('PLAY_PAUSE'));
  elements.prev.addEventListener('click', () => void control('PREVIOUS'));
  elements.next.addEventListener('click', () => void control('NEXT'));
  elements.stop.addEventListener('click', () => void control('STOP'));

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isExtensionMessage(message) && message.type === 'PLAYBACK_STATE') {
      renderStatus(message.status);
    }
    return false;
  });
}

async function init(): Promise<void> {
  wire();
  renderStatus(createIdleStatus());
  try {
    await refreshSettings();
    // Open on Voice Settings while setup is incomplete, like the old
    // auto-expanded disclosure; the user controls the view from then on.
    if (!setupComplete) selectTab(elements.tabSettings);
    await refreshStatus();
  } catch {
    showError('Could not reach the extension. Reopen the popup and try again.');
  }
}

void init();
