import { diffLines, diffWords, type Change } from 'diff';

/** Unchanged lines shown on each side of a change; longer unchanged stretches are folded. */
export const CONTEXT_LINES = 3;
/** Unchanged lines longer than this are cut when shown as context (an embedded image is one enormous line). */
export const MAX_CONTEXT_CHARS = 300;
/** Above this, changed regions are shown line by line instead of word by word. */
const WORD_DIFF_LIMIT = 20_000;

export type DiffSegment =
  /** unchanged lines shown around a change */
  | { type: 'context'; lines: string[] }
  /** unchanged lines folded away until expanded */
  | { type: 'folded'; lines: string[] }
  /** a changed region: word-level parts (added, removed or common) */
  | { type: 'change'; parts: Change[] };

function toLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop(); // diffLines values end with the newline of their last line
  return lines;
}

/**
 * The diff as a list of segments, GitHub style: each change with a few unchanged lines around it, and the unchanged
 * stretches between changes folded. A removal followed by an addition (a rewritten passage) is diffed word by word.
 */
export function diffSegments(
  before: string,
  after: string,
  context = CONTEXT_LINES,
): DiffSegment[] {
  const chunks = diffLines(before, after);
  const out: DiffSegment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (!c.added && !c.removed) {
      const lines = toLines(c.value);
      const first = i === 0;
      const last = i === chunks.length - 1;
      const head = first ? 0 : context; // lines kept after the previous change
      const tail = last ? 0 : context; // lines kept before the next change
      if (lines.length <= head + tail + 1) {
        out.push({ type: 'context', lines });
        continue;
      }
      if (head > 0) out.push({ type: 'context', lines: lines.slice(0, head) });
      out.push({ type: 'folded', lines: lines.slice(head, lines.length - tail) });
      if (tail > 0) out.push({ type: 'context', lines: lines.slice(lines.length - tail) });
      continue;
    }
    const next = chunks[i + 1];
    if (c.removed && next?.added) {
      const parts =
        c.value.length + next.value.length > WORD_DIFF_LIMIT
          ? [c, next]
          : diffWords(c.value, next.value);
      out.push({ type: 'change', parts });
      i++;
      continue;
    }
    out.push({ type: 'change', parts: [c] });
  }
  return out;
}

/** A context line as shown: cut when very long. */
export function shortLine(line: string): string {
  return line.length > MAX_CONTEXT_CHARS
    ? `${line.slice(0, MAX_CONTEXT_CHARS)}… (${line.length - MAX_CONTEXT_CHARS} more characters)`
    : line;
}
