// Narration segment types and structural helpers.
//
// Segments are the structured, in-reading-order pieces extracted from a page.
// The chunker (chunking.ts) later turns them into Fish Audio request chunks.

import { normalizeWhitespace } from './normalize';

export type SegmentKind =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'list-item'
  | 'caption';

const SEGMENT_KINDS: readonly SegmentKind[] = [
  'title',
  'heading',
  'paragraph',
  'blockquote',
  'list-item',
  'caption',
];

/**
 * A half-open character range `[start, end)` into a segment's normalized
 * text that a `<strong>` or `<em>` element emphasizes. Kept as structured
 * metadata (never baked into the source text) so Ishmael-generated cues stay
 * distinguishable from authored page content until final request rendering.
 */
export type EmphasisRange = readonly [start: number, end: number];

export type NarrationSegment = {
  id: string;
  kind: SegmentKind;
  text: string;
  /** Inline `<strong>`/`<em>` emphasis ranges into `text`. Omitted when none. */
  emphasis?: readonly EmphasisRange[];
  /** True when a `<hr>` separates this segment from the previous one. */
  thematicBreakBefore?: boolean;
};

export function isHeadingKind(kind: SegmentKind): boolean {
  return kind === 'title' || kind === 'heading';
}

function isEmphasisRange(value: unknown, textLength: number): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [start, end] = value;
  return (
    typeof start === 'number' &&
    Number.isInteger(start) &&
    start >= 0 &&
    typeof end === 'number' &&
    Number.isInteger(end) &&
    end <= textLength &&
    start < end
  );
}

export function isNarrationSegment(value: unknown): value is NarrationSegment {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const text = candidate.text;
  if (
    typeof candidate.id !== 'string' ||
    typeof text !== 'string' ||
    !SEGMENT_KINDS.includes(candidate.kind as SegmentKind)
  ) {
    return false;
  }
  if (candidate.thematicBreakBefore !== undefined && typeof candidate.thematicBreakBefore !== 'boolean') {
    return false;
  }
  if (candidate.emphasis !== undefined) {
    if (!Array.isArray(candidate.emphasis)) return false;
    if (!candidate.emphasis.every((range) => isEmphasisRange(range, text.length))) return false;
  }
  return true;
}

export function isNarrationSegments(value: unknown): value is NarrationSegment[] {
  return Array.isArray(value) && value.every(isNarrationSegment);
}

/**
 * Normalizes each segment's text, drops empty segments, and removes exact
 * duplicate text (keeping the first occurrence) while preserving order.
 * Deduplication compares normalized source text only, before any narration
 * cue is applied, and carries each kept segment's structural metadata
 * (emphasis ranges and thematic-break flag) through unchanged.
 */
export function dedupeSegments(segments: readonly NarrationSegment[]): NarrationSegment[] {
  const seen = new Set<string>();
  const out: NarrationSegment[] = [];
  for (const segment of segments) {
    const text = normalizeWhitespace(segment.text);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const kept: NarrationSegment = { id: segment.id, kind: segment.kind, text };
    if (segment.thematicBreakBefore === true) kept.thematicBreakBefore = true;
    const emphasis = segment.emphasis?.filter(
      (range) => range[0] >= 0 && range[1] <= text.length && range[0] < range[1],
    );
    if (emphasis && emphasis.length > 0) kept.emphasis = emphasis;
    out.push(kept);
  }
  return out;
}
