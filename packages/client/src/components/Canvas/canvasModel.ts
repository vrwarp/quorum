import type { Anchor, DocumentId, Message } from '@quorum/shared';
import { textHash } from '@quorum/shared';

export type BlockKind = 'text' | 'code' | 'table' | 'definition';

/** One block of the canvas: what a click edits and an anchor points at. */
export interface Line {
  /** 1-based first source line */
  line: number;
  /** 1-based last source line (the same as `line` for a one-line block) */
  endLine: number;
  /** the source lines of the block joined with "\n", exactly as they are in the file */
  text: string;
  /**
   * text: one paragraph line; code: a whole fenced block (```mermaid is drawn as a diagram); table: a GFM table, header
   * to last row; definition: a link reference definition (`[image1]: data:image/png;base64,...`), which the other blocks
   * need in order to resolve `![alt][image1]`
   */
  kind: BlockKind;
}

const FENCE = /^\s{0,3}(```|~~~)/;
/** `| a | b |` style row: has a pipe and is not a fence */
const TABLE_ROW = /\|/;
/** the delimiter row under a table header: `| --- | :-: |` */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** `[label]: destination` (a footnote `[^1]:` is not one) */
const DEFINITION = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*\S/;

/**
 * Splits a document into blocks: one per non-blank line (a paragraph is one line), except that a fenced code block
 * (blank lines inside it included) and a table each make one block, so they can be rendered whole.
 */
export function splitLines(source: string): Line[] {
  const src = source.split('\n');
  const out: Line[] = [];
  const push = (start: number, end: number, kind: BlockKind) =>
    out.push({
      line: start + 1,
      endLine: end + 1,
      text: src.slice(start, end + 1).join('\n'),
      kind,
    });
  for (let i = 0; i < src.length; i++) {
    const text = src[i]!;
    if (text.trim() === '') continue;
    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1]!;
      let end = i + 1;
      while (end < src.length && !src[end]!.trimStart().startsWith(marker)) end++;
      end = Math.min(end, src.length - 1); // an unclosed fence runs to the end of the document
      push(i, end, 'code');
      i = end;
      continue;
    }
    if (
      TABLE_ROW.test(text) &&
      i + 1 < src.length &&
      TABLE_DELIMITER.test(src[i + 1]!) &&
      src[i + 1]!.includes('|')
    ) {
      let end = i + 1;
      while (end + 1 < src.length && src[end + 1]!.trim() !== '' && TABLE_ROW.test(src[end + 1]!))
        end++;
      push(i, end, 'table');
      i = end;
      continue;
    }
    push(i, i, DEFINITION.test(text) ? 'definition' : 'text');
  }
  return out;
}

/** The document's link reference definitions, appended to each block so `![alt][label]` resolves wherever it is. */
export function definitionsOf(lines: readonly Line[]): string {
  return lines
    .filter((l) => l.kind === 'definition')
    .map((l) => l.text)
    .join('\n');
}

/** line number -> hash of its text (the same hash anchors carry) */
export function hashLines(lines: readonly Line[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of lines) out.set(l.line, textHash(l.text));
  return out;
}

/**
 * The anchor of a block, as it is when the editor opens: the text and hash the person sees, and the sha of the
 * revision that text was read from. It is submitted as it is even if the document moves on while they type; the
 * server reconciles by comparing against main (PRD 5.2).
 */
export function makeAnchor(documentId: DocumentId, baseSha: string, l: Line): Anchor {
  return {
    documentId,
    baseSha,
    startLine: l.line,
    endLine: l.endLine,
    textHash: textHash(l.text),
    text: l.text,
  };
}

function nearest(candidates: number[], to: number): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (best === null || Math.abs(c - to) < Math.abs(best - to)) best = c;
  }
  return best;
}

export interface AnchorLocation {
  /** the line to show the anchor on in the current text, or null when the document no longer reaches that far */
  line: number | null;
  /** true when the anchor's own line still holds exactly the anchored text */
  unchanged: boolean;
}

/**
 * Where an anchor is in the current text: its own line when that still holds the text, otherwise the nearest line
 * with the same text (the paragraph moved because something above it changed), otherwise the line it pointed at.
 */
export function locateAnchor(
  lines: readonly Line[],
  hashes: ReadonlyMap<number, string>,
  anchor: Pick<Anchor, 'startLine' | 'textHash'>,
): AnchorLocation {
  const own = lines.find((l) => l.line === anchor.startLine);
  if (own && hashes.get(own.line) === anchor.textHash) {
    return { line: own.line, unchanged: true };
  }
  const same = lines.filter((l) => hashes.get(l.line) === anchor.textHash).map((l) => l.line);
  const moved = nearest(same, anchor.startLine);
  if (moved !== null) return { line: moved, unchanged: false };
  return { line: own?.line ?? null, unchanged: false };
}

/**
 * Lines that carry a "suggestion pending" marker. A pending suggestion belongs to the paragraph whose text hash it
 * names, wherever that paragraph is now (the repository head moves with every commit to any document, so comparing
 * shas would hide the marker from people whose view of the head differs). Only when no line holds that text does the
 * suggestion fall back to its own line, and then only while the revision it was made against is still the one shown.
 */
export function pendingSuggestionLines(
  messages: readonly Message[],
  documentId: DocumentId,
  shownSha: string | null,
  lines: readonly Line[],
  hashes: ReadonlyMap<number, string>,
): Set<number> {
  const out = new Set<number>();
  for (const m of messages) {
    const c = m.card;
    if (!c || c.type !== 'suggestion' || c.status !== 'pending') continue;
    if (c.anchor.documentId !== documentId) continue;
    const at = locateAnchor(lines, hashes, c.anchor);
    const holdsText = at.line !== null && hashes.get(at.line) === c.anchor.textHash;
    if (holdsText && at.line !== null) out.add(at.line);
    else if (shownSha !== null && c.anchor.baseSha === shownSha) out.add(c.anchor.startLine);
  }
  return out;
}
