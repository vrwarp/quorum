import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useCommand, useRoom } from '../../store';
import { MessageView } from './MessageView';

export function Chat() {
  const { state, loadEarlier } = useRoom();
  const cmd = useCommand();
  const archived = !!state.room?.archivedAt;
  const [text, setText] = useState('');
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  const connected = state.presence.filter((p) => p.connected);

  // A proposal card is posted before its proposal.updated arrives and grows when it does, so follow proposals too:
  // otherwise the vote buttons of a new Quorum card end up below the fold.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.proposals]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  function submit() {
    const body = text.trim();
    if (!body || archived) return;
    const restore = () => {
      // the server refused it: the message comes back, in front of anything typed since, with the reason below
      setText((cur) => (cur.trim() ? `${body}\n${cur}` : body));
      inputRef.current?.focus();
    };
    if (cmd.run({ type: 'chat.send', body }, restore)) {
      setText('');
      inputRef.current?.focus(); // Send disables itself with the empty box: keep the keyboard where it was
    }
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section className="pane chat" aria-label="Chat">
      <div className="chat-head">
        <ul className="presence" aria-label="Connected participants">
          {connected.map((p) => (
            <li key={p.userId} className="pill ok" data-testid={`presence-${p.userId}`}>
              {p.displayName}
            </li>
          ))}
        </ul>
        <span
          className={`pill agent ${state.agentStatus}`}
          data-testid="agent-status"
          title={state.agentDetail ?? undefined}
        >
          Agent: {state.agentStatus}
        </span>
      </div>
      <div
        className="transcript"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <button
          type="button"
          className="btn small link"
          onClick={() => {
            setEarlierError(null);
            loadEarlier().catch((e) =>
              setEarlierError(e instanceof Error ? e.message : 'Could not load earlier messages'),
            );
          }}
        >
          Load earlier messages
        </button>
        {earlierError && (
          <p className="error small-text" role="alert">
            {earlierError}
          </p>
        )}
        {state.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
      </div>
      <div className="chat-input">
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          aria-label="Message"
          rows={2}
          placeholder={
            archived ? 'This room is archived.' : 'Say something. The agent is listening.'
          }
          value={text}
          disabled={archived}
          onChange={(e) => {
            setText(e.target.value);
            if (cmd.error) cmd.clearError();
          }}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="btn primary"
          data-testid="chat-send"
          onClick={submit}
          disabled={!text.trim() || archived}
        >
          Send
        </button>
      </div>
      {cmd.error && (
        <p className="error small-text field-error" role="alert" data-testid="chat-error">
          {cmd.error}
        </p>
      )}
    </section>
  );
}
