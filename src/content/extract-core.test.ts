// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  extractFromDocument,
  extractFromFallback,
  extractSelectionFromDocument,
  extractWithReadability,
} from './extract-core';

function documentFrom(html: string): Document {
  return new JSDOM(`<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`).window
    .document;
}

const ARTICLE_HTML = `
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <div id="ad" class="advertisement">Buy now! Buy now!</div>
  <article>
    <h1>An Inspiring Read</h1>
    <p>First paragraph with meaningful content about reading.</p>
    <p>Second paragraph continues the story with more details.</p>
    <blockquote>A memorable quotation worth hearing aloud.</blockquote>
    <ul>
      <li>First list item.</li>
      <li>Second list item.</li>
    </ul>
    <figure>
      <img src="cover.png" alt="Cover">
      <figcaption>A caption for the figure.</figcaption>
    </figure>
    <div style="display:none">Hidden promo that must never be read.</div>
    <p aria-hidden="true">Also hidden via aria.</p>
    <script>document.write('should not appear')</script>
    <form><input type="text" value="typed"><button>Submit</button></form>
    <p>First paragraph with meaningful content about reading.</p>
  </article>
  <footer>Footer notes.</footer>
`;

describe('extractFromDocument (primary Readability path)', () => {
  it('extracts meaningful segments in reading order', () => {
    const result = extractFromDocument(documentFrom(ARTICLE_HTML));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.segments.map((s) => s.kind)).toEqual([
      'title',
      'heading',
      'paragraph',
      'paragraph',
      'blockquote',
      'list-item',
      'list-item',
      'caption',
    ]);
    expect(result.segments[0]?.text).toBe('Fixture');
    expect(result.segments[1]?.text).toBe('An Inspiring Read');
    expect(result.segments[4]?.text).toBe('A memorable quotation worth hearing aloud.');
    expect(result.segments[5]?.text).toBe('First list item.');
    expect(result.segments[7]?.text).toBe('A caption for the figure.');
  });

  it('excludes navigation, ads, hidden content, scripts, forms, and footers', () => {
    const result = extractFromDocument(documentFrom(ARTICLE_HTML));
    if (!result.ok) return;
    const allText = result.segments.map((s) => s.text).join(' ');
    expect(allText).not.toContain('Home');
    expect(allText).not.toContain('About');
    expect(allText).not.toContain('Buy now');
    expect(allText).not.toContain('Hidden promo');
    expect(allText).not.toContain('aria');
    expect(allText).not.toContain('should not appear');
    expect(allText).not.toContain('Submit');
    expect(allText).not.toContain('Footer notes');
  });

  it('removes duplicate segments (repeated paragraph, title-as-heading)', () => {
    const result = extractFromDocument(documentFrom(ARTICLE_HTML));
    if (!result.ok) return;
    const texts = result.segments.map((s) => s.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('never mutates the live document', () => {
    const document = documentFrom(ARTICLE_HTML);
    const before = document.body.innerHTML;
    extractFromDocument(document);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('extractFromDocument (fallback path)', () => {
  it('returns a no-content error when Readability finds nothing', () => {
    const document = new JSDOM('<!doctype html><html><head><title>Fixture</title></head><body></body></html>').window
      .document;
    expect(extractWithReadability(document)).toBeNull();
    const result = extractFromDocument(document);
    expect(result).toEqual({ ok: false, code: 'no-content', message: expect.any(String) });
  });

  it('falls back to conservative extraction when Readability throws', () => {
    const spy = vi.spyOn(Readability.prototype, 'parse').mockImplementation(() => {
      throw new Error('readability exploded');
    });
    try {
      const result = extractFromDocument(documentFrom(ARTICLE_HTML));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const allText = result.segments.map((s) => s.text).join(' ');
      expect(allText).toContain('An Inspiring Read');
      expect(allText).not.toContain('Menu');
      expect(allText).not.toContain('Footer notes');
      expect(allText).not.toContain('should not appear');
    } finally {
      spy.mockRestore();
    }
  });

  it('extracts from main/article/body directly and skips junk', () => {
    const fallback = extractFromFallback(documentFrom(ARTICLE_HTML));
    expect(fallback).not.toBeNull();
    const texts = (fallback ?? []).map((s) => s.text).join(' ');
    expect(texts).not.toContain('Menu');
    expect(texts).not.toContain('Footer notes');
    expect(texts).not.toContain('Hidden promo');
  });
});

describe('no-content handling', () => {
  it('returns a no-content error for an empty document', () => {
    const document = new JSDOM('<!doctype html><html><head></head><body></body></html>').window.document;
    const result = extractFromDocument(document);
    expect(result).toEqual({ ok: false, code: 'no-content', message: expect.any(String) });
  });
});

describe('extractSelectionFromDocument', () => {
  it('returns the selected text as a single paragraph segment', () => {
    const document = documentFrom('<p>Nothing selected by default.</p>');
    vi.spyOn(document, 'getSelection').mockReturnValue({
      toString: () => '  Selected   text across lines.\nSecond line.  ',
    } as unknown as Selection);
    const result = extractSelectionFromDocument(document);
    expect(result).toEqual({
      ok: true,
      segments: [{ id: 'selection-1', kind: 'paragraph', text: 'Selected text across lines. Second line.' }],
    });
  });

  it('reports an empty-selection error when nothing is selected', () => {
    const document = documentFrom('<p>Text.</p>');
    vi.spyOn(document, 'getSelection').mockReturnValue({ toString: () => '   ' } as unknown as Selection);
    const result = extractSelectionFromDocument(document);
    expect(result).toEqual({ ok: false, code: 'empty-selection', message: expect.any(String) });
  });
});
