import { describe, expect, it } from 'vitest';
import type { Message, Proposal, RoomState, ServerEvent } from '@quorum/shared';
import {
  OFFLINE_MESSAGE,
  applyEvent,
  initialState,
  mergeSnapshotMessages,
  reducer,
  type RoomStoreState,
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
