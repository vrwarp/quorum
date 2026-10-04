import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, ClientCommand } from '@quorum/shared';
import { getDocument } from '../../api';
import { useRoom } from '../../store';
import type { DocWithHead } from '../../store';
import { DocTabs } from './DocTabs';
import { Block } from './Block';
import { Editor } from './Editor';
import {
  definitionsOf,
  hashLines,
  locateAnchor,
  makeAnchor,
  pendingSuggestionLines,
  splitLines,
} from './canvasModel';
import type { Line } from './canvasModel';

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
  /** the revision the content was read at: what an anchor taken from it is based on */
  sha: string;
}

/**
 * An open editor. The anchor is captured when it opens and is what gets submitted, however the document moves on
 * meanwhile: line numbers shift when someone else's change lands above, and an anchor read at submit time would
 * point at a different paragraph.
 */
interface EditSession {
  id: number;
  /** `${document}|${ref}` it was opened on; it closes when the person looks at another */
  key: string;
  anchor: Anchor;
  ask: boolean;
  draft: string;
  question: string;
  error: string | null;
}

export function Canvas(props: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  branch: BranchView | null;
  onExitBranch: () => void;
}) {
  const { state, roomId, send, reportError } = useRoom();
  const { selectedId, onSelect, branch, onExitBranch } = props;
  const docs = state.documents.filter((d) => d.status === 'active');
  const doc: DocWithHead | null = docs.find((d) => d.id === selectedId) ?? docs[0] ?? null;
  const viewingBranch = !!branch && !!doc && branch.documentId === doc.id;
  const archived = !!state.room?.archivedAt;
  const readOnly = viewingBranch || archived;
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
        setLoaded({ key, content: r.content, sha: r.sha });
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

  const here = loaded && loaded.key === key ? loaded : null;
  const content = here ? here.content : null;
  const lines = useMemo(() => (content === null ? [] : splitLines(content)), [content]);
  const hashes = useMemo(() => hashLines(lines), [lines]);
  const definitions = useMemo(() => definitionsOf(lines), [lines]);

  const shownSha = here?.sha ?? doc?.headSha ?? null;
  const pendingLines = useMemo(
    () =>
      !doc || viewingBranch
        ? new Set<number>()
        : pendingSuggestionLines(state.messages, doc.id, shownSha, lines, hashes),
    [state.messages, doc, viewingBranch, shownSha, lines, hashes],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState<{ line: number; x: number; y: number } | null>(null);
  const [session, setSession] = useState<EditSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionIds = useRef(0);
  const focusLine = useRef<number | null>(null);

  // An editor belongs to one document and ref: looking at another closes it.
  useEffect(() => {
    setSession((cur) => (cur && cur.key !== key ? null : cur));
  }, [key]);
  const active = !readOnly && session && session.key === key ? session : null;

  const where = useMemo(
    () => (active ? locateAnchor(lines, hashes, active.anchor) : null),
    [active, lines, hashes],
  );

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

  // After the editor closes, keyboard focus goes back to the paragraph it was on.
  useEffect(() => {
    if (active || focusLine.current === null) return;
    const line = focusLine.current;
    focusLine.current = null;
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-testid="block-${line}"] .block-view`)
      ?.focus();
  }, [active]);

  function openEditor(l: Line, ask: boolean) {
    if (!doc || !here || readOnly) return;
    setSession({
      id: ++sessionIds.current,
      key,
      anchor: makeAnchor(doc.id, here.sha, l),
      ask,
      draft: l.text,
      question: '',
      error: null,
    });
  }

  function closeEditor() {
    focusLine.current = where?.line ?? null;
    setSession(null);
  }

  const patch = (changes: Partial<EditSession>) =>
    setSession((cur) => (cur ? { ...cur, ...changes } : cur));

  /** Sends the editor's command; if the server rejects it the editor comes back with the person's text and the reason. */
  function submit(s: EditSession, command: ClientCommand) {
    const sent = send(command, {
      onError: (e) => {
        // another editor was opened meanwhile: do not replace it, say it on the banner
        if (sessionRef.current) reportError(e.message);
        else setSession({ ...s, id: ++sessionIds.current, error: e.message });
      },
    });
    if (sent) closeEditor();
  }

  const floatLine = floating ? lines.find((l) => l.line === floating.line) : null;
  const editor = active ? (
    <Editor
      key={active.id}
      original={active.anchor.text}
      value={active.draft}
      asking={active.ask}
      question={active.question}
      error={active.error}
      changed={where ? !where.unchanged : false}
      onValue={(draft) => patch({ draft, error: null })}
      onAsking={() => patch({ ask: true })}
      onQuestion={(question) => patch({ question, error: null })}
      onClose={closeEditor}
      onSuggest={() =>
        submit(active, {
          type: 'suggestion.create',
          anchor: active.anchor,
          replacement: active.draft,
        })
      }
      onAsk={() =>
        submit(active, {
          type: 'ask.create',
          anchor: active.anchor,
          question: active.question.trim(),
        })
      }
    />
  ) : null;

  return (
    <section className="pane canvas" aria-label="Document">
      <DocTabs docs={docs} selectedId={doc?.id ?? null} onSelect={onSelect} readOnly={archived} />
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
              endLine={l.endLine}
              text={l.text}
              kind={l.kind}
              definitions={definitions}
              readOnly={readOnly}
              pending={pendingLines.has(l.line)}
              editor={active && where?.line === l.line ? editor : null}
              onActivate={() => openEditor(l, false)}
            />
          ))}
          {active && where?.line == null && (
            <div className="block editing" data-testid="editor-orphan">
              {editor}
            </div>
          )}
          {floating && floatLine && !readOnly && !active && (
            <FloatingAsk
              x={floating.x}
              y={floating.y}
              onAsk={() => {
                openEditor(floatLine, true);
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
