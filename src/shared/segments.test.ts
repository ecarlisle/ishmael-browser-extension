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
