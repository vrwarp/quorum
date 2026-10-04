import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommitMeta, RoomRepository } from '../../contracts/index.js';
import { createGitRepo, type GitRepoRig } from '../testing/gitRepo.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { ScratchWorktree } from './scratch.js';
import { orchestratorTools } from './tools.js';

const ARCH = '# Architecture\n\nPara 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n';
const PRD = '# PRD\n\nGoals.\n';
const bob: CommitMeta = {
  actor: { kind: 'user', userId: 'user_bob', displayName: 'Bob' },
  triggerMessageIds: [],
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });
const onMain = (repo: RoomRepository, files: Record<string, string | null>, subject = 'Change') =>
  repo.withMainLock(() => repo.commitToMain(files, subject, bob));

describe('ScratchWorktree on a real repository', () => {
  let g: GitRepoRig;
  beforeEach(async () => {
    g = await createGitRepo({ 'Architecture.md': ARCH, 'PRD.md': PRD });
  });
  afterEach(() => g.cleanup());

  it('is a detached worktree of its own at main, not the main worktree', async () => {
    const s = await ScratchWorktree.create(g.repo);
    expect(s.dir).not.toBe(g.repo.mainWorktree);
    expect(s.base).toBe(await g.repo.headSha('main'));
    expect(existsSync(join(s.dir, '.git'))).toBe(true);
    expect(readFileSync(join(s.dir, 'Architecture.md'), 'utf8')).toBe(ARCH);
    expect(git(s.dir, 'rev-parse', 'HEAD').trim()).toBe(s.base);
    expect(git(s.dir, 'status', '--porcelain')).toBe('');
    await s.dispose();
  });

  it('is replaced by a fresh one when a room starts again (what an earlier run left is gone)', async () => {
    const first = await ScratchWorktree.create(g.repo);
    writeFileSync(join(first.dir, 'Architecture.md'), 'half-finished edit from an earlier run');
    writeFileSync(join(first.dir, 'Junk.md'), 'x');
    const second = await ScratchWorktree.create(g.repo);
    expect(second.dir).toBe(first.dir); // same name, same place
    expect(readFileSync(join(second.dir, 'Architecture.md'), 'utf8')).toBe(ARCH);
    expect(existsSync(join(second.dir, 'Junk.md'))).toBe(false);
    await second.dispose();
  });

  it("reset() makes it a clean copy of main's current head: files, HEAD and index follow main", async () => {
    const s = await ScratchWorktree.create(g.repo);
    writeFileSync(join(s.dir, 'Architecture.md'), '# Architecture\n\nMy edit.\n');
    writeFileSync(join(s.dir, 'Scratch notes.md'), 'untracked');
    const sha = await onMain(g.repo, { 'PRD.md': `${PRD}\nMore goals.\n`, 'New.md': '# New\n' });

    expect(await s.reset()).toBe(sha);
    expect(s.base).toBe(sha);
    expect(readFileSync(join(s.dir, 'Architecture.md'), 'utf8')).toBe(ARCH); // its own edit is gone
    expect(existsSync(join(s.dir, 'Scratch notes.md'))).toBe(false);
    expect(readFileSync(join(s.dir, 'PRD.md'), 'utf8')).toContain('More goals.'); // main's change is in
    expect(existsSync(join(s.dir, 'New.md'))).toBe(true);
    // git inside the session shows no phantom edits, and history follows main
    expect(git(s.dir, 'status', '--porcelain')).toBe('');
    expect(git(s.dir, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(s.dir, 'log', '-1', '--format=%s').trim()).toBe('Change');
    await s.dispose();
  });

  it('resets in place: the directory is never deleted, so a process working in it keeps its cwd', async () => {
    const s = await ScratchWorktree.create(g.repo);
    const before = statSync(s.dir).ino;
    writeFileSync(join(s.dir, 'Architecture.md'), 'edit');
    await onMain(g.repo, { 'PRD.md': `${PRD}\nMore.\n` });
    await s.reset();
    await s.reset();
    expect(statSync(s.dir).ino).toBe(before);
    await s.dispose();
  });

  it('dispose() removes the worktree and its registration', async () => {
    const s = await ScratchWorktree.create(g.repo);
    await s.dispose();
    expect(existsSync(s.dir)).toBe(false);
    expect(git(g.repo.bareDir, 'worktree', 'list')).not.toContain('orchestrator');
  });
});

describe('ScratchWorktree without git (test doubles)', () => {
  it('create() and reset() work on the files alone', async () => {
    const repo = new MemoryRepo('room_test', { 'Architecture.md': ARCH });
    const s = await ScratchWorktree.create(repo);
    writeFileSync(join(s.dir, 'Architecture.md'), 'edit');
    writeFileSync(join(s.dir, 'Stray.md'), 'x');
    await repo.commitToMain({ 'PRD.md': PRD }, 'Add PRD', bob);
    await s.reset();
    expect(readFileSync(join(s.dir, 'Architecture.md'), 'utf8')).toBe(ARCH);
    expect(existsSync(join(s.dir, 'Stray.md'))).toBe(false);
    expect(readFileSync(join(s.dir, 'PRD.md'), 'utf8')).toBe(PRD);
    expect(s.base).toBe(await repo.headSha('main'));
  });
});

/**
 * The review's H1: the orchestrator's edits sat uncommitted in the main worktree, outside the write queue. Another
 * writer's `git add -A` committed them under its own name (no size rule, no Change card, wrong trailers), and a merge or
 * revert that resets the worktree wiped them. Now the orchestrator edits a scratch worktree of its own, and only
 * commit_main, under the lock, takes the text to main.
 */
describe('a pending orchestrator edit and other writers to main (real git)', () => {
  let g: GitRepoRig;
  let stub: StubActions;
  let scratch: ScratchWorktree;
  let commitMain: (a: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  const EDIT = ARCH.replace('Para 2.', 'Para two, edited by the orchestrator.');
  const args = (over: Record<string, unknown> = {}) => ({
    documentPath: 'Architecture.md',
    subject: 'Reword paragraph two',
    summary: 'Reworded paragraph two',
    triggerMessageIds: ['msg_abc'],
    ...over,
  });
  const mainFile = (f: string) => readFileSync(join(g.repo.mainWorktree, f), 'utf8');

  beforeEach(async () => {
    g = await createGitRepo({ 'Architecture.md': ARCH, 'PRD.md': PRD });
    stub = createStubActions({
      repo: g.repo,
      documents: [
        { path: 'Architecture.md', title: 'Architecture' },
        { path: 'PRD.md', title: 'PRD' },
      ],
      participants: [{ userId: 'user_bob', displayName: 'Bob' }],
    });
    scratch = await ScratchWorktree.create(g.repo);
    const tools = orchestratorTools({
      roomId: stub.roomId,
      actions: stub.actions,
      repo: g.repo,
      scratch,
      logger: () => undefined,
    });
    const tool = tools.find((t) => t.name === 'commit_main')!;
    commitMain = async (a) => {
      const r = (await tool.handler(a as never, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      return { text: r.content[0]!.text, isError: Boolean(r.isError) };
    };
    // the model is halfway through an edit
    writeFileSync(join(scratch.dir, 'Architecture.md'), EDIT);
  });
  afterEach(async () => {
    await scratch.dispose();
    g.cleanup();
  });

  it("another actor's commitToMain does not commit the pending edit, and does not lose it", async () => {
    const other = await onMain(g.repo, { 'Notes.md': '# Notes\n' }, 'Create document Notes');

    // Bob's commit holds exactly his own file, under his own name
    const info = await g.repo.show(other);
    expect(info.files).toEqual(['Notes.md']);
    expect(info.trailers.actor).toBe('user:user_bob');
    expect(mainFile('Architecture.md')).toBe(ARCH);
    expect(await g.repo.readFile('Architecture.md')).toBe(ARCH);
    // and the edit is still there for the orchestrator to finish
    expect(readFileSync(join(scratch.dir, 'Architecture.md'), 'utf8')).toBe(EDIT);

    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    const sha = /committed ([0-9a-f]{40})/.exec(out.text)![1]!;
    const mine = await g.repo.show(sha);
    expect(mine.files).toEqual(['Architecture.md']);
    expect(mine.trailers).toMatchObject({
      actor: 'agent:orchestrator',
      triggerMessageIds: ['msg_abc'],
    });
    expect(await g.repo.readFile('Architecture.md')).toBe(EDIT);
    expect(await g.repo.readFile('Notes.md')).toBe('# Notes\n'); // Bob's document is still there
    expect(mainFile('Architecture.md')).toBe(EDIT); // main's checkout is in step
    expect(git(g.repo.mainWorktree, 'status', '--porcelain')).toBe('');
    expect(stub.changes.map((c) => c.sha)).toEqual([sha]);
  });

  it('merges with a concurrent edit of the same document by another actor: both survive, one commit each', async () => {
    const bobsSha = await onMain(
      g.repo,
      { 'Architecture.md': ARCH.replace('Para 4.', 'Para four, edited by Bob.') },
      'Edit Architecture',
    );
    expect((await g.repo.show(bobsSha)).files).toEqual(['Architecture.md']);

    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/merged with the newer text/);
    const text = (await g.repo.readFile('Architecture.md'))!;
    expect(text).toContain('Para two, edited by the orchestrator.');
    expect(text).toContain('Para four, edited by Bob.');
    const log = await g.repo.log('Architecture.md', 'main', 3);
    expect(log.map((c) => c.trailers.actor)).toEqual([
      'agent:orchestrator',
      'user:user_bob',
      'agent:system',
    ]);
    expect(mainFile('Architecture.md')).toBe(text);
  });

  it('refuses, rather than overwrite, when the other actor changed the same paragraph', async () => {
    const bobsText = ARCH.replace('Para 2.', 'Para two, as Bob wants it.');
    await onMain(g.repo, { 'Architecture.md': bobsText }, 'Edit Architecture');
    const out = await commitMain(args());
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/could not be merged/);
    expect(await g.repo.readFile('Architecture.md')).toBe(bobsText); // Bob's text was not overwritten
    expect(stub.changes).toHaveLength(0);
  });

  it('survives a merge of a proposal into main (the merge no longer sweeps or resets anything of the orchestrator)', async () => {
    const { worktreePath } = await g.repo.createBranch('prd/goals/a');
    writeFileSync(join(worktreePath, 'PRD.md'), `${PRD}\nA goal from the proposal.\n`);
    await g.repo.commitWorktree(worktreePath, 'Draft goals', {
      actor: { kind: 'agent', role: 'worker' },
      triggerMessageIds: [],
    });
    const mergeSha = await g.repo.withMainLock(async () => {
      const m = await g.repo.beginMerge('prd/goals/a');
      return g.repo.finishMerge(m.worktreePath!, 'Merge goals', {
        actor: { kind: 'agent', role: 'merge' },
        triggerMessageIds: [],
        proposalId: 'prop_1',
      });
    });
    expect(await g.repo.headSha('main')).toBe(mergeSha);
    expect(mainFile('PRD.md')).toContain('A goal from the proposal.');
    expect(mainFile('Architecture.md')).toBe(ARCH);
    expect(readFileSync(join(scratch.dir, 'Architecture.md'), 'utf8')).toBe(EDIT); // not lost

    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    expect(await g.repo.readFile('Architecture.md')).toBe(EDIT);
    expect(await g.repo.readFile('PRD.md')).toContain('A goal from the proposal.');
  });

  it('survives a revert on main (it no longer resets a worktree the orchestrator works in)', async () => {
    const bobsSha = await onMain(g.repo, { 'PRD.md': `${PRD}\nA goal Bob will take back.\n` });
    await g.repo.withMainLock(() => g.repo.revert(bobsSha, bob));
    expect(mainFile('PRD.md')).toBe(PRD);
    expect(readFileSync(join(scratch.dir, 'Architecture.md'), 'utf8')).toBe(EDIT);

    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    expect(await g.repo.readFile('Architecture.md')).toBe(EDIT);
  });

  it('runs the formatter at commit, and the next turn starts from a clean copy of what was committed', async () => {
    writeFileSync(
      join(scratch.dir, 'Architecture.md'),
      `${EDIT}\n\n\n\n## Latency\n\nUnder 200 ms.\n`,
    );
    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    const committed = (await g.repo.readFile('Architecture.md'))!;
    expect(committed).not.toContain('\n\n\n'); // prettier collapsed the blank lines
    expect(readFileSync(join(scratch.dir, 'Architecture.md'), 'utf8')).toBe(committed);
    expect(git(scratch.dir, 'status', '--porcelain')).toBe('');
  });

  it('never leaves the main worktree dirty, whatever the orchestrator does', async () => {
    writeFileSync(join(scratch.dir, 'PRD.md'), '# PRD\n\nSneaky edit.\n');
    writeFileSync(join(scratch.dir, 'Stray.md'), 'x');
    const out = await commitMain(args());
    expect(out.isError).toBe(false);
    expect(git(g.repo.mainWorktree, 'status', '--porcelain')).toBe('');
    expect(await g.repo.readFile('PRD.md')).toBe(PRD);
    expect(await g.repo.listFiles()).toEqual(['Architecture.md', 'PRD.md']);
  });
});
