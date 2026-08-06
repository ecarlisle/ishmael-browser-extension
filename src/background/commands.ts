// Manifest V3 command → narration-source mapping. Pure so it is unit-testable.

export const READ_PAGE_COMMAND = 'read-page';
export const READ_SELECTION_COMMAND = 'read-selection';

export type NarrationSource = 'page' | 'selection';

/**
 * Maps a chrome.commands command name to a narration source. Unknown commands
 * (including Chrome's reserved `_execute_action`) return null so they are
 * ignored.
 */
export function sourceForCommand(command: string): NarrationSource | null {
  switch (command) {
    case READ_PAGE_COMMAND:
      return 'page';
    case READ_SELECTION_COMMAND:
      return 'selection';
    default:
      return null;
  }
}
