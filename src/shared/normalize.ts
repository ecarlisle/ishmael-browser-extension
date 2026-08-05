// Deterministic text normalization shared by extraction, chunking, and tests.

/** Characters that are removed entirely (zero-width, BOM, control chars). */
const REMOVE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;

/** Unicode space variants that collapse to a plain space. */
const SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

/**
 * Collapses all whitespace runs to single spaces, trims the result, removes
 * control/zero-width characters, and maps exotic spaces to plain spaces.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(REMOVE, '').replace(SPACE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Removes characters that are not valid within a Fish Audio narration chunk:
 * nothing meaningful is removed beyond what `normalizeWhitespace` already
 * handles. Exists so callers have one entry point for "clean this text".
 */
export function cleanNarrationText(text: string): string {
  return normalizeWhitespace(text);
}
