// Narration decoration: turns chunked source text into the final text sent to
// Fish Audio. This layer is conceptually separate from extraction (which
// captures page structure) and from Fish request construction (audio-core.ts).
//
// It adds two kinds of cues, both kept strictly separate from source text:
//
// 1. Structural cues derived automatically from page semantics — `[emphasis]`
//    for titles/headings and inline `<strong>`/`<em>` phrases, `[soft tone]`
//    for blockquotes and captions, and `[break]`/`[long-break]` for paragraph,
//    list, and thematic-break boundaries. No emotion is ever inferred from a
//    page.
// 2. The user's Mood cue (optional, defaults to none). The mood applies to
//    every request because chunks are synthesized independently, and always
//    precedes structural cues.
//
// Source integrity: chunks carry normalized source text plus boundary/emphasis
// metadata; decoration renders cues around that text and never alters its
// order or wording. Bracketed text already present on a page is preserved as
// authored. Cues exist only in the in-memory request text — never in stored
// page content or narration history.

import type { NarrationChunk, BoundaryKind } from './chunking';
import type { EmphasisRange, SegmentKind } from './segments';
import type { Mood } from './settings';

/** Local pause between two separate audio files at a semantic boundary (ms). */
export const INTER_CHUNK_PAUSE_MS = 250;

export type DecoratedChunk = {
  id: string;
  kind: SegmentKind;
  /** Final request text: Mood cue + structural cues + unchanged source text. */
  text: string;
  /**
   * Local pause to hold before playing this chunk's audio file (0 when the
   * boundary is inside one long paragraph, is handled by a synthesized tag at
   * the end of the previous chunk, or there is no previous chunk).
   */
  pauseBeforeMs: number;
};

/** Characters that count as sentence-final (optionally followed by closers). */
const TERMINAL_PUNCTUATION = /[.!?…。！？]['"”’」』)\]}]*$/;

/** Moods whose cue is the bracket form of the stored value, e.g. `[calm]`. */
export function moodCue(mood: Mood): string {
  return mood === 'none' ? '' : `[${mood}]`;
}

function leadTagFor(kind: SegmentKind): string {
  switch (kind) {
    case 'title':
    case 'heading':
      return '[emphasis]';
    case 'blockquote':
    case 'caption':
      return '[soft tone]';
    default:
      return '';
  }
}

function boundaryTagFor(boundary: BoundaryKind): string {
  switch (boundary) {
    case 'break':
      return '[break]';
    case 'long-break':
      return '[long-break]';
    case 'none':
      return '';
  }
}

/**
 * Inserts `[emphasis]` immediately before each emphasized range. Ranges are
 * expected to be sorted and non-overlapping (extraction records only the
 * outermost `<strong>`/`<em>`); the walk is defensive anyway.
 */
export function insertEmphasisMarkers(text: string, emphasis: readonly EmphasisRange[]): string {
  if (emphasis.length === 0) return text;
  const sorted = [...emphasis].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor || start >= end) continue;
    out += text.slice(cursor, start) + '[emphasis] ' + text.slice(start, end);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Titles, headings, blockquotes, and captions receive terminal punctuation so
 * the trailing pause reads naturally — without duplicating punctuation the
 * author already wrote. Paragraphs and list items keep their source wording.
 */
function needsTerminalPunctuation(kind: SegmentKind, text: string): boolean {
  if (kind !== 'title' && kind !== 'heading' && kind !== 'blockquote' && kind !== 'caption') return false;
  return !TERMINAL_PUNCTUATION.test(text);
}

function renderPartText(part: NarrationChunk['parts'][number]): string {
  const emphasized = insertEmphasisMarkers(part.text, part.emphasis);
  return needsTerminalPunctuation(part.kind, part.text) ? `${emphasized}.` : emphasized;
}

/**
 * Synthesized trailing cue for a chunk's own audio, used only when following
 * content exists in the session (no dangling pause at the end of a reading).
 * A thematic break (`<hr>`) between this chunk and the next attaches
 * `[long-break]` to this, the preceding spoken chunk, so no tag-only request
 * is ever produced; the boundary is then handled exactly once.
 */
function trailingTagFor(chunk: NarrationChunk, next: NarrationChunk | undefined): string {
  if (!next) return '';
  const nextFirstBoundary = next.parts[0]?.boundaryBefore ?? 'none';
  if (nextFirstBoundary === 'long-break') return '[long-break]';
  switch (chunk.kind) {
    case 'title':
      return '[long-break]';
    case 'heading':
      return '[break]';
    case 'blockquote':
      return '[break]';
    case 'caption':
      return next.kind === 'caption' ? '' : '[break]';
    default:
      return '';
  }
}

/**
 * Local pause before `chunk`'s audio file. Applied only when the boundary is a
 * semantic `break` between two paragraph/list chunks — chunks whose own audio
 * carries a synthesized trailing tag (titles, headings, blockquotes,
 * captions) or whose boundary is a continuation of one long paragraph never
 * combine a synthesized pause with a local one.
 */
function interChunkPauseMs(prev: NarrationChunk, chunk: NarrationChunk): number {
  const firstBoundary = chunk.parts[0]?.boundaryBefore ?? 'none';
  if (firstBoundary !== 'break') return 0;
  if (prev.kind !== 'paragraph' && prev.kind !== 'list-item') return 0;
  return INTER_CHUNK_PAUSE_MS;
}

/**
 * Decorates chunks into final Fish request texts. The Mood cue (when not
 * `none`) prefixes every chunk — including the first — so each independently
 * synthesized request carries it; structural cues follow it.
 */
export function decorateChunks(chunks: readonly NarrationChunk[], mood: Mood): DecoratedChunk[] {
  return chunks.map((chunk, index) => {
    const next = chunks[index + 1];
    const parts = chunk.parts.map((part, partIndex) => {
      const rendered = renderPartText(part);
      if (partIndex === 0) return rendered;
      const boundary = boundaryTagFor(part.boundaryBefore);
      // Adjacent figure captions share the lead's [soft tone]; a plain
      // [break] between them would be the only synthesized pause in a gallery.
      const betweenCaptions = chunk.kind === 'caption' && part.boundaryBefore === 'break';
      return boundary && !betweenCaptions ? `${boundary} ${rendered}` : rendered;
    });
    const body = parts.join(' ');
    const head = [moodCue(mood), leadTagFor(chunk.kind)].filter(Boolean).join(' ');
    const trailing = trailingTagFor(chunk, next);
    const text = [head, body, trailing].filter(Boolean).join(' ');
    const pauseBeforeMs = index > 0 ? interChunkPauseMs(chunks[index - 1]!, chunk) : 0;
    return { id: chunk.id, kind: chunk.kind, text, pauseBeforeMs };
  });
}
