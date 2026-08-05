// Fish Audio error mapping.
//
// Maps HTTP failures, network failures, and malformed responses to concise,
// actionable user-facing messages. Secrets (the API key) are never included;
// server-provided detail is sanitized, truncated, and only included when it
// cannot leak request text (4xx/5xx with generic detail).

import { normalizeWhitespace } from './normalize';

export type ErrorKind =
  | 'missing-api-key'
  | 'missing-voice'
  | 'unsupported-page'
  | 'empty-selection'
  | 'no-content'
  | 'network'
  | 'unauthorized'
  | 'insufficient-balance'
  | 'rate-limit'
  | 'invalid-request'
  | 'invalid-voice'
  | 'server-error'
  | 'malformed-response'
  | 'playback'
  | 'unknown';

export type ErrorResult = {
  kind: ErrorKind;
  message: string;
};

const KIND_MESSAGES: Record<ErrorKind, string> = {
  'missing-api-key': 'No Fish Audio API key saved. Add one in the voice settings.',
  'missing-voice': 'No Fish Audio voice/reference ID saved. Add one in the voice settings.',
  'unsupported-page': 'This browser page cannot be read. Open a regular web page first.',
  'empty-selection': 'Nothing is selected on the page. Select some text first.',
  'no-content': 'No readable content was found on this page.',
  network: 'Could not reach Fish Audio. Check your internet connection and try again.',
  unauthorized: 'Fish Audio rejected the API key (HTTP 401). Check the key in the voice settings.',
  'insufficient-balance': 'Fish Audio reported insufficient balance (HTTP 402). Add credit to your account.',
  'rate-limit': 'Fish Audio rate limit reached (HTTP 429). Wait a moment, then try again.',
  'invalid-request': 'Fish Audio rejected the request. Check the voice/reference ID and settings.',
  'invalid-voice': 'Fish Audio could not find that voice/reference ID. Check the ID in the voice settings.',
  'server-error': 'Fish Audio hit a server error. Wait a moment and try again.',
  'malformed-response': 'Fish Audio returned an unexpected response. Try again.',
  playback: 'The generated audio could not be played.',
  unknown: 'Something went wrong while narrating. Try again.',
};

export function messageForKind(kind: ErrorKind, detail?: string): string {
  const base = KIND_MESSAGES[kind];
  return detail ? `${base} ${detail}` : base;
}

/** A server error body is `{ "status": number, "message": string }`. */
export function parseFishErrorBody(responseBody: string): { status?: number; message?: string } {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (isRecord(parsed)) {
      return {
        status: typeof parsed.status === 'number' ? parsed.status : undefined,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
      };
    }
  } catch {
    // Not JSON; fall through.
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Sanitizes a server-provided message: redacts secret substrings, collapses
 * whitespace, and truncates to a safe length. Never include full article text
 * in errors.
 */
export function sanitizeServerMessage(message: unknown, secrets: readonly string[] = []): string {
  let text = typeof message === 'string' ? message : '';
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return normalizeWhitespace(text).slice(0, 160);
}

function mentionsVoiceDetail(message: string | undefined): boolean {
  if (!message) return false;
  return /reference|voice|model|speaker/i.test(message);
}

export function fishErrorFromStatus(status: number, serverMessage?: string): ErrorResult {
  switch (status) {
    case 401:
      return { kind: 'unauthorized', message: messageForKind('unauthorized') };
    case 402:
      return { kind: 'insufficient-balance', message: messageForKind('insufficient-balance') };
    case 429:
      return { kind: 'rate-limit', message: messageForKind('rate-limit') };
    case 400:
    case 422: {
      const kind: ErrorKind = mentionsVoiceDetail(serverMessage) ? 'invalid-voice' : 'invalid-request';
      const detail = serverMessage ? sanitizeServerMessage(serverMessage) : undefined;
      return { kind, message: messageForKind(kind, detail) };
    }
    default:
      if (status >= 500) {
        const detail = serverMessage ? sanitizeServerMessage(serverMessage) : undefined;
        return { kind: 'server-error', message: messageForKind('server-error', detail) };
      }
      return { kind: 'unknown', message: messageForKind('unknown', `(HTTP ${status})`) };
  }
}

/**
 * Maps a thrown error from a fetch/synthesis call. Abort errors are the
 * caller's signal that work was cancelled and are returned as `null` so the
 * caller can avoid reporting them as failures.
 */
export function fishErrorFromUnknown(error: unknown, secrets: readonly string[] = []): ErrorResult | null {
  if (isAbortError(error)) return null;
  if (error instanceof TypeError) {
    return { kind: 'network', message: messageForKind('network') };
  }
  if (error instanceof FishAudioError) {
    return fishErrorFromStatus(error.status, sanitizeServerMessage(error.serverMessage, secrets));
  }
  return { kind: 'unknown', message: messageForKind('unknown') };
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Wraps an HTTP failure from the Fish Audio endpoint with its status. */
export class FishAudioError extends Error {
  readonly status: number;
  readonly serverMessage: string | undefined;

  constructor(status: number, serverMessage?: string) {
    super(`Fish Audio HTTP ${status}`);
    this.name = 'FishAudioError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}
