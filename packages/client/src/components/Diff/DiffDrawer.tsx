import { useEffect, useRef, useState } from 'react';
import type { DiffResponse } from '@quorum/shared';
import type { DiffRequest } from '../../ui';
import { shortSha } from '../../ui';
import { WordDiff } from './WordDiff';

export function DiffDrawer({ request, onClose }: { request: DiffRequest; onClose: () => void }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    request
      .load()
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load diff'));
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-label="Diff"
        data-testid="diff-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h3>{request.title}</h3>
          <span className="spacer" />
          <button
            type="button"
            className="btn small"
            data-testid="diff-raw-toggle"
            aria-pressed={raw}
            onClick={() => setRaw((v) => !v)}
          >
            {raw ? 'Word diff' : 'Raw diff'}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="btn small"
            aria-label="Close diff"
            data-testid="diff-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!diff && !error && <p className="muted">Loading diff…</p>}
        {diff && (
          <>
            <p className="muted small-text">
              {diff.path} · {shortSha(diff.baseSha)} → {shortSha(diff.headSha)}
            </p>
            {raw ? (
              <pre className="unified">{diff.unified || '(empty)'}</pre>
            ) : (
              <WordDiff before={diff.before} after={diff.after} />
            )}
          </>
        )}
      </aside>
    </div>
  );
}
