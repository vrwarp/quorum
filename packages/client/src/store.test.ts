import { describe, expect, it } from 'vitest';
import type { Message, Proposal, RoomState, ServerEvent } from '@quorum/shared';
import {
  BACKFILL_PAGE,
  OFFLINE_MESSAGE,
  applyEvent,
  backfillTranscript,
  findGap,
  initialState,
  mergeSnapshotMessages,
  reducer,
  type RoomStoreState,
  type TranscriptGap,
} from './store';

/** The store against the event shapes the server really sends (see packages/server/src/room/RoomService.ts). */

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const you = { userId: 'user_bob', displayName: 'Bob' };

function msg(id: string, n: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    roomId: 'room_1',
    author: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
    kind: 'text',
    body: id,
    card: null,
    anchor: null,
    privateTo: null,
    inReplyTo: [],
    createdAt: T(n),
    ...extra,
  };
}

function digest(id: string, n: number): Message {
  return msg(id, n, {
    author: { kind: 'agent', role: 'digest' },
    kind: 'card',
    card: { type: 'digest', sinceMessageId: null },
    privateTo: you.userId,
  });
}

function snapshot(over: Partial<RoomState> = {}): RoomState {
  return {
    room: {
      id: 'room_1',
      name: 'Room',
      ownerId: 'user_alice',
      votingRule: 'unanimous',
      createdAt: T(0),
      archivedAt: null,
    },
    participants: [
      { roomId: 'room_1', userId: 'user_alice', displayName: 'Alice', role: 'owner' },
      { roomId: 'room_1', userId: 'user_bob', displayName: 'Bob', role: 'member' },
    ],
    presence: [
      { userId: 'user_alice', displayName: 'Alice', connected: true, lastSeenAt: T(1) },
      { userId: 'user_bob', displayName: 'Bob', connected: true, lastSeenAt: T(1) },
    ],
    documents: [
      {
        id: 'doc_1',
        roomId: 'room_1',
        path: 'Plan.md',
        title: 'Plan',
        status: 'active',
        createdAt: T(1),
        headSha: 'aaa',
      },
    ],
    proposals: [],
    recentMessages: [msg('m1', 1), msg('m2', 2)],
    agentStatus: 'idle',
    agentDetail: null,
    ...over,
  };
}

const hello = (over: Partial<RoomState> = {}): ServerEvent => ({
  type: 'hello',
  state: snapshot(over),
  you,
});
const run = (events: ServerEvent[], from: RoomStoreState = initialState) =>
  events.reduce(applyEvent, from);

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop_1',
    roomId: 'room_1',
    documentId: 'doc_1',
    kind: 'quorum',
    state: 'open',
    title: 'A vs B',
    branchBase: 'aaa',
    options: [
      {
        id: 'opt_a',
        proposalId: 'prop_1',
        label: 'A',
        branch: 'plan/a-vs-b/a',
        summary: '',
        tradeoffs: '',
        headSha: 'bbb',
      },
      {
        id: 'opt_b',
        proposalId: 'prop_1',
        label: 'B',
        branch: 'plan/a-vs-b/b',
        summary: '',
        tradeoffs: '',
        headSha: 'ccc',
      },
    ],
    votes: [],
    windowClosesAt: null,
    stale: false,
    reconciled: false,
    mergedOptionId: null,
    mergeSha: null,
    triggerMessageIds: [],
    cardMessageId: null,
    openedAt: T(3),
    closedAt: null,
    createdAt: T(3),
    ...over,
  };
}

describe('hello', () => {
  it('loads the room snapshot', () => {
    const s = run([hello()]);
    expect(s).toMatchObject({ loaded: true, you, agentStatus: 'idle' });
    expect(s.room?.name).toBe('Room');
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(s.documents.map((d) => d.path)).toEqual(['Plan.md']);
  });

  it('keeps a private digest that arrived before hello, in order', () => {
    const early = digest('d1', 5);
    const s = run([
      { type: 'chat.message', message: early },
      hello({ recentMessages: [msg('m1', 1), msg('m2', 6)] }),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'd1', 'm2']);
    expect(s.messages.find((m) => m.id === 'd1')?.privateTo).toBe(you.userId);
  });

  it('keeps a message that raced ahead of the snapshot', () => {
    const s = run([{ type: 'chat.message', message: msg('late', 9) }, hello()]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'late']);
  });

  it('does not duplicate a digest the snapshot already contains', () => {
    const d = digest('d1', 5);
    const s = run([
      { type: 'chat.message', message: d },
      hello({ recentMessages: [msg('m1', 1), d] }),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'd1']);
  });

  it('on reconnect, the new snapshot wins but earlier loaded pages stay', () => {
    const first = run([hello({ recentMessages: [msg('m5', 5), msg('m6', 6)] })]);
    const withOlder = reducer(first, { type: 'prepend', messages: [msg('m3', 3), msg('m4', 4)] });
    expect(withOlder.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
    const updated5 = msg('m5', 5, { body: 'edited while away' });
    const again = applyEvent(withOlder, {
      type: 'hello',
      state: snapshot({ recentMessages: [updated5, msg('m6', 6), msg('m7', 7)] }),
      you,
    });
    expect(again.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(again.messages.find((m) => m.id === 'm5')?.body).toBe('edited while away');
  });

  it('mergeSnapshotMessages returns the snapshot itself when nothing else is held', () => {
    const snap = [msg('a', 1)];
    expect(mergeSnapshotMessages([], snap)).toBe(snap);
  });
});

describe('chat events', () => {
  it('appends new messages and a private digest after hello', () => {
    const s = run([
      hello(),
      { type: 'chat.message', message: msg('m3', 3) },
      { type: 'chat.message', message: digest('d1', 4) },
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'd1']);
  });

  it('chat.message with a known id replaces it instead of duplicating', () => {
    const s = run([hello(), { type: 'chat.message', message: msg('m2', 2, { body: 'again' }) }]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]!.body).toBe('again');
  });

  it('chat.updated resolves a suggestion card in place, without moving it', () => {
    const pending = msg('sug', 2, {
      kind: 'card',
      card: {
        type: 'suggestion',
        anchor: {
          documentId: 'doc_1',
          baseSha: 'aaa',
          startLine: 1,
          endLine: 1,
          textHash: 'h',
          text: 'x',
        },
        replacement: 'y',
        status: 'pending',
        resolutionSha: null,
        note: null,
      },
    });
    const applied = {
      ...pending,
      card: { ...pending.card!, status: 'applied', resolutionSha: 'abc' },
    } as Message;
    const s = run([
      hello({ recentMessages: [msg('m1', 1), pending, msg('m3', 3)] }),
      { type: 'chat.updated', message: applied },
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'sug', 'm3']);
    expect(s.messages[1]!.card).toMatchObject({ status: 'applied', resolutionSha: 'abc' });
  });

  it('chat.updated for a message that is not on screen is ignored, not appended', () => {
    const s = run([hello(), { type: 'chat.updated', message: msg('ancient', 0) }]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('documents', () => {
  it('document.created upserts: a rename keeps the id and replaces title and path', () => {
    const created = {
      id: 'doc_2',
      roomId: 'room_1',
      path: 'Notes.md',
      title: 'Notes',
      status: 'active' as const,
      createdAt: T(2),
      headSha: 'bbb',
    };
    let s = run([hello(), { type: 'document.created', document: created }]);
    expect(s.documents.map((d) => d.id)).toEqual(['doc_1', 'doc_2']);
    s = applyEvent(s, {
      type: 'document.created',
      document: { ...created, path: 'Journal.md', title: 'Journal', headSha: 'ccc' },
    });
    expect(s.documents.map((d) => [d.id, d.path, d.title, d.headSha])).toEqual([
      ['doc_1', 'Plan.md', 'Plan', 'aaa'],
      ['doc_2', 'Journal.md', 'Journal', 'ccc'],
    ]);
  });

  it('document.updated moves one document head; document.archived hides it from active use', () => {
    let s = run([hello(), { type: 'document.updated', documentId: 'doc_1', headSha: 'zzz' }]);
    expect(s.documents[0]!.headSha).toBe('zzz');
    s = applyEvent(s, { type: 'document.updated', documentId: 'doc_unknown', headSha: 'q' });
    expect(s.documents).toHaveLength(1);
    s = applyEvent(s, { type: 'document.archived', documentId: 'doc_1' });
    expect(s.documents[0]!.status).toBe('archived');
  });
});

describe('proposals, presence and status', () => {
  it('proposal.updated replaces the proposal as votes, merge and revert come in', () => {
    const open = proposal();
    const vote = {
      proposalId: 'prop_1',
      userId: 'user_alice',
      optionId: 'opt_a',
      decision: 'approve' as const,
      castAt: T(4),
    };
    let s = run([
      hello({ proposals: [open] }),
      { type: 'proposal.updated', proposal: proposal({ votes: [vote] }) },
    ]);
    expect(s.proposals).toHaveLength(1);
    expect(s.proposals[0]!.votes).toHaveLength(1);
    s = applyEvent(s, {
      type: 'proposal.updated',
      proposal: proposal({ votes: [vote, { ...vote, userId: 'user_bob' }], state: 'merging' }),
    });
    expect(s.proposals[0]).toMatchObject({ state: 'merging' });
    expect(s.proposals[0]!.votes).toHaveLength(2);
    s = applyEvent(s, {
      type: 'proposal.updated',
      proposal: proposal({ state: 'merged', mergedOptionId: 'opt_a', mergeSha: 'abc' }),
    });
    expect(s.proposals[0]).toMatchObject({ state: 'merged', mergeSha: 'abc' });
    s = applyEvent(s, { type: 'proposal.updated', proposal: proposal({ id: 'prop_2' }) });
    expect(s.proposals.map((p) => p.id)).toEqual(['prop_1', 'prop_2']);
  });

  it('presence.update replaces the list on connect and on disconnect', () => {
    const s = run([
      hello({
        presence: [
          { userId: 'user_alice', displayName: 'Alice', connected: true, lastSeenAt: T(1) },
        ],
      }),
      {
        type: 'presence.update',
        presence: [
          { userId: 'user_alice', displayName: 'Alice', connected: true, lastSeenAt: T(1) },
          { userId: 'user_bob', displayName: 'Bob', connected: true, lastSeenAt: T(2) },
        ],
      },
    ]);
    expect(s.presence.filter((p) => p.connected).map((p) => p.userId)).toEqual([
      'user_alice',
      'user_bob',
    ]);
    const gone = applyEvent(s, {
      type: 'presence.update',
      presence: s.presence.map((p) =>
        p.userId === 'user_bob' ? { ...p, connected: false, lastSeenAt: T(3) } : p,
      ),
    });
    expect(gone.presence.filter((p) => p.connected).map((p) => p.userId)).toEqual(['user_alice']);
  });

  it('room.updated carries a changed voting rule', () => {
    const base = snapshot().room;
    const s = run([hello(), { type: 'room.updated', room: { ...base, votingRule: 'majority' } }]);
    expect(s.room?.votingRule).toBe('majority');
    expect(s.room?.name).toBe('Room');
  });

  it('tracks the agent status and server errors', () => {
    let s = run([hello(), { type: 'agent.status', status: 'thinking', detail: 'reading' }]);
    expect(s).toMatchObject({ agentStatus: 'thinking', agentDetail: 'reading' });
    s = applyEvent(s, { type: 'agent.status', status: 'unavailable', detail: null });
    expect(s.agentStatus).toBe('unavailable');
    s = applyEvent(s, { type: 'error', code: 'conflict', message: 'change was already reverted' });
    expect(s.error).toBe('change was already reverted');
    expect(reducer(s, { type: 'dismissError' }).error).toBeNull();
  });

  it('tracks the connection flag and drops the offline notice once reconnected, but keeps real errors', () => {
    expect(reducer(initialState, { type: 'connected', connected: true }).connected).toBe(true);
    const offline = applyEvent(initialState, {
      type: 'error',
      code: 'offline',
      message: OFFLINE_MESSAGE,
    });
    expect(reducer(offline, { type: 'connected', connected: false }).error).toBe(OFFLINE_MESSAGE);
    expect(reducer(offline, { type: 'connected', connected: true }).error).toBeNull();
    const refused = applyEvent(initialState, {
      type: 'error',
      code: 'conflict',
      message: 'change was already reverted',
    });
    expect(reducer(refused, { type: 'connected', connected: true }).error).toBe(
      'change was already reverted',
    );
  });
});

describe('agent detail', () => {
  it('hello carries the reason the agent is unavailable', () => {
    const s = run([
      hello({ agentStatus: 'unavailable', agentDetail: 'Sign in to Claude in Settings' }),
    ]);
    expect(s).toMatchObject({
      agentStatus: 'unavailable',
      agentDetail: 'Sign in to Claude in Settings',
    });
  });

  it('agent.status replaces both, and a later hello replaces them again', () => {
    let s = run([
      hello(),
      {
        type: 'agent.status',
        status: 'unavailable',
        detail: 'The agent has reached its spending limit',
      },
    ]);
    expect(s.agentDetail).toBe('The agent has reached its spending limit');
    s = applyEvent(s, { type: 'agent.status', status: 'idle', detail: null });
    expect(s).toMatchObject({ agentStatus: 'idle', agentDetail: null });
    s = applyEvent(s, {
      type: 'hello',
      state: snapshot({
        agentStatus: 'unavailable',
        agentDetail: 'The Claude account has a billing problem',
      }),
      you,
    });
    expect(s.agentDetail).toBe('The Claude account has a billing problem');
  });
});

describe('unknown events', () => {
  it('are ignored: the state is returned as it was', () => {
    const before = run([hello()]);
    const after = applyEvent(before, {
      type: 'quorum.future.thing',
      x: 1,
    } as unknown as ServerEvent);
    expect(after).toBe(before);
    expect(reducer(before, { type: 'event', ev: { type: 'nope' } as unknown as ServerEvent })).toBe(
      before,
    );
  });
});

describe('transcript gaps after a reconnect', () => {
  const msgs = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => msg(`m${from + i}`, from + i));

  it('finds none on a first connection, with an overlapping snapshot, or when only private messages are held', () => {
    expect(findGap([], msgs(1, 5))).toBeNull();
    expect(findGap(msgs(1, 5), msgs(3, 8))).toBeNull();
    expect(findGap([digest('d1', 2)], msgs(5, 9))).toBeNull();
    expect(findGap(msgs(1, 5), [])).toBeNull();
    // a snapshot reaching back past everything held is not a gap even if the newest held message is gone from it
    expect(
      findGap(
        [msg('old', 5)],
        msgs(1, 9).filter((m) => m.id !== 'm5'),
      ),
    ).toBeNull();
  });

  it('finds the hole when the snapshot starts after the newest message held', () => {
    expect(findGap(msgs(1, 5), msgs(300, 320))).toEqual({
      afterId: 'm5',
      beforeId: 'm300',
      coverFrom: T(1),
    });
  });

  it('ignores private digests when deciding what was last seen', () => {
    const held = [...msgs(1, 5), digest('d1', 6)];
    expect(findGap(held, msgs(300, 301))?.afterId).toBe('m5');
  });

  it('hello records the gap; an overlapping hello clears it', () => {
    let s = run([hello({ recentMessages: msgs(1, 5) })]);
    expect(s.gap).toBeNull();
    s = applyEvent(s, {
      type: 'hello',
      state: snapshot({ recentMessages: msgs(300, 320) }),
      you,
    });
    expect(s.gap).toMatchObject({ afterId: 'm5', beforeId: 'm300' });
    // what was held stays until the missing messages arrive
    expect(s.messages.map((m) => m.id).slice(0, 5)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    s = applyEvent(s, {
      type: 'hello',
      state: snapshot({ recentMessages: msgs(300, 322) }),
      you,
    });
    expect(s.gap).toBeNull();
  });

  const gapState = () => {
    const held = run([hello({ recentMessages: msgs(1, 5) })]);
    return applyEvent(held, {
      type: 'hello',
      state: snapshot({ recentMessages: msgs(300, 302) }),
      you,
    });
  };

  it('backfill puts the fetched messages ahead of the snapshot, in the order the server gave them', () => {
    const s = gapState();
    const filled = reducer(s, {
      type: 'backfill',
      gap: s.gap!,
      messages: [...msgs(1, 5), ...msgs(6, 20), ...msgs(290, 299)],
    });
    expect(filled.gap).toBeNull();
    const ids = filled.messages.map((m) => m.id);
    expect(ids.slice(0, 7)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(ids.slice(-4)).toEqual(['m299', 'm300', 'm301', 'm302']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not reorder messages that share a timestamp (a burst sent in one millisecond)', () => {
    const same = (id: string, at: number) => msg(id, at, { createdAt: T(at) });
    const held = run([hello({ recentMessages: [same('a1', 1)] })]);
    const burst = Array.from({ length: 12 }, (_, i) => same(`b${i + 1}`, 50));
    const s = applyEvent(held, {
      type: 'hello',
      state: snapshot({ recentMessages: burst.slice(4) }), // the snapshot holds b5..b12
      you,
    });
    const filled = reducer(s, {
      type: 'backfill',
      gap: s.gap!,
      messages: [same('a1', 1), ...burst.slice(0, 4)],
    });
    expect(filled.messages.map((m) => m.id)).toEqual(['a1', ...burst.map((m) => m.id)]);
  });

  it('backfill refreshes cards already on screen', () => {
    const pending = msg('sug', 2, {
      kind: 'card',
      card: {
        type: 'suggestion',
        anchor: {
          documentId: 'doc_1',
          baseSha: 'a',
          startLine: 1,
          endLine: 1,
          textHash: 'h',
          text: 'x',
        },
        replacement: 'y',
        status: 'pending',
        resolutionSha: null,
        note: null,
      },
    });
    const held = run([hello({ recentMessages: [msg('m1', 1), pending] })]);
    const s = applyEvent(held, {
      type: 'hello',
      state: snapshot({ recentMessages: msgs(300, 301) }),
      you,
    });
    const applied = { ...pending, card: { ...pending.card!, status: 'applied' } } as Message;
    const filled = reducer(s, {
      type: 'backfill',
      gap: s.gap!,
      messages: [msg('m1', 1), applied],
    });
    expect(filled.messages.find((m) => m.id === 'sug')?.card).toMatchObject({ status: 'applied' });
  });

  it('drops held messages older than the fetched ones, so no hole is left for Load earlier to skip', () => {
    const s = gapState();
    const filled = reducer(s, { type: 'backfill', gap: s.gap!, messages: msgs(250, 299) });
    expect(filled.gap).toBeNull();
    expect(filled.messages[0]!.id).toBe('m250');
    expect(filled.messages.some((m) => m.id === 'm3')).toBe(false);
    // with nothing fetched at all, the held history goes the same way
    const none = reducer(s, { type: 'backfill', gap: s.gap!, messages: [] });
    expect(none.messages.map((m) => m.id)).toEqual(['m300', 'm301', 'm302']);
  });

  it('a private digest in the fetched range comes back in its place', () => {
    const held = run([hello({ recentMessages: [msg('m1', 1), digest('d1', 2)] })]);
    const s = applyEvent(held, {
      type: 'hello',
      state: snapshot({ recentMessages: msgs(300, 302) }),
      you,
    });
    const filled = reducer(s, {
      type: 'backfill',
      gap: s.gap!,
      messages: [msg('m1', 1), digest('d1', 2), msg('m3', 3)],
    });
    expect(filled.messages.map((m) => m.id)).toEqual(['m1', 'd1', 'm3', 'm300', 'm301', 'm302']);
  });

  it('ignores a fill for a gap a newer snapshot already replaced', () => {
    const s = gapState();
    const stale: TranscriptGap = { ...s.gap! };
    expect(reducer(s, { type: 'backfill', gap: stale, messages: msgs(6, 10) })).toBe(s);
  });
});

describe('backfillTranscript', () => {
  const T2 = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  /** a transcript of messages m1..mN, served the way GET /messages?before= does: the page before `before`, oldest first */
  const server = (n: number) => {
    const all = Array.from({ length: n }, (_, i) => msg(`m${i + 1}`, i + 1));
    const calls: Array<[string, number]> = [];
    const fetchPage = async (before: string, limit: number) => {
      calls.push([before, limit]);
      const end = all.findIndex((m) => m.id === before);
      return all.slice(Math.max(0, end - limit), end);
    };
    return { all, calls, fetchPage };
  };

  it('pages back from the snapshot until it has covered everything that was held', async () => {
    const { calls, fetchPage } = server(1000);
    const got = await backfillTranscript(fetchPage, {
      afterId: 'm300',
      beforeId: 'm900',
      coverFrom: T2(300),
    });
    // each page is the 200 messages before the oldest one fetched so far; it stops once m300 (the oldest held) is in
    expect(calls.map(([b]) => b)).toEqual(['m900', 'm700', 'm500']);
    expect(calls.every(([, limit]) => limit === BACKFILL_PAGE)).toBe(true);
    expect(got[0]!.id).toBe('m300');
    expect(got.at(-1)!.id).toBe('m899');
    expect(got).toHaveLength(600);
  });

  it('stops at the start of the transcript', async () => {
    const { fetchPage } = server(250);
    const got = await backfillTranscript(fetchPage, {
      afterId: 'm1',
      beforeId: 'm250',
      coverFrom: T2(0),
    });
    expect(got.map((m) => m.id).slice(0, 2)).toEqual(['m1', 'm2']);
    expect(got).toHaveLength(249);
  });

  it('stops at the page bound, and on an error keeps what it already has', async () => {
    const { fetchPage } = server(5000);
    const bounded = await backfillTranscript(
      fetchPage,
      { afterId: 'm1', beforeId: 'm5000', coverFrom: T2(0) },
      2,
    );
    expect(bounded).toHaveLength(2 * BACKFILL_PAGE);
    expect(bounded.at(-1)!.id).toBe('m4999');

    let n = 0;
    const flaky = async (before: string, limit: number) => {
      if (n++ === 1) throw new Error('offline');
      return fetchPage(before, limit);
    };
    const failed = await backfillTranscript(flaky, {
      afterId: 'm1',
      beforeId: 'm5000',
      coverFrom: T2(0),
    });
    expect(failed).toHaveLength(BACKFILL_PAGE);
    const nothing = await backfillTranscript(
      async () => {
        throw new Error('offline');
      },
      { afterId: 'm1', beforeId: 'm5000', coverFrom: T2(0) },
    );
    expect(nothing).toEqual([]);
  });
});

describe('proposals fetched on demand', () => {
  it('adds the ones the store lacks, never replacing one it has', () => {
    const have = proposal({ id: 'prop_1', title: 'fresh from an event' });
    const s = run([hello({ proposals: [have] })]);
    const next = reducer(s, {
      type: 'proposals',
      proposals: [proposal({ id: 'prop_1', title: 'older copy' }), proposal({ id: 'prop_2' })],
      requested: ['prop_2'],
    });
    expect(next.proposals.map((p) => [p.id, p.title])).toEqual([
      ['prop_1', 'fresh from an event'],
      ['prop_2', 'A vs B'],
    ]);
    expect(next.missingProposals).toEqual([]);
  });

  it('marks a requested proposal the fetch could not produce as missing, until the next snapshot', () => {
    const s = run([hello()]);
    const next = reducer(s, { type: 'proposals', proposals: [], requested: ['prop_9'] });
    expect(next.missingProposals).toEqual(['prop_9']);
    expect(next.proposals).toBe(s.proposals);
    expect(applyEvent(next, { type: 'hello', state: snapshot(), you }).missingProposals).toEqual(
      [],
    );
  });
});

describe('fatal socket failures', () => {
  const at = '2026-02-01T00:00:00.000Z';

  it('are recorded', () => {
    expect(reducer(initialState, { type: 'fatal', reason: 'not_found', at }).fatal).toBe(
      'not_found',
    );
    expect(reducer(initialState, { type: 'fatal', reason: 'unauthorized', at }).fatal).toBe(
      'unauthorized',
    );
  });

  it('a refusal because the room is archived makes a room this page knew about read-only', () => {
    const s = run([hello()]);
    expect(s.room?.archivedAt).toBeNull();
    const refused = reducer(s, { type: 'fatal', reason: 'archived', at });
    expect(refused.fatal).toBe('archived');
    expect(refused.room?.archivedAt).toBe(at);
    // a room that already knew keeps its own timestamp, and a page that never loaded has nothing to mark
    const known = applyEvent(s, {
      type: 'room.updated',
      room: { ...s.room!, archivedAt: '2026-01-15T00:00:00.000Z' },
    });
    expect(reducer(known, { type: 'fatal', reason: 'archived', at }).room?.archivedAt).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(reducer(initialState, { type: 'fatal', reason: 'archived', at }).room).toBeNull();
  });
});
