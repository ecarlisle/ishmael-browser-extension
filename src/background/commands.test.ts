import { describe, expect, it } from 'vitest';
import {
  sourceForCommand,
  READ_PAGE_COMMAND,
  READ_SELECTION_COMMAND,
} from './commands';

describe('sourceForCommand', () => {
  it('maps read-page to the page source', () => {
    expect(sourceForCommand(READ_PAGE_COMMAND)).toBe('page');
  });

  it('maps read-selection to the selection source', () => {
    expect(sourceForCommand(READ_SELECTION_COMMAND)).toBe('selection');
  });

  it('returns null for unknown commands', () => {
    expect(sourceForCommand('toggle-feature')).toBeNull();
  });

  it('returns null for the reserved action command', () => {
    expect(sourceForCommand('_execute_action')).toBeNull();
  });

  it('returns null for an empty command name', () => {
    expect(sourceForCommand('')).toBeNull();
  });
});
