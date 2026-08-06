// Deterministic, sentence-aware narration chunking.
//
// Segments are grouped into chunks sized for one Fish Audio request each
// (roughly 500–1,200 characters). Rules, in order of priority:
//   1. Never drop or reorder text.
//   2. Headings and titles are always their own chunk so narration pauses
//      naturally around them.
//   3. Segments longer than the maximum are split at sentence boundaries.
//   4. Short adjacent segments of the same kind are combined up to the
//      maximum, aiming for paragraph-sized chunks.
//
// Chunks carry per-segment *parts*: the normalized source text, inline
// emphasis ranges, and the semantic boundary before each part (`none` for a
// continuation of the same long paragraph, `break` between different
// segments, `long-break` when a thematic break such as `<hr>` separated
// them). Boundary metadata survives merging and splitting so the decoration
// layer (decorate.ts) can render Fish cues without ever altering the source
// text or its order.
//
// No LLM is involved anywhere in this process.

import { normalizeWhitespace } from './normalize';
import { dedupeSegments, isHeadingKind, type EmphasisRange, type NarrationSegment, type SegmentKind } from './segments';

export const MAX_CHUNK_CHARS = 1200;
/** Largest buffer allowed to absorb more short segments. */
const MERGE_BUFFER_LIMIT = 500;
/** Largest single segment that may be merged into an existing buffer. */
const MERGE_SEGMENT_LIMIT = 500;

/** Pause between two parts: none (same long paragraph), break, or long-break. */
export type BoundaryKind = 'none' | 'break' | 'long-break';

export type ChunkPart = {
  segmentId: string;
  kind: SegmentKind;
  text: string;
  /** Emphasis ranges into this part's text (already offset-adjusted). */
  emphasis: readonly EmphasisRange[];
  /**
   * Semantic boundary between this part and the preceding part — either the
   * previous part in the same chunk or the previous chunk's last part.
   */
  boundaryBefore: BoundaryKind;
};

export type NarrationChunk = {
  id: string;
  /** All parts' source text joined with single spaces (no cues). */
  text: string;
  kind: SegmentKind;
  parts: readonly ChunkPart[];
};

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

const segmenterCache = new Map<string, Intl.Segmenter>();

function defaultSegmenter(): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return null;
  let segmenter = segmenterCache.get('sentence');
  if (!segmenter) {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    segmenterCache.set('sentence', segmenter);
  }
  return segmenter;
}

/**
 * Splits text at sentence boundaries.
 *
 * @param segmenter Pass `null` to force the regex fallback (used in tests and
 *   on engines without `Intl.Segmenter`), or omit to use the engine default.
 */
export function splitSentences(
  text: string,
  segmenter: Intl.Segmenter | null | undefined = defaultSegmenter(),
): string[] {
  const sentences = segmenter
    ? [...segmenter.segment(text)].map((part) => part.segment)
    : fallbackSplitSentences(text);
  return sentences
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length > 0);
}

/**
 * Regex fallback: split after sentence-ending punctuation (including closing
 * quotes and brackets), on the following whitespace. Less accurate than
 * `Intl.Segmenter` (e.g. "Dr. Smith" splits after "Dr."), which is why
 * `Intl.Segmenter` is preferred in the browser.
 */
function fallbackSplitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…。！？]['"”’」』)]*)\s+/);
}

// ---------------------------------------------------------------------------
// Long-text splitting
// ---------------------------------------------------------------------------

export type TextPiece = { text: string; start: number };

/**
 * Splits text into pieces of at most `maxChars`, preferring sentence
 * boundaries. A single sentence longer than `maxChars` is hard-split at word
 * boundaries as a last resort. Never drops text.
 *
 * Each piece reports its `start` offset within the original text so callers
 * can map per-character metadata (such as emphasis ranges) into the pieces.
 * Pieces are contiguous: piece[i].text occupies
 * `text.slice(piece[i].start, piece[i + 1]?.start)`.
 */
export function splitLongTextPieces(text: string, maxChars: number = MAX_CHUNK_CHARS): TextPiece[] {
  const pieces: TextPiece[] = [];

  const pushWords = (sentence: string, sentenceStart: number): void => {
    // A single sentence longer than maxChars: hard-split at word boundaries.
    const words = sentence.split(/\s+/);
    let buffer: string[] = [];
    let bufferStart = sentenceStart;
    let chars = 0;
    let cursor = sentenceStart;
    for (const word of words) {
      if (buffer.length > 0 && chars + 1 + word.length > maxChars) {
        pieces.push({ text: buffer.join(' '), start: bufferStart });
        buffer = [];
        chars = 0;
        bufferStart = cursor;
      }
      buffer.push(word);
      chars += (buffer.length > 1 ? 1 : 0) + word.length;
      cursor += word.length + 1;
    }
    if (buffer.length > 0) pieces.push({ text: buffer.join(' '), start: bufferStart });
  };

  const sentences = splitSentences(text);
  let offset = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let bufferChars = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    pieces.push({ text: buffer.join(' '), start: bufferStart });
    buffer = [];
    bufferChars = 0;
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush();
      pushWords(sentence, offset);
      offset += sentence.length + 1;
      continue;
    }
    if (buffer.length > 0 && bufferChars + 1 + sentence.length > maxChars) {
      flush();
    }
    if (buffer.length === 0) bufferStart = offset;
    buffer.push(sentence);
    bufferChars += (buffer.length > 1 ? 1 : 0) + sentence.length;
    offset += sentence.length + 1;
  }
  flush();
  return pieces;
}

/**
 * Splits text into pieces of at most `maxChars`, preferring sentence
 * boundaries. Equivalent to `splitLongTextPieces` with the offsets dropped.
 */
export function splitLongText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  return splitLongTextPieces(text, maxChars).map((piece) => piece.text);
}

/**
 * Keeps only the emphasis ranges that start inside `[start, end)` and re-bases
 * them into the piece's own coordinates. A range straddling a piece boundary
 * stays with the piece where it begins (the cue sits before the phrase, and
 * real emphasis phrases do not cross sentence boundaries).
 */
function emphasisForPiece(
  emphasis: readonly EmphasisRange[] | undefined,
  start: number,
  end: number,
): EmphasisRange[] {
  if (!emphasis) return [];
  const out: EmphasisRange[] = [];
  for (const [rangeStart, rangeEnd] of emphasis) {
    if (rangeStart >= start && rangeStart < end) {
      out.push([rangeStart - start, Math.min(rangeEnd, end) - start]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segment → chunk grouping
// ---------------------------------------------------------------------------

/**
 * Converts extracted segments into narration chunks in reading order. Each
 * chunk's parts retain their per-segment source text, emphasis ranges, and
 * semantic boundary metadata (see ChunkPart), which the decoration layer uses
 * to insert Fish cues. Deduplication happens here, on normalized source text,
 * before any cue is applied.
 */
export function chunkSegments(segments: readonly NarrationSegment[]): NarrationChunk[] {
  const normalized = dedupeSegments(segments);
  const chunks: NarrationChunk[] = [];
  let emittedAny = false;

  const pushChunk = (parts: readonly ChunkPart[]): void => {
    const kind = parts[0]?.kind ?? 'paragraph';
    const text = normalizeWhitespace(parts.map((part) => part.text).join(' '));
    if (!text) return;
    chunks.push({ id: `chunk-${chunks.length + 1}`, text, kind, parts: [...parts] });
  };

  const canMerge = (a: ChunkPart, b: NarrationSegment): boolean =>
    !isHeadingKind(a.kind) && a.kind === b.kind;

  let buffer: ChunkPart[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    pushChunk(buffer);
    buffer = [];
  };

  for (const segment of normalized) {
    const boundaryBefore: BoundaryKind = !emittedAny
      ? 'none'
      : segment.thematicBreakBefore === true
        ? 'long-break'
        : 'break';
    emittedAny = true;

    if (isHeadingKind(segment.kind)) {
      // Headings are always standalone so narration pauses around them.
      flush();
      pushChunk([
        {
          segmentId: segment.id,
          kind: segment.kind,
          text: segment.text,
          emphasis: segment.emphasis ?? [],
          boundaryBefore,
        },
      ]);
      continue;
    }
    if (segment.text.length > MAX_CHUNK_CHARS) {
      // Unusually long segment: split at sentence boundaries. Each piece is
      // its own chunk; only the first piece carries the segment's boundary
      // (`none` for continuation pieces, so no false pause is inserted).
      flush();
      for (const piece of splitLongTextPieces(segment.text)) {
        pushChunk([
          {
            segmentId: segment.id,
            kind: segment.kind,
            text: piece.text,
            emphasis: emphasisForPiece(segment.emphasis, piece.start, piece.start + piece.text.length),
            boundaryBefore: piece.start === 0 ? boundaryBefore : 'none',
          },
        ]);
      }
      continue;
    }
    const bufferLength = buffer.reduce((sum, item) => sum + item.text.length + 1, 0);
    const last = buffer[buffer.length - 1];
    if (
      last &&
      canMerge(last, segment) &&
      bufferLength <= MERGE_BUFFER_LIMIT &&
      segment.text.length <= MERGE_SEGMENT_LIMIT &&
      bufferLength + segment.text.length <= MAX_CHUNK_CHARS
    ) {
      buffer.push({
        segmentId: segment.id,
        kind: segment.kind,
        text: segment.text,
        emphasis: segment.emphasis ?? [],
        boundaryBefore,
      });
      continue;
    }
    flush();
    buffer = [
      {
        segmentId: segment.id,
        kind: segment.kind,
        text: segment.text,
        emphasis: segment.emphasis ?? [],
        boundaryBefore,
      },
    ];
  }
  flush();

  return chunks;
}

/**
 * Reconstructs the normalized full text from chunks. Used by tests to prove
 * that chunking never drops or reorders content.
 */
export function joinChunks(chunks: readonly NarrationChunk[]): string {
  return normalizeWhitespace(chunks.map((chunk) => chunk.text).join(' '));
}
