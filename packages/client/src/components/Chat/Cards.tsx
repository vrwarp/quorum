import { useState } from 'react';
import { diffWords } from 'diff';
import type { Card, Change, Message, Proposal, ProposalOption } from '@quorum/shared';
import { getChangeDiff, getProposalDiff } from '../../api';
import { formatCountdown, useNow } from '../../hooks';
import { useRoom } from '../../store';
import { shortSha, useUi } from '../../ui';
import { Markdown } from '../Markdown';
import { actorName } from './MessageView';

export function CardView({ message, card }: { message: Message; card: Card }) {
  switch (card.type) {
    case 'change':
      return <ChangeCard change={card.change} />;
    case 'suggestion':
      return <SuggestionCard card={card} />;
    case 'ask':
      return <AskCard card={card} />;
    case 'review':
      return <ReviewCard proposalId={card.proposalId} />;
    case 'quorum':
      return <QuorumCard proposalId={card.proposalId} />;
    case 'exploration_started':
      return <ExplorationCard card={card} />;
    case 'merge':
      return <MergeCard card={card} />;
    case 'digest':
      return (
        <div className="card digest" data-testid="card-digest">
          <div className="card-title">Digest while you were away</div>
          <Markdown>{message.body}</Markdown>
        </div>
      );
    case 'agent_status':
      return (
        <div className="card agent-status" data-testid="card-agent-status">
          Agent {card.status}
          {card.detail ? `: ${card.detail}` : ''}
        </div>
      );
  }
}

function DiffButton({ label = 'View diff', title, load, testid }: { label?: string; title: string; load: Parameters<ReturnType<typeof useUi>['openDiff']>[0]['load']; testid?: string }) {
  const { openDiff } = useUi();
  return (
    <button type="button" className="btn small" data-testid={testid} onClick={() => openDiff({ title, load })}>
      {label}
    </button>
  );
}

function ChangeCard({ change }: { change: Change }) {
  const { roomId, send } = useRoom();
  const [requested, setRequested] = useState(false);
  const reverted = !!change.revertedBySha;
  const isRevert = !!change.revertsSha;
  return (
    <div className={`card change${reverted ? ' reverted' : ''}`} data-testid="card-change">
      <div className="card-title">
        Change {isRevert ? '(revert) ' : ''}
        <code>{shortSha(change.sha)}</code>
        {reverted && <span className="pill warn">reverted</span>}
      </div>
      <p>{change.summary}</p>
      <div className="muted small-text">by {actorName(change.actor)}</div>
      <div className="card-actions">
        <DiffButton title={`Change ${shortSha(change.sha)}`} load={() => getChangeDiff(roomId, change.sha)} />
        <button
          type="button"
          className="btn small danger"
          data-testid={`revert-${change.sha}`}
          disabled={reverted || isRevert || requested}
          onClick={() => {
            if (send({ type: 'revert.request', sha: change.sha })) setRequested(true);
          }}
        >
          {reverted ? 'Reverted' : 'Revert'}
        </button>
      </div>
    </div>
  );
}

function SuggestionCard({ card }: { card: Extract<Card, { type: 'suggestion' }> }) {
  const parts = diffWords(card.anchor.text, card.replacement);
  return (
    <div className="card suggestion" data-testid="card-suggestion">
      <div className="card-title">
        Suggestion <span className={`pill status-${card.status}`}>{card.status}</span>
      </div>
      <div className="diff-text">
        {parts.map((p, i) =>
          p.added ? (
            <ins key={i} className="diff-ins">
              {p.value}
            </ins>
          ) : p.removed ? (
            <del key={i} className="diff-del">
              {p.value}
            </del>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        )}
      </div>
      {card.replacement === '' && <div className="muted small-text">Deletes this paragraph.</div>}
      <div className="muted small-text">line {card.anchor.startLine}</div>
      {card.note && <p className="muted small-text">{card.note}</p>}
      {card.resolutionSha && <div className="muted small-text">Applied in {shortSha(card.resolutionSha)}</div>}
    </div>
  );
}

function AskCard({ card }: { card: Extract<Card, { type: 'ask' }> }) {
  return (
    <div className="card ask" data-testid="card-ask">
      <div className="card-title">Question about line {card.anchor.startLine}</div>
      <blockquote className="anchor-quote">{card.anchor.text}</blockquote>
      <p>{card.question}</p>
    </div>
  );
}

function ExplorationCard({ card }: { card: Extract<Card, { type: 'exploration_started' }> }) {
  return (
    <div className="card exploration" data-testid="card-exploration">
      <div className="card-title">Exploring: {card.title}</div>
      <ul>
        {card.theses.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function MergeCard({ card }: { card: Extract<Card, { type: 'merge' }> }) {
  const { roomId, state } = useRoom();
  const p = state.proposals.find((x) => x.id === card.proposalId);
  const opt = p?.options.find((o) => o.id === card.optionId);
  return (
    <div className="card merge" data-testid="card-merge">
      <div className="card-title">
        Merged{p ? `: ${p.title}` : ''} <code>{shortSha(card.sha)}</code>
        {card.reconciled && <span className="pill">reconciled</span>}
      </div>
      {opt && <div className="muted small-text">Option {opt.label}</div>}
      <p>{card.summary}</p>
      <div className="card-actions">
        <DiffButton title={`Merge ${shortSha(card.sha)}`} load={() => getChangeDiff(roomId, card.sha)} />
      </div>
    </div>
  );
}

function ReviewCard({ proposalId }: { proposalId: string }) {
  const { state, send, you } = useRoom();
  const p = state.proposals.find((x) => x.id === proposalId);
  const closes = p?.windowClosesAt ? Date.parse(p.windowClosesAt) : null;
  const open = p?.state === 'open';
  const now = useNow(1000, open && closes !== null);
  if (!p) return <div className="card review" data-testid="card-review">Loading proposal…</div>;
  const opt = p.options[0];
  const mine = p.votes.find((v) => v.userId === you.userId);
  const approvals = p.votes.filter((v) => v.decision === 'approve').length;
  const rejections = p.votes.filter((v) => v.decision === 'reject').length;
  return (
    <div className={`card review state-${p.state}`} data-testid="card-review">
      <div className="card-title">
        Review: {p.title} <span className={`pill state-${p.state}`}>{p.state}</span>
      </div>
      {opt && <OptionBody option={opt} proposal={p} />}
      <div className="muted small-text">
        {approvals} approve, {rejections} reject
        {open && closes !== null && <> · window closes in <span data-testid="review-countdown">{formatCountdown(closes - now)}</span></>}
      </div>
      <div className="card-actions">
        {opt && <ProposalDiffButton proposal={p} option={opt} />}
        <button
          type="button"
          className={`btn small${mine?.decision === 'approve' ? ' selected' : ''}`}
          data-testid="review-approve"
          aria-pressed={mine?.decision === 'approve'}
          disabled={!open}
          onClick={() => send({ type: 'vote.cast', proposalId: p.id, decision: 'approve', optionId: opt?.id })}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn small danger${mine?.decision === 'reject' ? ' selected' : ''}`}
          data-testid="review-reject"
          aria-pressed={mine?.decision === 'reject'}
          disabled={!open}
          onClick={() => send({ type: 'vote.cast', proposalId: p.id, decision: 'reject' })}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function OptionBody({ option, proposal }: { option: ProposalOption; proposal: Proposal }) {
  void proposal;
  return (
    <div className="option-body">
      {option.summary && <Markdown>{option.summary}</Markdown>}
      {option.tradeoffs && (
        <div className="tradeoffs">
          <strong>Tradeoffs</strong>
          <Markdown>{option.tradeoffs}</Markdown>
        </div>
      )}
    </div>
  );
}

export function ProposalDiffButton({ proposal, option, label = 'View diff' }: { proposal: Proposal; option: ProposalOption; label?: string }) {
  const { roomId } = useRoom();
  return (
    <DiffButton
      label={label}
      testid={`diff-${option.id}`}
      title={`${proposal.title} (option ${option.label})`}
      load={() => getProposalDiff(roomId, proposal.id, option.id)}
    />
  );
}

function QuorumCard({ proposalId }: { proposalId: string }) {
  const { state, send, you } = useRoom();
  const p = state.proposals.find((x) => x.id === proposalId);
  if (!p) return <div className="card quorum" data-testid="card-quorum">Loading proposal…</div>;
  const open = p.state === 'open';
  const mine = p.votes.find((v) => v.userId === you.userId);
  const eligible = state.presence.filter((x) => x.connected).length;
  return (
    <div className={`card quorum state-${p.state}`} data-testid="card-quorum">
      <div className="card-title">
        {p.title} <span className={`pill state-${p.state}`}>{p.state}</span>
      </div>
      <div className="muted small-text">
        Rule: {state.room?.votingRule ?? '?'} · {eligible} connected
      </div>
      <ol className="options">
        {p.options.map((o) => {
          const tally = p.votes.filter((v) => v.decision === 'approve' && v.optionId === o.id).length;
          const chosen = mine?.decision === 'approve' && mine.optionId === o.id;
          const merged = p.mergedOptionId === o.id;
          return (
            <li key={o.id} className={`option${chosen ? ' chosen' : ''}${merged ? ' merged' : ''}`} data-testid={`option-${o.id}`}>
              <div className="option-head">
                <strong>Option {o.label}</strong>
                <span className="pill" data-testid={`tally-${o.id}`}>
                  {tally} {tally === 1 ? 'vote' : 'votes'}
                </span>
                {merged && <span className="pill ok">merged</span>}
              </div>
              <OptionBody option={o} proposal={p} />
              <div className="card-actions">
                <ProposalDiffButton proposal={p} option={o} />
                <button
                  type="button"
                  className={`btn small${chosen ? ' selected' : ' primary'}`}
                  data-testid={`vote-${o.id}`}
                  aria-pressed={chosen}
                  disabled={!open}
                  onClick={() => send({ type: 'vote.cast', proposalId: p.id, decision: 'approve', optionId: o.id })}
                >
                  {chosen ? 'Your vote' : `Vote ${o.label}`}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
