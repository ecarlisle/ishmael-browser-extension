// Pure page-extraction logic used by the content script. No chrome.* APIs
// here so the module can be unit-tested under jsdom.

import { Readability } from '@mozilla/readability';

import { normalizeWhitespace } from '../shared/normalize';
import { dedupeSegments, type EmphasisRange, type NarrationSegment, type SegmentKind } from '../shared/segments';
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

/** Inline elements whose authored emphasis is preserved. Not `<b>`/`<i>`. */
const EMPHASIS_TAGS = new Set(['STRONG', 'EM']);

function kindForElement(element: Element): SegmentKind | null {
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

// ---------------------------------------------------------------------------
// Text collection with inline-emphasis metadata
// ---------------------------------------------------------------------------

const REMOVE_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B\u200C\u200D\u2060\uFEFF]/;

/**
 * Normalizes raw text while recording, for each normalized character, the raw
 * index it derives from. Collapsed whitespace maps to the first raw character
 * of its run; removed characters produce no normalized output.
 */
function normalizeWithOffsetMap(raw: string): { text: string; toRaw: number[] } {
  const chars: string[] = [];
  const toRaw: number[] = [];
  let inSpace = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (REMOVE_CHAR.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (started && !inSpace) {
        chars.push(' ');
        toRaw.push(i);
        inSpace = true;
      }
      continue;
    }
    chars.push(ch);
    toRaw.push(i);
    started = true;
    inSpace = false;
  }
  if (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop();
    toRaw.pop();
  }
  return { text: chars.join(''), toRaw };
}

/**
 * Maps a raw character range to normalized character indices, trimming any
 * leading/trailing whitespace the range picked up (e.g. a `<strong>` whose
 * source formatting includes surrounding newlines). Returns null when the
 * range collapses to nothing.
 */
function mapEmphasisRange(
  text: string,
  toRaw: readonly number[],
  rawStart: number,
  rawEnd: number,
): EmphasisRange | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < toRaw.length; i++) {
    const raw = toRaw[i]!;
    if (raw >= rawStart && raw < rawEnd) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  let start = first;
  let end = last + 1;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  if (end <= start) return null;
  return [start, end];
}

/**
 * Collects a candidate element's normalized text plus the normalized character
 * ranges its `<strong>`/`<em>` descendants emphasize. Only the outermost
 * emphasis element is recorded, so nested emphasis never double-tags. Hidden
 * subtrees contribute nothing. Emphasis is structural metadata, not part of
 * the source text.
 */
function collectTextAndEmphasis(root: Element, isLive: boolean): { text: string; emphasis: EmphasisRange[] } {
  const buffer: string[] = [];
  const rawRanges: EmphasisRange[] = [];
  let total = 0;

  const walk = (node: Node, insideEmphasis: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = node.textContent ?? '';
      buffer.push(piece);
      total += piece.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (isHidden(element, isLive)) return;
    if (element.tagName === 'BR') {
      buffer.push(' ');
      total += 1;
      return;
    }
    const isEmphasis = EMPHASIS_TAGS.has(element.tagName);
    const start = total;
    for (const child of element.childNodes) walk(child, isEmphasis || insideEmphasis);
    if (isEmphasis && !insideEmphasis && total > start) {
      rawRanges.push([start, total]);
    }
  };

  walk(root, false);
  const raw = buffer.join('');
  const { text, toRaw } = normalizeWithOffsetMap(raw);
  const emphasis: EmphasisRange[] = [];
  for (const [rawStart, rawEnd] of rawRanges) {
    const mapped = mapEmphasisRange(text, toRaw, rawStart, rawEnd);
    if (mapped) emphasis.push(mapped);
  }
  return { text, emphasis };
}

let segmentCounter = 0;

function nextSegmentId(kind: SegmentKind): string {
  segmentCounter += 1;
  return `${kind}-${segmentCounter}`;
}

/**
 * Walks `root` in document order and collects narration segments. Nested
 * candidates (e.g. a <p> inside an <li>) are skipped so their text is only
 * captured by the outermost candidate.
 *
 * Hidden/excluded subtrees are rejected through the TreeWalker filter:
 * `FILTER_REJECT` skips the element and its entire subtree, so a hidden
 * element that is the last child of a nested container cannot terminate the
 * walk — traversal continues with the next eligible node in document order.
 */
export function collectSegmentsFromRoot(root: Element, isLive: boolean): NarrationSegment[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      return isHidden(node as Element, isLive) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: NarrationSegment[] = [];
  let pendingThematicBreak = false;

  let element = walker.nextNode() as Element | null;
  while (element) {
    if (element.tagName === 'HR') {
      // A thematic break is a long structural pause attached to the following
      // segment as boundary metadata (never a segment of its own, so no
      // tag-only narration request can be produced).
      pendingThematicBreak = true;
      element = walker.nextNode() as Element | null;
      continue;
    }
    const kind = kindForElement(element);
    const nestedInCandidate = element.parentElement?.closest(CANDIDATE_SELECTOR) ?? null;
    const insideRoot = nestedInCandidate !== null && root.contains(nestedInCandidate);
    if (kind && !insideRoot) {
      const { text, emphasis } = collectTextAndEmphasis(element, isLive);
      if (text) {
        const segment: NarrationSegment = { id: nextSegmentId(kind), kind, text };
        if (pendingThematicBreak) segment.thematicBreakBefore = true;
        if (emphasis.length > 0) segment.emphasis = emphasis;
        segments.push(segment);
        pendingThematicBreak = false;
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
function extractArticle(document: Document): NarrationSegment[] | null {
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
