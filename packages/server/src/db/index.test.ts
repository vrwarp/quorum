import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Anchor, Change, Message, Proposal } from '@quorum/shared';
import { openStorage } from './index.js';
import { migrations } from './schema.js';
import { SESSION_TTL_MS, type Storage } from '../contracts/storage.js';

let s: Storage;
beforeEach(() => {
  s = openStorage(':memory:');
});
afterEach(() => s.close());

const anchor: Anchor = {
  documentId: 'doc_1',
  baseSha: 'abc',
  startLine: 1,
  endLine: 2,
  textHash: 'h',
  text: 'hello',
};

function msg(id: string, roomId: string, over: Partial<Message> = {}): Message {
  return {
    id,
    roomId,
    author: { kind: 'user', userId: 'user_1', displayName: 'Ann' },
    kind: 'text',
    body: `body ${id}`,
    card: null,
    anchor: null,
    privateTo: null,
    inReplyTo: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('users and sessions', () => {
  it('creates, gets and finds users', () => {
    const u = s.users.create('Ann');
    expect(u.id).toMatch(/^user_/);
    expect(s.users.get(u.id)).toEqual(u);
    expect(s.users.findByDisplayName('Ann')).toEqual(u);
    expect(s.users.findByDisplayName('Bob')).toBeNull();
    expect(s.users.get('nope')).toBeNull();
  });

  it('issues random 32-byte hex tokens, resolves and revokes', () => {
    const u = s.users.create('Ann');
    const a = s.sessions.create(u.id);
    const b = s.sessions.create(u.id);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(s.sessions.resolve(a.token)).toBe(u.id);
    s.sessions.revoke(a.token);
    expect(s.sessions.resolve(a.token)).toBeNull();
    expect(s.sessions.resolve(b.token)).toBe(u.id);
  });

  it('makes the first user ever created the admin, and nobody else', () => {
    const first = s.users.create('Ann');
    const second = s.users.create('Bob');
    expect(first.admin).toBe(true);
    expect(second.admin).toBe(false);
    expect(s.users.get(first.id)!.admin).toBe(true);
    expect(s.users.findByDisplayName('Bob')!.admin).toBe(false);
  });

  it('promotes the oldest user when it upgrades a database that predates the admin flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-db-'));
    try {
      const file = join(dir, 'old.sqlite');
      const { DatabaseSync } = createRequire(import.meta.url)(
        'node:sqlite',
      ) as typeof import('node:sqlite');
      const old = new DatabaseSync(file);
      old.exec(migrations[0]!);
      old.exec('PRAGMA user_version = 1');
      for (const [id, name] of [
        ['user_a', 'Ann'],
        ['user_b', 'Bob'],
      ])
        old
          .prepare('INSERT INTO users (id, displayName, createdAt) VALUES (?, ?, ?)')
          .run(id!, name!, '2026-01-01T00:00:00.000Z');
      old.close();
      const upgraded = openStorage(file);
      expect(upgraded.users.get('user_a')!.admin).toBe(true);
      expect(upgraded.users.get('user_b')!.admin).toBe(false);
      expect(upgraded.users.create('Cy').admin).toBe(false);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires a session 30 days after it was created, and forgets it', () => {
    const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
    const timed = openStorage(':memory:', { now: () => new Date(clock.now) });
    try {
      const u = timed.users.create('Ann');
      const a = timed.sessions.create(u.id);
      clock.now += 7 * 24 * 3600 * 1000;
      const b = timed.sessions.create(u.id);
      clock.now = Date.parse('2026-01-01T00:00:00.000Z') + SESSION_TTL_MS - 1;
      expect(timed.sessions.resolve(a.token)).toBe(u.id);
      clock.now += 1;
      expect(timed.sessions.resolve(a.token)).toBeNull(); // 30 days old
      expect(timed.sessions.resolve(b.token)).toBe(u.id); // a week younger
      clock.now -= 10 * 24 * 3600 * 1000; // even if the clock went back, the session is gone for good
      expect(timed.sessions.resolve(a.token)).toBeNull();
    } finally {
      timed.close();
    }
  });
});

describe('rooms, participants, presence', () => {
  it('creates rooms and updates rule / archive', () => {
    const u = s.users.create('Ann');
    const r = s.rooms.create({ name: 'R', ownerId: u.id });
    expect(r.votingRule).toBe('unanimous');
    expect(r.archivedAt).toBeNull();
    s.rooms.setVotingRule(r.id, 'unanimous');
    expect(s.rooms.get(r.id)!.votingRule).toBe('unanimous');
    const r2 = s.rooms.create({ name: 'R2', ownerId: u.id, votingRule: 'unanimous' });
    expect(s.rooms.list().map((x) => x.id)).toEqual([r.id, r2.id]);
    s.rooms.archive(r.id);
    expect(s.rooms.get(r.id)!.archivedAt).not.toBeNull();
    expect(s.rooms.get('missing')).toBeNull();
  });

  it('adds participants idempotently', () => {
    const u = s.users.create('Ann');
    const r = s.rooms.create({ name: 'R', ownerId: u.id });
    s.rooms.addParticipant({ roomId: r.id, userId: u.id, displayName: 'Ann', role: 'owner' });
    s.rooms.addParticipant({ roomId: r.id, userId: u.id, displayName: 'Ann', role: 'owner' });
    expect(s.rooms.listParticipants(r.id)).toEqual([
      { roomId: r.id, userId: u.id, displayName: 'Ann', role: 'owner' },
    ]);
  });

  it('persists presence', () => {
    const u = s.users.create('Ann');
    const r = s.rooms.create({ name: 'R', ownerId: u.id });
    s.rooms.addParticipant({ roomId: r.id, userId: u.id, displayName: 'Ann', role: 'owner' });
    expect(s.rooms.getLastSeen(r.id, u.id)).toBeNull();
    s.rooms.upsertPresence(r.id, u.id, true, '2026-01-01T00:00:00.000Z');
    s.rooms.upsertPresence(r.id, u.id, false, '2026-01-01T00:05:00.000Z');
    expect(s.rooms.getLastSeen(r.id, u.id)).toBe('2026-01-01T00:05:00.000Z');
    expect(s.rooms.listPresence(r.id)).toEqual([
      {
        userId: u.id,
        displayName: 'Ann',
        connected: false,
        lastSeenAt: '2026-01-01T00:05:00.000Z',
      },
    ]);
  });

  it('survives reopening a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-db-'));
    try {
      const file = join(dir, 'nested', 'quorum.sqlite');
      const a = openStorage(file);
      const u = a.users.create('Ann');
      a.close();
      const b = openStorage(file);
      expect(b.users.get(u.id)).toEqual(u);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('messages', () => {
  it('round-trips JSON columns and updates', () => {
    const m = msg('msg_1', 'room_1', {
      kind: 'card',
      card: { type: 'ask', anchor, question: 'why?' },
      anchor,
      inReplyTo: ['msg_0'],
      author: { kind: 'agent', role: 'orchestrator' },
    });
    s.messages.insert(m);
    expect(s.messages.get('msg_1')).toEqual(m);
    const updated: Message = {
      ...m,
      body: 'changed',
      card: { type: 'agent_status', status: 'idle', detail: null },
    };
    s.messages.update(updated);
    expect(s.messages.get('msg_1')).toEqual(updated);
    expect(s.messages.get('nope')).toBeNull();
    const summarized: Message = { ...updated, summary: 'the gist' };
    s.messages.update(summarized);
    expect(s.messages.get('msg_1')).toEqual(summarized);
    s.messages.insert({ ...m, id: 'msg_s', summary: 'short' });
    expect(s.messages.get('msg_s')?.summary).toBe('short');
    expect(s.messages.getMany(['msg_1', 'nope']).map((x) => x.id)).toEqual(['msg_1']);
  });

  it('lists newest-last with before/after/limit and private filtering', () => {
    for (let i = 1; i <= 6; i++)
      s.messages.insert(msg(`msg_${i}`, 'room_1', i === 3 ? { privateTo: 'user_2' } : {}));
    s.messages.insert(msg('msg_other', 'room_2'));
    const ids = (ms: Message[]) => ms.map((m) => m.id);
    expect(ids(s.messages.list('room_1', { limit: 50, forUser: 'user_2' }))).toEqual([
      'msg_1',
      'msg_2',
      'msg_3',
      'msg_4',
      'msg_5',
      'msg_6',
    ]);
    expect(ids(s.messages.list('room_1', { limit: 50, forUser: 'user_1' }))).toEqual([
      'msg_1',
      'msg_2',
      'msg_4',
      'msg_5',
      'msg_6',
    ]);
    expect(ids(s.messages.list('room_1', { limit: 50 }))).toEqual([
      'msg_1',
      'msg_2',
      'msg_4',
      'msg_5',
      'msg_6',
    ]);
    expect(ids(s.messages.list('room_1', { limit: 2, forUser: 'user_2' }))).toEqual([
      'msg_5',
      'msg_6',
    ]);
    expect(
      ids(s.messages.list('room_1', { limit: 2, before: 'msg_5', forUser: 'user_2' })),
    ).toEqual(['msg_3', 'msg_4']);
    expect(ids(s.messages.list('room_1', { limit: 2, after: 'msg_2', forUser: 'user_2' }))).toEqual(
      ['msg_3', 'msg_4'],
    );
  });

  it('since and countSince', () => {
    for (let i = 1; i <= 4; i++) s.messages.insert(msg(`msg_${i}`, 'room_1'));
    expect(s.messages.since('room_1', null, 10).map((m) => m.id)).toEqual([
      'msg_1',
      'msg_2',
      'msg_3',
      'msg_4',
    ]);
    expect(s.messages.since('room_1', 'msg_2', 10).map((m) => m.id)).toEqual(['msg_3', 'msg_4']);
    expect(s.messages.since('room_1', 'msg_2', 1).map((m) => m.id)).toEqual(['msg_3']);
    expect(s.messages.countSince('room_1', null)).toBe(4);
    expect(s.messages.countSince('room_1', 'msg_3')).toBe(1);
    expect(s.messages.countSince('room_1', 'msg_4')).toBe(0);
  });
});

describe('documents', () => {
  it('creates, finds, renames, archives', () => {
    const d = s.documents.create({ roomId: 'room_1', path: 'Arch.md', title: 'Arch' });
    expect(d.status).toBe('active');
    expect(d.id).toMatch(/^doc_/);
    const fixed = s.documents.create({
      id: 'doc_fixed',
      roomId: 'room_1',
      path: 'B.md',
      title: 'B',
    });
    expect(fixed.id).toBe('doc_fixed');
    expect(s.documents.getByPath('room_1', 'Arch.md')).toEqual(d);
    expect(() => s.documents.create({ roomId: 'room_1', path: 'Arch.md', title: 'dup' })).toThrow();
    s.documents.rename(d.id, 'Architecture', 'Architecture.md');
    expect(s.documents.get(d.id)).toMatchObject({ title: 'Architecture', path: 'Architecture.md' });
    s.documents.archive(d.id);
    expect(s.documents.list('room_1').map((x) => x.id)).toEqual(['doc_fixed']);
    expect(s.documents.list('room_1', true).map((x) => x.id)).toEqual([d.id, 'doc_fixed']);
    // archived path can be reused
    const again = s.documents.create({ roomId: 'room_1', path: 'Architecture.md', title: 'New' });
    expect(s.documents.getByPath('room_1', 'Architecture.md')!.id).toBe(again.id);
  });
});

describe('proposals', () => {
  function proposal(): Proposal {
    return {
      id: 'prop_1',
      roomId: 'room_1',
      documentId: 'doc_1',
      kind: 'quorum',
      state: 'drafting',
      title: 'Storage engine',
      branchBase: 'base',
      options: ['A', 'B'].map((label) => ({
        id: `opt_${label}`,
        proposalId: 'prop_1',
        label,
        branch: `arch/storage/${label.toLowerCase()}`,
        summary: `sum ${label}`,
        tradeoffs: `trade ${label}`,
        headSha: null,
      })),
      votes: [],
      windowClosesAt: null,
      stale: false,
      reconciled: false,
      mergedOptionId: null,
      mergeSha: null,
      triggerMessageIds: ['msg_1', 'msg_2'],
      cardMessageId: null,
      openedAt: null,
      closedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('creates and returns options and votes populated', () => {
    const p = proposal();
    s.proposals.create(p);
    expect(s.proposals.get('prop_1')).toEqual(p);
    s.proposals.castVote({
      proposalId: 'prop_1',
      userId: 'user_1',
      optionId: 'opt_A',
      decision: 'approve',
      castAt: 't1',
    });
    s.proposals.castVote({
      proposalId: 'prop_1',
      userId: 'user_2',
      optionId: null,
      decision: 'reject',
      castAt: 't2',
    });
    const got = s.proposals.get('prop_1')!;
    expect(got.votes.map((v) => v.userId)).toEqual(['user_1', 'user_2']);
    expect(got.votes[1]).toMatchObject({ optionId: null, decision: 'reject' });
    expect(got.options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(s.proposals.get('missing')).toBeNull();
  });

  it('re-voting replaces, clearVote removes', () => {
    s.proposals.create(proposal());
    s.proposals.castVote({
      proposalId: 'prop_1',
      userId: 'user_1',
      optionId: 'opt_A',
      decision: 'approve',
      castAt: 't1',
    });
    s.proposals.castVote({
      proposalId: 'prop_1',
      userId: 'user_1',
      optionId: 'opt_B',
      decision: 'approve',
      castAt: 't2',
    });
    expect(s.proposals.listVotes('prop_1')).toEqual([
      {
        proposalId: 'prop_1',
        userId: 'user_1',
        optionId: 'opt_B',
        decision: 'approve',
        castAt: 't2',
      },
    ]);
    s.proposals.clearVote('prop_1', 'user_1');
    expect(s.proposals.listVotes('prop_1')).toEqual([]);
  });

  it('setState applies the patch and returns the updated proposal', () => {
    s.proposals.create(proposal());
    const open = s.proposals.setState('prop_1', 'open', {
      openedAt: 'now',
      stale: true,
      title: 'New title',
      cardMessageId: 'msg_9',
    });
    expect(open).toMatchObject({
      state: 'open',
      openedAt: 'now',
      stale: true,
      title: 'New title',
      cardMessageId: 'msg_9',
    });
    const merged = s.proposals.setState('prop_1', 'merged', {
      mergedOptionId: 'opt_B',
      mergeSha: 'sha',
      closedAt: 'later',
      reconciled: true,
      stale: false,
    });
    expect(merged).toMatchObject({
      state: 'merged',
      mergedOptionId: 'opt_B',
      mergeSha: 'sha',
      reconciled: true,
      stale: false,
    });
    expect(merged.options).toHaveLength(2);
    expect(() => s.proposals.setState('nope', 'open')).toThrow();
  });

  it('updateOption and list filters', () => {
    s.proposals.create(proposal());
    s.proposals.create({
      ...proposal(),
      id: 'prop_2',
      documentId: 'doc_2',
      state: 'open',
      createdAt: '2026-01-02T00:00:00.000Z',
      options: [],
    });
    s.proposals.updateOption({
      ...proposal().options[0]!,
      headSha: 'deadbeef',
      summary: 'changed',
    });
    expect(s.proposals.get('prop_1')!.options[0]).toMatchObject({
      headSha: 'deadbeef',
      summary: 'changed',
    });
    expect(s.proposals.list('room_1').map((p) => p.id)).toEqual(['prop_1', 'prop_2']);
    expect(s.proposals.list('room_1', { states: ['open'] }).map((p) => p.id)).toEqual(['prop_2']);
    expect(s.proposals.list('room_1', { documentId: 'doc_1' }).map((p) => p.id)).toEqual([
      'prop_1',
    ]);
    expect(s.proposals.list('room_1', { states: [] })).toEqual([]);
    expect(s.proposals.list('room_x')).toEqual([]);
  });
});

describe('changes', () => {
  const change = (sha: string, over: Partial<Change> = {}): Change => ({
    sha,
    roomId: 'room_1',
    documentId: 'doc_1',
    actor: { kind: 'agent', role: 'orchestrator' },
    summary: `s ${sha}`,
    triggerMessageIds: ['msg_1'],
    proposalId: null,
    revertsSha: null,
    revertedBySha: null,
    createdAt: new Date().toISOString(),
    ...over,
  });

  it('inserts, lists newest first, filters, marks reverted', () => {
    s.changes.insert(change('c1', { createdAt: '2026-01-01T00:00:00.000Z' }));
    s.changes.insert(change('c2', { createdAt: '2026-01-02T00:00:00.000Z', documentId: 'doc_2' }));
    s.changes.insert(change('c3', { createdAt: '2026-01-03T00:00:00.000Z', proposalId: 'prop_1' }));
    expect(s.changes.get('c3')).toMatchObject({
      proposalId: 'prop_1',
      triggerMessageIds: ['msg_1'],
    });
    expect(s.changes.list('room_1').map((c) => c.sha)).toEqual(['c3', 'c2', 'c1']);
    expect(s.changes.list('room_1', { documentId: 'doc_1' }).map((c) => c.sha)).toEqual([
      'c3',
      'c1',
    ]);
    expect(s.changes.list('room_1', { limit: 1 }).map((c) => c.sha)).toEqual(['c3']);
    s.changes.markReverted('c1', 'c4');
    expect(s.changes.get('c1')!.revertedBySha).toBe('c4');
    expect(s.changes.get('zzz')).toBeNull();
  });
});

describe('usage', () => {
  it('summarizes by role', () => {
    const base = {
      roomId: 'room_1',
      sessionId: 's',
      model: 'm',
      cacheReadTokens: 0,
      at: 'now',
    } as const;
    s.usage.insert({ ...base, role: 'listener', inputTokens: 10, outputTokens: 1, costUsd: 0.5 });
    s.usage.insert({ ...base, role: 'listener', inputTokens: 5, outputTokens: 2, costUsd: 0.25 });
    s.usage.insert({ ...base, role: 'worker', inputTokens: 100, outputTokens: 20, costUsd: 1 });
    s.usage.insert({
      ...base,
      roomId: 'room_2',
      role: 'worker',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 99,
    });
    expect(s.usage.summarize('room_1')).toEqual({
      totalCostUsd: 1.75,
      byRole: {
        listener: { costUsd: 0.75, inputTokens: 15, outputTokens: 3 },
        worker: { costUsd: 1, inputTokens: 100, outputTokens: 20 },
      },
    });
    expect(s.usage.summarize('empty')).toEqual({ totalCostUsd: 0, byRole: {} });
  });
});

describe('transaction', () => {
  it('commits, rolls back on throw, and nests', () => {
    s.transaction(() => s.users.create('Ann'));
    expect(s.users.findByDisplayName('Ann')).not.toBeNull();
    expect(() =>
      s.transaction(() => {
        s.users.create('Bob');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.users.findByDisplayName('Bob')).toBeNull();
    s.transaction(() => {
      s.users.create('Cy');
      expect(() =>
        s.transaction(() => {
          s.users.create('Dee');
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(s.users.findByDisplayName('Cy')).not.toBeNull();
    expect(s.users.findByDisplayName('Dee')).toBeNull();
    expect(s.transaction(() => 42)).toBe(42);
  });
});
