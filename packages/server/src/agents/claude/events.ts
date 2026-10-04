import type { Change, Intent, Message, Proposal, RoomState, Sha, UserId } from '@quorum/shared';
import { authorName } from '../common.js';

/** Everything the orchestrator hears about arrives as one of these, rendered as one user turn. */
export type OrchestratorEvent =
  | { type: 'intent'; intent: Intent; messages: Message[] }
  | { type: 'suggestion'; message: Message }
  | { type: 'ask'; message: Message }
  | { type: 'proposal_event'; event: ProposalEventInput }
  | { type: 'revert'; change: Change; revertSha: Sha; byUserId: UserId }
  | { type: 'expiry_check'; proposals: Proposal[]; now: string };

export type ProposalEventInput =
  | { type: 'merged'; proposal: Proposal; optionId: string; sha: Sha; reconciled: boolean }
  | { type: 'rejected'; proposal: Proposal; byUserId: UserId }
  | { type: 'expired' | 'superseded' | 'abandoned'; proposal: Proposal }
  | { type: 'merge_failed'; proposal: Proposal; reason: string };

export function compactMessage(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    from: authorName(m),
    at: m.createdAt,
    body: m.body,
  };
  if (m.author.kind === 'user') out.userId = m.author.userId;
  if (m.kind !== 'text') out.kind = m.kind;
  if (m.card) out.card = m.card.type;
  if (m.anchor) out.anchor = m.anchor;
  if (m.inReplyTo.length > 0) out.inReplyTo = m.inReplyTo;
  return out;
}

export function compactProposal(p: Proposal): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    kind: p.kind,
    state: p.state,
    documentId: p.documentId,
    stale: p.stale,
    reconciled: p.reconciled,
    branchBase: p.branchBase,
    openedAt: p.openedAt,
    windowClosesAt: p.windowClosesAt,
    mergedOptionId: p.mergedOptionId,
    mergeSha: p.mergeSha,
    options: p.options.map((o) => ({ id: o.id, label: o.label, branch: o.branch, summary: o.summary })),
    votes: p.votes.map((v) => ({ userId: v.userId, decision: v.decision, optionId: v.optionId, castAt: v.castAt })),
  };
}

export function compactState(s: RoomState, recent = 20): Record<string, unknown> {
  return {
    room: { id: s.room.id, name: s.room.name, ownerId: s.room.ownerId, votingRule: s.room.votingRule },
    participants: s.participants.map((p) => ({ userId: p.userId, displayName: p.displayName, role: p.role })),
    presence: s.presence.map((p) => ({ userId: p.userId, connected: p.connected, lastSeenAt: p.lastSeenAt })),
    documents: s.documents.map((d) => ({ id: d.id, path: d.path, title: d.title, status: d.status, headSha: d.headSha })),
    proposals: s.proposals.map(compactProposal),
    agentStatus: s.agentStatus,
    recentMessages: s.recentMessages.slice(-recent).map(compactMessage),
  };
}

/** Short label for "other events in flight" lists. */
export function eventLabel(e: OrchestratorEvent): string {
  switch (e.type) {
    case 'intent':
      return `intent:${e.intent.type} ${e.intent.summary}`.slice(0, 120);
    case 'suggestion':
      return `suggestion ${e.message.id}`;
    case 'ask':
      return `ask ${e.message.id}`;
    case 'proposal_event':
      return `proposal ${e.event.type} ${e.event.proposal.id}`;
    case 'revert':
      return `revert ${e.change.sha}`;
    case 'expiry_check':
      return 'expiry_check';
  }
}

export function eventPayload(e: OrchestratorEvent): Record<string, unknown> {
  switch (e.type) {
    case 'intent':
      return {
        intent: e.intent,
        messages: e.messages.map(compactMessage),
      };
    case 'suggestion': {
      const card = e.message.card;
      return {
        messageId: e.message.id,
        author: compactMessage(e.message).from,
        authorUserId: e.message.author.kind === 'user' ? e.message.author.userId : null,
        anchor: card?.type === 'suggestion' ? card.anchor : e.message.anchor,
        replacement: card?.type === 'suggestion' ? card.replacement : null,
        cardStatus: card?.type === 'suggestion' ? card.status : null,
        note: e.message.body,
      };
    }
    case 'ask': {
      const card = e.message.card;
      return {
        messageId: e.message.id,
        author: compactMessage(e.message).from,
        anchor: card?.type === 'ask' ? card.anchor : e.message.anchor,
        question: card?.type === 'ask' ? card.question : e.message.body,
      };
    }
    case 'proposal_event': {
      const ev = e.event;
      const base: Record<string, unknown> = { event: ev.type, proposal: compactProposal(ev.proposal) };
      if (ev.type === 'merged') Object.assign(base, { optionId: ev.optionId, sha: ev.sha, reconciled: ev.reconciled });
      if (ev.type === 'rejected') base.byUserId = ev.byUserId;
      if (ev.type === 'merge_failed') base.reason = ev.reason;
      return base;
    }
    case 'revert':
      return {
        change: {
          sha: e.change.sha,
          documentId: e.change.documentId,
          summary: e.change.summary,
          actor: e.change.actor,
          triggerMessageIds: e.change.triggerMessageIds,
        },
        revertSha: e.revertSha,
        byUserId: e.byUserId,
      };
    case 'expiry_check':
      return { now: e.now, openProposals: e.proposals.map(compactProposal) };
  }
}

/** The user turn the orchestrator sees: `[event:<type>]` header plus a JSON payload. */
export function formatEvent(e: OrchestratorEvent, otherInFlight: string[] = []): string {
  const payload: Record<string, unknown> = { ...eventPayload(e) };
  if (otherInFlight.length > 0) payload.otherEventsInFlight = otherInFlight;
  return `[event:${e.type}]\n${JSON.stringify(payload, null, 2)}`;
}

export function formatRehydrate(preamble: string, state: RoomState, messages: Message[]): string {
  return `[event:rehydrate]\n${preamble}\n${JSON.stringify({ state: { ...compactState(state, 0) }, lastMessages: messages.map(compactMessage) }, null, 2)}`;
}
