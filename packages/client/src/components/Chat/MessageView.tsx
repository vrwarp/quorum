import { useState } from 'react';
import type { ActorRef, Message } from '@quorum/shared';
import { clip } from '@quorum/shared';
import { useRoom } from '../../store';
import { formatTime } from '../../ui';
import { Markdown } from '../Markdown';
import { CardView } from './Cards';

export function actorName(a: ActorRef): string {
  return a.kind === 'user' ? a.displayName : a.role === 'system' ? 'System' : `Quorum (${a.role})`;
}

/** An agent message without a summary (older ones, digests) longer than this is shown clamped, with "Show more". */
export const LONG_BODY_CHARS = 600;

/** The gist in chat, the full text one click away. */
function SummarizedBody({ summary, body }: { summary: string; body: string }) {
  return (
    <>
      <div className="message-summary" data-testid="msg-summary">
        <Markdown>{summary}</Markdown>
      </div>
      <details className="message-details" data-testid="msg-details">
        <summary>Details</summary>
        <Markdown>{body}</Markdown>
      </details>
    </>
  );
}

/** A long message without a summary: the first lines, and a button for the rest. */
function ClampedBody({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={open ? undefined : 'message-clamped'} data-testid="msg-clamped">
        <Markdown>{body}</Markdown>
      </div>
      <button
        type="button"
        className="link-button small-text"
        data-testid="msg-more"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}

function MessageBody({ message: m }: { message: Message }) {
  if (m.summary) return <SummarizedBody summary={m.summary} body={m.body} />;
  if (m.author.kind === 'agent' && m.body.length > LONG_BODY_CHARS)
    return <ClampedBody body={m.body} />;
  return <Markdown>{m.body}</Markdown>;
}

export function MessageView({ message: m }: { message: Message }) {
  const { you } = useRoom();
  const mine = m.author.kind === 'user' && m.author.userId === you.userId;
  const isPrivate = !!m.privateTo;
  const cls = [
    'message',
    m.kind,
    mine ? 'mine' : '',
    m.author.kind === 'agent' ? 'agent' : '',
    isPrivate ? 'private' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article className={cls} data-testid={`message-${m.id}`}>
      <header className="message-head">
        <strong>{actorName(m.author)}</strong>
        <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
        {isPrivate && (
          <span className="pill private-marker" data-testid="private-marker">
            only you can see this
          </span>
        )}
      </header>
      {m.anchor && !m.card && (
        <blockquote className="anchor-quote">
          {clip(m.anchor.text, 300)}
          <span className="muted small-text"> (line {m.anchor.startLine})</span>
        </blockquote>
      )}
      {m.card ? <CardView message={m} card={m.card} /> : <MessageBody message={m} />}
    </article>
  );
}
