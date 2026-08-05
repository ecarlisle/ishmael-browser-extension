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
// No LLM is involved anywhere in this process.

import { normalizeWhitespace } from './normalize';
import { dedupeSegments, isHeadingKind, type NarrationSegment, type SegmentKind } from './segments';

export const MAX_CHUNK_CHARS = 1200;
/** Largest buffer allowed to absorb more short segments. */
const MERGE_BUFFER_LIMIT = 500;
/** Largest single segment that may be merged into an existing buffer. */
const MERGE_SEGMENT_LIMIT = 500;

export type NarrationChunk = {
  id: string;
  text: string;
  kind: SegmentKind;
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

/**
 * Splits text into pieces of at most `maxChars`, preferring sentence
 * boundaries. A single sentence longer than `maxChars` is hard-split at word
 * boundaries as a last resort. Never drops text.
 */
export function splitLongText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      pieces.push(buffer);
      buffer = '';
    }
  };

  for (const sentence of splitSentences(text)) {
    if (sentence.length > maxChars) {
      flush();
      pieces.push(...hardSplitWords(sentence, maxChars));
      continue;
    }
    if (buffer && buffer.length + 1 + sentence.length > maxChars) {
      flush();
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  flush();
  return pieces;
}

function hardSplitWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const pieces: string[] = [];
  let buffer = '';
  for (const word of words) {
    if (buffer && buffer.length + 1 + word.length > maxChars) {
      pieces.push(buffer);
      buffer = word;
    } else {
      buffer = buffer ? `${buffer} ${word}` : word;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

// ---------------------------------------------------------------------------
// Segment → chunk grouping
// ---------------------------------------------------------------------------

/**
 * Converts extracted segments into narration chunks in reading order.
 */
export function chunkSegments(segments: readonly NarrationSegment[]): NarrationChunk[] {
  const normalized = dedupeSegments(segments);
  const chunks: NarrationChunk[] = [];

  const pushChunk = (text: string, kind: SegmentKind) => {
    const cleaned = normalizeWhitespace(text);
    if (!cleaned) return;
    chunks.push({ id: `chunk-${chunks.length + 1}`, text: cleaned, kind });
  };

  const canMerge = (a: NarrationSegment, b: NarrationSegment): boolean =>
    !isHeadingKind(a.kind) && a.kind === b.kind;

  let buffer: NarrationSegment[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    pushChunk(buffer.map((segment) => segment.text).join(' '), buffer[0]!.kind);
    buffer = [];
  };

  for (const segment of normalized) {
    if (isHeadingKind(segment.kind)) {
      // Headings are always standalone so narration pauses around them.
      flush();
      pushChunk(segment.text, segment.kind);
      continue;
    }
    if (segment.text.length > MAX_CHUNK_CHARS) {
      // Unusually long segment: split at sentence boundaries.
      flush();
      for (const piece of splitLongText(segment.text)) {
        pushChunk(piece, segment.kind);
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
      buffer.push(segment);
      continue;
    }
    flush();
    buffer = [segment];
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
