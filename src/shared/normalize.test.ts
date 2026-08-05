import { describe, expect, it } from 'vitest';
import { normalizeWhitespace } from './normalize';

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace to single spaces', () => {
    expect(normalizeWhitespace('Hello   world\n\tthere')).toBe('Hello world there');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  padded text  ')).toBe('padded text');
  });

  it('maps non-breaking and exotic spaces to plain spaces', () => {
    expect(normalizeWhitespace('a\u00A0b\u202Fc')).toBe('a b c');
  });

  it('removes zero-width and control characters', () => {
    expect(normalizeWhitespace('ab\u200Bcd\uFEFFef\u0007')).toBe('abcdef');
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalizeWhitespace('')).toBe('');
    expect(normalizeWhitespace('   \n\t ')).toBe('');
  });
});
