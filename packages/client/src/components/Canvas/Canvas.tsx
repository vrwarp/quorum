import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, Document } from '@quorum/shared';
import { textHash } from '@quorum/shared';
import { getDocument } from '../../api';
import { useRoom } from '../../store';
import type { DocWithHead } from '../../store';
import { DocTabs } from './DocTabs';
import { Block } from './Block';

export interface BranchView {
  proposalId: string;
  optionId: string;
  documentId: string;
  branch: string;
  label: string;
  headSha: string | null;
}

interface Loaded {
  key: string;
  content: string;
}

interface Line {
  line: number;
  text: string;
  /** true for fence markers and lines inside a fenced code block */
  raw: boolean;
}

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

export function Canvas(props: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  branch: BranchView | null;
  onExitBranch: () => void;
}) {
  const { state, roomId, send } = useRoom();
  const { selectedId, onSelect, branch, onExitBranch } = props;
  const docs = state.documents.filter((d) => d.status === 'active');
  const doc: DocWithHead | null = docs.find((d) => d.id === selectedId) ?? docs[0] ?? null;
  const viewingBranch = !!branch && !!doc && branch.documentId === doc.id;
  const ref = viewingBranch ? branch.branch : 'main';
  const rev = viewingBranch ? branch.headSha : (doc?.headSha ?? null);
  const key = doc ? `${doc.id}|${ref}` : '';

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    getDocument(roomId, doc.id, ref)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ key, content: r.content });
        setError(null);
      })
      .catch(
        (e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load document'),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, doc?.id, ref, rev]);

  const content = loaded && loaded.key === key ? loaded.content : null;
  const lines = useMemo(() => (content === null ? [] : splitLines(content)), [content]);

  // pending suggestion markers: documentId + startLine while headSha equals baseSha
  const pendingLines = useMemo(() => {
    const set = new Set<number>();
    if (!doc || viewingBranch) return set;
    for (const m of state.messages) {
      const c = m.card;
      if (
        c &&
        c.type === 'suggestion' &&
        c.status === 'pending' &&
        c.anchor.documentId === doc.id &&
        c.anchor.baseSha === doc.headSha
      ) {
        set.add(c.anchor.startLine);
      }
    }
    return set;
  }, [state.messages, doc, viewingBranch]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState<{ line: number; x: number; y: number } | null>(null);
  const [active, setActive] = useState<{ line: number; ask: boolean } | null>(null);

  // Floating "Ask" button for text selections inside rendered blocks.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim() || !container) {
        setFloating(null);
        return;
      }
      const node = sel.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      const blockEl = el?.closest<HTMLElement>('[data-line].block-view');
      if (!blockEl || !container.contains(blockEl)) {
        setFloating(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setFloating({
        line: Number(blockEl.dataset.line),
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  function makeAnchor(l: Line): Anchor {
    return {
      documentId: (doc as Document).id,
      baseSha: doc?.headSha ?? '',
      startLine: l.line,
      endLine: l.line,
      textHash: textHash(l.text),
      text: l.text,
    };
  }

  const readOnly = viewingBranch;
  const floatLine = floating ? lines.find((l) => l.line === floating.line) : null;

  return (
    <section className="pane canvas" aria-label="Document">
      <DocTabs docs={docs} selectedId={doc?.id ?? null} onSelect={onSelect} send={send} />
      {viewingBranch && branch && (
        <div className="banner info" data-testid="branch-banner">
          <span>
            Viewing branch <code>{branch.branch}</code> (option {branch.label}), read-only.
          </span>
          <button
            type="button"
            className="btn small"
            data-testid="branch-exit"
            onClick={onExitBranch}
          >
            Back to main
          </button>
        </div>
      )}
      {!doc ? (
        <p className="muted empty">No documents yet. Create one with “New document”.</p>
      ) : error && content === null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : content === null ? (
        <p className="muted empty">Loading…</p>
      ) : (
        <div className="doc" ref={containerRef} data-testid="doc-content">
          {lines.length === 0 && <p className="muted empty">This document is empty.</p>}
          {lines.map((l) => (
            <Block
              key={l.line}
              line={l.line}
              text={l.text}
              raw={l.raw}
              readOnly={readOnly}
              pending={pendingLines.has(l.line)}
              active={active?.line === l.line}
              startWithAsk={active?.line === l.line && active.ask}
              onActivate={() => setActive({ line: l.line, ask: false })}
              onClose={() => setActive((cur) => (cur?.line === l.line ? null : cur))}
              onSuggest={(replacement) => {
                if (send({ type: 'suggestion.create', anchor: makeAnchor(l), replacement }))
                  setActive(null);
              }}
              onAsk={(question) => {
                if (send({ type: 'ask.create', anchor: makeAnchor(l), question })) setActive(null);
              }}
            />
          ))}
          {floating && floatLine && !readOnly && active === null && (
            <FloatingAsk
              x={floating.x}
              y={floating.y}
              onAsk={() => {
                setActive({ line: floatLine.line, ask: true });
                setFloating(null);
                window.getSelection()?.removeAllRanges();
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function FloatingAsk({ x, y, onAsk }: { x: number; y: number; onAsk: () => void }) {
  return (
    <button
      type="button"
      className="btn small primary floating-ask"
      data-testid="ask-button"
      style={{ left: Math.max(8, x - 24), top: Math.max(8, y - 36) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAsk}
    >
      Ask
    </button>
  );
}
