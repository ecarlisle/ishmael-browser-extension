// fallow-ignore-file

// Content script entry point.
//
// Injected on demand by the service worker (after an explicit user action),
// so it must not register broad page access. Responds to one message type:
// EXTRACT with a source of 'page' or 'selection'.

import { extractFromDocument, extractSelectionFromDocument } from './extract-core';
import { isExtensionMessage } from '../shared/messages';

const LOADED_KEY = '__ishmael_content_loaded__';

// The script can be injected multiple times (one executeScript call per
// "Read" click); guard so we only register the listener once per page.
const globalScope = globalThis as typeof globalThis & { [LOADED_KEY]?: boolean };
if (!globalScope[LOADED_KEY]) {
  globalScope[LOADED_KEY] = true;

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExtensionMessage(message) || message.target !== 'content' || message.type !== 'EXTRACT') {
      return false;
    }
    const result =
      message.source === 'selection' ? extractSelectionFromDocument(document) : extractFromDocument(document);
    sendResponse(result);
    return false;
  });
}
