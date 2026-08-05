import { describe, expect, it } from 'vitest';
import {
  chunkSegments,
  joinChunks,
  MAX_CHUNK_CHARS,
  splitLongText,
  splitSentences,
} from './chunking';
import { normalizeWhitespace } from './normalize';
import type { NarrationSegment } from './segments';

const seg = (id: string, kind: NarrationSegment['kind'], text: string): NarrationSegment => ({ id, kind, text });
const paragraph = (id: string, text: string): NarrationSegment => seg(id, 'paragraph', text);

/** One paragraph of roughly `words` words (sentence length ~7 words). */
function makeText(words: number): string {
  const sentence = 'The quick brown fox jumps over the lazy dog near the river bank.';
  const sentences = Array.from({ length: Math.ceil(words / 15) }, () => sentence).join(' ');
  return sentences.split(' ').slice(0, words).join(' ') + '.';
}

describe('splitSentences', () => {
  it('splits on sentence boundaries with Intl.Segmenter', () => {
    const result = splitSentences('First sentence here. Second one! Third?');
    expect(result).toEqual(['First sentence here.', 'Second one!', 'Third?']);
  });

  it('falls back to the regex splitter when Segmenter is unavailable', () => {
    const result = splitSentences('First sentence here. Second one! Third?', null);
    expect(result).toEqual(['First sentence here.', 'Second one!', 'Third?']);
  });

  it('drops empty pieces and trims whitespace', () => {
    expect(splitSentences('  A.  B.  ', null)).toEqual(['A.', 'B.']);
    expect(splitSentences('', null)).toEqual([]);
  });
});

describe('splitLongText', () => {
  it('splits long text at sentence boundaries, never exceeding the maximum', () => {
    const text = makeText(400);
    const pieces = splitLongText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('hard-splits a single enormous sentence without losing text', () => {
    const sentence = 'word '.repeat(600).trim() + '.';
    const pieces = splitLongText(sentence, 200);
    expect(pieces.length).toBeGreaterThan(1);
    expect(normalizeWhitespace(pieces.join(' '))).toBe(normalizeWhitespace(sentence));
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200);
    }
  });

  it('keeps short text as a single piece', () => {
    expect(splitLongText('A short paragraph.')).toEqual(['A short paragraph.']);
  });

  it('never drops or reorders text across a split', () => {
    const text = makeText(300);
    expect(normalizeWhitespace(splitLongText(text).join(' '))).toBe(normalizeWhitespace(text));
  });
});

describe('chunkSegments', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkSegments([])).toEqual([]);
  });

  it('keeps a single paragraph as one chunk', () => {
    const chunks = chunkSegments([paragraph('p1', 'A single paragraph of text.')]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('A single paragraph of text.');
    expect(chunks[0]?.kind).toBe('paragraph');
  });

  it('combines short adjacent segments of the same kind', () => {
    const chunks = chunkSegments([
      paragraph('p1', 'Short one.'),
      paragraph('p2', 'Short two.'),
      paragraph('p3', 'Short three.'),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Short one. Short two. Short three.');
  });

  it('never merges headings with other segments', () => {
    const chunks = chunkSegments([
      seg('h1', 'heading', 'Chapter one'),
      paragraph('p1', 'First paragraph here.'),
      seg('h2', 'heading', 'Chapter two'),
      paragraph('p2', 'Second paragraph here.'),
    ]);
    expect(chunks.map((c) => c.kind)).toEqual(['heading', 'paragraph', 'heading', 'paragraph']);
    expect(chunks.map((c) => c.text)).toEqual(['Chapter one', 'First paragraph here.', 'Chapter two', 'Second paragraph here.']);
  });

  it('does not merge different kinds together', () => {
    const chunks = chunkSegments([
      paragraph('p1', 'Short paragraph.'),
      seg('q1', 'blockquote', 'Short quote.'),
    ]);
    expect(chunks).toHaveLength(2);
  });

  it('splits an unusually long paragraph at sentence boundaries', () => {
    const text = makeText(400);
    const chunks = chunkSegments([paragraph('p1', text)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    expect(joinChunks(chunks)).toBe(normalizeWhitespace(text));
  });

  it('preserves the full text and reading order across many segments', () => {
    const segments = [
      seg('t', 'title', 'The Title'),
      seg('h', 'heading', 'Introduction'),
      paragraph('p1', 'First sentence. Second sentence.'),
      paragraph('p2', makeText(200)),
      seg('li1', 'list-item', 'Item alpha.'),
      seg('li2', 'list-item', 'Item beta.'),
      seg('cap', 'caption', 'A figure caption.'),
    ];
    const chunks = chunkSegments(segments);
    expect(joinChunks(chunks)).toBe(normalizeWhitespace(segments.map((s) => s.text).join(' ')));
    expect(chunks[0]?.kind).toBe('title');
    expect(chunks[1]?.kind).toBe('heading');
    expect(chunks[chunks.length - 1]?.kind).toBe('caption');
  });

  it('does not merge duplicate or empty segments', () => {
    const chunks = chunkSegments([
      paragraph('p1', 'Same text.'),
      paragraph('p2', 'Same text.'),
      paragraph('p3', '   '),
      paragraph('p4', ''),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Same text.');
  });
});
