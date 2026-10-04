import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useRoom } from '../../store';
import { MessageView } from './MessageView';

export function Chat() {
  const { state, send, loadEarlier } = useRoom();
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
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
    if (!body) return;
    if (send({ type: 'chat.send', body })) setText('');
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
          onClick={() => void loadEarlier().catch(() => {})}
        >
          Load earlier messages
        </button>
        {state.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
      </div>
      <div className="chat-input">
        <textarea
          data-testid="chat-input"
          aria-label="Message"
          rows={2}
          placeholder="Say something. The agent is listening."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="btn primary"
          data-testid="chat-send"
          onClick={submit}
          disabled={!text.trim()}
        >
          Send
        </button>
      </div>
    </section>
  );
}
