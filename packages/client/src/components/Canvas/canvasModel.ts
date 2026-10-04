import type { Anchor, DocumentId, Message } from '@quorum/shared';
import { textHash } from '@quorum/shared';

export interface Line {
  /** 1-based source line */
  line: number;
  text: string;
  /** true for fence markers and lines inside a fenced code block */
  raw: boolean;
}

/** One block per non-blank source line (a paragraph is one line); fenced code is kept verbatim. */
export function splitLines(source: string): Line[] {
  const out: Line[] = [];
  let fenced = false;
  source.split('\n').forEach((text, i) => {
    const isFence = /^\s*(```|~~~)/.test(text);
    if (isFence) fenced = !fenced;
    if (text.trim() === '') return;
    out.push({ line: i + 1, text, raw: isFence || fenced });
  });
  return out;
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
    endLine: l.line,
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
