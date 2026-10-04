import { useMemo, useState } from 'react';
import type { Change } from 'diff';
import { diffSegments, shortLine } from './diffModel';

/** Inserted, deleted and common parts of a change; a very long part (an embedded image) is cut. */
export function DiffParts({ parts }: { parts: readonly Change[] }) {
  return (
    <>
      {parts.map((p, j) =>
        p.added ? (
          <ins key={j} className="diff-ins">
            {shortLine(p.value)}
          </ins>
        ) : p.removed ? (
          <del key={j} className="diff-del">
            {shortLine(p.value)}
          </del>
        ) : (
          <span key={j}>{shortLine(p.value)}</span>
        ),
      )}
    </>
  );
}

/**
 * Word-level diff with insert/delete styling. Only the changes are shown, each with a few unchanged lines around it;
 * the unchanged stretches between them are folded and open with a click.
 */
export function WordDiff({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffSegments(before, after), [before, after]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  if (before === after) return <div className="diff-text muted">No changes.</div>;
  return (
    <div className="diff-text" data-testid="word-diff">
      {segments.map((s, i) => {
        if (s.type === 'folded' && !open.has(i))
          return (
            <button
              key={i}
              type="button"
              className="diff-fold"
              data-testid="diff-fold"
              onClick={() => setOpen((cur) => new Set(cur).add(i))}
            >
              ⋯ {s.lines.length} unchanged line{s.lines.length === 1 ? '' : 's'}
            </button>
          );
        if (s.type === 'context' || s.type === 'folded')
          return (
            <span key={i} className="diff-context">
              {s.lines.map(shortLine).join('\n') + '\n'}
            </span>
          );
        return (
          <span key={i} className="diff-change">
            <DiffParts parts={s.parts} />
          </span>
        );
      })}
    </div>
  );
}
