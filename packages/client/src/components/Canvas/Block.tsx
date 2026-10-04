import type { ReactNode } from 'react';
import { Markdown } from '../Markdown';

export function Block(props: {
  line: number;
  text: string;
  raw: boolean;
  readOnly: boolean;
  pending: boolean;
  /** the open editor, when this is the block it is shown on */
  editor: ReactNode | null;
  onActivate: () => void;
}) {
  const { line, text, raw, readOnly, pending, editor } = props;
  return (
    <div
      className={`block${pending ? ' has-pending' : ''}${editor ? ' editing' : ''}`}
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
          aria-label={readOnly ? undefined : `Line ${line}: click to suggest an edit`}
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
          {raw ? <pre className="raw-line">{text}</pre> : <Markdown>{text}</Markdown>}
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
