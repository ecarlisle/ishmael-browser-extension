// Narration-decoration tests: structural cues, Mood composition, and the pure
// inter-file pause decisions. All expectations are on final request text and
// pause metadata — no network, no browser APIs.

import { describe, expect, it } from 'vitest';
import { chunkSegments } from './chunking';
import { decorateChunks, INTER_CHUNK_PAUSE_MS, insertEmphasisMarkers, moodCue } from './decorate';
import { MOODS, type Mood } from './settings';
import type { NarrationSegment } from './segments';
import { normalizeWhitespace } from './normalize';

const seg = (id: string, kind: NarrationSegment['kind'], text: string, extra: Partial<NarrationSegment> = {}): NarrationSegment => ({
  id,
  kind,
  text,
  ...extra,
});

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the river bank and thinks about the weather.';

/** Paragraph too long to merge with a neighbor (~720 chars), but under the split limit. */
function longParagraph(id: string, text?: string): NarrationSegment {
  const body = Array.from({ length: 8 }, () => SENTENCE).join(' ');
  return seg(id, 'paragraph', text ?? `${id}: ${body}`);
}

/** Paragraph long enough to be split across multiple chunks (> 1200 chars). */
function veryLongParagraph(id: string): NarrationSegment {
  const body = Array.from({ length: 16 }, () => SENTENCE).join(' ');
  return seg(id, 'paragraph', `${id}: ${body}`);
}

function decorate(segments: NarrationSegment[], mood: Mood = 'none') {
  return decorateChunks(chunkSegments(segments), mood);
}

const decorateText = (segments: NarrationSegment[], mood: Mood = 'none'): string[] =>
  decorate(segments, mood).map((chunk) => chunk.text);

describe('page title', () => {
  it('receives [emphasis] and a trailing [long-break] when content follows', () => {
    const [title] = decorateText([
      seg('t', 'title', 'Moby Dick'),
      seg('p1', 'paragraph', 'Call me Ishmael.'),
    ]);
    expect(title).toBe('[emphasis] Moby Dick. [long-break]');
  });

  it('does not duplicate terminal punctuation already present in the title', () => {
    const [title] = decorateText([seg('t', 'title', 'Moby Dick.'), seg('p1', 'paragraph', 'Body.')]);
    expect(title).toBe('[emphasis] Moby Dick. [long-break]');
  });

  it('keeps the title as its own chunk without a dangling pause at session end', () => {
    const [title] = decorateText([seg('t', 'title', 'Alone')]);
    expect(title).toBe('[emphasis] Alone.');
  });
});

describe('headings', () => {
  it('receives [emphasis] and a trailing [break] when content follows', () => {
    const texts = decorateText([
      seg('h1', 'heading', 'Chapter one'),
      seg('p1', 'paragraph', 'It began quietly.'),
    ]);
    expect(texts[0]).toBe('[emphasis] Chapter one. [break]');
    expect(texts[1]).toBe('It began quietly.');
  });

  it('keeps headings standalone even when adjacent', () => {
    const texts = decorateText([seg('h1', 'heading', 'One'), seg('h2', 'heading', 'Two'), seg('p1', 'paragraph', 'Text.')]);
    expect(texts).toEqual(['[emphasis] One. [break]', '[emphasis] Two. [break]', 'Text.']);
  });

  it('adds terminal punctuation only when the heading lacks it', () => {
    expect(decorateText([seg('h1', 'heading', 'Really?'), seg('p1', 'paragraph', 'Yes.')])[0]).toBe(
      '[emphasis] Really? [break]',
    );
  });
});

describe('paragraph boundaries', () => {
  it('inserts a single [break] between adjacent paragraphs merged into one chunk', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'First paragraph.'),
      seg('p2', 'paragraph', 'Second paragraph.'),
    ]);
    expect(text).toBe('First paragraph. [break] Second paragraph.');
  });

  it('preserves the semantic boundary across several merged paragraphs', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'One.'),
      seg('p2', 'paragraph', 'Two.'),
      seg('p3', 'paragraph', 'Three.'),
    ]);
    expect(text).toBe('One. [break] Two. [break] Three.');
  });

  it('does not add a false pause between pieces of one split long paragraph', () => {
    const chunks = decorate([veryLongParagraph('p1')]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('[break]');
      expect(chunk.text).not.toContain('[long-break]');
      expect(chunk.pauseBeforeMs).toBe(0);
    }
  });

  it('uses the local pause between two separate long paragraph files', () => {
    const chunks = decorate([longParagraph('p1'), longParagraph('p2')]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.pauseBeforeMs).toBe(0);
    expect(chunks[1]?.pauseBeforeMs).toBe(INTER_CHUNK_PAUSE_MS);
    // The local pause replaces a synthesized trailing tag: no tags in the
    // paragraph texts, no combined pause.
    expect(chunks[0]?.text).not.toContain('[');
    expect(chunks[1]?.text).not.toContain('[');
  });

  it('never adds an unnecessary trailing pause to the final paragraph', () => {
    const [text] = decorateText([seg('p1', 'paragraph', 'The end of the reading.')]);
    expect(text).toBe('The end of the reading.');
  });
});

describe('blockquotes', () => {
  it('receives [soft tone] and a trailing [break] when content follows', () => {
    const texts = decorateText([
      seg('q1', 'blockquote', 'A memorable quotation'),
      seg('p1', 'paragraph', 'After the quote.'),
    ]);
    expect(texts[0]).toBe('[soft tone] A memorable quotation. [break]');
  });

  it('has no trailing pause when it is the last content', () => {
    const [text] = decorateText([seg('q1', 'blockquote', 'Final quote.')]);
    expect(text).toBe('[soft tone] Final quote.');
  });
});

describe('list items', () => {
  it('inserts [break] between items but not after the final item', () => {
    const [text] = decorateText([
      seg('li1', 'list-item', 'First item.'),
      seg('li2', 'list-item', 'Second item.'),
      seg('li3', 'list-item', 'Third item.'),
    ]);
    expect(text).toBe('First item. [break] Second item. [break] Third item.');
  });

  it('uses the local pause between list items in separate files', () => {
    const chunks = decorate(
      [longParagraph('li1'), longParagraph('li2')].map((s) => ({ ...s, kind: 'list-item' as const })),
    );
    expect(chunks[1]?.pauseBeforeMs).toBe(INTER_CHUNK_PAUSE_MS);
  });
});

describe('figure captions', () => {
  it('receives [soft tone] and adds [break] when regular content follows', () => {
    const texts = decorateText([
      seg('cap', 'caption', 'A chart of results'),
      seg('p1', 'paragraph', 'Explained below.'),
    ]);
    expect(texts[0]).toBe('[soft tone] A chart of results. [break]');
    expect(texts[1]).toBe('Explained below.');
  });

  it('does not insert [break] between adjacent captions (soft tone spans the gallery)', () => {
    const [text] = decorateText([seg('cap1', 'caption', 'Figure one.'), seg('cap2', 'caption', 'Figure two.')]);
    expect(text).toBe('[soft tone] Figure one. Figure two.');
  });
});

describe('thematic breaks (<hr>)', () => {
  it('renders a long boundary between short paragraphs merged into one request', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'Before the break.'),
      seg('p2', 'paragraph', 'After the break.', { thematicBreakBefore: true }),
    ]);
    expect(text).toBe('Before the break. [long-break] After the break.');
  });

  it('attaches [long-break] to the preceding file and adds no local pause', () => {
    const chunks = decorate(
      [longParagraph('p1'), longParagraph('p2')].map((s, i) => (i === 1 ? { ...s, thematicBreakBefore: true } : s)),
    );
    expect(chunks[0]?.text.endsWith('[long-break]')).toBe(true);
    expect(chunks[1]?.pauseBeforeMs).toBe(0);
  });

  it('never produces a tag-only request', () => {
    const chunks = decorate([
      seg('p1', 'paragraph', 'One.'),
      seg('p2', 'paragraph', 'Two.', { thematicBreakBefore: true }),
      seg('p3', 'paragraph', 'Three.', { thematicBreakBefore: true }),
    ]);
    for (const chunk of chunks) {
      const sourceOnly = chunk.text.replace(/\[[^\]]*\]/g, '').trim();
      expect(sourceOnly.length).toBeGreaterThan(0);
    }
  });
});

describe('inline emphasis', () => {
  it('places [emphasis] immediately before the emphasized phrase', () => {
    const text = insertEmphasisMarkers('This result is especially important for readers.', [
      [15, 34],
    ]);
    expect(text).toBe('This result is [emphasis] especially important for readers.');
  });

  it('decorates a segment carrying emphasis ranges', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'This result is especially important for readers.', {
        emphasis: [[15, 34]],
      }),
    ]);
    expect(text).toBe('This result is [emphasis] especially important for readers.');
  });

  it('keeps the source wording intact around an emphasized phrase', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'First, note that bold styling is not emphasis and stays as written.', {
        emphasis: [[17, 45]],
      }),
    ]);
    expect(text).toBe('First, note that [emphasis] bold styling is not emphasis and stays as written.');
  });

  it('preserves literal markup-looking text on the page (it is not emphasis)', () => {
    const [text] = decorateText([
      seg('p1', 'paragraph', 'This quote has <b>markup</b> as literal text and stays as written.'),
    ]);
    expect(text).toBe('This quote has <b>markup</b> as literal text and stays as written.');
  });
});

describe('source integrity', () => {
  it('deduplicates source text before any tag is applied', () => {
    const texts = decorateText([
      seg('p1', 'paragraph', 'Repeated sentence.'),
      seg('p2', 'paragraph', 'Repeated sentence.'),
    ]);
    expect(texts).toEqual(['Repeated sentence.']);
  });

  it('preserves literal square brackets authored on the page', () => {
    const [text] = decorateText([seg('p1', 'paragraph', 'See [1] and [emphasis] in the appendix.')]);
    expect(text).toBe('See [1] and [emphasis] in the appendix.');
    const withMood = decorateText([seg('p1', 'paragraph', 'See [1] for details.')], 'curious');
    expect(withMood).toEqual(['[curious] See [1] for details.']);
  });

  it('adds no generated tags when nothing structural or mood-based applies', () => {
    const [text] = decorateText([seg('p1', 'paragraph', 'Plain paragraph with no structure.')]);
    expect(text).toBe('Plain paragraph with no structure.');
  });

  it('never changes the order or wording of the source text', () => {
    const segments = [
      seg('t', 'title', 'Title Here'),
      seg('h1', 'heading', 'Intro'),
      seg('p1', 'paragraph', 'First paragraph.'),
      seg('p2', 'paragraph', 'Second paragraph.'),
      seg('q1', 'blockquote', 'A quote.'),
    ];
    const texts = decorateText(segments);
    const stripped = normalizeWhitespace(
      texts
        .map((text) => text.replace(/\[[^\]]*\]/g, ' ').trim())
        .join(' '),
    );
    let cursor = 0;
    for (const s of segments) {
      const expected = normalizeWhitespace(s.text);
      const at = stripped.indexOf(expected, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + expected.length;
    }
  });
});

describe('Mood composition', () => {
  it('adds no mood cue for none', () => {
    expect(moodCue('none')).toBe('');
    const [text] = decorateText([seg('p1', 'paragraph', 'Neutral.')]);
    expect(text).toBe('Neutral.');
  });

  it('maps every selectable mood to its expected bracket cue', () => {
    const expected: Record<Exclude<Mood, 'none'>, string> = {
      calm: '[calm]',
      happy: '[happy]',
      sad: '[sad]',
      excited: '[excited]',
      confident: '[confident]',
      curious: '[curious]',
      empathetic: '[empathetic]',
      relaxed: '[relaxed]',
      hopeful: '[hopeful]',
      nostalgic: '[nostalgic]',
      serious: '[serious]',
      nervous: '[nervous]',
      worried: '[worried]',
      angry: '[angry]',
      sarcastic: '[sarcastic]',
    };
    for (const mood of MOODS) {
      if (mood === 'none') continue;
      expect(moodCue(mood)).toBe(expected[mood]);
      const [text] = decorateText([seg('p1', 'paragraph', 'Tone test.')], mood);
      expect(text).toBe(`${expected[mood]} Tone test.`);
    }
  });

  it('places the mood cue before structural cues', () => {
    const [title] = decorateText(
      [seg('t', 'title', 'Page title'), seg('p1', 'paragraph', 'Body.')],
      'happy',
    );
    expect(title).toBe('[happy] [emphasis] Page title. [long-break]');

    const [quote] = decorateText(
      [seg('q1', 'blockquote', 'Quoted text.'), seg('p1', 'paragraph', 'After.')],
      'calm',
    );
    expect(quote).toBe('[calm] [soft tone] Quoted text. [break]');

    const [paragraph] = decorateText([seg('p1', 'paragraph', 'Paragraph text.')], 'curious');
    expect(paragraph).toBe('[curious] Paragraph text.');
  });

  it('applies the mood to every independently synthesized chunk', () => {
    const chunks = decorate([longParagraph('p1'), longParagraph('p2')], 'hopeful');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('[hopeful] ')).toBe(true);
    }
  });

  it('never duplicates identical tags', () => {
    const texts = decorateText(
      [seg('t', 'title', 'Title'), seg('p1', 'paragraph', 'After.', { thematicBreakBefore: true })],
      'happy',
    );
    expect(texts[0]).toBe('[happy] [emphasis] Title. [long-break]');
    expect((texts[0]!.match(/\[long-break\]/g) ?? []).length).toBe(1);
    expect((texts.join(' ').match(/\[break\]/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('does not emit malformed combinations like [none] or [[happy]]', () => {
    const texts = decorateText(
      [seg('t', 'title', 'Title'), seg('p1', 'paragraph', 'Body.')],
      'none',
    );
    expect(texts.join(' ')).not.toContain('[none]');
    expect(texts.join(' ')).not.toContain('[[');
    expect(texts.join(' ')).not.toContain('] ]');
  });
});

describe('read selection', () => {
  it('applies the mood without adding page structure or a trailing pause', () => {
    const [text] = decorateText([seg('selection-1', 'paragraph', 'Selected text stays as written.')], 'excited');
    expect(text).toBe('[excited] Selected text stays as written.');
  });
});

describe('inter-file pause decisions', () => {
  it('uses the intended local delay only at semantic boundaries between paragraph/list files', () => {
    const chunks = decorate([
      longParagraph('p1'),
      longParagraph('p2'),
      seg('h1', 'heading', 'A heading'),
      longParagraph('p3'),
    ]);
    expect(chunks[0]?.pauseBeforeMs).toBe(0);
    expect(chunks[1]?.pauseBeforeMs).toBe(INTER_CHUNK_PAUSE_MS); // paragraph → paragraph
    expect(chunks[2]?.pauseBeforeMs).toBe(INTER_CHUNK_PAUSE_MS); // paragraph → heading
    expect(chunks[3]?.pauseBeforeMs).toBe(0); // heading audio already ends with [break]
  });

  it('adds no delay after a chunk whose audio already ends with a synthesized tag', () => {
    const chunks = decorate([
      seg('q1', 'blockquote', 'A long quoted passage that stands alone as one file.'),
      longParagraph('p1'),
    ]);
    expect(chunks[0]?.text.endsWith('[break]')).toBe(true);
    expect(chunks[1]?.pauseBeforeMs).toBe(0);
  });
});
