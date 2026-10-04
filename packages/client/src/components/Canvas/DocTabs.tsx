import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientCommand } from '@quorum/shared';
import type { DocWithHead } from '../../store';

export function DocTabs(props: {
  docs: DocWithHead[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  send: (cmd: ClientCommand) => boolean;
}) {
  const { docs, selectedId, onSelect, send } = props;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState('');
  const selected = docs.find((d) => d.id === selectedId);
  const awaiting = useRef<Set<string> | null>(null);

  // select the document this user just created once it shows up
  useEffect(() => {
    if (!awaiting.current) return;
    const fresh = docs.find((d) => !awaiting.current!.has(d.id));
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
    if (send({ type: 'document.create', title: t })) {
      awaiting.current = known;
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
        <button type="button" className="btn small" data-testid="doc-create" onClick={() => setCreating((v) => !v)}>
          New document
        </button>
        {selected && (
          <button
            type="button"
            className="btn small"
            aria-label="Document menu"
            aria-expanded={menu}
            data-testid="doc-menu"
            onClick={() => {
              setRenaming(selected.title);
              setMenu((v) => !v);
            }}
          >
            ⋯
          </button>
        )}
      </div>
      {creating && (
        <form className="inline-form" onSubmit={create}>
          <input data-testid="doc-create-title" aria-label="Document title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <button type="submit" className="btn small primary" data-testid="doc-create-submit" disabled={!title.trim()}>
            Create
          </button>
        </form>
      )}
      {menu && selected && (
        <div className="menu" data-testid="doc-menu-panel">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const t = renaming.trim();
              if (t && t !== selected.title && send({ type: 'document.rename', documentId: selected.id, title: t })) setMenu(false);
            }}
          >
            <input data-testid="doc-rename-input" aria-label="New title" value={renaming} onChange={(e) => setRenaming(e.target.value)} />
            <button type="submit" className="btn small" data-testid="doc-rename-submit">
              Rename
            </button>
          </form>
          <button
            type="button"
            className="btn small danger"
            data-testid="doc-archive"
            onClick={() => {
              if (send({ type: 'document.archive', documentId: selected.id })) setMenu(false);
            }}
          >
            Archive document
          </button>
        </div>
      )}
    </div>
  );
}
