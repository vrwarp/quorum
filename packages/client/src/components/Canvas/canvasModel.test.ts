import { describe, expect, it } from 'vitest';
import { textHash } from '@quorum/shared';
import type { Message } from '@quorum/shared';
import {
  hashLines,
  locateAnchor,
  makeAnchor,
  pendingSuggestionLines,
  splitLines,
} from './canvasModel';

const DOC = ['# Title', '', 'Alpha paragraph.', '', '## Beta', '', 'Beta paragraph.', ''].join(
  '\n',
);

function suggestion(
  anchor: ReturnType<typeof makeAnchor>,
  status: 'pending' | 'applied' = 'pending',
) {
  return {
    id: `m_${anchor.startLine}_${status}`,
    roomId: 'room_1',
    author: { kind: 'user', userId: 'u1', displayName: 'Alice' },
    kind: 'card',
    body: 'Suggested an edit',
    card: {
      type: 'suggestion',
      anchor,
      replacement: 'x',
      status,
      resolutionSha: null,
      note: null,
    },
    anchor,
    privateTo: null,
    inReplyTo: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  } satisfies Message;
}

describe('splitLines', () => {
  it('gives one block per non-blank source line, numbered from 1', () => {
    expect(splitLines(DOC).map((l) => [l.line, l.text])).toEqual([
      [1, '# Title'],
      [3, 'Alpha paragraph.'],
      [5, '## Beta'],
      [7, 'Beta paragraph.'],
    ]);
  });

  it('keeps fenced code verbatim, blank lines inside it dropped as elsewhere', () => {
    const lines = splitLines(['text', '```js', 'const a = 1;', '```', 'after'].join('\n'));
    expect(lines.map((l) => l.raw)).toEqual([false, true, true, true, false]);
  });
});

describe('makeAnchor', () => {
  it('captures the text, its hash and the revision it was read at', () => {
    const [, alpha] = splitLines(DOC);
    expect(makeAnchor('doc_1', 'sha1', alpha!)).toEqual({
      documentId: 'doc_1',
      baseSha: 'sha1',
      startLine: 3,
      endLine: 3,
      textHash: textHash('Alpha paragraph.'),
      text: 'Alpha paragraph.',
    });
  });
});

describe('locateAnchor', () => {
  const lines = splitLines(DOC);
  const hashes = hashLines(lines);

  it('finds an unchanged paragraph on its own line', () => {
    const anchor = makeAnchor('d', 's', lines[3]!); // Beta paragraph, line 7
    expect(locateAnchor(lines, hashes, anchor)).toEqual({ line: 7, unchanged: true });
  });

  it('follows a paragraph that moved down because something above it grew', () => {
    const anchor = makeAnchor('d', 's', lines[3]!); // line 7 when it was read
    const grown = splitLines(
      [
        '# Title',
        '',
        'Alpha one.',
        '',
        'Alpha two.',
        '',
        'Alpha paragraph.',
        '',
        '## Beta',
        '',
        'Beta paragraph.',
      ].join('\n'),
    );
    const at = locateAnchor(grown, hashLines(grown), anchor);
    expect(at).toEqual({ line: 11, unchanged: false });
  });

  it('stays on the line when the paragraph was edited in place, and says it changed', () => {
    const anchor = makeAnchor('d', 's', lines[3]!);
    const edited = splitLines(DOC.replace('Beta paragraph.', 'Beta paragraph, edited by Bob.'));
    expect(locateAnchor(edited, hashLines(edited), anchor)).toEqual({ line: 7, unchanged: false });
  });

  it('has no line when the document no longer reaches that far', () => {
    const anchor = makeAnchor('d', 's', lines[3]!);
    const short = splitLines('# Title');
    expect(locateAnchor(short, hashLines(short), anchor)).toEqual({ line: null, unchanged: false });
  });

  it('prefers the nearest of several identical paragraphs', () => {
    const dup = splitLines(['same', '', 'x', '', 'same', '', 'y', '', 'same'].join('\n')); // lines 1, 5, 9
    const anchor = { startLine: 6, textHash: textHash('same') };
    expect(locateAnchor(dup, hashLines(dup), anchor).line).toBe(5);
  });
});

describe('pendingSuggestionLines', () => {
  const lines = splitLines(DOC);
  const hashes = hashLines(lines);
  const anchorOn = (i: number, baseSha = 'sha-old') => makeAnchor('doc_1', baseSha, lines[i]!);

  it('marks the paragraph the suggestion names, whatever sha each person sees as the head', () => {
    const m = [suggestion(anchorOn(1))]; // Alpha, line 3, read at an older sha
    expect(pendingSuggestionLines(m, 'doc_1', 'sha-new', lines, hashes)).toEqual(new Set([3]));
    expect(pendingSuggestionLines(m, 'doc_1', null, lines, hashes)).toEqual(new Set([3]));
  });

  it('follows the paragraph when it moved', () => {
    const m = [suggestion(anchorOn(3))]; // Beta paragraph at line 7
    const grown = splitLines(DOC.replace('# Title', '# Title\n\nNew intro.'));
    expect(pendingSuggestionLines(m, 'doc_1', 'x', grown, hashLines(grown))).toEqual(new Set([9]));
  });

  it("falls back to the suggestion's line only while the shown revision is the one it was made on", () => {
    const edited = splitLines(DOC.replace('Alpha paragraph.', 'Alpha, rewritten.'));
    const m = [suggestion(anchorOn(1, 'sha-1'))];
    expect(pendingSuggestionLines(m, 'doc_1', 'sha-1', edited, hashLines(edited))).toEqual(
      new Set([3]),
    );
    expect(pendingSuggestionLines(m, 'doc_1', 'sha-2', edited, hashLines(edited))).toEqual(
      new Set(),
    );
  });

  it('ignores resolved suggestions and other documents', () => {
    const m = [
      suggestion(anchorOn(1), 'applied'),
      suggestion({ ...anchorOn(3), documentId: 'doc_2' }),
    ];
    expect(pendingSuggestionLines(m, 'doc_1', 'sha-old', lines, hashes)).toEqual(new Set());
  });
});
