// Pure page-extraction logic used by the content script. No chrome.* APIs
// here so the module can be unit-tested under jsdom.

import { Readability } from '@mozilla/readability';

import { normalizeWhitespace } from '../shared/normalize';
import { dedupeSegments, type NarrationSegment, type SegmentKind } from '../shared/segments';
import type { ExtractionResult } from '../shared/messages';

// Tags whose text we never narrate (skipped along with their subtrees).
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'FRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'PICTURE',
  'MAP',
  'NAV',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'FORM',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'DIALOG',
]);

const SKIP_ROLES = new Set(['navigation', 'complementary', 'banner', 'contentinfo', 'search', 'dialog', 'alert']);

const CANDIDATE_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption';

export function kindForElement(element: Element): SegmentKind | null {
  const tag = element.tagName;
  if (tag === 'P') return 'paragraph';
  if (tag.startsWith('H') && tag.length === 2 && tag >= 'H1' && tag <= 'H6') return 'heading';
  if (tag === 'BLOCKQUOTE') return 'blockquote';
  if (tag === 'LI') return 'list-item';
  if (tag === 'FIGCAPTION') return 'caption';
  return null;
}

function isHidden(element: Element, isLive: boolean): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const role = element.getAttribute('role');
  if (role && SKIP_ROLES.has(role.toLowerCase())) return true;
  if (SKIP_TAGS.has(element.tagName)) return true;
  const inlineStyle = (element.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (inlineStyle.includes('display:none') || inlineStyle.includes('visibility:hidden')) return true;
  if (isLive) {
    try {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    } catch {
      // Detached or unusual nodes: fall back to attribute checks only.
    }
  }
  return false;
}

let segmentCounter = 0;

function nextSegmentId(kind: SegmentKind): string {
  segmentCounter += 1;
  return `${kind}-${segmentCounter}`;
}

/**
 * Walks `root` in document order and collects narration segments. Nested
 * candidates (e.g. a <p> inside an <li>) are skipped so their text is only
 * captured by the outermost candidate. Hidden subtrees are skipped entirely.
 */
export function collectSegmentsFromRoot(root: Element, isLive: boolean): NarrationSegment[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const segments: NarrationSegment[] = [];

  let element = walker.nextNode() as Element | null;
  while (element) {
    if (isHidden(element, isLive)) {
      walker.currentNode = element;
      element = walker.nextSibling() as Element | null;
      continue;
    }
    const kind = kindForElement(element);
    const nestedInCandidate = element.parentElement?.closest(CANDIDATE_SELECTOR) ?? null;
    const insideRoot = nestedInCandidate !== null && root.contains(nestedInCandidate);
    if (kind && !insideRoot) {
      const text = normalizeWhitespace(element.textContent ?? '');
      if (text) {
        segments.push({ id: nextSegmentId(kind), kind, text });
      }
    }
    element = walker.nextNode() as Element | null;
  }
  return segments;
}

function cloneDocument(document: Document): Document {
  try {
    const clone = document.cloneNode(true);
    if (clone && clone.nodeType === Node.DOCUMENT_NODE) return clone as Document;
  } catch {
    // Fall through to the serialization approach.
  }
  const serialized = document.documentElement?.outerHTML ?? '';
  return new DOMParser().parseFromString(serialized, 'text/html');
}

function titleSegment(title: string | null | undefined): NarrationSegment[] {
  const text = normalizeWhitespace(title ?? '');
  return text ? [{ id: 'title-0', kind: 'title', text }] : [];
}

/** A title alone is not meaningful readable content. */
function hasBodyContent(segments: readonly NarrationSegment[]): boolean {
  return segments.some((segment) => segment.kind !== 'title');
}

/**
 * Primary path: Mozilla Readability on a clone of the document.
 * Returns null when Readability cannot find an article.
 */
export function extractWithReadability(document: Document): NarrationSegment[] | null {
  const clone = cloneDocument(document);
  const article = new Readability<Element>(clone, { serializer: (node) => node as Element }).parse();
  const content = article?.content;
  if (!content || !article?.textContent?.trim()) return null;

  const segments = collectSegmentsFromRoot(content, false);
  const withTitle = [...titleSegment(article.title), ...segments];
  const cleaned = dedupeSegments(withTitle);
  return hasBodyContent(cleaned) ? cleaned : null;
}

/**
 * Conservative fallback: extract from main/article/body without Readability.
 * Used when Readability finds no useful article.
 */
export function extractFromFallback(document: Document): NarrationSegment[] | null {
  const root =
    document.querySelector('main') ??
    document.querySelector('article') ??
    document.body;
  if (!root) return null;

  const segments = collectSegmentsFromRoot(root, true);
  const withTitle = [...titleSegment(document.title), ...segments];
  const cleaned = dedupeSegments(withTitle);
  return hasBodyContent(cleaned) ? cleaned : null;
}

/**
 * Extracts the primary article from a document. Never mutates the live page
 * (Readability runs on a clone). Returns null when no meaningful content is
 * found. If Readability itself fails, we fall back to conservative
 * extraction rather than failing the whole page.
 */
export function extractArticle(document: Document): NarrationSegment[] | null {
  try {
    const readability = extractWithReadability(document);
    if (readability) return readability;
  } catch {
    // Readability threw (unusual document); fall through to the fallback.
  }
  return extractFromFallback(document);
}

export function extractFromDocument(document: Document): ExtractionResult {
  const segments = extractArticle(document);
  if (!segments) return { ok: false, code: 'no-content', message: 'No readable content was found on this page.' };
  return { ok: true, segments };
}

/** Extracts the current text selection as a single paragraph segment. */
export function extractSelectionFromDocument(document: Document): ExtractionResult {
  const selection = document.getSelection?.();
  const text = normalizeWhitespace(selection?.toString() ?? '');
  if (!text) {
    return { ok: false, code: 'empty-selection', message: 'Nothing is selected on the page. Select some text first.' };
  }
  return {
    ok: true,
    segments: [{ id: 'selection-1', kind: 'paragraph', text }],
  };
}
