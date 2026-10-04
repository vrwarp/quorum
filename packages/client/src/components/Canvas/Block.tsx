import type { ReactNode } from 'react';
import { Markdown } from '../Markdown';
import type { BlockKind } from './canvasModel';

/** `[image1]: data:image/png;base64,…` shown as one short line instead of pages of base64. */
function DefinitionView({ text }: { text: string }) {
  const m = /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(text);
  const label = m?.[1] ?? '';
  const dest = m?.[2] ?? text;
  const data = /^data:([^;,]+)/.exec(dest);
  const what = data
    ? `${data[1]} embedded, ${Math.max(1, Math.round((dest.length * 3) / 4 / 1024))} KB`
    : dest.length > 80
      ? `${dest.slice(0, 79)}…`
      : dest;
  return (
    <div className="definition muted small-text" data-testid="definition">
      <code>[{label}]</code> {what}
    </div>
  );
}

export function Block(props: {
  line: number;
  endLine: number;
  text: string;
  kind: BlockKind;
  /** the document's link reference definitions, for blocks that use `![alt][label]` */
  definitions: string;
  readOnly: boolean;
  pending: boolean;
  /** the open editor, when this is the block it is shown on */
  editor: ReactNode | null;
  onActivate: () => void;
}) {
  const { line, endLine, text, kind, readOnly, pending, editor } = props;
  const where = endLine > line ? `Lines ${line}-${endLine}` : `Line ${line}`;
  return (
    <div
      className={`block block-${kind}${pending ? ' has-pending' : ''}${editor ? ' editing' : ''}`}
      data-testid={`block-${line}`}
      data-line={line}
    >
      {editor && !readOnly ? (
        editor
      ) : (
        <div
          className={`block-view${readOnly ? '' : ' clickable'}`}
          data-line={line}
          role={readOnly ? undefined : 'button'}
          tabIndex={readOnly ? undefined : 0}
          aria-label={readOnly ? undefined : `${where}: click to suggest an edit`}
          onClick={(e) => {
            if (readOnly) return;
            if ((e.target as Element).closest('a')) return; // following a link is not an edit
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim()) return; // selecting to Ask
            props.onActivate();
          }}
          onKeyDown={(e) => {
            if (!readOnly && e.key === 'Enter' && e.target === e.currentTarget) props.onActivate();
          }}
        >
          {kind === 'definition' ? (
            <DefinitionView text={text} />
          ) : (
            <Markdown definitions={kind === 'code' ? undefined : props.definitions}>
              {text}
            </Markdown>
          )}
        </div>
      )}
      {pending && (
        <span className="pill pending-marker" data-testid={`pending-${line}`}>
          suggestion pending
        </span>
      )}
    </div>
  );
}
