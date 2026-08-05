// Offscreen startup orchestration: a readiness handshake followed by a
// validated START_READING acknowledgement.
//
// chrome.offscreen.createDocument() resolves as soon as the document exists —
// not when its script has registered the runtime message listener. Messages
// sent before that point reject with "Receiving end does not exist." This
// module therefore polls the controller with PING until it answers PONG
// (short bounded backoff), then sends START_READING and requires a validated
// acknowledgement. The messaging boundary and delays are injected so the
// whole contract is unit-testable without a browser.

import { isPongResponse, isStartReadingAck, type ExtensionMessage } from '../shared/messages';

/** Max PING polls before declaring the offscreen document not ready. */
export const READY_MAX_ATTEMPTS = 8;
/** Delay between PING polls (~2 s total budget). */
export const READY_POLL_INTERVAL_MS = 250;
/** START_READING delivery attempts once the controller is ready. */
export const START_READING_MAX_ATTEMPTS = 2;
export const START_READING_RETRY_DELAY_MS = 200;

/** The document was created but never answered PING within the budget. */
export const OFFSCREEN_NOT_READY_MESSAGE =
  'Background audio did not become ready. Check the extension service worker console, then reload the extension.';
/** The document was ready but never acknowledged START_READING. */
export const START_READING_FAILED_MESSAGE =
  'Background audio did not start. Check the service worker and offscreen consoles, then reload the extension.';

export type StartReadingResult = { ok: true } | { ok: false; error: string };

type Send = (message: ExtensionMessage) => Promise<unknown>;
type Delay = (ms: number) => Promise<void>;

/**
 * Starts a narration session in the offscreen controller:
 *
 * 1. Poll PING until a valid PONG arrives (up to `READY_MAX_ATTEMPTS`,
 *    `READY_POLL_INTERVAL_MS` apart). A missing or malformed response is
 *    treated as not-yet-ready.
 * 2. Send START_READING and require a validated acknowledgement, retrying
 *    once on delivery failure.
 *
 * Returns distinct, actionable errors for "never became ready" versus
 * "ready but rejected or failed to acknowledge". Never reports success
 * without an accepted session, and never waits for Fish synthesis before
 * acknowledging acceptance.
 */
export async function startOffscreenSession(
  startMessage: Extract<ExtensionMessage, { type: 'START_READING' }>,
  send: Send,
  delay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<StartReadingResult> {
  let ready = false;
  for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt += 1) {
    let response: unknown;
    try {
      response = await send({ target: 'offscreen', type: 'PING' });
    } catch {
      // No receiving end yet (document still starting up): keep polling.
      response = undefined;
    }
    if (isPongResponse(response)) {
      ready = true;
      break;
    }
    if (attempt < READY_MAX_ATTEMPTS - 1) {
      await delay(READY_POLL_INTERVAL_MS);
    }
  }
  if (!ready) {
    return { ok: false, error: OFFSCREEN_NOT_READY_MESSAGE };
  }

  for (let attempt = 0; attempt < START_READING_MAX_ATTEMPTS; attempt += 1) {
    let response: unknown;
    try {
      response = await send(startMessage);
    } catch {
      response = undefined;
    }
    if (isStartReadingAck(response)) {
      return response.ok ? { ok: true } : { ok: false, error: response.error };
    }
    if (attempt < START_READING_MAX_ATTEMPTS - 1) {
      await delay(START_READING_RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: START_READING_FAILED_MESSAGE };
}
