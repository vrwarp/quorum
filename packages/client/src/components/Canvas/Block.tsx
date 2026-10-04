import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

export function Block(props: {
  line: number;
  text: string;
  raw: boolean;
  readOnly: boolean;
  pending: boolean;
  active: boolean;
  startWithAsk: boolean;
  onActivate: () => void;
  onClose: () => void;
  onSuggest: (replacement: string) => void;
  onAsk: (question: string) => void;
}) {
  const { line, text, raw, readOnly, pending, active, startWithAsk } = props;
  return (
    <div
      className={`block${pending ? ' has-pending' : ''}${active ? ' editing' : ''}`}
      data-testid={`block-${line}`}
      data-line={line}
    >
      {active && !readOnly ? (
        <Editor
          text={text}
          startWithAsk={startWithAsk}
          onClose={props.onClose}
          onSuggest={props.onSuggest}
          onAsk={props.onAsk}
        />
      ) : (
        <div
          className={`block-view${readOnly ? '' : ' clickable'}`}
          data-line={line}
          role={readOnly ? undefined : 'button'}
          tabIndex={readOnly ? undefined : 0}
          aria-label={readOnly ? undefined : `Line ${line}: click to suggest an edit`}
          onClick={() => {
            if (readOnly) return;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim()) return; // selecting to Ask
            props.onActivate();
          }}
          onKeyDown={(e) => {
            if (!readOnly && e.key === 'Enter' && e.target === e.currentTarget) props.onActivate();
          }}
        >
          {raw ? (
            <pre className="raw-line">{text}</pre>
          ) : (
            <div className="md">
              <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
            </div>
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

function Editor(props: {
  text: string;
  startWithAsk: boolean;
  onClose: () => void;
  onSuggest: (replacement: string) => void;
  onAsk: (question: string) => void;
}) {
  const [value, setValue] = useState(props.text);
  const [asking, setAsking] = useState(props.startWithAsk);
  const [question, setQuestion] = useState('');
  const askRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (asking) askRef.current?.focus();
    else areaRef.current?.focus();
  }, [asking]);

  return (
    <div className="editor">
      <textarea
        ref={areaRef}
        data-testid="suggest-textarea"
        aria-label="Suggested text"
        rows={Math.min(8, Math.max(2, Math.ceil(value.length / 70)))}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      />
      <div className="card-actions">
        <button
          type="button"
          className="btn small primary"
          data-testid="suggest-submit"
          disabled={value === props.text}
          onClick={() => props.onSuggest(value)}
        >
          Suggest
        </button>
        <button type="button" className="btn small" onClick={props.onClose}>
          Cancel
        </button>
        {!asking && (
          <button
            type="button"
            className="btn small"
            data-testid="ask-button"
            onClick={() => setAsking(true)}
          >
            Ask
          </button>
        )}
      </div>
      {asking && (
        <form
          className="inline-form ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) props.onAsk(question.trim());
          }}
        >
          <input
            ref={askRef}
            data-testid="ask-input"
            aria-label="Question about this passage"
            placeholder="Ask about this passage…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
          />
          <button
            type="submit"
            className="btn small primary"
            data-testid="ask-submit"
            disabled={!question.trim()}
          >
            Ask
          </button>
        </form>
      )}
    </div>
  );
}
