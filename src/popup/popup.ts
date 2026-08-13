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

/** Inline SVG icons (currentColor, decorative). Kept here so the popup can
 * swap the Play/Pause glyph as the playback phase changes. */
const PLAY_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const EYE_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C4 8.3 2 12 2 12s3.6 7 10 7a10.4 10.4 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

type View = 'onboarding' | 'app' | 'help';

const elements = {
  viewOnboarding: byId<HTMLElement>('view-onboarding'),
  viewApp: byId<HTMLElement>('view-app'),
  viewHelp: byId<HTMLElement>('view-help'),

  onboardingForm: byId<HTMLFormElement>('onboarding-form'),
  onboardingApiKey: byId<HTMLInputElement>('onboarding-api-key'),
  onboardingToggleVisibility: byId<HTMLButtonElement>('onboarding-toggle-visibility'),
  onboardingHelpToggle: byId<HTMLButtonElement>('onboarding-help-toggle'),
  onboardingHelpContent: byId<HTMLDivElement>('onboarding-help-content'),

  openHelp: byId<HTMLButtonElement>('open-help'),
  closeHelp: byId<HTMLButtonElement>('close-help'),

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
  playerStatus: byId<HTMLParagraphElement>('player-status'),
  segmentTracker: byId<HTMLDivElement>('segment-tracker'),
  playerMeta: byId<HTMLSpanElement>('player-meta'),
  progressTrack: byId<HTMLDivElement>('progress-track'),
  progressFill: byId<HTMLDivElement>('progress-fill'),
  status: byId<HTMLParagraphElement>('status'),
};

/** The source of the most recent narration the popup started (unknown when
 * the session began from a keyboard shortcut with the popup closed). */
let lastSource: 'page' | 'selection' | null = null;

/** The two in-app views in tab order (roving tabindex, see selectTab). */
const tabs: ReadonlyArray<HTMLButtonElement> = [elements.tabListen, elements.tabSettings];

/** True once the API key and reference ID are both saved (drives the default tab). */
let setupComplete = false;

/** Which app tab was active before Help & Privacy was opened, so closing it returns there. */
let tabBeforeHelp: HTMLButtonElement = elements.tabListen;

/**
 * Switches the popup between onboarding, the main app, and Help & Privacy.
 * Only one top-level view is visible at a time.
 */
function showView(view: View): void {
  elements.viewOnboarding.hidden = view !== 'onboarding';
  elements.viewApp.hidden = view !== 'app';
  elements.viewHelp.hidden = view !== 'help';
}

/**
 * Switches the popup to the given in-app tab. Inactive tabs stay in the tab
 * order only via arrow keys (WAI-ARIA tabs pattern); panels are hidden/shown.
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
  // when the reference ID is still missing (see init).
  setupComplete = settings.hasApiKey && settings.voiceId.trim().length > 0;
  elements.settingsSummaryNote.textContent = setupComplete ? '' : 'Setup required';

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

  // Onboarding gates the whole app: without a key, nothing else is reachable.
  if (!elements.viewHelp.hidden) return; // do not steal focus from an open Help screen
  showView(settings.hasApiKey ? 'app' : 'onboarding');
}

/** Session headline shown in the player status area for each phase. */
function sessionStatusText(phase: PlaybackStatus['phase'], source: 'page' | 'selection' | null): string {
  switch (phase) {
    case 'idle':
      return 'No active session';
    case 'loading':
      return source === 'page' ? 'Preparing page…' : source === 'selection' ? 'Preparing selection…' : 'Preparing narration…';
    case 'playing':
      return source === 'page' ? 'Reading page' : source === 'selection' ? 'Reading selection' : 'Reading';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Narration error';
  }
}

/** Makes the central Play/Pause control reflect the current phase: icon,
 * accessible name, tooltip, and enabled state change together. */
function renderPlayPause(status: PlaybackStatus): void {
  const canToggle = status.phase === 'playing' || status.phase === 'paused';
  const paused = status.phase === 'paused';
  elements.playPause.disabled = !canToggle;
  elements.playPause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  elements.playPause.setAttribute('aria-label', paused ? 'Resume narration' : 'Pause narration');
  elements.playPause.dataset.tooltip = paused ? 'Resume narration' : 'Pause narration';
}

function renderStatus(status: PlaybackStatus): void {
  renderPlayPause(status);

  const active = status.phase !== 'idle' && status.total > 0;
  elements.prev.disabled = !active;
  elements.next.disabled = !active;
  elements.stop.disabled = !active;

  elements.playerStatus.textContent = sessionStatusText(status.phase, lastSource);

  if (active) {
    const shownIndex = Math.min(status.index + 1, status.total);
    const phaseLabel =
      status.phase === 'paused'
        ? 'Paused'
        : status.phase === 'loading'
          ? 'Preparing'
          : status.phase === 'error'
            ? 'Error'
            : 'Playing';
    elements.segmentTracker.hidden = false;
    elements.playerMeta.textContent = `Segment ${shownIndex} of ${status.total} — ${phaseLabel}`;

    const completed = status.phase === 'playing' ? status.index + 0.5 : status.index;
    const percent = Math.min(100, Math.max(0, (completed / status.total) * 100));
    elements.progressTrack.hidden = false;
    elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
    elements.progressFill.style.width = `${percent}%`;
  } else {
    elements.segmentTracker.hidden = true;
    elements.playerMeta.textContent = '';
    elements.progressTrack.hidden = true;
    elements.progressFill.style.width = '0%';
  }

  if (status.phase === 'error' && status.error) {
    showError(status.error);
  } else if (statusKind === 'error') {
    // A non-error state arrived after an error: do not leave the error
    // visible once the action recovered or was superseded.
    clearStatus();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function readWithSource(source: 'page' | 'selection'): Promise<void> {
  lastSource = source;
  elements.playerStatus.textContent = source === 'page' ? 'Preparing page…' : 'Preparing selection…';
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

async function saveKeyFrom(input: HTMLInputElement): Promise<void> {
  const apiKey = input.value.trim();
  if (!apiKey) return;
  try {
    await send({ target: 'service-worker', type: 'SAVE_SETTINGS', patch: { apiKey } });
    input.value = '';
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

  elements.openHelp.addEventListener('click', () => {
    tabBeforeHelp = elements.tabSettings.getAttribute('aria-selected') === 'true' ? elements.tabSettings : elements.tabListen;
    showView('help');
  });
  elements.closeHelp.addEventListener('click', () => {
    selectTab(tabBeforeHelp);
    showView('app');
  });

  elements.onboardingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveKeyFrom(elements.onboardingApiKey);
  });
  elements.onboardingToggleVisibility.addEventListener('click', () => {
    const showing = elements.onboardingApiKey.type === 'text';
    elements.onboardingApiKey.type = showing ? 'password' : 'text';
    elements.onboardingToggleVisibility.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
    elements.onboardingToggleVisibility.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
  });
  elements.onboardingHelpToggle.addEventListener('click', () => {
    elements.onboardingHelpContent.hidden = !elements.onboardingHelpContent.hidden;
  });

  elements.apiKey.addEventListener('input', () => {
    elements.saveKey.disabled = elements.apiKey.value.trim().length === 0;
  });
  elements.saveKey.addEventListener('click', () => void saveKeyFrom(elements.apiKey));
  elements.replaceKey.addEventListener('click', () => {
    elements.apiKey.focus();
    elements.apiKey.placeholder = 'Paste a new API key';
  });
  elements.removeKey.addEventListener('click', () => void removeKey());
  elements.saveVoice.addEventListener('click', () => void saveVoice());
  elements.speed.addEventListener('change', () => void applySpeed());

  elements.readPage.addEventListener('click', () => void readWithSource('page'));
  elements.readSelection.addEventListener('click', () => void readWithSource('selection'));
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
