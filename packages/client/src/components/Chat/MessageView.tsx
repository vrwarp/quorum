import type { ActorRef, Message } from '@quorum/shared';
import { useRoom } from '../../store';
import { formatTime } from '../../ui';
import { Markdown } from '../Markdown';
import { CardView } from './Cards';

export function actorName(a: ActorRef): string {
  return a.kind === 'user' ? a.displayName : a.role === 'system' ? 'System' : `Quorum (${a.role})`;
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
          {m.anchor.text}
          <span className="muted small-text"> (line {m.anchor.startLine})</span>
        </blockquote>
      )}
      {m.card ? <CardView message={m} card={m.card} /> : <Markdown>{m.body}</Markdown>}
    </article>
  );
}
