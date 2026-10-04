import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor, Message, Proposal, ServerEvent } from '@quorum/shared';
import { textHash } from '@quorum/shared';
import { RoomService } from './RoomService.js';
import { RoomError } from './types.js';
import { FakeGit, FakeRepository, MemoryStorage, StubRuntime } from './testing/index.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

async function setup(
  tunables: ConstructorParameters<typeof RoomService>[0]['tunables'] = {},
  extra: Partial<ConstructorParameters<typeof RoomService>[0]> = {},
) {
  const clock = { t: T0 };
  const storage = new MemoryStorage(() => new Date(clock.t));
  const git = new FakeGit();
  const runtime = new StubRuntime();
  const logs: string[] = [];
  const service = new RoomService({
    storage,
    git,
    tunables,
    logger: (_l, msg) => logs.push(msg),
    now: () => new Date(clock.t),
    ...extra,
  });
  service.setRuntime(runtime);
  const alice = storage.users.create('Alice');
  const bob = storage.users.create('Bob');
  const carol = storage.users.create('Carol');
  const room = await service.createRoom(alice.id, 'Test room');
  const repo = git.repos.get(room.id) as FakeRepository;
  const doc = await service.createDocument(room.id, alice.id, 'Plan');

  const clients = new Map<string, { events: ServerEvent[]; disconnect: () => void }>();
  const connect = async (user: { id: string }) => {
    const events: ServerEvent[] = [];
    const disconnect = await service.connect(room.id, user.id, (e) => events.push(e));
    clients.set(user.id, { events, disconnect });
    return { events, disconnect };
  };
  const mkBranch = (name: string, content: string, extra: Record<string, string> = {}) =>
    repo.commitOnBranch(name, { 'Plan.md': content, ...extra });
  const open = (kind: 'review' | 'quorum', branches: string[]) =>
    service.openProposal(room.id, {
      documentId: doc.id,
      kind,
      title: 'Pick storage',
      branchBase: repo.refs.get('main')!,
      options: branches.map((b, i) => ({
        label: String.fromCharCode(65 + i),
        branch: b,
        summary: `s${i}`,
        tradeoffs: `t${i}`,
      })),
      triggerMessageIds: [],
    });
  const vote = (user: { id: string }, p: Proposal, i: number | 'reject') =>
    service.handle(
      room.id,
      user.id,
      i === 'reject'
        ? { type: 'vote.cast', proposalId: p.id, decision: 'reject' }
        : { type: 'vote.cast', proposalId: p.id, decision: 'approve', optionId: p.options[i]!.id },
    );
  const proposal = (id: string) => storage.proposals.get(id)!;
  return {
    storage,
    git,
    runtime,
    clock,
    service,
    alice,
    bob,
    carol,
    room,
    repo,
    doc,
    connect,
    mkBranch,
    open,
    vote,
    proposal,
    logs,
    clients,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('rooms and documents', () => {
  it('creates a room with an initialized repo, and a document committed to main', async () => {
    const h = await setup();
    expect(h.repo.initialized).toBe(true);
    const { events } = await h.connect(h.alice);
    expect(events[0]!.type).toBe('hello');
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    expect(h.doc.path).toBe('Plan.md');
    const head = h.repo.commits.get(h.repo.refs.get('main')!)!;
    expect(head.meta?.actor).toMatchObject({ kind: 'user', userId: h.alice.id });

    const created = await h.service.createDocument(h.room.id, h.alice.id, 'Notes');
    expect(events.some((e) => e.type === 'document.created' && e.document.id === created.id)).toBe(
      true,
    );
    const state = await h.service.getState(h.room.id, h.alice.id);
    expect(state.documents.map((d) => d.path)).toEqual(['Plan.md', 'Notes.md']);
    expect(
      state.recentMessages.some((m) => m.kind === 'system' && m.body.includes('Notes.md')),
    ).toBe(true);
    await expect(h.service.createDocument(h.room.id, h.alice.id, 'Notes')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('renames and archives documents through main', async () => {
    const h = await setup();
    await h.service.handle(h.room.id, h.alice.id, {
      type: 'document.rename',
      documentId: h.doc.id,
      title: 'Roadmap',
    });
    expect(await h.repo.readFile('Roadmap.md')).toBe('# Plan\n');
    expect(await h.repo.readFile('Plan.md')).toBeNull();
    await h.service.handle(h.room.id, h.alice.id, {
      type: 'document.archive',
      documentId: h.doc.id,
    });
    expect(await h.repo.readFile('Roadmap.md')).toBeNull();
    expect(h.storage.documents.get(h.doc.id)!.status).toBe('archived');
  });

  it('only the owner can change the voting rule, and everyone connected hears about it', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    const b = await h.connect(h.bob);
    await expect(
      h.service.handle(h.room.id, h.bob.id, { type: 'room.setRule', votingRule: 'majority' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const updates = (events: ServerEvent[]) => events.filter((e) => e.type === 'room.updated');
    expect(updates(b.events)).toHaveLength(0);
    await h.service.handle(h.room.id, h.alice.id, { type: 'room.setRule', votingRule: 'majority' });
    expect(h.storage.rooms.get(h.room.id)!.votingRule).toBe('majority');
    for (const events of [a.events, b.events])
      expect(updates(events)).toEqual([
        {
          type: 'room.updated',
          room: expect.objectContaining({ id: h.room.id, votingRule: 'majority' }),
        },
      ]);
    // setting the rule it already has is not an event
    await h.service.handle(h.room.id, h.alice.id, { type: 'room.setRule', votingRule: 'majority' });
    expect(updates(b.events)).toHaveLength(1);
  });
});

describe('messages', () => {
  it('routes human chat to the runtime and persists it', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    await h.service.handle(h.room.id, h.alice.id, {
      type: 'chat.send',
      body: 'please add a section',
    });
    expect(h.runtime.chat).toHaveLength(1);
    expect(h.runtime.chat[0]!.author).toMatchObject({ kind: 'user', displayName: 'Alice' });
    expect(
      a.events.some((e) => e.type === 'chat.message' && e.message.body === 'please add a section'),
    ).toBe(true);
    await expect(
      h.service.handle(h.room.id, h.alice.id, { type: 'chat.send', body: '  ' }),
    ).rejects.toBeInstanceOf(RoomError);
  });

  it('creates suggestion and ask cards and notifies the runtime', async () => {
    const h = await setup();
    const anchor: Anchor = {
      documentId: h.doc.id,
      baseSha: 'x',
      startLine: 1,
      endLine: 1,
      textHash: textHash('# Plan'),
      text: '# Plan',
    };
    await h.service.handle(h.room.id, h.alice.id, {
      type: 'suggestion.create',
      anchor,
      replacement: '# Plan v2',
      note: 'rename',
    });
    await h.service.handle(h.room.id, h.alice.id, { type: 'ask.create', anchor, question: 'why?' });
    expect(h.runtime.suggestions[0]!.card).toMatchObject({
      type: 'suggestion',
      status: 'pending',
      replacement: '# Plan v2',
    });
    expect(h.runtime.asks[0]!.card).toMatchObject({ type: 'ask', question: 'why?' });
    expect(h.runtime.chat).toHaveLength(0);
  });

  it('delivers private messages only to their recipient and hides them from others', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    const b = await h.connect(h.bob);
    await h.service.sendPrivate(h.room.id, h.bob.id, { body: 'secret digest' });
    expect(
      b.events.some((e) => e.type === 'chat.message' && e.message.body === 'secret digest'),
    ).toBe(true);
    expect(
      a.events.some((e) => e.type === 'chat.message' && e.message.body === 'secret digest'),
    ).toBe(false);
    const forAlice = await h.service.getState(h.room.id, h.alice.id);
    expect(forAlice.recentMessages.some((m: Message) => m.body === 'secret digest')).toBe(false);
    const forBob = await h.service.getState(h.room.id, h.bob.id);
    expect(forBob.recentMessages.some((m: Message) => m.body === 'secret digest')).toBe(true);
  });

  it('survives a runtime that throws', async () => {
    const h = await setup();
    h.runtime.throwEverywhere = true;
    await h.connect(h.alice);
    await expect(
      h.service.handle(h.room.id, h.alice.id, { type: 'chat.send', body: 'hi' }),
    ).resolves.toBeUndefined();
    expect(h.logs.some((l) => l.includes('onChatMessage'))).toBe(true);
  });
});

describe('proposals', () => {
  it('validates single-document scope', async () => {
    const h = await setup();
    h.mkBranch('plan/two-files', 'x', { 'Other.md': 'y' });
    await expect(h.open('review', ['plan/two-files'])).rejects.toMatchObject({ code: 'invalid' });
    h.repo.refs.set('plan/nothing', h.repo.refs.get('main')!);
    await expect(h.open('review', ['plan/nothing'])).rejects.toMatchObject({ code: 'invalid' });
    h.mkBranch('plan/ok', 'ok');
    h.repo.commitOnBranch('plan/bad2', { 'Other.md': 'z' });
    await expect(h.open('quorum', ['plan/ok', 'plan/bad2'])).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(h.storage.proposals.list(h.room.id)).toHaveLength(0);
  });

  it('opens a card and broadcasts proposal.updated', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    expect(p.state).toBe('open');
    expect(p.windowClosesAt).toBe(new Date(T0 + 120_000).toISOString());
    const stored = h.proposal(p.id);
    expect(stored.cardMessageId).toBeTruthy();
    expect(h.storage.messages.get(stored.cardMessageId!)!.card).toEqual({
      type: 'review',
      proposalId: p.id,
    });
    expect(a.events.some((e) => e.type === 'proposal.updated' && e.proposal.id === p.id)).toBe(
      true,
    );
    await h.service.close();
  });

  it('unanimous: merges only when every connected participant approved, and presence changes re-evaluate', async () => {
    const h = await setup();
    await h.connect(h.alice);
    await h.connect(h.bob);
    const carol = await h.connect(h.carol);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('quorum', ['plan/a', 'plan/b']);
    await h.vote(h.alice, p, 0);
    await h.vote(h.bob, p, 1);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    await h.vote(h.bob, p, 0); // changed vote
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open'); // carol has not voted
    carol.disconnect(); // departure completes the vote
    await h.service.idle();
    const merged = h.proposal(p.id);
    expect(merged.state).toBe('merged');
    expect(merged.mergedOptionId).toBe(p.options[0]!.id);
    expect(await h.repo.readFile('Plan.md')).toBe('A');
    expect(h.repo.tags.has('milestone/1')).toBe(true);
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({ type: 'merged', reconciled: false });
    expect(h.storage.changes.get(merged.mergeSha!)).toMatchObject({
      proposalId: p.id,
      actor: { kind: 'agent', role: 'merge' },
    });
    await expect(h.vote(h.alice, p, 1)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('majority: merges when one option has more than half of connected participants', async () => {
    const h = await setup();
    await h.service.handle(h.room.id, h.alice.id, { type: 'room.setRule', votingRule: 'majority' });
    await h.connect(h.alice);
    await h.connect(h.bob);
    await h.connect(h.carol);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('quorum', ['plan/a', 'plan/b']);
    await h.vote(h.alice, p, 1);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    await h.vote(h.bob, p, 1);
    await h.service.idle();
    expect(h.proposal(p.id)).toMatchObject({ state: 'merged', mergedOptionId: p.options[1]!.id });
  });

  it('validates votes', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const q = await h.open('quorum', ['plan/a', 'plan/b']);
    await expect(
      h.service.handle(h.room.id, h.alice.id, {
        type: 'vote.cast',
        proposalId: q.id,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      h.service.handle(h.room.id, h.alice.id, {
        type: 'vote.cast',
        proposalId: q.id,
        decision: 'approve',
        optionId: 'opt_nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      h.service.handle(h.room.id, h.alice.id, {
        type: 'vote.cast',
        proposalId: 'prop_nope',
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('review: a rejection archives the proposal', async () => {
    const h = await setup();
    await h.connect(h.alice);
    await h.connect(h.bob);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.vote(h.bob, p, 'reject');
    expect(h.proposal(p.id)).toMatchObject({ state: 'rejected' });
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({ type: 'rejected', byUserId: h.bob.id });
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    await h.service.close();
  });

  it('review: the first approval from a connected participant merges it; nobody else has to agree (PRD §4.4)', async () => {
    const h = await setup();
    await h.connect(h.alice);
    await h.connect(h.bob);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.vote(h.alice, p, 0); // the rule is unanimous, and Bob has not voted
    await h.service.idle();
    expect(h.proposal(p.id)).toMatchObject({ state: 'merged', mergedOptionId: p.options[0]!.id });
    expect(await h.repo.readFile('Plan.md')).toBe('A');
    await h.service.close();
  });

  it('review: an approval from someone who is not connected does not count; the window ending with no rejection passes; timers are cleared on close', async () => {
    vi.useFakeTimers();
    const h = await setup({ reviewWindowMs: 60_000 });
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.service.castVote(h.room.id, h.bob.id, p.id, 'approve'); // Bob is not in the room
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    h.clock.t += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('merged');
    expect(await h.repo.readFile('Plan.md')).toBe('A');

    h.mkBranch('plan/b', 'B');
    const p2 = await h.open('review', ['plan/b']);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await h.service.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.proposal(p2.id).state).toBe('open');
  });

  it('merge pipeline: non-fast-forward goes through the merge driver and records reconciliation', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    // main moves after the branch point
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', {
        actor: { kind: 'agent', role: 'orchestrator' },
        triggerMessageIds: [],
      }),
    );
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.runtime.mergeDriverCalls).toHaveLength(1);
    const merged = h.proposal(p.id);
    expect(merged).toMatchObject({ state: 'merged', reconciled: true });
    expect(await h.repo.readFile('Plan.md')).toBe('A');
    expect(await h.repo.readFile('Side.md')).toBe('side');
    const msgs = h.storage.messages.list(h.room.id, { limit: 100 });
    expect(msgs.some((m) => m.card?.type === 'merge' && m.card.reconciled)).toBe(true);
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({ type: 'merged', reconciled: true });
  });

  it('merge failure restores open state, aborts the worktree and reports merge_failed', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', {
        actor: { kind: 'agent', role: 'orchestrator' },
        triggerMessageIds: [],
      }),
    );
    h.runtime.mergeDriver = async () => {
      throw new Error('cannot reconcile');
    };
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    expect(h.repo.aborted).toHaveLength(1);
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({
      type: 'merge_failed',
      reason: 'cannot reconcile',
    });
    expect(
      a.events.some(
        (e) =>
          e.type === 'chat.message' &&
          e.message.kind === 'system' &&
          e.message.body.includes('failed'),
      ),
    ).toBe(true);
    await h.service.close();
  });

  it('requestMerge merges only what the vote has passed (review F14)', async () => {
    const h = await setup();
    await h.connect(h.alice);
    await h.connect(h.bob);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const q = await h.open('quorum', ['plan/a', 'plan/b']);
    await expect(h.service.requestMerge(h.room.id, q.id, q.options[1]!.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await h.vote(h.alice, q, 1); // one of two connected: not unanimous
    await expect(h.service.requestMerge(h.room.id, q.id, q.options[1]!.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(h.service.requestMerge(h.room.id, q.id, 'opt_nope')).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(h.proposal(q.id).state).toBe('open');
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');

    h.mkBranch('plan/c', 'C');
    const r = await h.open('review', ['plan/c']);
    await expect(h.service.requestMerge(h.room.id, r.id, r.options[0]!.id)).rejects.toThrow(
      /objection window is still open/,
    );
    await h.service.close();
  });

  it('requestMerge retries a merge that failed, which presence changes will not (review F8)', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('quorum', ['plan/a', 'plan/b']);
    // main moves after the branch point, so the merge needs the driver, which cannot do it right now
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', {
        actor: { kind: 'agent', role: 'orchestrator' },
        triggerMessageIds: [],
      }),
    );
    h.runtime.mergeDriver = async () => {
      throw new Error('not confident');
    };
    await h.vote(h.alice, p, 1);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    expect(h.runtime.mergeDriverCalls).toHaveLength(1);

    h.runtime.mergeDriver = async () => ({ reconciled: true, summary: 'ok' });
    await expect(h.service.requestMerge(h.room.id, p.id, p.options[0]!.id)).rejects.toMatchObject({
      code: 'conflict',
    }); // Alice approved B, not A
    await h.service.requestMerge(h.room.id, p.id, p.options[1]!.id);
    expect(h.proposal(p.id)).toMatchObject({ state: 'merged', mergedOptionId: p.options[1]!.id });
    expect(h.runtime.mergeDriverCalls).toHaveLength(2);
  });

  it('closeProposal archives and notifies the runtime', async () => {
    const h = await setup();
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    const closed = await h.service.closeProposal(h.room.id, p.id, 'expired', 'moved on');
    expect(closed.state).toBe('expired');
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({ type: 'expired' });
    await h.service.close();
  });
});

describe('changes and revert', () => {
  async function withChange() {
    const h = await setup();
    const a = await h.connect(h.alice);
    const sha = await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Plan.md': '# Plan\nmore\n' }, 'add more', {
        actor: { kind: 'agent', role: 'orchestrator' },
        triggerMessageIds: [],
      }),
    );
    const change = await h.service.recordChange(h.room.id, {
      sha,
      documentId: h.doc.id,
      actor: { kind: 'agent', role: 'orchestrator' },
      summary: 'Added more',
      triggerMessageIds: [],
      proposalId: null,
      revertsSha: null,
    });
    return { h, a, sha, change };
  }

  it('recordChange persists, posts a Change card and broadcasts document.updated', async () => {
    const { h, a, sha } = await withChange();
    expect(a.events.some((e) => e.type === 'document.updated' && e.headSha === sha)).toBe(true);
    expect(
      a.events.some((e) => e.type === 'chat.message' && e.message.card?.type === 'change'),
    ).toBe(true);
    expect(h.storage.changes.get(sha)).toBeTruthy();
  });

  it('reverts mechanically through the lock', async () => {
    const { h, a, sha } = await withChange();
    await h.service
      .handle(h.room.id, h.bob.id, { type: 'revert.request', sha })
      .catch((e) => expect(e.code).toBe('forbidden'));
    await h.service.handle(h.room.id, h.alice.id, { type: 'revert.request', sha });
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    const orig = h.storage.changes.get(sha)!;
    expect(orig.revertedBySha).toBeTruthy();
    expect(h.storage.changes.get(orig.revertedBySha!)).toMatchObject({ revertsSha: sha });
    expect(h.runtime.reverted).toHaveLength(1);
    expect(
      a.events.some((e) => e.type === 'document.updated' && e.headSha === orig.revertedBySha),
    ).toBe(true);
    await expect(
      h.service.handle(h.room.id, h.alice.id, { type: 'revert.request', sha }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('flags the Change card as reverted, live and in storage', async () => {
    const { h, a, sha } = await withChange();
    const cardOf = (m: Message) => (m.card?.type === 'change' ? m.card.change : null);
    expect(
      h.storage.messages
        .list(h.room.id, { limit: 50 })
        .map(cardOf)
        .find((c) => c?.sha === sha)?.revertedBySha,
    ).toBeNull();
    await h.service.handle(h.room.id, h.alice.id, { type: 'revert.request', sha });
    const revertSha = h.storage.changes.get(sha)!.revertedBySha;
    expect(revertSha).toBeTruthy();
    const updates = a.events.filter(
      (e): e is Extract<ServerEvent, { type: 'chat.updated' }> => e.type === 'chat.updated',
    );
    expect(updates.map((e) => cardOf(e.message))).toEqual([
      expect.objectContaining({ sha, revertedBySha: revertSha }),
    ]);
    const stored = h.storage.messages.list(h.room.id, { limit: 50 }).map(cardOf);
    expect(stored.find((c) => c?.sha === sha)?.revertedBySha).toBe(revertSha);
    // the revert itself shows as a new, separate Change card
    expect(stored.find((c) => c?.sha === revertSha)).toMatchObject({
      revertsSha: sha,
      revertedBySha: null,
    });
  });

  it('falls back to the semantic revert when git revert conflicts', async () => {
    const { h, sha } = await withChange();
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Plan.md': '# Plan\nmore\nlater\n' }, 'later', {
        actor: { kind: 'agent', role: 'orchestrator' },
        triggerMessageIds: [],
      }),
    );
    h.runtime.semanticRevert = async () =>
      h.repo.withMainLock(() =>
        h.repo.commitToMain({ 'Plan.md': '# Plan\nlater\n' }, 'semantic revert', {
          actor: { kind: 'agent', role: 'merge' },
          triggerMessageIds: [],
        }),
      );
    await h.service.handle(h.room.id, h.alice.id, { type: 'revert.request', sha });
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\nlater\n');
    expect(h.storage.changes.get(sha)!.revertedBySha).toBeTruthy();
    expect(h.runtime.reverted).toHaveLength(1);
  });
});

describe('presence and digest', () => {
  it('broadcasts presence and spawns a digest after a long absence with notable events', async () => {
    const h = await setup({ digestAbsenceMs: 120_000 });
    const a = await h.connect(h.alice);
    const b = await h.connect(h.bob);
    expect(
      a.events.some(
        (e) =>
          e.type === 'presence.update' && e.presence.find((p) => p.userId === h.bob.id)?.connected,
      ),
    ).toBe(true);
    b.disconnect();
    expect(a.events.filter((e) => e.type === 'presence.update').at(-1)).toMatchObject({
      presence: expect.arrayContaining([
        expect.objectContaining({ userId: h.bob.id, connected: false }),
      ]),
    });

    // short absence, with an event: no digest
    h.clock.t += 30_000;
    await h.service.createDocument(h.room.id, h.alice.id, 'Short');
    h.clock.t += 1_000;
    const b2 = await h.connect(h.bob);
    await h.service.idle();
    expect(h.runtime.digests).toHaveLength(0);
    b2.disconnect();

    // long absence without events: no digest
    h.clock.t += 5 * 60_000;
    const b3 = await h.connect(h.bob);
    await h.service.idle();
    expect(h.runtime.digests).toHaveLength(0);
    b3.disconnect();

    // long absence with an event: digest, private to bob
    h.clock.t += 60_000;
    await h.service.createDocument(h.room.id, h.alice.id, 'Notes');
    h.clock.t += 3 * 60_000;
    const b4 = await h.connect(h.bob);
    await h.service.idle();
    expect(h.runtime.digests).toHaveLength(1);
    expect(h.runtime.digests[0]!.events.join('\n')).toContain('Notes');
    expect(
      b4.events.some(
        (e) =>
          e.type === 'chat.message' &&
          e.message.card?.type === 'digest' &&
          e.message.privateTo === h.bob.id,
      ),
    ).toBe(true);
    expect(
      a.events.some((e) => e.type === 'chat.message' && e.message.card?.type === 'digest'),
    ).toBe(false);
  });
});

const orchestrator = { kind: 'agent', role: 'orchestrator' } as const;
const asOrchestrator = { actor: orchestrator, triggerMessageIds: [] };

describe('scope and the fork point (review F6)', () => {
  it('works out the fork point itself: a base later than the real one cannot hide another file', async () => {
    const h = await setup();
    const c1 = h.repo.commitOnBranch('plan/s', {
      'Plan.md': 'v1',
      'Secret.md': 'another document',
    });
    h.repo.commitOnBranch('plan/s', { 'Plan.md': 'v2' });
    await expect(
      h.service.openProposal(h.room.id, {
        documentId: h.doc.id,
        kind: 'review',
        title: 'S',
        branchBase: c1, // a later commit of the branch: the diff base..branch is only Plan.md
        options: [{ label: 'A', branch: 'plan/s', summary: '', tradeoffs: '' }],
        triggerMessageIds: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Secret.md') });
    expect(h.storage.proposals.list(h.room.id)).toHaveLength(0);
  });

  it('stores the real fork point as the proposal base, whatever the caller named', async () => {
    const h = await setup();
    const fork = h.repo.refs.get('main')!;
    h.mkBranch('plan/a', 'A');
    const p = await h.service.openProposal(h.room.id, {
      documentId: h.doc.id,
      kind: 'review',
      title: 'A',
      branchBase: 'not-a-commit',
      options: [{ label: 'A', branch: 'plan/a', summary: '', tradeoffs: '' }],
      triggerMessageIds: [],
    });
    expect(p.branchBase).toBe(fork);
    expect(p.options[0]!.headSha).toBe(h.repo.refs.get('plan/a'));
    await h.service.close();
  });

  it('rejects a branch that does not exist, and a document that was archived', async () => {
    const h = await setup();
    await expect(h.open('review', ['plan/missing'])).rejects.toMatchObject({ code: 'invalid' });
    h.mkBranch('plan/a', 'A');
    await h.service.archiveDocument(h.room.id, h.alice.id, h.doc.id);
    await expect(h.open('review', ['plan/a'])).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('archived'),
    });
  });

  it('merges only the head that was voted on: a branch that moved afterwards fails the merge and stays open', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    h.repo.commitOnBranch('plan/a', { 'Plan.md': 'changed after the proposal' });
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    expect(h.logs).toContain('merge failed');
    const failure = h.storage.messages
      .list(h.room.id, { limit: 50 })
      .find((m) => m.kind === 'system' && m.body.includes('failed'));
    expect(failure?.body).toMatch(/changed after it was proposed/);
    await h.service.close();
  });

  it('checks the scope again at merge time', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    // the head was never recorded (a legacy row), so only the scope check can notice the new file
    h.storage.proposals.updateOption({ ...p.options[0]!, headSha: null });
    h.repo.commitOnBranch('plan/a', { 'Other.md': 'sneaked in' });
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    expect(await h.repo.listFiles()).toEqual(['Plan.md']);
    await h.service.close();
  });

  it('a branch whose commits are already in main is refused when opened and cannot merge again', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const first = await h.open('review', ['plan/a']);
    const second = await h.open('review', ['plan/a']); // both opened while the branch was still new
    await h.vote(h.alice, first, 0);
    await h.service.idle();
    expect(h.proposal(first.id).state).toBe('merged');
    expect(h.proposal(second.id).state).toBe('open'); // not merged: its branch is already in main
    await expect(h.open('review', ['plan/a'])).rejects.toMatchObject({ code: 'invalid' });
    await h.service
      .requestMerge(h.room.id, second.id, second.options[0]!.id)
      .catch(() => undefined);
    expect(h.proposal(second.id).state).toBe('open');
    expect(await h.repo.readFile('Plan.md')).toBe('A');
    await h.service.close();
  });

  it('hands the merge driver the document and finishes with the document as the only allowed path', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', asOrchestrator),
    );
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('merged');
    expect(h.repo.finishMergePaths).toEqual([['Plan.md']]);
  });
});

describe('a merge that failed (review F8)', () => {
  it('is not tried again whenever someone comes or goes, only after the votes change', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('quorum', ['plan/a']);
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', asOrchestrator),
    );
    h.runtime.mergeDriver = async () => {
      throw new Error('not confident');
    };
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    const failures = () =>
      h.storage.messages.list(h.room.id, { limit: 200 }).filter((m) => m.body.includes('failed'))
        .length;
    expect([h.runtime.mergeDriverCalls.length, failures()]).toEqual([1, 1]);

    // Bob joins and leaves three times: each departure makes Alice's approval unanimous again
    for (let i = 0; i < 3; i++) {
      const bob = await h.connect(h.bob);
      await h.service.idle();
      bob.disconnect();
      await h.service.idle();
    }
    expect([h.runtime.mergeDriverCalls.length, failures()]).toEqual([1, 1]);
    expect(h.proposal(p.id).state).toBe('open');

    // a vote is a new attempt: Alice confirms her approval, and this time the driver can do it
    h.runtime.mergeDriver = async () => ({ reconciled: true, summary: 'reconciled' });
    h.clock.t += 1_000;
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('merged');
    expect(h.runtime.mergeDriverCalls).toHaveLength(2);
  });

  it('a Review whose window already ended is not retried on every join and leave either', async () => {
    const h = await setup({ reviewWindowMs: 1 });
    h.mkBranch('plan/a', 'A');
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', asOrchestrator),
    );
    h.runtime.mergeDriver = async () => {
      throw new Error('no login');
    };
    const p = await h.open('review', ['plan/a']);
    h.clock.t += 10;
    await h.service.castVote(h.room.id, h.alice.id, p.id, 'approve').catch(() => undefined);
    for (let i = 0; i < 3; i++) {
      const a = await h.connect(h.alice);
      await h.service.idle();
      a.disconnect();
      await h.service.idle();
    }
    expect(h.runtime.mergeDriverCalls.length).toBeLessThanOrEqual(2); // the window's own attempt, and maybe Alice's vote
    const calls = h.runtime.mergeDriverCalls.length;
    for (let i = 0; i < 3; i++) {
      const a = await h.connect(h.alice);
      await h.service.idle();
      a.disconnect();
      await h.service.idle();
    }
    expect(h.runtime.mergeDriverCalls).toHaveLength(calls);
    await h.service.close();
  });
});

describe('merges that main has not moved past (review F1)', () => {
  it('merge without the driver: a merge commit tagged with the proposal, the voted text exactly, not reconciled', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    const merged = h.proposal(p.id);
    expect(merged).toMatchObject({ state: 'merged', reconciled: false });
    expect(h.runtime.mergeDriverCalls).toHaveLength(0);
    const commit = h.repo.commits.get(merged.mergeSha!)!;
    expect(commit.mergeParent).toBe(h.repo.refs.get('plan/a')); // a real merge, so Revert takes the whole proposal
    expect(commit.meta?.proposalId).toBe(p.id);
    expect(h.repo.finishMergePaths).toEqual([['Plan.md']]);
  });
});

describe('proposals stranded in merging (review F4)', () => {
  /** a second service on the same storage and repository: what a restart looks like */
  const restart = (h: Awaited<ReturnType<typeof setup>>) => {
    const s2 = new RoomService({
      storage: h.storage,
      git: h.git,
      logger: (_l, msg) => h.logs.push(msg),
      now: () => new Date(h.clock.t),
    });
    s2.setRuntime(h.runtime);
    return s2;
  };

  it('finishes a proposal whose merge reached main before the restart', async () => {
    const h = await setup();
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('quorum', ['plan/a', 'plan/b']);
    // the merge landed on main (merge commit with the proposal in its trailers), then the process died
    const out = await h.repo.withMainLock(() => h.repo.beginMerge('plan/b'));
    const sha = await h.repo.withMainLock(() =>
      h.repo.finishMerge(out.worktreePath!, 'Merge option B', {
        actor: { kind: 'agent', role: 'merge' },
        triggerMessageIds: [],
        proposalId: p.id,
      }),
    );
    h.storage.proposals.setState(p.id, 'merging');
    await h.service.close();

    const s2 = restart(h);
    await s2.start();
    expect(h.proposal(p.id)).toMatchObject({
      state: 'merged',
      mergeSha: sha,
      mergedOptionId: p.options[1]!.id,
      reconciled: false,
    });
    expect(h.storage.changes.get(sha)).toMatchObject({ proposalId: p.id });
    expect(h.repo.tags.get('milestone/1')).toBe(sha);
    expect(
      h.storage.messages.list(h.room.id, { limit: 50 }).some((m) => m.card?.type === 'merge'),
    ).toBe(true);
    expect(h.runtime.proposalEvents.at(-1)).toMatchObject({ type: 'merged', sha });
    // starting again changes nothing
    await restart(h).start();
    expect(h.storage.changes.list(h.room.id, {}).filter((c) => c.sha === sha)).toHaveLength(1);
    await s2.close();
  });

  it('reopens a proposal whose merge never reached main, and says so', async () => {
    const h = await setup();
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    h.storage.proposals.setState(p.id, 'merging');
    await h.service.close();

    const s2 = restart(h);
    await s2.start();
    expect(h.proposal(p.id).state).toBe('open');
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    expect(
      h.storage.messages
        .list(h.room.id, { limit: 50 })
        .some((m) => m.kind === 'system' && m.body.includes('interrupted')),
    ).toBe(true);
    // it can be voted on and closed again, and it blocks nothing
    await s2.closeProposal(h.room.id, p.id, 'expired');
    await s2.archiveDocument(h.room.id, h.alice.id, h.doc.id);
    await s2.close();
  });

  it('a reopened proposal whose vote still passes merges again at once', async () => {
    const h = await setup({ reviewWindowMs: 1 });
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    h.storage.proposals.setState(p.id, 'merging');
    await h.service.close();
    h.clock.t += 5_000; // the objection window ended while the server was down
    const s2 = restart(h);
    await s2.start();
    await s2.idle();
    expect(h.proposal(p.id).state).toBe('merged');
    await s2.close();
  });

  it('bookkeeping that fails after the merge reached main completes through recovery instead of reopening it', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    const insert = h.storage.changes.insert;
    let failures = 1;
    h.storage.changes.insert = (c) => {
      if (failures-- > 0) throw new Error('database is locked');
      insert(c);
    };
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.logs).toContain('recording a merge failed; completing it through recovery');
    const merged = h.proposal(p.id);
    expect(merged.state).toBe('merged');
    expect(await h.repo.readFile('Plan.md')).toBe('A');
    expect(h.storage.changes.get(merged.mergeSha!)).toBeTruthy();
    await h.service.close();
  });

  it('a merge in flight gets time to finish when the server is told to stop; nothing new starts', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('review', ['plan/a']);
    const slow = await h.open('quorum', ['plan/b']);
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Side.md': 'side' }, 'side', asOrchestrator),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.runtime.mergeDriver = async () => {
      await gate;
      return { reconciled: true, summary: 'done' };
    };
    await h.vote(h.alice, p, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.proposal(p.id).state).toBe('merging');

    expect(await h.service.drain(30)).toBe(false); // still running when the time is up
    await h.vote(h.alice, slow, 0); // a vote that would pass is recorded but starts no merge while stopping
    expect(h.proposal(slow.id).state).toBe('open');
    release();
    expect(await h.service.drain(2_000)).toBe(true);
    expect(h.proposal(p.id).state).toBe('merged');
    await h.service.close();
  });
});

describe('structure changes are atomic (review F9)', () => {
  it.each([['create first'], ['rename first']])(
    'create(Spec) and rename(Plan -> Spec) at once leave git and the database agreeing (%s)',
    async (order) => {
      const h = await setup();
      const create = () => h.service.createDocument(h.room.id, h.alice.id, 'Spec');
      const rename = () => h.service.renameDocument(h.room.id, h.alice.id, h.doc.id, 'Spec');
      const results = await Promise.allSettled(
        order === 'create first' ? [create(), rename()] : [rename(), create()],
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(RoomError);
      expect(failed.reason).toMatchObject({ code: 'conflict' });
      const docs = h.storage.documents.list(h.room.id).map((d) => d.path);
      expect(docs).toHaveLength(new Set(docs).size);
      expect((await h.repo.listFiles()).sort()).toEqual([...docs].sort());
    },
  );

  it('a proposal cannot be opened on a document while it is being renamed, nor renamed under a proposal', async () => {
    for (const order of ['open first', 'rename first']) {
      const h = await setup();
      h.mkBranch('plan/a', 'A');
      const open = () => h.open('review', ['plan/a']);
      const rename = () => h.service.renameDocument(h.room.id, h.alice.id, h.doc.id, 'Spec');
      const [a, b] = await Promise.allSettled(
        order === 'open first' ? [open(), rename()] : [rename(), open()],
      );
      const [opened, renamed] = order === 'open first' ? [a!, b!] : [b!, a!];
      expect(opened.status === 'fulfilled' && renamed.status === 'fulfilled', order).toBe(false);
      expect(opened.status === 'rejected' && renamed.status === 'rejected', order).toBe(false);
      const live = h.storage.proposals.list(h.room.id, { states: ['open'] });
      const doc = h.storage.documents.get(h.doc.id)!;
      // never an open proposal for a document under another name than the branch changes
      expect(live.length === 0 || doc.path === 'Plan.md', order).toBe(true);
      await h.service.close();
    }
  });

  it('never makes a path that could pass for a command-line option (review F11)', async () => {
    const h = await setup();
    for (const [title, path] of [
      ['--plugin=evil', 'plugin=evil.md'],
      ['-l', 'l.md'],
      ['- - x', 'x.md'],
      ['.hidden', 'hidden.md'],
    ] as const) {
      const d = await h.service.createDocument(h.room.id, h.alice.id, title);
      expect(d.path, title).toBe(path);
    }
    await expect(h.service.createDocument(h.room.id, h.alice.id, '---')).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('connections (review F10)', () => {
  it('a connect that fails after registering the connection leaves nobody connected', async () => {
    const h = await setup();
    let fail = true;
    const flaky = {
      open: async (id: string) => {
        if (fail) {
          fail = false;
          throw new Error('disk full');
        }
        return h.git.open(id);
      },
    };
    const s2 = new RoomService({ storage: h.storage, git: flaky });
    s2.setRuntime(h.runtime);
    await expect(s2.connect(h.room.id, h.bob.id, () => undefined)).rejects.toThrow('disk full');
    const state = await s2.getState(h.room.id);
    expect(state.presence.find((p) => p.userId === h.bob.id)?.connected).toBe(false);
    expect(
      h.storage.rooms.listPresence(h.room.id).find((p) => p.userId === h.bob.id)?.connected,
    ).toBe(false);
    await s2.close();
  });

  it('a ghost does not block a unanimous vote', async () => {
    const h = await setup();
    let fail = true;
    const flaky = {
      open: async (id: string) => {
        if (fail) {
          fail = false;
          throw new Error('disk full');
        }
        return h.git.open(id);
      },
    };
    const s2 = new RoomService({ storage: h.storage, git: flaky, now: () => new Date(h.clock.t) });
    s2.setRuntime(h.runtime);
    await expect(s2.connect(h.room.id, h.bob.id, () => undefined)).rejects.toThrow('disk full');
    await s2.connect(h.room.id, h.alice.id, () => undefined);
    h.mkBranch('plan/a', 'A');
    const p = await s2.openProposal(h.room.id, {
      documentId: h.doc.id,
      kind: 'quorum',
      title: 'T',
      branchBase: h.repo.refs.get('main')!,
      options: [{ label: 'A', branch: 'plan/a', summary: '', tradeoffs: '' }],
      triggerMessageIds: [],
    });
    // Bob never got in. With a ghost he would count as connected, and Alice alone would not be unanimous.
    await s2.castVote(h.room.id, h.alice.id, p.id, 'approve', p.options[0]!.id);
    await s2.idle();
    expect(h.proposal(p.id).state).toBe('merged');
    await s2.close();
  });
});

describe('simultaneous reverts (review F15)', () => {
  it('the second request is refused as already reverted, not as an internal error, and no semantic revert starts', async () => {
    const h = await setup();
    await h.connect(h.alice);
    const sha = await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Plan.md': '# Plan\nmore\n' }, 'more', asOrchestrator),
    );
    await h.service.recordChange(h.room.id, {
      sha,
      documentId: h.doc.id,
      actor: orchestrator,
      summary: 'more',
      triggerMessageIds: [],
      proposalId: null,
      revertsSha: null,
    });
    let semantic = 0;
    h.runtime.semanticRevert = async () => {
      semantic++;
      throw new Error('semantic revert invoked');
    };
    const results = await Promise.allSettled([
      h.service.revertChange(h.room.id, h.alice.id, sha),
      h.service.revertChange(h.room.id, h.bob.id, sha),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({
      code: 'conflict',
      message: 'change was already reverted',
    });
    expect(semantic).toBe(0);
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
  });

  it('a revert that failed can be asked for again', async () => {
    const h = await setup();
    const sha = await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Plan.md': '# Plan\nmore\n' }, 'more', asOrchestrator),
    );
    await h.service.recordChange(h.room.id, {
      sha,
      documentId: h.doc.id,
      actor: orchestrator,
      summary: 'more',
      triggerMessageIds: [],
      proposalId: null,
      revertsSha: null,
    });
    await h.repo.withMainLock(() =>
      h.repo.commitToMain({ 'Plan.md': '# Plan\nmore\nlater\n' }, 'later', asOrchestrator),
    );
    await expect(h.service.revertChange(h.room.id, h.alice.id, sha)).rejects.toThrow(
      /semantic revert not configured/,
    ); // the revert conflicts with the later commit and there is no semantic fallback
    h.runtime.semanticRevert = async () =>
      h.repo.withMainLock(() =>
        h.repo.commitToMain({ 'Plan.md': '# Plan\nlater\n' }, 'semantic', asOrchestrator),
      );
    await h.service.revertChange(h.room.id, h.alice.id, sha);
    expect(h.storage.changes.get(sha)!.revertedBySha).toBeTruthy();
  });
});

describe('worktrees and sessions are not leaked (review F17)', () => {
  it('removes the option worktrees of a proposal once it is merged, rejected, expired or abandoned; branches stay', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const merged = await h.open('quorum', ['plan/a', 'plan/b']);
    await h.vote(h.alice, merged, 0);
    await h.service.idle();
    expect(h.proposal(merged.id).state).toBe('merged');
    expect(h.repo.removedWorktrees.sort()).toEqual(['plan/a', 'plan/b']);

    h.repo.removedWorktrees.length = 0;
    h.mkBranch('plan/c', 'C');
    const rejected = await h.open('review', ['plan/c']);
    await h.vote(h.alice, rejected, 'reject');
    h.mkBranch('plan/d', 'D');
    const expired = await h.open('review', ['plan/d']);
    await h.service.closeProposal(h.room.id, expired.id, 'expired');
    h.mkBranch('plan/e', 'E');
    const abandoned = await h.open('review', ['plan/e']);
    await h.service.closeProposal(h.room.id, abandoned.id, 'abandoned');
    await h.service.idle();
    expect(h.repo.removedWorktrees.sort()).toEqual(['plan/c', 'plan/d', 'plan/e']);
    expect(await h.repo.listBranches()).toEqual(
      expect.arrayContaining(['plan/a', 'plan/b', 'plan/c', 'plan/d', 'plan/e']),
    );
    await h.service.close();
  });

  it('keeps the proposal worktrees while it is open or its merge failed', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    h.repo.commitOnBranch('plan/a', { 'Plan.md': 'moved' }); // the merge will be refused
    await h.vote(h.alice, p, 0);
    await h.service.idle();
    expect(h.proposal(p.id).state).toBe('open');
    expect(h.repo.removedWorktrees).toEqual([]);
    await h.service.close();
  });

  it('stops the agent session of a room that stayed empty for the idle period, not before, not after someone came back', async () => {
    vi.useFakeTimers();
    const h = await setup({}, { idleStopMs: 10_000 });
    const a = await h.connect(h.alice);
    a.disconnect();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.runtime.stopped).toEqual([]);
    const again = await h.connect(h.bob); // someone came back in time
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.runtime.stopped).toEqual([]);
    again.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runtime.stopped).toEqual([h.room.id]);
    // and the next visitor starts it again
    const starts = h.runtime.started.length;
    await h.connect(h.alice);
    expect(h.runtime.started).toHaveLength(starts + 1);
    await h.service.close();
  });
});

describe('archived rooms (the room.archive command)', () => {
  it('only the owner archives; the room leaves the list, refuses connections and commands, and its agent is stopped', async () => {
    const h = await setup();
    const a = await h.connect(h.alice);
    const b = await h.connect(h.bob);
    await expect(
      h.service.handle(h.room.id, h.bob.id, { type: 'room.archive' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.service.listRooms().map((r) => r.id)).toEqual([h.room.id]);

    await h.service.handle(h.room.id, h.alice.id, { type: 'room.archive', cid: 'x' });
    expect(h.storage.rooms.get(h.room.id)!.archivedAt).not.toBeNull();
    for (const events of [a.events, b.events])
      expect(events.at(-1)).toMatchObject({
        type: 'room.updated',
        room: { id: h.room.id, archivedAt: expect.any(String) },
      });
    expect(h.service.listRooms()).toEqual([]);
    expect(h.service.listRooms({ includeArchived: true }).map((r) => r.id)).toEqual([h.room.id]);
    expect(h.runtime.stopped).toEqual([h.room.id]);

    await expect(h.connect(h.carol)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      h.service.handle(h.room.id, h.alice.id, { type: 'chat.send', body: 'anyone?' }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('archived') });
    expect(h.runtime.chat).toHaveLength(0);
    // archiving twice is a no-op, and history stays readable
    await h.service.handle(h.room.id, h.alice.id, { type: 'room.archive' });
    expect((await h.service.getState(h.room.id, h.alice.id)).room.archivedAt).not.toBeNull();
    await h.service.close();
  });

  it('does not merge in an archived room, and does not re-arm its windows after a restart', async () => {
    const h = await setup({ reviewWindowMs: 1 });
    h.mkBranch('plan/a', 'A');
    await h.open('review', ['plan/a']);
    await h.service.archiveRoom(h.room.id, h.alice.id);
    await h.service.close();
    h.clock.t += 60_000;
    const s2 = new RoomService({ storage: h.storage, git: h.git, now: () => new Date(h.clock.t) });
    s2.setRuntime(h.runtime);
    await s2.start();
    await s2.idle();
    expect(h.storage.proposals.list(h.room.id)[0]!.state).toBe('open');
    expect(await h.repo.readFile('Plan.md')).toBe('# Plan\n');
    await s2.close();
  });
});
