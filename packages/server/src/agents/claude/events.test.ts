import { describe, expect, it } from 'vitest';
import type { Intent, RoomState } from '@quorum/shared';
import { createStubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { makeChange, makeProposal } from '../testing/fixtures.js';
import {
  compactMessage,
  compactProposal,
  compactState,
  eventLabel,
  eventPayload,
  formatEvent,
  formatRehydrate,
  type OrchestratorEvent,
} from './events.js';

const stub = createStubActions({
  repo: new MemoryRepo(),
  documents: [{ path: 'Architecture.md', title: 'Architecture' }],
  participants: [
    { userId: 'user_alice', displayName: 'Alice' },
    { userId: 'user_bob', displayName: 'Bob' },
  ],
});

const alice = stub.human('user_alice', 'Alice', 'we should add a section on latency requirements');
const bob = stub.human('user_bob', 'Bob', 'agreed');
const anchor = {
  documentId: 'doc_1',
  baseSha: 'b'.repeat(40),
  startLine: 3,
  endLine: 3,
  textHash: 'deadbeefdeadbeef',
  text: 'Paragraph under discussion.',
};

/** Splits a formatted event into its header and parsed JSON payload. */
function parse(text: string): { header: string; payload: Record<string, any> } {
  const nl = text.indexOf('\n');
  return { header: text.slice(0, nl), payload: JSON.parse(text.slice(nl + 1)) };
}

const intent: Intent = {
  type: 'edit_request',
  confidence: 0.92,
  documents: ['Architecture.md'],
  summary: 'add a latency requirements section',
  messageIds: [alice.id],
  positions: [],
  needsResearch: false,
};

describe('formatEvent', () => {
  it('renders an intent as [event:intent] plus a JSON payload with the referenced messages', () => {
    const { header, payload } = parse(formatEvent({ type: 'intent', intent, messages: [alice] }));
    expect(header).toBe('[event:intent]');
    expect(payload.intent).toEqual(intent);
    expect(payload.messages).toEqual([
      { id: alice.id, from: 'Alice', at: alice.createdAt, body: alice.body, userId: 'user_alice' },
    ]);
    expect(payload.otherEventsInFlight).toBeUndefined();
    expect(payload.openProposals).toBeUndefined();
  });

  it('lists the open proposals on an intent so expiry can be judged on every listener cycle', () => {
    const open = makeProposal({
      votes: [
        {
          proposalId: 'prop_1',
          userId: 'user_alice',
          optionId: 'opt_a',
          decision: 'approve',
          castAt: '2026-10-04T10:05:00.000Z',
        },
      ],
    });
    const { payload } = parse(
      formatEvent({ type: 'intent', intent, messages: [alice], openProposals: [open] }),
    );
    expect(payload.openProposals).toHaveLength(1);
    expect(payload.openProposals[0]).toMatchObject({
      id: 'prop_1',
      state: 'open',
      kind: 'quorum',
      votes: [{ userId: 'user_alice', decision: 'approve', optionId: 'opt_a' }],
    });
    // an empty list adds nothing
    expect(
      parse(formatEvent({ type: 'intent', intent, messages: [alice], openProposals: [] })).payload
        .openProposals,
    ).toBeUndefined();
  });

  it('tells the orchestrator what else is in flight', () => {
    const { payload } = parse(
      formatEvent({ type: 'ask', message: bob }, [
        'intent:edit_request add a section',
        'suggestion msg_9',
      ]),
    );
    expect(payload.otherEventsInFlight).toEqual([
      'intent:edit_request add a section',
      'suggestion msg_9',
    ]);
  });

  it('renders a suggestion with its anchor, replacement and card status', () => {
    const suggestion = stub.human('user_bob', 'Bob', 'tighten this', {
      kind: 'card',
      anchor,
      card: {
        type: 'suggestion',
        anchor,
        replacement: 'Tighter paragraph.',
        status: 'pending',
        resolutionSha: null,
        note: null,
      },
    });
    const { header, payload } = parse(formatEvent({ type: 'suggestion', message: suggestion }));
    expect(header).toBe('[event:suggestion]');
    expect(payload).toMatchObject({
      messageId: suggestion.id,
      author: 'Bob',
      authorUserId: 'user_bob',
      anchor,
      replacement: 'Tighter paragraph.',
      cardStatus: 'pending',
      note: 'tighten this',
    });
  });

  it('renders an ask with the question and its anchor', () => {
    const ask = stub.human('user_bob', 'Bob', 'why 200 ms?', {
      kind: 'card',
      anchor,
      card: { type: 'ask', anchor, question: 'why 200 ms?' },
    });
    const { header, payload } = parse(formatEvent({ type: 'ask', message: ask }));
    expect(header).toBe('[event:ask]');
    expect(payload).toMatchObject({
      messageId: ask.id,
      author: 'Bob',
      anchor,
      question: 'why 200 ms?',
    });
  });

  it('falls back to the message anchor and body for cards without a payload', () => {
    const plain = stub.human('user_bob', 'Bob', 'what is this?', { anchor });
    expect(parse(formatEvent({ type: 'ask', message: plain })).payload).toMatchObject({
      anchor,
      question: 'what is this?',
    });
    expect(parse(formatEvent({ type: 'suggestion', message: plain })).payload).toMatchObject({
      anchor,
      replacement: null,
      cardStatus: null,
    });
  });

  it.each([
    [
      'merged',
      {
        type: 'merged',
        proposal: makeProposal(),
        optionId: 'opt_a',
        sha: 'd'.repeat(40),
        reconciled: true,
      },
      { optionId: 'opt_a', sha: 'd'.repeat(40), reconciled: true },
    ],
    [
      'rejected',
      { type: 'rejected', proposal: makeProposal(), byUserId: 'user_bob' },
      { byUserId: 'user_bob' },
    ],
    [
      'merge_failed',
      { type: 'merge_failed', proposal: makeProposal(), reason: 'driver timed out' },
      { reason: 'driver timed out' },
    ],
    ['expired', { type: 'expired', proposal: makeProposal() }, {}],
    ['superseded', { type: 'superseded', proposal: makeProposal() }, {}],
    ['abandoned', { type: 'abandoned', proposal: makeProposal() }, {}],
  ] as const)('renders a %s proposal event', (kind, event, extra) => {
    const { header, payload } = parse(
      formatEvent({ type: 'proposal_event', event } as OrchestratorEvent),
    );
    expect(header).toBe('[event:proposal_event]');
    expect(payload.event).toBe(kind);
    expect(payload.proposal).toMatchObject({
      id: 'prop_1',
      title: 'PostgreSQL vs ClickHouse',
      options: [
        { id: 'opt_a', label: 'A' },
        { id: 'opt_b', label: 'B' },
      ],
    });
    expect(payload).toMatchObject(extra);
  });

  it('renders a revert with the change that was undone', () => {
    const change = makeChange({ summary: 'Added latency', triggerMessageIds: ['msg_1', 'msg_2'] });
    const { header, payload } = parse(
      formatEvent({ type: 'revert', change, revertSha: 'e'.repeat(40), byUserId: 'user_bob' }),
    );
    expect(header).toBe('[event:revert]');
    expect(payload).toMatchObject({
      revertSha: 'e'.repeat(40),
      byUserId: 'user_bob',
      change: {
        sha: change.sha,
        summary: 'Added latency',
        triggerMessageIds: ['msg_1', 'msg_2'],
        documentId: 'doc_1',
      },
    });
  });

  it('renders an expiry check with the open proposals and the time', () => {
    const { header, payload } = parse(
      formatEvent({
        type: 'expiry_check',
        proposals: [makeProposal()],
        now: '2026-10-04T10:10:00.000Z',
      }),
    );
    expect(header).toBe('[event:expiry_check]');
    expect(payload.now).toBe('2026-10-04T10:10:00.000Z');
    expect(payload.openProposals[0]).toMatchObject({
      id: 'prop_1',
      openedAt: '2026-10-04T10:00:00.000Z',
    });
  });

  it('labels events briefly for the in-flight list', () => {
    expect(eventLabel({ type: 'intent', intent, messages: [] })).toBe(
      'intent:edit_request add a latency requirements section',
    );
    expect(
      eventLabel({ type: 'intent', intent: { ...intent, summary: 'x'.repeat(300) }, messages: [] })
        .length,
    ).toBe(120);
    expect(eventLabel({ type: 'suggestion', message: alice })).toBe(`suggestion ${alice.id}`);
    expect(eventLabel({ type: 'ask', message: alice })).toBe(`ask ${alice.id}`);
    expect(
      eventLabel({ type: 'proposal_event', event: { type: 'expired', proposal: makeProposal() } }),
    ).toBe('proposal expired prop_1');
    expect(
      eventLabel({ type: 'revert', change: makeChange(), revertSha: 'x', byUserId: 'u' }),
    ).toBe(`revert ${'c'.repeat(40)}`);
    expect(eventLabel({ type: 'expiry_check', proposals: [], now: '' })).toBe('expiry_check');
  });

  it('is deterministic JSON for the same event', () => {
    const e: OrchestratorEvent = { type: 'ask', message: bob };
    expect(formatEvent(e)).toBe(formatEvent(e));
    expect(eventPayload(e)).toEqual(eventPayload(e));
  });
});

describe('compact views', () => {
  it('compactMessage keeps what the orchestrator needs and omits the rest', () => {
    expect(compactMessage(alice)).toEqual({
      id: alice.id,
      from: 'Alice',
      userId: 'user_alice',
      at: alice.createdAt,
      body: alice.body,
    });

    const reply = stub.human('user_bob', 'Bob', 'see this', {
      kind: 'card',
      anchor,
      card: { type: 'ask', anchor, question: 'q' },
      inReplyTo: [alice.id],
    });
    expect(compactMessage(reply)).toMatchObject({
      kind: 'card',
      card: 'ask',
      anchor,
      inReplyTo: [alice.id],
    });

    const agent = { ...alice, author: { kind: 'agent', role: 'orchestrator' } } as typeof alice;
    const out = compactMessage(agent);
    expect(out.from).toBe('agent:orchestrator');
    expect(out.userId).toBeUndefined();
  });

  it('compactProposal carries votes, options and flags', () => {
    const p = makeProposal({
      stale: true,
      state: 'merged',
      mergedOptionId: 'opt_b',
      mergeSha: 'f'.repeat(40),
    });
    expect(compactProposal(p)).toMatchObject({
      id: 'prop_1',
      stale: true,
      state: 'merged',
      mergedOptionId: 'opt_b',
      mergeSha: 'f'.repeat(40),
      reconciled: false,
    });
    expect((compactProposal(p).options as unknown[]).length).toBe(2);
  });

  it('compactState trims recent messages to the requested count', async () => {
    const s = await stub.actions.getRoomState(stub.roomId);
    const compact = compactState(s, 1) as {
      recentMessages: unknown[];
      participants: unknown[];
      documents: Array<{ path: string }>;
      room: { votingRule: string };
    };
    expect(compact.recentMessages).toHaveLength(1);
    expect(compact.participants).toHaveLength(2);
    expect(compact.documents[0]!.path).toBe('Architecture.md');
    expect(compact.room.votingRule).toBe('unanimous');
    expect((compactState(s, 0) as { recentMessages: unknown[] }).recentMessages).toEqual([]);
  });

  it('formatRehydrate carries the preamble, a state snapshot and the last messages', async () => {
    const s: RoomState = await stub.actions.getRoomState(stub.roomId);
    const text = formatRehydrate('You are resuming.', s, [alice, bob]);
    expect(text.startsWith('[event:rehydrate]\nYou are resuming.\n')).toBe(true);
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    expect(payload.state.participants).toHaveLength(2);
    expect(payload.state.recentMessages).toEqual([]); // messages are listed separately, not twice
    expect(payload.lastMessages.map((m: { id: string }) => m.id)).toEqual([alice.id, bob.id]);
  });
});
