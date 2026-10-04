import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoomState } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { makeProposal } from '../testing/fixtures.js';
import {
  evaluateVote,
  mcpToolNames,
  orchestratorTools,
  readOnlyTools,
  type ExplorationRequest,
} from './tools.js';

const DOC = '# Architecture\n\nPara 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n\nPara 5.\n';
const AGENT = { kind: 'agent', role: 'worker' } as const;

interface Rig {
  repo: MemoryRepo;
  stub: StubActions;
  run(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  explorations: ExplorationRequest[];
  statusCalls: Array<[string, string | null]>;
  logs: string[];
}

function rig(
  opts: { withExploration?: boolean; withStatusHook?: boolean; limit?: number } = {},
): Rig {
  const repo = new MemoryRepo('room_test', {
    'Architecture.md': DOC,
    'PRD.md': '# PRD\n\nGoals.\n',
  });
  const stub = createStubActions({
    repo,
    documents: [
      { path: 'Architecture.md', title: 'Architecture' },
      { path: 'PRD.md', title: 'PRD' },
    ],
    participants: [
      { userId: 'user_alice', displayName: 'Alice' },
      { userId: 'user_bob', displayName: 'Bob' },
    ],
  });
  const explorations: ExplorationRequest[] = [];
  const statusCalls: Rig['statusCalls'] = [];
  const logs: string[] = [];
  const tools = orchestratorTools({
    roomId: stub.roomId,
    actions: stub.actions,
    repo,
    logger: (_l, msg) => logs.push(msg),
    immediateRewriteLimit: opts.limit,
    startExploration: opts.withExploration
      ? async (req) => {
          explorations.push(req);
          return { branchBase: 'abc', workers: [] };
        }
      : undefined,
    setStatus: opts.withStatusHook ? (s, d) => statusCalls.push([s, d]) : undefined,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    repo,
    stub,
    explorations,
    statusCalls,
    logs,
    async run(name, args) {
      const t = byName.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      const r = (await t.handler(args as never, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      return { text: r.content[0]!.text, isError: Boolean(r.isError) };
    },
  };
}

function editMain(repo: MemoryRepo, file: string, content: string): void {
  writeFileSync(join(repo.mainWorktree, file), content);
}

async function branchWith(
  repo: MemoryRepo,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const { worktreePath, baseSha } = await repo.createBranch(name);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(worktreePath, f), c);
  await repo.commitWorktree(worktreePath, `Draft ${name}`, { actor: AGENT, triggerMessageIds: [] });
  return baseSha;
}

describe('tool set', () => {
  it('exposes the PRD tools under mcp__quorum__ names', () => {
    const r = rig();
    const names = orchestratorTools({
      roomId: 'r',
      actions: r.stub.actions,
      repo: r.repo,
      logger: () => undefined,
    }).map((t) => t.name);
    expect(names).toEqual([
      'post_chat',
      'read_transcript',
      'get_room_state',
      'commit_main',
      'resolve_suggestion',
      'start_exploration',
      'open_proposal',
      'close_proposal',
      'request_merge',
      'set_status',
    ]);
    expect(mcpToolNames([{ name: 'post_chat' }])).toEqual(['mcp__quorum__post_chat']);
    // workers and the digest writer only read
    const readonly = readOnlyTools({
      roomId: 'r',
      actions: r.stub.actions,
      repo: r.repo,
      logger: () => undefined,
    }).map((t) => t.name);
    expect(readonly).toEqual(['read_transcript', 'get_room_state']);
  });

  it('returns failures as tool errors instead of throwing into the SDK', async () => {
    const r = rig();
    const out = await r.run('close_proposal', { proposalId: 'prop_missing', reason: 'expired' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/close_proposal failed: no proposal prop_missing/);
    expect(r.logs.some((l) => l.includes('close_proposal failed'))).toBe(true);
  });
});

describe('commit_main', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  const args = (over: Record<string, unknown> = {}) => ({
    documentPath: 'Architecture.md',
    subject: 'Add latency section',
    summary: 'Added a latency section',
    triggerMessageIds: ['msg_1'],
    ...over,
  });

  it('commits the edit through the write queue with trailers and records a Change', async () => {
    editMain(r.repo, 'Architecture.md', `${DOC}\n## Latency\n\np99 under 200 ms.\n`);
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(false);
    const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
    expect(await r.repo.headSha('main')).toBe(sha);
    expect(await r.repo.readFile('Architecture.md')).toContain('## Latency');

    const info = await r.repo.show(sha);
    expect(info.subject).toBe('Add latency section');
    expect(info.trailers).toMatchObject({
      actor: 'agent:orchestrator',
      triggerMessageIds: ['msg_1'],
    });
    expect(r.stub.changes).toHaveLength(1);
    expect(r.stub.changes[0]).toMatchObject({
      sha,
      documentId: 'doc_1',
      summary: 'Added a latency section',
      actor: { kind: 'agent', role: 'orchestrator' },
      triggerMessageIds: ['msg_1'],
      revertsSha: null,
    });
  });

  it('authors the commit as the participant when applying their suggestion', async () => {
    editMain(r.repo, 'Architecture.md', DOC.replace('Para 2.', 'Para two, fixed.'));
    const out = await r.run(
      'commit_main',
      args({ subject: 'Apply suggestion', asUserId: 'user_bob' }),
    );
    expect(out.isError).toBe(false);
    const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
    expect((await r.repo.show(sha)).trailers.actor).toBe('user:user_bob');
    expect(r.stub.changes[0]!.actor).toEqual({
      kind: 'user',
      userId: 'user_bob',
      displayName: 'Bob',
    });
  });

  it('rejects unknown participants, unknown documents and archived documents', async () => {
    editMain(r.repo, 'Architecture.md', `${DOC}\nMore.\n`);
    expect((await r.run('commit_main', args({ asUserId: 'user_nobody' }))).text).toMatch(
      /unknown participant/,
    );
    expect((await r.run('commit_main', args({ documentPath: 'Nope.md' }))).text).toMatch(
      /no document with path Nope.md/,
    );
    r.stub.documents[0]!.status = 'archived';
    expect((await r.run('commit_main', args())).text).toMatch(/archived/);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('discards edits to other files: a change touches exactly one document', async () => {
    editMain(r.repo, 'Architecture.md', `${DOC}\nAdded.\n`);
    editMain(r.repo, 'PRD.md', '# PRD\n\nSneaky edit.\n');
    editMain(r.repo, 'Notes.md', 'a new file');
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/Changes to Notes\.md, PRD\.md were discarded/);
    const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
    expect((await r.repo.show(sha)).files).toEqual(['Architecture.md']);
    expect(await r.repo.readFile('PRD.md')).toBe('# PRD\n\nGoals.\n');
    expect(readFileSync(join(r.repo.mainWorktree, 'PRD.md'), 'utf8')).toBe('# PRD\n\nGoals.\n');
    expect(await r.repo.listFiles()).toEqual(['Architecture.md', 'PRD.md']);
  });

  it('says so when only other files were touched, and commits nothing', async () => {
    editMain(r.repo, 'PRD.md', 'changed');
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Nothing to commit/);
    expect(out.text).toMatch(/PRD\.md were discarded/);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('refuses a change that rewrites more paragraphs than the size rule allows, and discards the edit', async () => {
    const before = await r.repo.headSha('main');
    editMain(r.repo, 'Architecture.md', '# Architecture\n\nPara 5.\n'); // removes paragraphs 1-4
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/deletes or rewrites 4 existing paragraphs/);
    expect(out.text).toMatch(/at most 3/);
    expect(out.text).toMatch(/start_exploration/);
    expect(out.text).toMatch(/kind "review"/);
    expect(await r.repo.headSha('main')).toBe(before);
    expect(readFileSync(join(r.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(DOC);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('allows exactly the limit, and any amount of added text', async () => {
    editMain(
      r.repo,
      'Architecture.md',
      DOC.replace('Para 1.', 'One.').replace('Para 2.', 'Two.').replace('Para 3.', 'Three.'),
    );
    expect((await r.run('commit_main', args())).isError).toBe(false); // 3 rewritten paragraphs

    const many = Array.from({ length: 30 }, (_, i) => `Added paragraph ${i}.`).join('\n\n');
    editMain(r.repo, 'Architecture.md', `${await r.repo.readFile('Architecture.md')}\n${many}\n`);
    expect((await r.run('commit_main', args({ subject: 'Add lots' }))).isError).toBe(false);
    expect(r.stub.changes).toHaveLength(2);
  });

  it('applies the room tunable for the size rule', async () => {
    const strict = rig({ limit: 1 });
    editMain(
      strict.repo,
      'Architecture.md',
      DOC.replace('Para 1.', 'One.').replace('Para 2.', 'Two.'),
    );
    expect((await strict.run('commit_main', args())).text).toMatch(/at most 1/);
  });

  it('reports an unchanged document, and restores a deleted file', async () => {
    expect((await r.run('commit_main', args())).text).toMatch(
      /Nothing to commit: Architecture\.md is unchanged/,
    );
    rmSync(join(r.repo.mainWorktree, 'Architecture.md'));
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/archived from the UI, never deleted/);
    expect(readFileSync(join(r.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(DOC);
  });
});

describe('open_proposal', () => {
  let r: Rig;
  const option = (label: string, branch: string) => ({
    label,
    branch,
    summary: `Option ${label}`,
    tradeoffs: 'tradeoffs',
  });
  const open = (over: Record<string, unknown> = {}) => ({
    documentPath: 'Architecture.md',
    kind: 'quorum',
    title: 'PostgreSQL vs ClickHouse',
    branchBase: 'ignored-or-wrong',
    options: [option('A', 'architecture/storage/a'), option('B', 'architecture/storage/b')],
    triggerMessageIds: ['msg_1'],
    ...over,
  });

  beforeEach(() => {
    r = rig();
  });

  it('opens a proposal for branches that change only the document, using the real fork point', async () => {
    const base = await branchWith(r.repo, 'architecture/storage/a', {
      'Architecture.md': `${DOC}\n## Postgres\n`,
    });
    await branchWith(r.repo, 'architecture/storage/b', {
      'Architecture.md': `${DOC}\n## ClickHouse\n`,
    });
    const out = await r.run('open_proposal', open({ branchBase: 'deadbeef' }));
    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text);
    expect(body.state).toBe('open');
    expect(body.options.map((o: { label: string }) => o.label)).toEqual(['A', 'B']);
    expect(body.branchBaseUsed).toBe(base); // the wrong base was replaced by the repository's fork point
    expect(r.stub.proposals[0]).toMatchObject({
      documentId: 'doc_1',
      kind: 'quorum',
      branchBase: base,
      triggerMessageIds: ['msg_1'],
    });
  });

  it('accepts an abbreviated base without comment', async () => {
    const base = await branchWith(r.repo, 'architecture/storage/a', {
      'Architecture.md': `${DOC}\nA\n`,
    });
    await branchWith(r.repo, 'architecture/storage/b', { 'Architecture.md': `${DOC}\nB\n` });
    const body = JSON.parse(
      (await r.run('open_proposal', open({ branchBase: base.slice(0, 8) }))).text,
    );
    expect(body.branchBaseUsed).toBeUndefined();
  });

  it('refuses a branch that touches another document (scope rule) and says which', async () => {
    await branchWith(r.repo, 'architecture/storage/a', { 'Architecture.md': `${DOC}\nA\n` });
    await branchWith(r.repo, 'architecture/storage/b', {
      'Architecture.md': `${DOC}\nB\n`,
      'PRD.md': '# PRD\n\nAlso changed.\n',
    });
    const out = await r.run('open_proposal', open());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(
      /option B \(architecture\/storage\/b\) must change only Architecture\.md, but changes: Architecture\.md, PRD\.md/,
    );
    expect(r.stub.proposals).toHaveLength(0);
  });

  it('refuses a branch that changes a different document only', async () => {
    await branchWith(r.repo, 'architecture/storage/a', { 'PRD.md': '# PRD\n\nOnly the PRD.\n' });
    await branchWith(r.repo, 'architecture/storage/b', { 'Architecture.md': `${DOC}\nB\n` });
    expect((await r.run('open_proposal', open())).text).toMatch(
      /must change only Architecture\.md, but changes: PRD\.md/,
    );
  });

  it('refuses a branch with no changes (a worker that produced nothing)', async () => {
    await r.repo.createBranch('architecture/storage/a');
    await branchWith(r.repo, 'architecture/storage/b', { 'Architecture.md': `${DOC}\nB\n` });
    const out = await r.run('open_proposal', open());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/option A \(architecture\/storage\/a\) has no changes/);
  });

  it('refuses branches that do not exist', async () => {
    await branchWith(r.repo, 'architecture/storage/b', { 'Architecture.md': `${DOC}\nB\n` });
    expect((await r.run('open_proposal', open())).text).toMatch(
      /branch architecture\/storage\/a does not exist/,
    );
  });

  it('enforces option counts per kind', async () => {
    await branchWith(r.repo, 'architecture/storage/a', { 'Architecture.md': `${DOC}\nA\n` });
    expect(
      (
        await r.run(
          'open_proposal',
          open({ kind: 'quorum', options: [option('A', 'architecture/storage/a')] }),
        )
      ).text,
    ).toMatch(/at least two options/);
    expect(
      (
        await r.run(
          'open_proposal',
          open({
            kind: 'review',
            options: [option('A', 'architecture/storage/a'), option('B', 'architecture/storage/b')],
          }),
        )
      ).text,
    ).toMatch(/exactly one option/);
    const ok = await r.run(
      'open_proposal',
      open({ kind: 'review', title: 'Rewrite', options: [option('A', 'architecture/storage/a')] }),
    );
    expect(ok.isError).toBe(false);
    expect(r.stub.proposals[0]).toMatchObject({ kind: 'review', title: 'Rewrite' });
  });

  it('passes stale through and flags a document that moved on main', async () => {
    await branchWith(r.repo, 'architecture/storage/a', { 'Architecture.md': `${DOC}\nA\n` });
    await branchWith(r.repo, 'architecture/storage/b', { 'Architecture.md': `${DOC}\nB\n` });
    // someone changed the same document on main after the fork
    await r.repo.commitToMain({ 'Architecture.md': DOC.replace('Para 5.', 'Para five.') }, 'Edit', {
      actor: AGENT,
      triggerMessageIds: [],
    });
    const body = JSON.parse((await r.run('open_proposal', open({ stale: true }))).text);
    expect(body.stale).toBe(true);
    expect(body.mainChangedSince).toMatch(/Architecture\.md changed on main/);
    expect(r.stub.proposals[0]!.stale).toBe(true);
  });

  it('refuses an unknown document', async () => {
    expect((await r.run('open_proposal', open({ documentPath: 'Missing.md' }))).text).toMatch(
      /no document with path Missing\.md/,
    );
  });
});

describe('request_merge and the voting rule', () => {
  const alice = 'user_alice';
  const bob = 'user_bob';
  const vote = (
    userId: string,
    optionId: string | null,
    decision: 'approve' | 'reject' = 'approve',
  ) =>
    ({
      proposalId: 'prop_1',
      userId,
      optionId,
      decision,
      castAt: '2026-10-04T10:05:00.000Z',
    }) as const;

  async function state(
    r: Rig,
    opts: { rule?: 'unanimous' | 'majority'; connected?: string[] } = {},
  ): Promise<RoomState> {
    const s = await r.stub.actions.getRoomState(r.stub.roomId);
    s.room.votingRule = opts.rule ?? 'unanimous';
    if (opts.connected)
      s.presence = s.presence.map((p) => ({ ...p, connected: opts.connected!.includes(p.userId) }));
    return s;
  }

  it('refuses to merge what the room has not passed, and never calls the merge pipeline', async () => {
    const r = rig();
    r.stub.proposals.push(makeProposal({ votes: [vote(alice, 'opt_a')] }));
    const out = await r.run('request_merge', { proposalId: 'prop_1', optionId: 'opt_a' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(
      /Not merged: 1 of 2 connected participants approved this option and the rule is unanimous/,
    );
    expect(out.text).toMatch(/cannot force a merge/);
    expect(r.stub.calls).not.toContain('requestMerge');
  });

  it('requests the merge once the rule is satisfied', async () => {
    const r = rig();
    r.stub.proposals.push(makeProposal({ votes: [vote(alice, 'opt_a'), vote(bob, 'opt_a')] }));
    const out = await r.run('request_merge', { proposalId: 'prop_1', optionId: 'opt_a' });
    expect(out).toEqual({ text: 'merge requested', isError: false });
    expect(r.stub.calls).toContain('requestMerge');
  });

  it('validates the proposal, its state and the option', async () => {
    const r = rig();
    expect(
      (await r.run('request_merge', { proposalId: 'prop_x', optionId: 'opt_a' })).text,
    ).toMatch(/unknown proposal/);
    r.stub.proposals.push(makeProposal({ state: 'merged' }));
    expect(
      (await r.run('request_merge', { proposalId: 'prop_1', optionId: 'opt_a' })).text,
    ).toMatch(/is merged, not open/);
    r.stub.proposals[0]!.state = 'open';
    expect(
      (await r.run('request_merge', { proposalId: 'prop_1', optionId: 'opt_zzz' })).text,
    ).toMatch(/unknown option/);
  });

  describe('evaluateVote', () => {
    const base = async () => rig();

    it('unanimous needs every connected participant on the same option, and at least one', async () => {
      const r = await base();
      const p = makeProposal({ votes: [vote(alice, 'opt_a'), vote(bob, 'opt_b')] });
      expect(evaluateVote(await state(r), p, 'opt_a').passed).toBe(false);
      expect(evaluateVote(await state(r), p, 'opt_b').passed).toBe(false);
      // a departure completes the vote: only Alice is connected now
      expect(evaluateVote(await state(r, { connected: [alice] }), p, 'opt_a').passed).toBe(true);
      // nobody connected: no approvals, no pass
      expect(evaluateVote(await state(r, { connected: [] }), p, 'opt_a').passed).toBe(false);
    });

    it('does not count votes of participants who are no longer connected', async () => {
      const r = await base();
      const p = makeProposal({ votes: [vote(alice, 'opt_a'), vote(bob, 'opt_a')] });
      expect(evaluateVote(await state(r, { connected: [alice] }), p, 'opt_a')).toMatchObject({
        passed: true,
      });
      const onlyBobVoted = makeProposal({ votes: [vote(bob, 'opt_a')] });
      expect(
        evaluateVote(await state(r, { connected: [alice] }), onlyBobVoted, 'opt_a').passed,
      ).toBe(false);
    });

    it('majority needs more than half of the connected participants', async () => {
      const r = await base();
      const s = await state(r, { rule: 'majority' });
      s.participants.push({
        roomId: 'room_test',
        userId: 'user_carol',
        displayName: 'Carol',
        role: 'member',
      });
      s.presence.push({
        userId: 'user_carol',
        displayName: 'Carol',
        connected: true,
        lastSeenAt: '',
      });
      expect(evaluateVote(s, makeProposal({ votes: [vote(alice, 'opt_a')] }), 'opt_a').passed).toBe(
        false,
      ); // 1 of 3
      expect(
        evaluateVote(
          s,
          makeProposal({ votes: [vote(alice, 'opt_a'), vote(bob, 'opt_a')] }),
          'opt_a',
        ).passed,
      ).toBe(true); // 2 of 3
      expect(
        evaluateVote(
          await state(r, { rule: 'majority' }),
          makeProposal({ votes: [vote(alice, 'opt_a')] }),
          'opt_a',
        ).passed,
      ).toBe(false); // 1 of 2 is not more than half
    });

    it('a review passes on any approval or when the objection window has elapsed, and never after a rejection', async () => {
      const r = await base();
      const s = await state(r);
      const now = new Date('2026-10-04T10:10:00.000Z');
      const review = (over: Parameters<typeof makeProposal>[0]) =>
        makeProposal({ kind: 'review', options: [makeProposal().options[0]!], ...over });
      expect(
        evaluateVote(s, review({ windowClosesAt: '2026-10-04T10:12:00.000Z' }), 'opt_a', now),
      ).toMatchObject({ passed: false });
      expect(
        evaluateVote(
          s,
          review({ windowClosesAt: '2026-10-04T10:12:00.000Z', votes: [vote(alice, 'opt_a')] }),
          'opt_a',
          now,
        ),
      ).toMatchObject({ passed: true });
      expect(
        evaluateVote(s, review({ windowClosesAt: '2026-10-04T10:09:00.000Z' }), 'opt_a', now),
      ).toMatchObject({ passed: true });
      const rejected = review({
        windowClosesAt: '2026-10-04T10:09:00.000Z',
        votes: [vote(bob, null, 'reject'), vote(alice, 'opt_a')],
      });
      expect(evaluateVote(s, rejected, 'opt_a', now)).toMatchObject({
        passed: false,
        reason: 'the review was rejected',
      });
    });
  });
});

describe('other tools', () => {
  it('post_chat posts as the agent with the reply ids, anchor and exploration card', async () => {
    const r = rig();
    const anchor = {
      documentId: 'doc_1',
      baseSha: 'b'.repeat(40),
      startLine: 3,
      endLine: 3,
      textHash: 'abc',
      text: 'Para 1.',
    };
    const card = {
      type: 'exploration_started',
      documentId: 'doc_1',
      title: 'Exploring A vs B for Architecture',
      theses: ['A', 'B'],
    };
    const out = await r.run('post_chat', {
      body: 'Exploring A vs B',
      inReplyTo: ['msg_1'],
      anchor,
      card,
    });
    expect(out.text).toMatch(/^posted msg_/);
    expect(r.stub.messages.at(-1)).toMatchObject({
      body: 'Exploring A vs B',
      inReplyTo: ['msg_1'],
      anchor,
      card,
    });
    expect((await r.run('post_chat', { body: 'plain' })).isError).toBe(false);
    expect(r.stub.messages.at(-1)).toMatchObject({ inReplyTo: [], anchor: null, card: null });
  });

  it('resolve_suggestion updates the card status and resolution sha', async () => {
    const r = rig();
    const anchor = {
      documentId: 'doc_1',
      baseSha: 'b'.repeat(40),
      startLine: 3,
      endLine: 3,
      textHash: 'abc',
      text: 'Para 1.',
    };
    const m = r.stub.human('user_alice', 'Alice', 'suggested an edit', {
      kind: 'card',
      anchor,
      card: {
        type: 'suggestion',
        anchor,
        replacement: 'x',
        status: 'pending',
        resolutionSha: null,
        note: null,
      },
    });
    const out = await r.run('resolve_suggestion', {
      messageId: m.id,
      status: 'applied',
      resolutionSha: 'f'.repeat(40),
    });
    expect(out.text).toBe('suggestion applied');
    expect(m.card).toMatchObject({
      type: 'suggestion',
      status: 'applied',
      resolutionSha: 'f'.repeat(40),
      note: null,
    });
    await r.run('resolve_suggestion', {
      messageId: m.id,
      status: 'declined',
      note: 'the paragraph changed',
    });
    expect(m.card).toMatchObject({
      status: 'declined',
      resolutionSha: null,
      note: 'the paragraph changed',
    });
    const plain = r.stub.human('user_alice', 'Alice', 'just chat');
    expect(
      (await r.run('resolve_suggestion', { messageId: plain.id, status: 'applied' })).text,
    ).toMatch(/is not a suggestion message/);
  });

  it('read_transcript and get_room_state return compact JSON', async () => {
    const r = rig();
    const m = r.stub.human('user_alice', 'Alice', 'hello');
    const transcript = JSON.parse((await r.run('read_transcript', { ids: [m.id] })).text);
    expect(transcript).toEqual([
      { id: m.id, from: 'Alice', userId: 'user_alice', at: m.createdAt, body: 'hello' },
    ]);
    const state = JSON.parse((await r.run('get_room_state', {})).text);
    expect(state.documents.map((d: { path: string }) => d.path)).toEqual([
      'Architecture.md',
      'PRD.md',
    ]);
    expect(state.room.votingRule).toBe('unanimous');
  });

  it('close_proposal archives with the reason', async () => {
    const r = rig();
    r.stub.proposals.push(makeProposal());
    expect(
      (
        await r.run('close_proposal', {
          proposalId: 'prop_1',
          reason: 'expired',
          note: 'settled elsewhere',
        })
      ).text,
    ).toBe('proposal prop_1 is now expired');
  });

  it('start_exploration hands the request to the runtime, or says it is unavailable', async () => {
    const r = rig({ withExploration: true });
    const out = await r.run('start_exploration', {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL', 'ClickHouse'],
      triggerMessageIds: ['msg_1'],
    });
    expect(JSON.parse(out.text)).toEqual({ branchBase: 'abc', workers: [] });
    expect(r.explorations[0]).toMatchObject({
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL', 'ClickHouse'],
      triggerMessageIds: ['msg_1'],
    });
    expect(
      (
        await rig().run('start_exploration', {
          documentPath: 'Architecture.md',
          topic: 't',
          theses: ['x'],
        })
      ).text,
    ).toMatch(/explorations are not available/);
  });

  it('set_status goes through the status hook when there is one, else straight to the room', async () => {
    const hooked = rig({ withStatusHook: true });
    await hooked.run('set_status', { status: 'thinking', detail: 'Exploring A vs B' });
    await hooked.run('set_status', { status: 'idle' });
    expect(hooked.statusCalls).toEqual([
      ['thinking', 'Exploring A vs B'],
      ['idle', null],
    ]);
    expect(hooked.stub.statuses).toEqual([]);

    const direct = rig();
    await direct.run('set_status', { status: 'thinking', detail: 'x' });
    expect(direct.stub.statuses).toEqual([{ status: 'thinking', detail: 'x' }]);
  });
});
