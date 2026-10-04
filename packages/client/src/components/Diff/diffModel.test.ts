import { describe, expect, it } from 'vitest';
import { diffSegments, shortLine, MAX_CONTEXT_CHARS } from './diffModel';

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('diffSegments', () => {
  it('folds the unchanged stretches, keeping three lines around each change', () => {
    const before = lines(20);
    const after = before.replace('line 10\n', 'line ten\n');
    const segs = diffSegments(before, after);
    expect(segs.map((s) => s.type)).toEqual(['folded', 'context', 'change', 'context', 'folded']);
    expect(segs[0]).toEqual({ type: 'folded', lines: lines(6).trimEnd().split('\n') });
    expect(segs[1]).toEqual({ type: 'context', lines: ['line 7', 'line 8', 'line 9'] });
    expect(segs[3]).toEqual({ type: 'context', lines: ['line 11', 'line 12', 'line 13'] });
    expect((segs[4] as { lines: string[] }).lines).toHaveLength(7);
  });

  it('diffs a rewritten line word by word', () => {
    const segs = diffSegments('a\nthe quick fox\nb\n', 'a\nthe slow fox\nb\n');
    const change = segs.find((s) => s.type === 'change');
    expect(change).toMatchObject({
      parts: [
        { value: 'the ' },
        { value: 'quick', removed: true },
        { value: 'slow', added: true },
        { value: ' fox\n' },
      ],
    });
  });

  it('does not fold a short gap between two changes', () => {
    const before = lines(9);
    const after = before.replace('line 2\n', 'two\n').replace('line 8\n', 'eight\n');
    expect(diffSegments(before, after).map((s) => s.type)).toEqual([
      'context',
      'change',
      'context',
      'change',
      'context',
    ]);
  });

  it('shows pure additions and removals', () => {
    expect(diffSegments('', 'new\n')).toEqual([
      { type: 'change', parts: [expect.objectContaining({ added: true })] },
    ]);
    expect(diffSegments('old\n', '')).toEqual([
      { type: 'change', parts: [expect.objectContaining({ removed: true })] },
    ]);
  });
});

describe('shortLine', () => {
  it('cuts an enormous line such as an embedded image', () => {
    const long = 'x'.repeat(MAX_CONTEXT_CHARS + 50);
    expect(shortLine(long)).toBe(`${'x'.repeat(MAX_CONTEXT_CHARS)}… (50 more characters)`);
    expect(shortLine('short')).toBe('short');
  });
});

describe('changeSize', () => {
  it('counts the words added and removed', async () => {
    const { changeSize } = await import('../Chat/Cards');
    expect(changeSize('the quick fox', 'the slow red fox')).toBe('+2 −1 words');
    expect(changeSize('a', 'a b')).toBe('+1 −0 word');
  });
});
