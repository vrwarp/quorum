import { useEffect, useMemo, useState } from 'react';
import { diffWords } from 'diff';
import type { Card, Change, Message, Proposal, ProposalOption } from '@quorum/shared';
import { getChangeDiff, getProposalDiff } from '../../api';
import { formatCountdown, useNow } from '../../hooks';
import { collapseReason, tallyOption } from '../../proposalState';
import type { CollapseReason } from '../../proposalState';
import { useCommand, useProposal, useRoom } from '../../store';
import { shortSha, useUi } from '../../ui';
import { Markdown } from '../Markdown';
import { WordDiff } from '../Diff/WordDiff';
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

function DiffButton({
  label = 'View diff',
  title,
  load,
  testid,
}: {
  label?: string;
  title: string;
  load: Parameters<ReturnType<typeof useUi>['openDiff']>[0]['load'];
  testid?: string;
}) {
  const { openDiff } = useUi();
  return (
    <button
      type="button"
      className="btn small"
      data-testid={testid}
      onClick={() => openDiff({ title, load })}
    >
      {label}
    </button>
  );
}

/** The reason a command was rejected, shown next to the control that sent it. */
function CommandMessage({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="error small-text field-error" role="alert" data-testid="card-error">
      {error}
    </p>
  );
}

function useArchived(): boolean {
  const { state } = useRoom();
  return !!state.room?.archivedAt;
}

/**
 * Sends revert.request once per click. The button is held while the request is out and released again if the server
 * rejects it (the reason shows next to the button) or the connection drops before the card updates.
 */
function useRevert(sha: string) {
  const { state } = useRoom();
  const cmd = useCommand();
  const [requested, setRequested] = useState(false);
  const connected = state.connected;
  useEffect(() => {
    if (!connected) setRequested(false);
  }, [connected]);
  return {
    requested,
    error: cmd.error,
    revert: () => {
      if (cmd.run({ type: 'revert.request', sha }, () => setRequested(false))) setRequested(true);
    },
  };
}

const MESSAGE_PREVIEW = 80;

const CARD_NOUN: Record<Card['type'], string> = {
  change: 'a change',
  suggestion: 'a suggestion',
  ask: 'a question',
  review: 'a review proposal',
  quorum: 'a vote',
  exploration_started: 'an exploration',
  merge: 'a merge',
  digest: 'a digest',
  agent_status: 'a status update',
};

function triggerText(m: Message): string {
  if (m.card) return CARD_NOUN[m.card.type];
  const line = (m.body.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > MESSAGE_PREVIEW ? `${line.slice(0, MESSAGE_PREVIEW - 1)}…` : line;
}

function jumpToMessage(id: string) {
  const wanted = `message-${id}`;
  const el = [...document.querySelectorAll<HTMLElement>('[data-testid^="message-"]')].find(
    (candidate) => candidate.dataset.testid === wanted,
  );
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** "On behalf of which messages" (PRD 7.1): the chat that caused a change, each one a link into the transcript. */
function Triggers({ ids }: { ids: string[] }) {
  const { state } = useRoom();
  const found = useMemo(() => {
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    return ids.map((id) => byId.get(id)).filter((m): m is Message => !!m);
  }, [ids, state.messages]);
  if (ids.length === 0) return null;
  const unseen = ids.length - found.length;
  return (
    <div className="triggers muted small-text" data-testid="change-triggers">
      On behalf of:{' '}
      {found.slice(0, 3).map((m) => (
        <button
          key={m.id}
          type="button"
          className="btn small link trigger"
          data-testid={`trigger-${m.id}`}
          title="Show this message in the chat"
          onClick={() => jumpToMessage(m.id)}
        >
          {actorName(m.author)}: {triggerText(m)}
        </button>
      ))}
      {found.length > 3 && <span> and {found.length - 3} more</span>}
      {unseen > 0 && (
        <span>
          {found.length > 0 ? ' · ' : ''}
          {unseen} earlier {unseen === 1 ? 'message' : 'messages'}
        </span>
      )}
    </div>
  );
}

function ChangeCard({ change }: { change: Change }) {
  const { roomId } = useRoom();
  const archived = useArchived();
  const { requested, error, revert } = useRevert(change.sha);
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
      <Triggers ids={change.triggerMessageIds} />
      <div className="card-actions">
        <DiffButton
          title={`Change ${shortSha(change.sha)}`}
          load={() => getChangeDiff(roomId, change.sha)}
        />
        <button
          type="button"
          className="btn small danger"
          data-testid={`revert-${change.sha}`}
          title={isRevert ? 'Undo this revert: put the reverted change back' : undefined}
          disabled={reverted || requested || archived}
          onClick={revert}
        >
          {reverted ? 'Reverted' : 'Revert'}
        </button>
      </div>
      <CommandMessage error={error} />
    </div>
  );
}

/** "+12 −3 words": how big a suggested edit is, shown while its diff is folded. */
export function changeSize(before: string, after: string): string {
  let added = 0;
  let removed = 0;
  for (const p of diffWords(before, after)) {
    const words = p.value.split(/\s+/).filter(Boolean).length;
    if (p.added) added += words;
    else if (p.removed) removed += words;
  }
  return `+${added} −${removed} word${added + removed === 1 ? '' : 's'}`;
}

function SuggestionCard({ card }: { card: Extract<Card, { type: 'suggestion' }> }) {
  const size = useMemo(
    () => changeSize(card.anchor.text, card.replacement),
    [card.anchor.text, card.replacement],
  );
  return (
    <div className="card suggestion" data-testid="card-suggestion">
      <div className="card-title">
        Suggestion <span className={`pill status-${card.status}`}>{card.status}</span>
      </div>
      {/* folded by default: a suggestion can rewrite a whole table or carry an embedded image */}
      <details className="card-diff" data-testid="suggestion-diff">
        <summary>Show changes ({size})</summary>
        <WordDiff before={card.anchor.text} after={card.replacement} />
      </details>
      {card.replacement === '' && <div className="muted small-text">Deletes this paragraph.</div>}
      <div className="muted small-text">line {card.anchor.startLine}</div>
      {card.note && <p className="muted small-text">{card.note}</p>}
      {card.resolutionSha && (
        <div className="muted small-text">Applied in {shortSha(card.resolutionSha)}</div>
      )}
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
      <div className="card-title">
        {/^exploring\b/i.test(card.title) ? card.title : `Exploring: ${card.title}`}
      </div>
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
  const archived = useArchived();
  const { requested, error, revert } = useRevert(card.sha);
  const { proposal: p } = useProposal(card.proposalId);
  const opt = p?.options.find((o) => o.id === card.optionId);
  // The proposal says so when it is in the store; the revert's own Change card says so when it is not (a proposal
  // older than the recent history the snapshot carries).
  const reverted =
    (p?.state === 'reverted' && p.mergeSha === card.sha) ||
    state.messages.some((m) => m.card?.type === 'change' && m.card.change.revertsSha === card.sha);
  return (
    <div className={`card merge${reverted ? ' reverted' : ''}`} data-testid="card-merge">
      <div className="card-title">
        Merged{p ? `: ${p.title}` : ''} <code>{shortSha(card.sha)}</code>
        {card.reconciled && <span className="pill">reconciled</span>}
        {reverted && <span className="pill warn">reverted</span>}
      </div>
      {opt && <div className="muted small-text">Option {opt.label}</div>}
      <p>{card.summary}</p>
      {p && <Triggers ids={p.triggerMessageIds} />}
      <div className="card-actions">
        <DiffButton
          title={`Merge ${shortSha(card.sha)}`}
          load={() => getChangeDiff(roomId, card.sha)}
        />
        <button
          type="button"
          className="btn small danger"
          data-testid={`revert-${card.sha}`}
          disabled={reverted || requested || archived}
          onClick={revert}
        >
          {reverted ? 'Reverted' : 'Revert'}
        </button>
      </div>
      <CommandMessage error={error} />
    </div>
  );
}

/** Stale and archived proposals render collapsed and labelled (PRD 6.5, 7.4); the person can expand them. */
function useCollapse(reason: CollapseReason | null) {
  const [expanded, setExpanded] = useState(false);
  return {
    collapsed: reason !== null && !expanded,
    toggle: reason ? () => setExpanded((v) => !v) : null,
    expanded,
  };
}

function CardToggle({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn small link"
      aria-expanded={expanded}
      data-testid="card-toggle"
      onClick={onClick}
    >
      {expanded ? 'Hide details' : 'Show details'}
    </button>
  );
}

function CollapsedProposal(props: {
  kind: 'review' | 'quorum';
  proposal: Proposal;
  reason: CollapseReason;
  onExpand: () => void;
}) {
  const { kind, proposal: p, reason } = props;
  return (
    <div className={`card ${kind} collapsed state-${p.state}`} data-testid={`card-${kind}`}>
      <div className="collapsed-row">
        <span className="card-title">{kind === 'review' ? `Review: ${p.title}` : p.title}</span>
        <span className={`pill state-${p.state}`}>{p.state}</span>
        {p.stale && <span className="pill warn">stale</span>}
        <span className="spacer" />
        <CardToggle expanded={false} onClick={props.onExpand} />
      </div>
      <div className="muted small-text" data-testid="card-collapsed-label">
        {reason.label}
      </div>
    </div>
  );
}

/** The label of an expanded stale or archived card, with the way to collapse it again. */
function CollapseNote({ reason, onToggle }: { reason: CollapseReason; onToggle: () => void }) {
  return (
    <div className="collapsed-row">
      <span className="muted small-text" data-testid="card-collapsed-label">
        {reason.label}
      </span>
      <span className="spacer" />
      <CardToggle expanded onClick={onToggle} />
    </div>
  );
}

function ProposalPlaceholder({ kind, missing }: { kind: 'review' | 'quorum'; missing: boolean }) {
  return (
    <div className={`card ${kind}`} data-testid={`card-${kind}`}>
      {missing ? (
        <span className="muted" data-testid="card-proposal-missing">
          The details of this proposal are older than the history this page has.
        </span>
      ) : (
        'Loading proposal…'
      )}
    </div>
  );
}

function ReviewCard({ proposalId }: { proposalId: string }) {
  const { state, you } = useRoom();
  const archivedRoom = useArchived();
  const cmd = useCommand();
  const { proposal: p, missing } = useProposal(proposalId);
  const reason = p ? collapseReason(p) : null;
  const collapse = useCollapse(reason);
  const closes = p?.windowClosesAt ? Date.parse(p.windowClosesAt) : null;
  const open = p?.state === 'open';
  const now = useNow(1000, open && closes !== null);
  if (!p) return <ProposalPlaceholder kind="review" missing={missing} />;
  if (reason && collapse.collapsed) {
    return (
      <CollapsedProposal kind="review" proposal={p} reason={reason} onExpand={collapse.toggle!} />
    );
  }
  const opt = p.options[0];
  const mine = p.votes.find((v) => v.userId === you.userId);
  const connected = new Set(state.presence.filter((x) => x.connected).map((x) => x.userId));
  const { counted: approvals, away } = tallyOption(p, opt?.id, connected);
  const rejections = p.votes.filter((v) => v.decision === 'reject').length;
  return (
    <div className={`card review state-${p.state}`} data-testid="card-review">
      <div className="card-title">
        Review: {p.title} <span className={`pill state-${p.state}`}>{p.state}</span>
        {p.stale && <span className="pill warn">stale</span>}
      </div>
      {reason && collapse.toggle && <CollapseNote reason={reason} onToggle={collapse.toggle} />}
      {opt && <OptionBody option={opt} />}
      <div className="muted small-text">
        {approvals} approve
        {away > 0 && ` (+${away} not connected)`}, {rejections} reject
        {open && closes !== null && (
          <>
            {' '}
            · window closes in{' '}
            <span data-testid="review-countdown">{formatCountdown(closes - now)}</span>
          </>
        )}
      </div>
      <div className="card-actions">
        {opt && <ProposalDiffButton proposal={p} option={opt} />}
        <button
          type="button"
          className={`btn small${mine?.decision === 'approve' ? ' selected' : ''}`}
          data-testid="review-approve"
          aria-pressed={mine?.decision === 'approve'}
          disabled={!open || archivedRoom}
          onClick={() =>
            cmd.run({
              type: 'vote.cast',
              proposalId: p.id,
              decision: 'approve',
              optionId: opt?.id,
            })
          }
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn small danger${mine?.decision === 'reject' ? ' selected' : ''}`}
          data-testid="review-reject"
          aria-pressed={mine?.decision === 'reject'}
          disabled={!open || archivedRoom}
          onClick={() => cmd.run({ type: 'vote.cast', proposalId: p.id, decision: 'reject' })}
        >
          Reject
        </button>
      </div>
      <CommandMessage error={cmd.error} />
    </div>
  );
}

function OptionBody({ option }: { option: ProposalOption }) {
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

export function ProposalDiffButton({
  proposal,
  option,
  label = 'View diff',
}: {
  proposal: Proposal;
  option: ProposalOption;
  label?: string;
}) {
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
  const { state, you } = useRoom();
  const archivedRoom = useArchived();
  const cmd = useCommand();
  const { proposal: p, missing } = useProposal(proposalId);
  const reason = p ? collapseReason(p) : null;
  const collapse = useCollapse(reason);
  if (!p) return <ProposalPlaceholder kind="quorum" missing={missing} />;
  if (reason && collapse.collapsed) {
    return (
      <CollapsedProposal kind="quorum" proposal={p} reason={reason} onExpand={collapse.toggle!} />
    );
  }
  const open = p.state === 'open';
  const mine = p.votes.find((v) => v.userId === you.userId);
  const connected = new Set(state.presence.filter((x) => x.connected).map((x) => x.userId));
  return (
    <div className={`card quorum state-${p.state}`} data-testid="card-quorum">
      <div className="card-title">
        {p.title} <span className={`pill state-${p.state}`}>{p.state}</span>
        {p.stale && <span className="pill warn">stale</span>}
      </div>
      {reason && collapse.toggle && <CollapseNote reason={reason} onToggle={collapse.toggle} />}
      <div className="muted small-text">
        Rule: {state.room?.votingRule ?? '?'} · {connected.size} connected
      </div>
      <ol className="options">
        {p.options.map((o) => {
          const { counted: tally, away } = tallyOption(p, o.id, connected);
          const chosen = mine?.decision === 'approve' && mine.optionId === o.id;
          const merged = p.mergedOptionId === o.id;
          return (
            <li
              key={o.id}
              className={`option${chosen ? ' chosen' : ''}${merged ? ' merged' : ''}`}
              data-testid={`option-${o.id}`}
            >
              <div className="option-head">
                <strong>Option {o.label}</strong>
                <span className="pill" data-testid={`tally-${o.id}`}>
                  {tally} {tally === 1 ? 'vote' : 'votes'}
                </span>
                {away > 0 && (
                  <span
                    className="muted small-text tally-away"
                    data-testid={`tally-away-${o.id}`}
                    title="Votes from people who are not connected do not count toward the rule"
                  >
                    +{away} not connected
                  </span>
                )}
                {merged && <span className="pill ok">merged</span>}
              </div>
              <OptionBody option={o} />
              <div className="card-actions">
                <ProposalDiffButton proposal={p} option={o} />
                <button
                  type="button"
                  className={`btn small${chosen ? ' selected' : ' primary'}`}
                  data-testid={`vote-${o.id}`}
                  aria-pressed={chosen}
                  disabled={!open || archivedRoom}
                  onClick={() =>
                    cmd.run({
                      type: 'vote.cast',
                      proposalId: p.id,
                      decision: 'approve',
                      optionId: o.id,
                    })
                  }
                >
                  {chosen ? 'Your vote' : `Vote ${o.label}`}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <CommandMessage error={cmd.error} />
    </div>
  );
}
