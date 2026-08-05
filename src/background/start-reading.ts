// Delivery of the START_READING message to the offscreen controller, with a
// validated acknowledgement and one bounded retry.
//
// Starting narration is the critical startup path: the service worker must not
// report success merely because the offscreen document was created. This module
// is pure (the messaging boundary is injected) so the retry/acknowledgement
// contract is unit-testable.

import { isStartReadingAck, type ExtensionMessage } from '../shared/messages';

export const START_READING_MAX_ATTEMPTS = 2;
export const START_READING_RETRY_DELAY_MS = 250;

export const START_READING_FAILED_MESSAGE =
  'Background narration did not start. Reload the extension and try again.';

export type StartReadingResult = { ok: true } | { ok: false; error: string };

/**
 * Delivers START_READING and waits for the controller's acknowledgement.
 *
 * - A valid `{ ok: true }` acknowledgement means the session was accepted.
 * - A valid `{ ok: false, error }` acknowledgement is returned immediately
 *   (the controller received the request and refused it; retrying would not
 *   help).
 * - No acknowledgement (message delivery failure right after the offscreen
 *   document is created) is retried once, after a short delay. The response
 *   is validated, so a malformed acknowledgement is never treated as success.
 */
export async function sendStartReading(
  message: Extract<ExtensionMessage, { type: 'START_READING' }>,
  send: (message: ExtensionMessage) => Promise<unknown>,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<StartReadingResult> {
  for (let attempt = 0; attempt < START_READING_MAX_ATTEMPTS; attempt += 1) {
    let response: unknown;
    try {
      response = await send(message);
    } catch {
      // No receiving end (the offscreen document may still be starting up):
      // treat as a delivery failure and retry below.
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
