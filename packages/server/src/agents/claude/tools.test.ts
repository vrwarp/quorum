import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoomState } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { makeProposal } from '../testing/fixtures.js';
import { ScratchWorktree } from './scratch.js';
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
  /** the orchestrator's working copy: commit_main takes the edit from here */
  scratch: ScratchWorktree;
  run(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  explorations: ExplorationRequest[];
  statusCalls: Array<[string, string | null]>;
  logs: string[];
}

async function rig(
  opts: { withExploration?: boolean; withStatusHook?: boolean; limit?: number } = {},
): Promise<Rig> {
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
  const scratch = await ScratchWorktree.create(repo);
  const explorations: ExplorationRequest[] = [];
  const statusCalls: Rig['statusCalls'] = [];
  const logs: string[] = [];
  const tools = orchestratorTools({
    roomId: stub.roomId,
    actions: stub.actions,
    repo,
    scratch,
    logger: (_l, msg) => logs.push(msg),
    immediateRewriteLimit: opts.limit,
    startExploration: opts.withExploration
      ? async (req) => {
          explorations.push(req);
          return { explorationId: 'expl_1', branches: ['architecture/storage/a'], baseSha: 'abc' };
        }
      : undefined,
    setStatus: opts.withStatusHook ? (s, d) => statusCalls.push([s, d]) : undefined,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    repo,
    stub,
    scratch,
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

/** What the model does with Edit/Write: change a file in its own working directory. */
function edit(r: Rig, file: string, content: string): void {
  writeFileSync(join(r.scratch.dir, file), content);
}

/** Another writer commits to main meanwhile (a participant creating or changing a document, a merge). */
async function otherWriter(r: Rig, files: Record<string, string>, subject = 'Other change') {
  return r.repo.withMainLock(() =>
    r.repo.commitToMain(files, subject, {
      actor: { kind: 'user', userId: 'user_bob', displayName: 'Bob' },
      triggerMessageIds: [],
    }),
  );
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
  it('exposes the PRD tools under mcp__quorum__ names', async () => {
    const r = await rig();
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
    const r = await rig();
    const out = await r.run('close_proposal', { proposalId: 'prop_missing', reason: 'expired' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/close_proposal failed: no proposal prop_missing/);
    expect(r.logs.some((l) => l.includes('close_proposal failed'))).toBe(true);
  });
});

describe('commit_main', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  const args = (over: Record<string, unknown> = {}) => ({
    documentPath: 'Architecture.md',
    subject: 'Add latency section',
    summary: 'Added a latency section',
    triggerMessageIds: ['msg_1'],
    ...over,
  });
  const mainText = () => r.repo.readFile('Architecture.md');
  const scratchText = (file = 'Architecture.md') => readFileSync(join(r.scratch.dir, file), 'utf8');

  it('commits the edit through the write queue with trailers and records a Change', async () => {
    edit(r, 'Architecture.md', `${DOC}\n## Latency\n\np99 under 200 ms.\n`);
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

  it("works on the orchestrator's own working copy, never on the main worktree", async () => {
    edit(r, 'Architecture.md', `${DOC}\n## Latency\n\np99 under 200 ms.\n`);
    // the edit is not visible to main in any way until commit_main takes it there
    expect(readFileSync(join(r.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(DOC);
    expect(await mainText()).toBe(DOC);
    expect(r.scratch.dir).not.toBe(r.repo.mainWorktree);
    await r.run('commit_main', args());
    // afterwards the working copy mirrors main again
    expect(scratchText()).toBe(await mainText());
    expect(r.scratch.base).toBe(await r.repo.headSha('main'));
  });

  it('authors the commit as the participant when applying their suggestion', async () => {
    edit(r, 'Architecture.md', DOC.replace('Para 2.', 'Para two, fixed.'));
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
    edit(r, 'Architecture.md', `${DOC}\nMore.\n`);
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
    edit(r, 'Architecture.md', `${DOC}\nAdded.\n`);
    edit(r, 'PRD.md', '# PRD\n\nSneaky edit.\n');
    edit(r, 'Notes.md', 'a new file');
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/Changes to Notes\.md, PRD\.md were discarded/);
    const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
    expect((await r.repo.show(sha)).files).toEqual(['Architecture.md']);
    expect(await r.repo.readFile('PRD.md')).toBe('# PRD\n\nGoals.\n');
    expect(scratchText('PRD.md')).toBe('# PRD\n\nGoals.\n');
    expect(existsSync(join(r.scratch.dir, 'Notes.md'))).toBe(false);
    expect(await r.repo.listFiles()).toEqual(['Architecture.md', 'PRD.md']);
  });

  it('says so when only other files were touched, and commits nothing', async () => {
    edit(r, 'PRD.md', 'changed');
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Nothing to commit/);
    expect(out.text).toMatch(/PRD\.md were discarded/);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('refuses a change that rewrites more paragraphs than the size rule allows, and discards the edit', async () => {
    const before = await r.repo.headSha('main');
    edit(r, 'Architecture.md', '# Architecture\n\nPara 5.\n'); // removes paragraphs 1-4
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/deletes or rewrites 4 existing paragraphs/);
    expect(out.text).toMatch(/at most 3/);
    expect(out.text).toMatch(/start_exploration/);
    expect(out.text).toMatch(/exploration_finished/);
    expect(out.text).toMatch(/kind "review"/);
    expect(await r.repo.headSha('main')).toBe(before);
    expect(scratchText()).toBe(DOC); // the working copy is clean again
    expect(r.stub.changes).toHaveLength(0);
  });

  it('allows exactly the limit, and any amount of added text', async () => {
    edit(
      r,
      'Architecture.md',
      DOC.replace('Para 1.', 'One.').replace('Para 2.', 'Two.').replace('Para 3.', 'Three.'),
    );
    expect((await r.run('commit_main', args())).isError).toBe(false); // 3 rewritten paragraphs

    const many = Array.from({ length: 30 }, (_, i) => `Added paragraph ${i}.`).join('\n\n');
    edit(r, 'Architecture.md', `${await r.repo.readFile('Architecture.md')}\n${many}\n`);
    expect((await r.run('commit_main', args({ subject: 'Add lots' }))).isError).toBe(false);
    expect(r.stub.changes).toHaveLength(2);
  });

  it('applies the room tunable for the size rule', async () => {
    const strict = await rig({ limit: 1 });
    edit(strict, 'Architecture.md', DOC.replace('Para 1.', 'One.').replace('Para 2.', 'Two.'));
    expect((await strict.run('commit_main', args())).text).toMatch(/at most 1/);
  });

  it('reports an unchanged document, and restores a deleted file', async () => {
    expect((await r.run('commit_main', args())).text).toMatch(
      /Nothing to commit: Architecture\.md is unchanged/,
    );
    rmSync(join(r.scratch.dir, 'Architecture.md'));
    const out = await r.run('commit_main', args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/archived from the UI, never deleted/);
    expect(scratchText()).toBe(DOC);
  });

  it('refuses to commit without a working copy', async () => {
    const tools = orchestratorTools({
      roomId: r.stub.roomId,
      actions: r.stub.actions,
      repo: r.repo,
      logger: () => undefined,
    });
    const commit = tools.find((t) => t.name === 'commit_main')!;
    const out = (await commit.handler(args() as never, {})) as { content: Array<{ text: string }> };
    expect(out.content[0]!.text).toMatch(/no working directory to commit from/);
  });

  describe('when main moved since the turn began (another writer committed meanwhile)', () => {
    const para = (n: number, text: string) => DOC.replace(`Para ${n}.`, text);

    it('commits the edit on top of an unrelated change to another document, and says nothing about a merge', async () => {
      edit(r, 'Architecture.md', para(2, 'Para two, edited.'));
      await otherWriter(r, { 'PRD.md': '# PRD\n\nGoals.\n\nMore goals.\n' }, 'Edit PRD');
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(false);
      expect(out.text).not.toMatch(/merged/);
      expect(await mainText()).toBe(para(2, 'Para two, edited.'));
      expect(await r.repo.readFile('PRD.md')).toContain('More goals.');
    });

    it('merges an edit with a concurrent change to other paragraphs of the same document: neither is lost', async () => {
      edit(r, 'Architecture.md', para(2, 'Para two, edited by the orchestrator.'));
      const other = para(4, 'Para four, edited by Bob.');
      await otherWriter(r, { 'Architecture.md': other });
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/merged with the newer text/);
      const text = (await mainText())!;
      expect(text).toContain('Para two, edited by the orchestrator.');
      expect(text).toContain('Para four, edited by Bob.');
      // the Change card reports the orchestrator's own commit
      expect(r.stub.changes).toHaveLength(1);
    });

    it("refuses when the same lines changed, discards the edit, and leaves the other writer's text alone", async () => {
      edit(r, 'Architecture.md', para(2, "Para two, the orchestrator's version."));
      await otherWriter(r, { 'Architecture.md': para(2, "Para two, Bob's version.") });
      const before = await r.repo.headSha('main');
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Refused: Architecture\.md changed on main while you were editing/);
      expect(out.text).toMatch(/Read Architecture\.md again, redo the edit/);
      expect(await r.repo.headSha('main')).toBe(before);
      expect(await mainText()).toContain("Para two, Bob's version.");
      // the working copy shows the current text, ready for the edit to be redone
      expect(scratchText()).toBe(await mainText());
      expect(r.stub.changes).toHaveLength(0);
    });

    it("counts only what the commit changes in main's current text against the size rule", async () => {
      // the orchestrator rewrites 3 paragraphs (the limit); Bob meanwhile rewrote 2 others. Bob's are already in main,
      // so the commit replaces 3 of main's paragraphs, not 5.
      edit(
        r,
        'Architecture.md',
        para(1, 'One.').replace('Para 2.', 'Two.').replace('Para 3.', 'Three.'),
      );
      await otherWriter(r, {
        'Architecture.md': para(4, 'Four.').replace('Para 5.', 'Five.'),
      });
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(false);
      const text = (await mainText())!;
      expect(text).toContain('Three.');
      expect(text).toContain('Five.');
    });

    it('applies the size rule to the merged result: a change over the limit is refused even when main moved', async () => {
      edit(
        r,
        'Architecture.md',
        para(1, 'One.')
          .replace('Para 2.', 'Two.')
          .replace('Para 3.', 'Three.')
          .replace('Para 4.', 'Four.'),
      );
      await otherWriter(r, { 'Architecture.md': para(5, 'Five, edited by Bob.') });
      const before = await r.repo.headSha('main');
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/deletes or rewrites 4 existing paragraphs/);
      expect(await r.repo.headSha('main')).toBe(before);
      expect(scratchText()).toBe(await mainText());
    });

    it('says the text is already there when someone made the same change', async () => {
      edit(r, 'Architecture.md', para(2, 'Para two, edited.'));
      await otherWriter(r, { 'Architecture.md': para(2, 'Para two, edited.') });
      const out = await r.run('commit_main', args());
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Nothing to commit: Architecture\.md on main already has this text/);
      expect(r.stub.changes).toHaveLength(0);
    });

    it('holds the write queue while it checks and commits: a writer queued behind it sees the commit', async () => {
      edit(r, 'Architecture.md', `${DOC}\n## Latency\n\np99 under 200 ms.\n`);
      let seenByWriter = '';
      const first = r.run('commit_main', args());
      // queued behind commit_main's use of the lock
      const second = r.repo.withMainLock(async () => {
        seenByWriter = (await r.repo.readFile('Architecture.md')) ?? '';
      });
      await Promise.all([first, second]);
      // either order is a correct serialization, but commit_main's check and commit are never interleaved with it
      expect(seenByWriter === DOC || seenByWriter.includes('## Latency')).toBe(true);
      expect(await mainText()).toContain('## Latency');
    });
  });

  describe('ids the model supplies reach commit trailers, so they are validated', () => {
    it('drops trigger ids that are not message ids, and says so', async () => {
      edit(r, 'Architecture.md', `${DOC}\nAdded.\n`);
      const out = await r.run(
        'commit_main',
        args({
          triggerMessageIds: [
            'msg_abc123',
            'msg_1\nQuorum-Actor: user:user_alice',
            'x',
            'msg_abc123',
          ],
        }),
      );
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/Ignored trigger ids that are not message ids/);
      const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
      expect((await r.repo.show(sha)).trailers.triggerMessageIds).toEqual(['msg_abc123']);
      expect(r.stub.changes[0]!.triggerMessageIds).toEqual(['msg_abc123']);
    });

    it('drops a proposal id that is not one', async () => {
      edit(r, 'Architecture.md', `${DOC}\nAdded.\n`);
      const out = await r.run('commit_main', args({ proposalId: 'prop_1\nQuorum-Reverts: abc' }));
      expect(out.text).toMatch(/Ignored proposalId/);
      const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
      expect((await r.repo.show(sha)).trailers.proposalId).toBeNull();
      edit(r, 'Architecture.md', `${await mainText()}\nMore.\n`);
      const ok = await r.run('commit_main', args({ proposalId: 'prop_abc123' }));
      const sha2 = /committed ([0-9a-f]{40})/.exec(ok.text)![1]!;
      expect((await r.repo.show(sha2)).trailers.proposalId).toBe('prop_abc123');
    });
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

  beforeEach(async () => {
    r = await rig();
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
    const r = await rig();
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
    const r = await rig();
    r.stub.proposals.push(makeProposal({ votes: [vote(alice, 'opt_a'), vote(bob, 'opt_a')] }));
    const out = await r.run('request_merge', { proposalId: 'prop_1', optionId: 'opt_a' });
    expect(out).toEqual({ text: 'merge requested', isError: false });
    expect(r.stub.calls).toContain('requestMerge');
  });

  it('validates the proposal, its state and the option', async () => {
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig({ withExploration: true });
    const out = await r.run('start_exploration', {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL', 'ClickHouse'],
      triggerMessageIds: ['msg_1'],
    });
    // returns whatever the runtime reports once the workers are started: it does not wait for them
    expect(JSON.parse(out.text)).toEqual({
      explorationId: 'expl_1',
      branches: ['architecture/storage/a'],
      baseSha: 'abc',
    });
    expect(r.explorations[0]).toMatchObject({
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL', 'ClickHouse'],
      triggerMessageIds: ['msg_1'],
    });
    expect(
      (
        await (
          await rig()
        ).run('start_exploration', {
          documentPath: 'Architecture.md',
          topic: 't',
          theses: ['x'],
        })
      ).text,
    ).toMatch(/explorations are not available/);
  });

  it('start_exploration passes the mode and the announcement on, and defaults to drafting', async () => {
    const r = await rig({ withExploration: true });
    await r.run('start_exploration', {
      documentPath: 'Architecture.md',
      topic: 'p99',
      theses: ['What latency do comparable systems promise?'],
      mode: 'research',
      announcement: 'Looking into typical p99 targets',
    });
    expect(r.explorations[0]).toMatchObject({
      mode: 'research',
      announcement: 'Looking into typical p99 targets',
    });
    await r.run('start_exploration', {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL'],
    });
    // the schema's default ('draft') is applied by the SDK, which parses the arguments before the handler runs
    expect(r.explorations[1]!.mode ?? 'draft').toBe('draft');
    expect(r.explorations[1]!.triggerMessageIds).toEqual([]);
  });

  it('start_exploration and open_proposal drop trigger ids that are not message ids (they reach commit trailers)', async () => {
    const r = await rig({ withExploration: true });
    const out = await r.run('start_exploration', {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['PostgreSQL'],
      triggerMessageIds: ['msg_abc', 'msg_x\nQuorum-Actor: user:user_alice', '../../etc'],
    });
    expect(r.explorations[0]!.triggerMessageIds).toEqual(['msg_abc']);
    expect(JSON.parse(out.text).note).toMatch(/Ignored trigger ids that are not message ids/);

    await branchWith(r.repo, 'architecture/storage/a', {
      'Architecture.md': `${DOC}\nPostgreSQL.\n`,
    });
    const opened = await r.run('open_proposal', {
      documentPath: 'Architecture.md',
      kind: 'review',
      title: 'Storage',
      branchBase: await r.repo.headSha('main'),
      options: [
        {
          label: 'A',
          branch: 'architecture/storage/a',
          summary: 's',
          tradeoffs: 't',
        },
      ],
      triggerMessageIds: ['msg_ok1', 'not an id'],
    });
    expect(opened.isError).toBe(false);
    expect(r.stub.proposals[0]!.triggerMessageIds).toEqual(['msg_ok1']);
    expect(JSON.parse(opened.text).ignoredTriggerIds).toMatch(/not message ids/);
  });

  it('set_status goes through the status hook when there is one, else straight to the room', async () => {
    const hooked = await rig({ withStatusHook: true });
    await hooked.run('set_status', { status: 'thinking', detail: 'Exploring A vs B' });
    await hooked.run('set_status', { status: 'idle' });
    expect(hooked.statusCalls).toEqual([
      ['thinking', 'Exploring A vs B'],
      ['idle', null],
    ]);
    expect(hooked.stub.statuses).toEqual([]);

    const direct = await rig();
    await direct.run('set_status', { status: 'thinking', detail: 'x' });
    expect(direct.stub.statuses).toEqual([{ status: 'thinking', detail: 'x' }]);
  });
});
