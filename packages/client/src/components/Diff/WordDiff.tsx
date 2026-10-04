import { diffLines, diffWords } from 'diff';

const LONG_DOC = 20_000;

/** Word-level diff with insert/delete styling; falls back to a line diff for long text. */
export function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = before.length + after.length > LONG_DOC ? diffLines(before, after) : diffWords(before, after);
  if (before === after) return <div className="diff-text muted">No changes.</div>;
  return (
    <div className="diff-text" data-testid="word-diff">
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i} className="diff-ins">
            {p.value}
          </ins>
        ) : p.removed ? (
          <del key={i} className="diff-del">
            {p.value}
          </del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </div>
  );
}
