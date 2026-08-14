// Popup controller: settings, actions, and live playback status display.
// The API key is never rendered back into the DOM after being saved.

import './popup.css';
import { isExtensionMessage, type ExtensionMessage } from '../shared/messages';
import { DEFAULT_SPEED, type Mood, type RedactedSettings } from '../shared/settings';
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
  appVersion: byId<HTMLSpanElement>('app-version'),
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

/** The view last shown by showView, so it only moves focus on a real transition. */
let currentView: View | null = null;

/**
 * Switches the popup between onboarding, the main app, and Help & Privacy.
 * Only one top-level view is visible at a time. On a real transition, focus
 * moves into the newly shown view — otherwise the element that had focus
 * gets hidden and the browser drops focus to <body>, silently stranding
 * keyboard and screen-reader users.
 */
function showView(view: View): void {
  const changed = view !== currentView;
  currentView = view;
  elements.viewOnboarding.hidden = view !== 'onboarding';
  elements.viewApp.hidden = view !== 'app';
  elements.viewHelp.hidden = view !== 'help';
  if (changed) focusView(view);
}

function focusView(view: View): void {
  if (view === 'onboarding') elements.onboardingApiKey.focus();
  else if (view === 'help') elements.closeHelp.focus();
  else elements.openHelp.focus();
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

/** Short user-facing name for each playback phase. */
function playbackPhaseLabel(phase: PlaybackStatus['phase']): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing';
    case 'connecting':
      return 'Connecting';
    case 'generating':
      return 'Generating';
    case 'buffering':
      return 'Buffering';
    case 'playing':
      return 'Playing';
    case 'paused':
      return 'Paused';
    case 'complete':
      return 'Complete';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
  }
}

/**
 * The headline shown above the transport controls: a short, always-present
 * phrase covering every phase. The segment count and precise phase word live
 * in the chip below (see renderStatus) so this stays readable at a glance.
 */
function statusHeadline(status: PlaybackStatus): string {
  switch (status.phase) {
    case 'idle':
      return 'No active session';
    case 'preparing':
      return lastSource === 'page'
        ? 'Preparing page…'
        : lastSource === 'selection'
          ? 'Preparing selection…'
          : 'Preparing narration…';
    case 'connecting':
    case 'generating':
    case 'buffering':
    case 'playing':
      return lastSource === 'page' ? 'Reading page' : lastSource === 'selection' ? 'Reading selection' : 'Reading';
    case 'paused':
      return 'Paused';
    case 'complete':
      return 'Finished';
    case 'stopped':
      return 'Stopped';
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

/**
 * Phases where the transport controls are meaningful: the session is live or
 * recoverable and the chunk count is known. Preparing/stopped/complete/idle
 * are not navigable.
 */
const NAVIGABLE_PHASES: readonly PlaybackStatus['phase'][] = [
  'connecting',
  'generating',
  'buffering',
  'playing',
  'paused',
  'error',
];

function renderStatus(status: PlaybackStatus): void {
  renderPlayPause(status);

  const navigable = NAVIGABLE_PHASES.includes(status.phase) && status.total > 0;
  elements.prev.disabled = !navigable;
  elements.next.disabled = !navigable;
  elements.stop.disabled = !navigable;

  elements.playerStatus.textContent = statusHeadline(status);

  // The chip shows the segment count and precise phase word whenever a count
  // is known, independent of whether the transport is currently navigable
  // (e.g. "Segment 3 of 3 — Complete" once a reading finishes).
  if (status.total > 0) {
    const shownIndex = Math.min(status.index + 1, status.total);
    elements.segmentTracker.hidden = false;
    elements.playerMeta.textContent = `Segment ${shownIndex} of ${status.total} — ${playbackPhaseLabel(status.phase)}`;
  } else {
    elements.segmentTracker.hidden = true;
    elements.playerMeta.textContent = '';
  }

  if (navigable) {
    const completed = status.phase === 'playing' ? status.index + 0.5 : status.index;
    const percent = Math.min(100, Math.max(0, (completed / status.total) * 100));
    elements.progressTrack.hidden = false;
    elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
    elements.progressFill.style.width = `${percent}%`;
  } else {
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
  // Optimistic local state while the service worker extracts: the offscreen
  // broadcasts the authoritative preparing → … → playing chain once it has
  // the session.
  renderStatus({ phase: 'preparing', index: 0, total: 0, speed: DEFAULT_SPEED });
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
  if (!apiKey) {
    showError('Enter your Fish Audio API key.');
    return;
  }
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
    const nowHidden = !elements.onboardingHelpContent.hidden;
    elements.onboardingHelpContent.hidden = nowHidden;
    elements.onboardingHelpToggle.setAttribute('aria-expanded', String(!nowHidden));
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
  elements.appVersion.textContent = `Ishmael v${chrome.runtime.getManifest().version}`;
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
