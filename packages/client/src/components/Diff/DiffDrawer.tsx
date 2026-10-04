import { useEffect, useRef, useState } from 'react';
import type { DiffResponse } from '@quorum/shared';
import type { DiffRequest } from '../../ui';
import { shortRef } from '../../ui';
import { WordDiff } from './WordDiff';

export function DiffDrawer({ request, onClose }: { request: DiffRequest; onClose: () => void }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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

  // Focus moves into the drawer once, when it opens (not again whenever the room re-renders), and goes back to
  // whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

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
            <p className="muted small-text" data-testid="diff-range">
              {diff.path} · {shortRef(diff.baseSha)} → {shortRef(diff.headSha)}
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
