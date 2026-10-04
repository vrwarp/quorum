import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor, Message, Proposal, ServerEvent } from '@quorum/shared';
import { textHash } from '@quorum/shared';
import { RoomService } from './RoomService.js';
import { RoomError } from './types.js';
import { FakeGit, FakeRepository, MemoryStorage, StubRuntime } from './testing/index.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

async function setup(tunables: ConstructorParameters<typeof RoomService>[0]['tunables'] = {}) {
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

  it('review: window elapse with no rejection passes; clock timers are cleared on close', async () => {
    vi.useFakeTimers();
    const h = await setup({ reviewWindowMs: 60_000 });
    await h.connect(h.alice);
    await h.connect(h.bob);
    h.mkBranch('plan/a', 'A');
    const p = await h.open('review', ['plan/a']);
    await h.vote(h.alice, p, 0); // unanimous needs bob too
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

  it('requestMerge runs the pipeline for an open proposal', async () => {
    const h = await setup();
    await h.connect(h.alice);
    h.mkBranch('plan/a', 'A');
    h.mkBranch('plan/b', 'B');
    const p = await h.open('quorum', ['plan/a', 'plan/b']);
    await h.service.requestMerge(h.room.id, p.id, p.options[1]!.id);
    expect(h.proposal(p.id)).toMatchObject({ state: 'merged', mergedOptionId: p.options[1]!.id });
    expect(await h.repo.readFile('Plan.md')).toBe('B');
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
