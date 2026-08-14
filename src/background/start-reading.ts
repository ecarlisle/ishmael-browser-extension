// Offscreen startup orchestration: a readiness handshake followed by a
// validated START_READING acknowledgement.
//
// chrome.offscreen.createDocument() resolves once the document has completed
// its initial page load, so a document whose controller script threw during
// startup (for example a missing extension API — offscreen documents support
// only chrome.runtime) never registers a message listener and can never be
// messaged. The PING/PONG handshake below verifies the controller actually
// initialized and is responding before START_READING is sent; a controller
// that is not yet ready (or never became ready) yields a distinct, actionable
// error instead of a silent success.
//
// The messaging boundary and delays are injected so the whole contract is
// unit-testable without a browser. Safe diagnostic outcomes are retained
// (never message contents, credentials, or narration text) so the service
// worker can distinguish failure stages.

import { isPongResponse, isStartReadingAck, type ExtensionMessage } from '../shared/messages';

/** Max PING polls before declaring the offscreen controller not ready. */
export const READY_MAX_ATTEMPTS = 8;
/** Delay between PING polls (~2 s total budget). */
// fallow-ignore-next-line unused-export
export const READY_POLL_INTERVAL_MS = 250;
/** START_READING delivery attempts once the controller is ready. */
// fallow-ignore-next-line unused-export
export const START_READING_MAX_ATTEMPTS = 2;
// fallow-ignore-next-line unused-export
export const START_READING_RETRY_DELAY_MS = 200;

/** The controller never answered PING within the budget. */
export const OFFSCREEN_NOT_READY_MESSAGE =
  'Background audio did not become ready. Check the extension\'s offscreen document console, then reload the extension.';
/** The controller was ready but never acknowledged START_READING. */
export const START_READING_FAILED_MESSAGE =
  'Background audio did not start. Check the service worker and offscreen consoles, then reload the extension.';

/**
 * Failure stages distinguished by the service worker for diagnostics. Safe
 * technical detail only — never message contents, credentials, or text.
 */
export type OffscreenProblem =
  /** runtime.sendMessage rejected or resolved without a response. */
  | 'no-receiver'
  /** The context responded, but the payload was not a valid PONG. */
  | 'malformed-pong'
  /** The document existed but never became responsive within the budget. */
  | 'not-ready'
  /** Ready, but START_READING was never acknowledged. */
  | 'start-not-acknowledged'
  /** The controller explicitly rejected the session with its own error. */
  | 'controller-rejected';

export type SendOutcome = { ok: true; value: unknown } | { ok: false; problem: 'no-receiver' };

export type StartReadingResult =
  | { ok: true }
  | { ok: false; error: string; problem: OffscreenProblem };

type Send = (message: ExtensionMessage) => Promise<SendOutcome>;
type Delay = (ms: number) => Promise<void>;

/**
 * Starts a narration session in the offscreen controller:
 *
 * 1. Poll PING until a valid PONG arrives (up to `READY_MAX_ATTEMPTS`,
 *    `READY_POLL_INTERVAL_MS` apart). A missing receiver or malformed
 *    response is recorded and the poll continues.
 * 2. Send START_READING and require a validated acknowledgement, retrying
 *    once on delivery failure.
 *
 * Returns a distinct, actionable error plus a safe `problem` tag for each
 * failure stage. Never reports success without an accepted session, and never
 * waits for Fish synthesis before acknowledging acceptance.
 */
export async function startOffscreenSession(
  startMessage: Extract<ExtensionMessage, { type: 'START_READING' }>,
  send: Send,
  delay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<StartReadingResult> {
  let ready = false;
  let lastProblem: Exclude<OffscreenProblem, 'start-not-acknowledged' | 'controller-rejected'> = 'not-ready';
  for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await send({ target: 'offscreen', type: 'PING' });
    if (outcome.ok) {
      if (isPongResponse(outcome.value)) {
        ready = true;
        break;
      }
      lastProblem = outcome.value === undefined ? 'no-receiver' : 'malformed-pong';
    } else {
      lastProblem = outcome.problem;
    }
    if (attempt < READY_MAX_ATTEMPTS - 1) {
      await delay(READY_POLL_INTERVAL_MS);
    }
  }
  if (!ready) {
    return { ok: false, error: OFFSCREEN_NOT_READY_MESSAGE, problem: lastProblem };
  }

  for (let attempt = 0; attempt < START_READING_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await send(startMessage);
    if (outcome.ok && isStartReadingAck(outcome.value)) {
      return outcome.value.ok
        ? { ok: true }
        : { ok: false, error: outcome.value.error, problem: 'controller-rejected' };
    }
    if (attempt < START_READING_MAX_ATTEMPTS - 1) {
      await delay(START_READING_RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: START_READING_FAILED_MESSAGE, problem: 'start-not-acknowledged' };
}
