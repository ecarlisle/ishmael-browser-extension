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

export const SEGMENT_KINDS: readonly SegmentKind[] = [
  'title',
  'heading',
  'paragraph',
  'blockquote',
  'list-item',
  'caption',
];

export type NarrationSegment = {
  id: string;
  kind: SegmentKind;
  text: string;
};

export function isHeadingKind(kind: SegmentKind): boolean {
  return kind === 'title' || kind === 'heading';
}

export function isNarrationSegment(value: unknown): value is NarrationSegment {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.text === 'string' &&
    SEGMENT_KINDS.includes(candidate.kind as SegmentKind)
  );
}

export function isNarrationSegments(value: unknown): value is NarrationSegment[] {
  return Array.isArray(value) && value.every(isNarrationSegment);
}

/**
 * Normalizes each segment's text, drops empty segments, and removes exact
 * duplicate text (keeping the first occurrence) while preserving order.
 */
export function dedupeSegments(segments: readonly NarrationSegment[]): NarrationSegment[] {
  const seen = new Set<string>();
  const out: NarrationSegment[] = [];
  for (const segment of segments) {
    const text = normalizeWhitespace(segment.text);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: segment.id, kind: segment.kind, text });
  }
  return out;
}
