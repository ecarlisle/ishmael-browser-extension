import { describe, expect, it } from 'vitest';
import { dedupeSegments, isHeadingKind, isNarrationSegment, type NarrationSegment } from './segments';

const segment = (id: string, kind: NarrationSegment['kind'], text: string): NarrationSegment => ({ id, kind, text });

describe('dedupeSegments', () => {
  it('removes empty segments after normalization', () => {
    const segments = [segment('a', 'paragraph', '  '), segment('b', 'paragraph', 'Real text')];
    const result = dedupeSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('Real text');
  });

  it('removes exact duplicate text keeping the first occurrence', () => {
    const segments = [
      segment('a', 'paragraph', 'Repeat'),
      segment('b', 'paragraph', 'Unique'),
      segment('c', 'heading', 'Repeat'),
    ];
    const result = dedupeSegments(segments);
    expect(result.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('preserves reading order', () => {
    const segments = [
      segment('a', 'heading', 'Intro'),
      segment('b', 'paragraph', 'Body one'),
      segment('c', 'paragraph', 'Body two'),
    ];
    expect(dedupeSegments(segments).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps case-distinct text (does not over-merge)', () => {
    const segments = [segment('a', 'paragraph', 'AI models'), segment('b', 'paragraph', 'ai models')];
    expect(dedupeSegments(segments)).toHaveLength(2);
  });
});

describe('isNarrationSegment / isHeadingKind', () => {
  it('accepts valid segments and rejects malformed ones', () => {
    expect(isNarrationSegment(segment('x', 'paragraph', 'Hi'))).toBe(true);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph' })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'bogus', text: 'Hi' })).toBe(false);
    expect(isNarrationSegment(null)).toBe(false);
    expect(isNarrationSegment('text')).toBe(false);
  });

  it('treats title and heading as heading kinds', () => {
    expect(isHeadingKind('title')).toBe(true);
    expect(isHeadingKind('heading')).toBe(true);
    expect(isHeadingKind('paragraph')).toBe(false);
  });
});

describe('emphasis and thematic-break validation', () => {
  it('accepts valid emphasis ranges within the text', () => {
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Bold words here.', emphasis: [[0, 4]] })).toBe(true);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Bold words here.', emphasis: [[0, 4], [6, 11]] })).toBe(true);
  });

  it('rejects emphasis ranges that are out of bounds, reversed, fractional, or malformed', () => {
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Short.', emphasis: [[0, 99]] })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Short.', emphasis: [[2, 1]] })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Short.', emphasis: [[0.5, 2]] })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Short.', emphasis: 'nope' })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Short.', emphasis: [[0, 2, 3]] })).toBe(false);
  });

  it('requires thematicBreakBefore to be a boolean when present', () => {
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Text.', thematicBreakBefore: true })).toBe(true);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Text.', thematicBreakBefore: 'yes' })).toBe(false);
    expect(isNarrationSegment({ id: 'x', kind: 'paragraph', text: 'Text.', thematicBreakBefore: 1 })).toBe(false);
  });
});

describe('dedupeSegments metadata', () => {
  it('carries emphasis and thematic-break metadata through dedupe', () => {
    const result = dedupeSegments([
      { id: 'a', kind: 'paragraph', text: '  Bold  word.  ', emphasis: [[0, 4]], thematicBreakBefore: true },
      { id: 'b', kind: 'paragraph', text: 'Bold word.' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('Bold word.');
    expect(result[0]?.thematicBreakBefore).toBe(true);
    // The range is re-validated against the normalized text.
    expect(result[0]?.emphasis).toEqual([[0, 4]]);
  });

  it('drops emphasis ranges that fall outside the normalized text', () => {
    const result = dedupeSegments([{ id: 'a', kind: 'paragraph', text: '  x  ', emphasis: [[10, 12]] }]);
    expect(result[0]?.emphasis).toBeUndefined();
  });

  it('keeps emphasis only from the first occurrence of duplicate text', () => {
    const result = dedupeSegments([
      { id: 'a', kind: 'paragraph', text: 'Same text', emphasis: [[0, 4]] },
      { id: 'b', kind: 'paragraph', text: 'Same text', emphasis: [[5, 9]] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.emphasis).toEqual([[0, 4]]);
  });
});
