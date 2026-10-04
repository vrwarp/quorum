import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useCommand } from '../../store';
import type { DocWithHead } from '../../store';

/** After creating a document, the tab follows it only if it shows up within this long (not someone else's, later). */
const AWAIT_CREATED_MS = 10_000;

export function DocTabs(props: {
  docs: DocWithHead[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** the room is archived: nothing can be created, renamed or archived */
  readOnly: boolean;
}) {
  const { docs, selectedId, onSelect, readOnly } = props;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState('');
  const selected = docs.find((d) => d.id === selectedId);
  const cmd = useCommand();
  const awaiting = useRef<{ known: Set<string>; until: number } | null>(null);

  // select the document this user just created once it shows up
  useEffect(() => {
    const waiting = awaiting.current;
    if (!waiting) return;
    if (Date.now() > waiting.until) {
      awaiting.current = null;
      return;
    }
    const fresh = docs.find((d) => !waiting.known.has(d.id));
    if (fresh) {
      awaiting.current = null;
      onSelect(fresh.id);
    }
  }, [docs, onSelect]);

  function create(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const known = new Set(docs.map((d) => d.id));
    const sent = cmd.run({ type: 'document.create', title: t }, () => {
      // rejected: nothing is coming, so do not follow whatever appears next; bring the form back with the title
      awaiting.current = null;
      setTitle(t);
      setCreating(true);
    });
    if (sent) {
      awaiting.current = { known, until: Date.now() + AWAIT_CREATED_MS };
      setTitle('');
      setCreating(false);
    }
  }

  return (
    <div className="doc-tabs">
      <div className="tab-row" role="tablist" aria-label="Documents">
        {docs.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === selectedId}
            className={`tab${d.id === selectedId ? ' active' : ''}`}
            data-testid={`doc-tab-${d.id}`}
            onClick={() => {
              setMenu(false);
              onSelect(d.id);
            }}
          >
            {d.title}
          </button>
        ))}
        <button
          type="button"
          className="btn small"
          data-testid="doc-create"
          disabled={readOnly}
          onClick={() => setCreating((v) => !v)}
        >
          New document
        </button>
        {selected && (
          <button
            type="button"
            className="btn small"
            aria-label="Document menu"
            aria-expanded={menu}
            data-testid="doc-menu"
            disabled={readOnly}
            onClick={() => {
              setRenaming(selected.title);
              setMenu((v) => !v);
            }}
          >
            ⋯
          </button>
        )}
      </div>
      {creating && !readOnly && (
        <form className="inline-form" onSubmit={create}>
          <input
            data-testid="doc-create-title"
            aria-label="Document title"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="btn small primary"
            data-testid="doc-create-submit"
            disabled={!title.trim()}
          >
            Create
          </button>
        </form>
      )}
      {menu && selected && !readOnly && (
        <div className="menu" data-testid="doc-menu-panel">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const t = renaming.trim();
              if (
                t &&
                t !== selected.title &&
                cmd.run({ type: 'document.rename', documentId: selected.id, title: t }, () =>
                  setMenu(true),
                )
              )
                setMenu(false);
            }}
          >
            <input
              data-testid="doc-rename-input"
              aria-label="New title"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
            />
            <button type="submit" className="btn small" data-testid="doc-rename-submit">
              Rename
            </button>
          </form>
          <button
            type="button"
            className="btn small danger"
            data-testid="doc-archive"
            onClick={() => {
              if (
                cmd.run({ type: 'document.archive', documentId: selected.id }, () => setMenu(true))
              )
                setMenu(false);
            }}
          >
            Archive document
          </button>
        </div>
      )}
      {cmd.error && (
        <p className="error small-text field-error" role="alert" data-testid="doc-error">
          {cmd.error}
        </p>
      )}
    </div>
  );
}
