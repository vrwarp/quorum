import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RevertConflictError, type CommitMeta, type RoomRepository } from '../contracts/git.js';
import { createGitProvider } from './index.js';

let root: string;
let repo: RoomRepository;

const user: CommitMeta = { actor: { kind: 'user', userId: 'user_1', displayName: 'Ann' }, triggerMessageIds: [] };
const agent: CommitMeta = {
  actor: { kind: 'agent', role: 'orchestrator' },
  triggerMessageIds: ['msg_1', 'msg_2'],
  proposalId: 'prop_7',
};

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const main = (r: RoomRepository, files: Record<string, string | null>, subject: string, meta: CommitMeta = agent) =>
  r.withMainLock(() => r.commitToMain(files, subject, meta));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'quorum-git-'));
  repo = await createGitProvider(root).open('room_test');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('init', () => {
  it('creates bare repo, main branch, initial commit, main worktree and hook; is idempotent', async () => {
    expect(repo.bareDir).toBe(join(root, 'rooms', 'room_test', 'repo.git'));
    expect(repo.mainWorktree).toBe(join(root, 'rooms', 'room_test', 'worktrees', 'main'));
    expect(existsSync(join(repo.mainWorktree, '.git'))).toBe(true);
    expect(await repo.listBranches()).toEqual(['main']);
    const head = await repo.headSha();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(repo.bareDir, 'config', 'user.email').trim()).toBe('quorum@localhost');
    expect(sh(repo.bareDir, 'config', 'core.hooksPath').trim()).toMatch(/hooks$/);
    expect(existsSync(join(sh(repo.bareDir, 'config', 'core.hooksPath').trim(), 'pre-commit'))).toBe(true);

    await repo.init();
    // a fresh provider on the same directory finds the existing repo
    const again = await createGitProvider(root).open('room_test');
    expect(await again.headSha()).toBe(head);
    expect(await again.listBranches()).toEqual(['main']);
    expect(await again.headSha('does-not-exist')).toBeNull();
  });

  it('rejects unsafe room ids', async () => {
    await expect(createGitProvider(root).open('../evil')).rejects.toThrow();
  });
});

describe('commitToMain and trailers', () => {
  it('commits and round-trips trailers through show/log', async () => {
    const sha = await main(repo, { 'A.md': '# A\n\nhello\n' }, 'Add A', agent);
    const c = await repo.show(sha);
    expect(c).toMatchObject({ sha, subject: 'Add A', body: '', authorName: 'Quorum', files: ['A.md'] });
    expect(c.trailers).toEqual({
      actor: 'agent:orchestrator',
      triggerMessageIds: ['msg_1', 'msg_2'],
      proposalId: 'prop_7',
      revertsSha: null,
    });
    const sha2 = await main(repo, { 'A.md': '# A\n\nhello world\n' }, 'Edit A', user);
    const log = await repo.log('A.md');
    expect(log.map((x) => x.sha)).toEqual([sha2, sha]);
    expect(log[0]!.trailers.actor).toBe('user:user_1');
    expect(log[0]!.trailers.triggerMessageIds).toEqual([]);
    expect(await repo.log(null, 'main', 1)).toHaveLength(1);
    expect((await repo.log(null)).at(-1)!.subject).toBe('Initialize room');
  });

  it('reads files, lists files, deletes, and throws when nothing changed', async () => {
    await main(repo, { 'A.md': '# A\n', 'B.md': '# B\n' }, 'Add');
    expect(await repo.readFile('A.md')).toBe('# A\n');
    expect(await repo.readFile('Nope.md')).toBeNull();
    expect((await repo.listFiles()).sort()).toEqual(['A.md', 'B.md']);
    await expect(main(repo, { 'A.md': '# A\n' }, 'Same')).rejects.toThrow(/nothing to commit/);
    await main(repo, { 'B.md': null }, 'Delete B');
    expect(await repo.listFiles()).toEqual(['A.md']);
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n');
    await expect(main(repo, { '../x.md': 'x' }, 'bad')).rejects.toThrow(/invalid path/);
  });

  it('serializes withMainLock callers', async () => {
    const order: string[] = [];
    const slow = repo.withMainLock(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-end');
    });
    const failing = repo.withMainLock(async () => {
      order.push('b');
      throw new Error('x');
    });
    const last = repo.withMainLock(async () => {
      order.push('c');
    });
    await expect(failing).rejects.toThrow('x');
    await Promise.all([slow, last]);
    expect(order).toEqual(['a-start', 'a-end', 'b', 'c']);
  });
});

describe('formatter', () => {
  it('normalizes markdown with prettier (preserve wrap) in commitToMain', async () => {
    const raw = '# T\n\nSome *emphasis* here\nsecond line stays on its own line   \n\n\n\n* item   \n';
    await main(repo, { 'F.md': raw }, 'Add F');
    const stored = (await repo.readFile('F.md'))!;
    expect(stored).toContain('_emphasis_');
    expect(stored).not.toMatch(/ +\n/);
    expect(stored).not.toMatch(/\n\n\n/);
    expect(stored).toContain('here\nsecond line stays on its own line');
    expect(stored).toBe(readFileSync(join(repo.mainWorktree, 'F.md'), 'utf8'));
  });

  it('uses a custom formatter when provided', async () => {
    const r = await createGitProvider(root, { formatter: (m) => m.toUpperCase() }).open('room_custom');
    await main(r, { 'U.md': 'abc\n', 'data.txt': 'abc\n' }, 'Add');
    expect(await r.readFile('U.md')).toBe('ABC\n');
    expect(await r.readFile('data.txt')).toBe('abc\n');
  });

  it('pre-commit hook formats staged markdown even for plain git commits', async () => {
    const { worktreePath } = await repo.createBranch('doc/hook/a');
    writeFileSync(join(worktreePath, 'H.md'), '# H\n\nSome *emphasis*   \n\n\n\ntext\n');
    sh(worktreePath, 'add', '-A');
    sh(worktreePath, 'commit', '-m', 'raw commit');
    expect(await repo.readFile('H.md', 'doc/hook/a')).toBe('# H\n\nSome _emphasis_\n\ntext\n');
  });

  it('commitWorktree formats, commits with trailers, and returns null when clean', async () => {
    const { worktreePath } = await repo.createBranch('doc/wt/a');
    expect(await repo.commitWorktree(worktreePath, 'noop', agent)).toBeNull();
    writeFileSync(join(worktreePath, 'W.md'), '# W\n\n*x*\n');
    const sha = (await repo.commitWorktree(worktreePath, 'Add W', agent))!;
    expect((await repo.show(sha)).trailers.proposalId).toBe('prop_7');
    expect(await repo.readFile('W.md', 'doc/wt/a')).toBe('# W\n\n_x_\n');
  });
});

describe('branches and merging', () => {
  it('creates a branch worktree, fast-forwards main', async () => {
    const base = await main(repo, { 'A.md': '# A\n\none\n' }, 'Add A');
    const { worktreePath, baseSha } = await repo.createBranch('a/topic/x');
    expect(baseSha).toBe(base);
    expect(worktreePath).toBe(join(root, 'rooms', 'room_test', 'worktrees', 'a__topic__x'));
    expect(await repo.listBranches()).toEqual(['a/topic/x', 'main']);
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\none\n\ntwo\n');
    const head = (await repo.commitWorktree(worktreePath, 'Branch edit', agent))!;
    expect(await repo.changedFiles(base, 'a/topic/x')).toEqual(['A.md']);
    expect(await repo.mergeBase('main', 'a/topic/x')).toBe(base);

    const out = await repo.withMainLock(() => repo.beginMerge('a/topic/x'));
    expect(out).toEqual({ status: 'fast-forward', newMainSha: head, worktreePath: null, conflictedFiles: [] });
    expect(await repo.headSha('main')).toBe(head);
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\none\n\ntwo\n');

    await repo.removeWorktree('a/topic/x');
    expect(existsSync(worktreePath)).toBe(false);
    await repo.deleteBranch('a/topic/x');
    expect(await repo.listBranches()).toEqual(['main']);
    await expect(repo.deleteBranch('main')).rejects.toThrow();
  });

  it('non-fast-forward clean merge: begin, finish, main advances with trailers', async () => {
    await main(repo, { 'A.md': '# A\n\none\n\ntwo\n\nthree\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/t/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nONE\n\ntwo\n\nthree\n');
    await repo.commitWorktree(worktreePath, 'Branch edit', agent);
    const mainHead = await main(repo, { 'A.md': '# A\n\none\n\ntwo\n\nTHREE\n' }, 'Main edit', user);

    const out = await repo.withMainLock(() => repo.beginMerge('a/t/x'));
    expect(out.status).toBe('clean');
    expect(out.newMainSha).toBeNull();
    expect(out.conflictedFiles).toEqual([]);
    expect(out.worktreePath).toMatch(/worktrees\/merge-a__t__x-/);
    expect(await repo.headSha('main')).toBe(mainHead); // main untouched until finish

    const sha = await repo.withMainLock(() => repo.finishMerge(out.worktreePath!, 'Merge x', agent));
    expect(await repo.headSha('main')).toBe(sha);
    expect(existsSync(out.worktreePath!)).toBe(false);
    expect(await repo.readFile('A.md')).toBe('# A\n\nONE\n\ntwo\n\nTHREE\n');
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nONE\n\ntwo\n\nTHREE\n');
    const c = await repo.show(sha);
    expect(c.trailers.actor).toBe('agent:orchestrator');
    expect(c.files).toEqual(['A.md']);
    expect(sh(repo.bareDir, 'rev-list', '--parents', '-n1', sha).trim().split(' ')).toHaveLength(3);
  });

  it('detects conflicts, refuses to finish with markers, finishes after resolution', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/c/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nbranch\n');
    await repo.commitWorktree(worktreePath, 'Branch', agent);
    await main(repo, { 'A.md': '# A\n\nmain\n' }, 'Main edit', user);

    const out = await repo.withMainLock(() => repo.beginMerge('a/c/x'));
    expect(out.status).toBe('conflict');
    expect(out.conflictedFiles).toEqual(['A.md']);
    const wt = out.worktreePath!;
    expect(readFileSync(join(wt, 'A.md'), 'utf8')).toContain('<<<<<<<');
    await expect(repo.finishMerge(wt, 'Merge', agent)).rejects.toThrow(/conflict/);

    writeFileSync(join(wt, 'A.md'), '# A\n\nboth\n');
    const sha = await repo.finishMerge(wt, 'Merge resolved', agent);
    expect(await repo.readFile('A.md', sha)).toBe('# A\n\nboth\n');
  });

  it('abortMerge removes the worktree and leaves main alone', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/ab/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nbranch\n');
    await repo.commitWorktree(worktreePath, 'Branch', agent);
    const head = await main(repo, { 'A.md': '# A\n\nmain\n' }, 'Main edit', user);
    const out = await repo.beginMerge('a/ab/x');
    await repo.abortMerge(out.worktreePath!);
    expect(existsSync(out.worktreePath!)).toBe(false);
    expect(await repo.headSha()).toBe(head);
    expect(sh(repo.bareDir, 'worktree', 'list')).not.toContain('merge-');
  });

  it('finishMerge fails when main moved meanwhile', async () => {
    await main(repo, { 'A.md': '# A\n\none\n\ntwo\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/mv/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nONE\n\ntwo\n');
    await repo.commitWorktree(worktreePath, 'Branch', agent);
    await main(repo, { 'A.md': '# A\n\none\n\nTWO\n' }, 'Main edit', user);
    const out = await repo.beginMerge('a/mv/x');
    expect(out.status).toBe('clean');
    const moved = await main(repo, { 'B.md': '# B\n' }, 'Main moves', user);
    await expect(repo.finishMerge(out.worktreePath!, 'Merge', agent)).rejects.toThrow(/main moved/);
    expect(await repo.headSha()).toBe(moved);
    await repo.abortMerge(out.worktreePath!);
  });

  it('creates detached worktrees', async () => {
    const head = await repo.headSha();
    const p = await repo.createDetachedWorktree('merge-driver', 'main');
    expect(p).toBe(join(root, 'rooms', 'room_test', 'worktrees', 'merge-driver'));
    expect(sh(p, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(sh(p, 'branch', '--show-current').trim()).toBe('');
    await repo.removeWorktree('merge-driver');
    expect(existsSync(p)).toBe(false);
  });
});

describe('revert', () => {
  it('reverts a commit with a Quorum-Reverts trailer', async () => {
    await main(repo, { 'A.md': '# A\n\none\n' }, 'Add A');
    const bad = await main(repo, { 'A.md': '# A\n\none\n\nbad\n' }, 'Add bad', agent);
    const sha = await repo.withMainLock(() => repo.revert(bad, user));
    expect(await repo.readFile('A.md')).toBe('# A\n\none\n');
    const c = await repo.show(sha);
    expect(c.subject).toBe('Revert "Add bad"');
    expect(c.trailers.revertsSha).toBe(bad);
    expect(c.trailers.actor).toBe('user:user_1');
    expect(c.body).toContain(`This reverts commit ${bad}`);
  });

  it('reverts a merge commit', async () => {
    await main(repo, { 'A.md': '# A\n\none\n\ntwo\n\nthree\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/rv/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nONE\n\ntwo\n\nthree\n');
    await repo.commitWorktree(worktreePath, 'Branch edit', agent);
    await main(repo, { 'A.md': '# A\n\none\n\ntwo\n\nTHREE\n' }, 'Main edit', user);
    const out = await repo.beginMerge('a/rv/x');
    const merge = await repo.finishMerge(out.worktreePath!, 'Merge', agent);
    await repo.revert(merge, user);
    expect(await repo.readFile('A.md')).toBe('# A\n\none\n\ntwo\n\nTHREE\n');
  });

  it('throws RevertConflictError and leaves main clean when later commits conflict', async () => {
    await main(repo, { 'A.md': '# A\n\none\n' }, 'Add A');
    const first = await main(repo, { 'A.md': '# A\n\ntwo\n' }, 'one -> two');
    const second = await main(repo, { 'A.md': '# A\n\nthree\n' }, 'two -> three');
    let err: unknown;
    try {
      await repo.withMainLock(() => repo.revert(first, user));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RevertConflictError);
    expect((err as RevertConflictError).conflictedFiles).toEqual(['A.md']);
    expect((err as RevertConflictError).sha).toBe(first);
    expect(await repo.headSha()).toBe(second);
    expect(sh(repo.mainWorktree, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nthree\n');
  });
});

describe('history queries', () => {
  it('logLines, blame, diff, rewrittenLineCount, tag', async () => {
    const c1 = await main(repo, { 'A.md': '# A\n\nalpha\n\nbeta\n\ngamma\n' }, 'Add A', agent);
    const c2 = await main(repo, { 'A.md': '# A\n\nalpha\n\nBETA\n\ngamma\n\ndelta\n' }, 'Edit beta', user);
    const c3 = await main(repo, { 'A.md': '# A\n\nalpha\n\nBETA\n\ngamma\n\ndelta\n\nepsilon\n' }, 'Add epsilon', agent);

    const betaHistory = await repo.logLines('A.md', 5, 5);
    expect(betaHistory.map((c) => c.sha)).toEqual([c2, c1]);
    expect(betaHistory[0]!.trailers.actor).toBe('user:user_1');
    expect(betaHistory[0]!.files).toEqual(['A.md']);

    const blame = await repo.blame('A.md');
    expect(blame).toHaveLength(11);
    expect(blame[0]).toEqual({ line: 1, sha: c1, text: '# A' });
    expect(blame[4]).toEqual({ line: 5, sha: c2, text: 'BETA' });
    expect(blame[10]).toEqual({ line: 11, sha: c3, text: 'epsilon' });

    const d = await repo.diff('A.md', c1, c2);
    expect(d).toContain('-beta');
    expect(d).toContain('+BETA');
    expect(d).toContain('+delta');
    expect(await repo.rewrittenLineCount('A.md', c1, c2)).toEqual({ removed: 1, added: 3 });
    expect(await repo.rewrittenLineCount('A.md', c3, c3)).toEqual({ removed: 0, added: 0 });
    expect(await repo.changedFiles(c1, c3)).toEqual(['A.md']);

    await repo.tag('milestone/1', 'First milestone', c2);
    expect(sh(repo.bareDir, 'tag', '-l', '--format=%(objecttype) %(refname:short)')).toContain('tag milestone/1');
    expect(await repo.headSha('milestone/1')).toBe(c2);
  });
});
