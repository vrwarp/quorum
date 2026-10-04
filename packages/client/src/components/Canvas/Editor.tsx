import { useEffect, useRef } from 'react';

/**
 * The inline editor for one paragraph: Suggest posts the edited text, Ask posts a question about the paragraph. It
 * works on the text the person opened it on (`original`), not on whatever the paragraph has become since. Its state
 * lives with the caller, so the editor can move to wherever its paragraph went without losing what was typed.
 */
export function Editor(props: {
  /** the paragraph as it was when the editor opened */
  original: string;
  /** the suggested text */
  value: string;
  asking: boolean;
  question: string;
  /** why the last submit was rejected, if it was */
  error: string | null;
  /** the paragraph changed (or moved) in the document since the editor opened */
  changed: boolean;
  onValue: (value: string) => void;
  onAsking: () => void;
  onQuestion: (question: string) => void;
  onClose: () => void;
  onSuggest: () => void;
  onAsk: () => void;
}) {
  const { original, value, asking, question, changed, error } = props;
  const askRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (asking) {
      askRef.current?.focus();
      return;
    }
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length); // type on from the end of the paragraph
  }, [asking]);

  const canSuggest = value !== original;

  return (
    <div className="editor">
      {changed && (
        <p className="editor-notice" role="status" data-testid="editor-stale-notice">
          This part of the document changed while you were editing. Your suggestion is based on the
          version you opened, so the agent will check it against the current text and may ask you to
          try again.
        </p>
      )}
      <textarea
        ref={areaRef}
        data-testid="suggest-textarea"
        aria-label="Suggested text"
        rows={Math.min(16, Math.max(2, value.split('\n').length, Math.ceil(value.length / 70)))}
        value={value}
        onChange={(e) => props.onValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSuggest) {
            e.preventDefault();
            props.onSuggest();
          }
        }}
      />
      <div className="card-actions">
        <button
          type="button"
          className="btn small primary"
          data-testid="suggest-submit"
          disabled={!canSuggest}
          onClick={props.onSuggest}
        >
          Suggest
        </button>
        <button
          type="button"
          className="btn small"
          data-testid="suggest-cancel"
          onClick={props.onClose}
        >
          Cancel
        </button>
        {!asking && (
          <button
            type="button"
            className="btn small"
            data-testid="ask-button"
            onClick={props.onAsking}
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
            if (question.trim()) props.onAsk();
          }}
        >
          <input
            ref={askRef}
            data-testid="ask-input"
            aria-label="Question about this passage"
            placeholder="Ask about this passage…"
            value={question}
            onChange={(e) => props.onQuestion(e.target.value)}
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
      {error && (
        <p className="error small-text field-error" role="alert" data-testid="editor-error">
          {error}
        </p>
      )}
    </div>
  );
}
