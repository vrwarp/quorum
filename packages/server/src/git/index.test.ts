import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RevertConflictError, type CommitMeta, type RoomRepository } from '../contracts/git.js';
import { runGit } from './exec.js';
import { createGitProvider } from './index.js';

let root: string;
let repo: RoomRepository;

const user: CommitMeta = {
  actor: { kind: 'user', userId: 'user_1', displayName: 'Ann' },
  triggerMessageIds: [],
};
const agent: CommitMeta = {
  actor: { kind: 'agent', role: 'orchestrator' },
  triggerMessageIds: ['msg_1', 'msg_2'],
  proposalId: 'prop_7',
};

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const main = (
  r: RoomRepository,
  files: Record<string, string | null>,
  subject: string,
  meta: CommitMeta = agent,
) => r.withMainLock(() => r.commitToMain(files, subject, meta));

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
    expect(
      existsSync(join(sh(repo.bareDir, 'config', 'core.hooksPath').trim(), 'pre-commit')),
    ).toBe(true);

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
    expect(c).toMatchObject({
      sha,
      subject: 'Add A',
      body: '',
      authorName: 'Quorum',
      files: ['A.md'],
    });
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
    const raw =
      '# T\n\nSome *emphasis* here\nsecond line stays on its own line   \n\n\n\n* item   \n';
    await main(repo, { 'F.md': raw }, 'Add F');
    const stored = (await repo.readFile('F.md'))!;
    expect(stored).toContain('_emphasis_');
    expect(stored).not.toMatch(/ +\n/);
    expect(stored).not.toMatch(/\n\n\n/);
    expect(stored).toContain('here\nsecond line stays on its own line');
    expect(stored).toBe(readFileSync(join(repo.mainWorktree, 'F.md'), 'utf8'));
  });

  it('uses a custom formatter when provided', async () => {
    const r = await createGitProvider(root, { formatter: (m) => m.toUpperCase() }).open(
      'room_custom',
    );
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
  it('creates a branch worktree; a branch main has not moved past still merges as a merge commit that Revert undoes whole', async () => {
    const base = await main(repo, { 'A.md': '# A\n\none\n' }, 'Add A');
    const { worktreePath, baseSha } = await repo.createBranch('a/topic/x');
    expect(baseSha).toBe(base);
    expect(worktreePath).toBe(join(root, 'rooms', 'room_test', 'worktrees', 'a__topic__x'));
    expect(await repo.listBranches()).toEqual(['a/topic/x', 'main']);
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\none\n\ntwo\n');
    await repo.commitWorktree(worktreePath, 'Branch edit 1', agent);
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\none\n\ntwo\n\nthree\n');
    const head = (await repo.commitWorktree(worktreePath, 'Branch edit 2', agent))!;
    expect(await repo.changedFiles(base, 'a/topic/x')).toEqual(['A.md']);
    expect(await repo.mergeBase('main', 'a/topic/x')).toBe(base);

    // main has not moved: 'fast-forward' means no reconciliation is owed, not that history is a straight line
    const out = await repo.withMainLock(() => repo.beginMerge('a/topic/x'));
    expect(out).toMatchObject({ status: 'fast-forward', newMainSha: null, conflictedFiles: [] });
    expect(out.worktreePath).toMatch(/worktrees\/merge-a__topic__x-/);
    expect(await repo.headSha('main')).toBe(base); // main is untouched until finishMerge
    const sha = await repo.withMainLock(() =>
      repo.finishMerge(out.worktreePath!, 'Merge x', agent, { paths: ['A.md'] }),
    );
    expect(await repo.headSha('main')).toBe(sha);
    expect(existsSync(out.worktreePath!)).toBe(false);

    // a real merge commit: old main first, the branch head second, and exactly the voted tree
    expect(sh(repo.bareDir, 'rev-list', '--parents', '-n1', sha).trim().split(' ')).toEqual([
      sha,
      base,
      head,
    ]);
    expect(sh(repo.bareDir, 'rev-parse', `${sha}^{tree}`)).toBe(
      sh(repo.bareDir, 'rev-parse', 'a/topic/x^{tree}'),
    );
    expect((await repo.show(sha)).trailers.proposalId).toBe('prop_7');
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe(
      '# A\n\none\n\ntwo\n\nthree\n',
    );
    expect(sh(repo.mainWorktree, 'status', '--porcelain').trim()).toBe('');

    // Revert (first parent) takes back every commit of the branch, not just the last one
    await repo.withMainLock(() => repo.revert(sha, user));
    expect(await repo.readFile('A.md')).toBe('# A\n\none\n');

    // what is already in main cannot be merged again (it would silently merge nothing)
    await expect(repo.beginMerge('a/topic/x')).rejects.toThrow(/already contained in main/);
    expect(sh(repo.bareDir, 'worktree', 'list')).not.toContain('merge-');

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
    const mainHead = await main(
      repo,
      { 'A.md': '# A\n\none\n\ntwo\n\nTHREE\n' },
      'Main edit',
      user,
    );

    const out = await repo.withMainLock(() => repo.beginMerge('a/t/x'));
    expect(out.status).toBe('clean');
    expect(out.newMainSha).toBeNull();
    expect(out.conflictedFiles).toEqual([]);
    expect(out.worktreePath).toMatch(/worktrees\/merge-a__t__x-/);
    expect(await repo.headSha('main')).toBe(mainHead); // main untouched until finish

    const sha = await repo.withMainLock(() =>
      repo.finishMerge(out.worktreePath!, 'Merge x', agent),
    );
    expect(await repo.headSha('main')).toBe(sha);
    expect(existsSync(out.worktreePath!)).toBe(false);
    expect(await repo.readFile('A.md')).toBe('# A\n\nONE\n\ntwo\n\nTHREE\n');
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe(
      '# A\n\nONE\n\ntwo\n\nTHREE\n',
    );
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
    const c2 = await main(
      repo,
      { 'A.md': '# A\n\nalpha\n\nBETA\n\ngamma\n\ndelta\n' },
      'Edit beta',
      user,
    );
    const c3 = await main(
      repo,
      { 'A.md': '# A\n\nalpha\n\nBETA\n\ngamma\n\ndelta\n\nepsilon\n' },
      'Add epsilon',
      agent,
    );

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
    expect(sh(repo.bareDir, 'tag', '-l', '--format=%(objecttype) %(refname:short)')).toContain(
      'tag milestone/1',
    );
    expect(await repo.headSha('milestone/1')).toBe(c2);
  });
});

/** write a base document and a branch that changes it; returns what a merge needs */
async function branchWithEdit(r: RoomRepository, branch: string, text: string) {
  const { worktreePath } = await r.createBranch(branch);
  writeFileSync(join(worktreePath, 'A.md'), text);
  const head = (await r.commitWorktree(worktreePath, `Edit on ${branch}`, agent))!;
  return { worktreePath, head };
}

describe('advancing main (review F2)', () => {
  it('a merge that cannot update the main checkout fails whole: the ref does not move, a later commit does not undo it', async () => {
    const r = await createGitProvider(root, { lockRetries: 2, lockRetryDelayMs: 10 }).open(
      'room_lock',
    );
    await main(r, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const before = (await r.headSha())!;
    await branchWithEdit(r, 'a/lk/x', '# A\n\nvoted\n');
    const out = await r.withMainLock(() => r.beginMerge('a/lk/x'));

    // `git status` run by the orchestrator holds the main worktree's index lock for a moment
    const lock = join(r.bareDir, 'worktrees', 'main', 'index.lock');
    writeFileSync(lock, '');
    await expect(
      r.withMainLock(() => r.finishMerge(out.worktreePath!, 'Merge lk', agent)),
    ).rejects.toThrow(/could not advance main; merge not applied/);
    expect(await r.headSha()).toBe(before); // ref and checkout still agree
    expect(readFileSync(join(r.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nbase\n');
    rmSync(lock);
    expect(sh(r.mainWorktree, 'status', '--porcelain').trim()).toBe('');
    await r.abortMerge(out.worktreePath!);

    // the proposal is merged again (a new vote) and an unrelated commit afterwards keeps the merged text
    const again = await r.withMainLock(() => r.beginMerge('a/lk/x'));
    await r.withMainLock(() => r.finishMerge(again.worktreePath!, 'Merge lk', agent));
    await main(r, { 'Other.md': '# Other\n' }, 'Create Other.md', user);
    expect(await r.readFile('A.md')).toBe('# A\n\nvoted\n');
  });

  it('waits out an index.lock that goes away within a moment', async () => {
    const r = await createGitProvider(root, { lockRetries: 6, lockRetryDelayMs: 40 }).open(
      'room_wait',
    );
    await main(r, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    await branchWithEdit(r, 'a/wt/x', '# A\n\nvoted\n');
    const out = await r.withMainLock(() => r.beginMerge('a/wt/x'));
    const lock = join(r.bareDir, 'worktrees', 'main', 'index.lock');
    writeFileSync(lock, '');
    setTimeout(() => rmSync(lock, { force: true }), 100);
    const sha = await r.withMainLock(() => r.finishMerge(out.worktreePath!, 'Merge wt', agent));
    expect(await r.headSha()).toBe(sha);
    expect(readFileSync(join(r.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nvoted\n');
  });

  it('refuses to merge over uncommitted edits to the same file, and keeps them', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const before = (await repo.headSha())!;
    await branchWithEdit(repo, 'a/dirty/x', '# A\n\nvoted\n');
    const out = await repo.withMainLock(() => repo.beginMerge('a/dirty/x'));
    writeFileSync(join(repo.mainWorktree, 'A.md'), '# A\n\nbase\n\nhalf-typed edit\n');
    await expect(
      repo.withMainLock(() => repo.finishMerge(out.worktreePath!, 'Merge', agent)),
    ).rejects.toThrow(/could not advance main/);
    expect(await repo.headSha()).toBe(before);
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toContain('half-typed edit');
  });

  it('keeps unrelated uncommitted files when it does advance', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    await branchWithEdit(repo, 'a/keep/x', '# A\n\nvoted\n');
    writeFileSync(join(repo.mainWorktree, 'Scratch.md'), 'orchestrator notes\n');
    const out = await repo.withMainLock(() => repo.beginMerge('a/keep/x'));
    await repo.withMainLock(() => repo.finishMerge(out.worktreePath!, 'Merge', agent));
    expect(readFileSync(join(repo.mainWorktree, 'Scratch.md'), 'utf8')).toBe(
      'orchestrator notes\n',
    );
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nvoted\n');
  });

  it('finishMerge refuses a merge that changes files outside the allowed paths', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const { worktreePath } = await repo.createBranch('a/scope/x');
    writeFileSync(join(worktreePath, 'A.md'), '# A\n\nvoted\n');
    writeFileSync(join(worktreePath, 'Secret.md'), 'another document\n');
    await repo.commitWorktree(worktreePath, 'Edit two files', agent);
    const out = await repo.withMainLock(() => repo.beginMerge('a/scope/x'));
    await expect(
      repo.withMainLock(() =>
        repo.finishMerge(out.worktreePath!, 'Merge', agent, { paths: ['A.md'] }),
      ),
    ).rejects.toThrow(/Secret\.md, outside A\.md/);
    await repo.abortMerge(out.worktreePath!);
    expect(await repo.listFiles()).toEqual(['A.md']);
  });
});

describe('never sweeping unrelated uncommitted files (review F3)', () => {
  it('commitToMain commits only the files it wrote; a staged or dirty neighbour stays as it was', async () => {
    await main(repo, { 'Plan.md': '# Plan\n', 'ab.md': '# ab\n' }, 'Add docs');
    writeFileSync(join(repo.mainWorktree, 'Plan.md'), '# Plan\n\norchestrator half-done edit\n');
    writeFileSync(join(repo.mainWorktree, 'Staged.md'), 'staged by someone\n');
    sh(repo.mainWorktree, 'add', 'Staged.md');
    writeFileSync(join(repo.mainWorktree, 'ab.md'), '# ab\n\ndirty\n');
    const sha = await main(repo, { 'a*.md': '# star\n', 'Other.md': '# Other\n' }, 'Create two');
    expect(
      sh(repo.bareDir, 'show', '--name-only', '--format=', sha).trim().split('\n').sort(),
    ).toEqual(['Other.md', 'a*.md']); // 'ab.md' is not matched by the glob in a literal name
    expect(readFileSync(join(repo.mainWorktree, 'Plan.md'), 'utf8')).toContain('half-done edit');
    expect(readFileSync(join(repo.mainWorktree, 'ab.md'), 'utf8')).toContain('dirty');
    expect(sh(repo.mainWorktree, 'status', '--porcelain')).toContain('?? Staged.md');
  });

  it('commitWorktree with paths commits only those, formatted; without paths it commits everything', async () => {
    await main(repo, { 'Plan.md': '# Plan\n' }, 'Add Plan');
    writeFileSync(join(repo.mainWorktree, 'Plan.md'), '# Plan\n\n*edited*\n');
    writeFileSync(join(repo.mainWorktree, 'Other.md'), '# Other\n\nnot mine\n');
    const sha = (await repo.withMainLock(() =>
      repo.commitWorktree(repo.mainWorktree, 'Edit Plan', agent, ['Plan.md']),
    ))!;
    expect(sh(repo.bareDir, 'show', '--name-only', '--format=', sha).trim()).toBe('Plan.md');
    expect(await repo.readFile('Plan.md')).toBe('# Plan\n\n_edited_\n');
    expect(sh(repo.mainWorktree, 'status', '--porcelain').trim()).toBe('?? Other.md');
    expect(await repo.commitWorktree(repo.mainWorktree, 'nothing', agent, ['Plan.md'])).toBeNull();
    expect(await repo.commitWorktree(repo.mainWorktree, 'nothing', agent, [])).toBeNull();
    const all = (await repo.commitWorktree(repo.mainWorktree, 'Everything', agent))!;
    expect(sh(repo.bareDir, 'show', '--name-only', '--format=', all).trim()).toBe('Other.md');
    await expect(repo.commitWorktree(repo.mainWorktree, 'bad', agent, ['../x.md'])).rejects.toThrow(
      /invalid path/,
    );
  });

  it('a revert commits only what the reverted commit changed and leaves unrelated edits alone', async () => {
    await main(repo, { 'Plan.md': '# Plan\n' }, 'Add Plan');
    const notes = await main(repo, { 'Notes.md': '# Notes\n' }, 'notes');
    writeFileSync(join(repo.mainWorktree, 'Plan.md'), '# Plan\n\norchestrator half-done edit\n');
    sh(repo.mainWorktree, 'add', 'Plan.md'); // even staged by the orchestrator
    const rev = await repo.withMainLock(() => repo.revert(notes, user));
    expect(sh(repo.bareDir, 'show', '--name-only', '--format=', rev).trim()).toBe('Notes.md');
    expect(readFileSync(join(repo.mainWorktree, 'Plan.md'), 'utf8')).toContain('half-done edit');
    expect(await repo.readFile('Plan.md')).toBe('# Plan\n');
  });

  it('a revert that cannot run (the file is being edited) fails without destroying the edit', async () => {
    await main(repo, { 'Plan.md': '# Plan\n' }, 'Add Plan');
    const add = await main(repo, { 'Plan.md': '# Plan\n\nadded\n' }, 'add');
    writeFileSync(join(repo.mainWorktree, 'Plan.md'), '# Plan\n\nadded\n\nin-progress paragraph\n');
    await expect(repo.withMainLock(() => repo.revert(add, user))).rejects.toThrow(
      /git revert failed/,
    );
    expect(readFileSync(join(repo.mainWorktree, 'Plan.md'), 'utf8')).toContain(
      'in-progress paragraph',
    );
  });

  it('a conflicting revert is aborted and unrelated uncommitted edits survive it', async () => {
    await main(repo, { 'A.md': '# A\n\none\n', 'Plan.md': '# Plan\n' }, 'Add');
    const first = await main(repo, { 'A.md': '# A\n\ntwo\n' }, 'one -> two');
    await main(repo, { 'A.md': '# A\n\nthree\n' }, 'two -> three');
    writeFileSync(join(repo.mainWorktree, 'Plan.md'), '# Plan\n\nhalf-done\n');
    writeFileSync(join(repo.mainWorktree, 'Scratch.md'), 'scratch\n');
    await expect(repo.withMainLock(() => repo.revert(first, user))).rejects.toBeInstanceOf(
      RevertConflictError,
    );
    expect(readFileSync(join(repo.mainWorktree, 'Plan.md'), 'utf8')).toContain('half-done');
    expect(readFileSync(join(repo.mainWorktree, 'Scratch.md'), 'utf8')).toBe('scratch\n');
    expect(readFileSync(join(repo.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nthree\n');
    expect(existsSync(join(repo.bareDir, 'worktrees', 'main', 'REVERT_HEAD'))).toBe(false);
  });
});

describe('file names are never options (review F11) and git trusts the data directory', () => {
  it('commits documents whose names look like command-line options through the real formatter hook', async () => {
    const dashed = await main(
      repo,
      { '-l.md': '# L\n\nSome *text*\n', '--plugin=evil.md': '# E\n', '--check.md': '# C\n' },
      'Create dashed names',
      user,
    );
    expect((await repo.show(dashed)).files.sort()).toEqual([
      '--check.md',
      '--plugin=evil.md',
      '-l.md',
    ]);
    expect(await repo.readFile('-l.md')).toBe('# L\n\nSome _text_\n');
    // and plain git commits in a worktree take the same route through the hook
    const { worktreePath } = await repo.createBranch('doc/dash/a');
    writeFileSync(join(worktreePath, '-x.md'), '# X\n\n*y*\n');
    sh(worktreePath, 'add', '--', '-x.md');
    sh(worktreePath, 'commit', '-m', 'raw commit');
    expect(await repo.readFile('-x.md', 'doc/dash/a')).toBe('# X\n\n_y_\n');
  });

  it('passes safe.directory=* to every git call, which the server needs because it ignores the system config', async () => {
    const r = await runGit(['config', '--get-all', 'safe.directory'], { cwd: repo.bareDir });
    expect(r.stdout.trim()).toBe('*');
    expect(
      readFileSync(join(sh(repo.bareDir, 'config', 'core.hooksPath').trim(), 'pre-commit'), 'utf8'),
    ).toContain("safe.directory='*'");
  });
});

describe('opening a repository after a crash (review F17)', () => {
  it('removes stale merge worktrees and lock files and discards half-finished work in the main worktree', async () => {
    await main(repo, { 'A.md': '# A\n\nbase\n' }, 'Add A');
    const { worktreePath: keep } = await repo.createBranch('a/keep/x');
    const stale = await repo.createDetachedWorktree('merge-a__old-abc123', 'main');
    writeFileSync(join(repo.mainWorktree, 'A.md'), '# A\n\nhalf-done edit\n');
    writeFileSync(join(repo.mainWorktree, 'Scratch.md'), 'scratch\n');
    sh(repo.mainWorktree, 'add', 'Scratch.md');
    const locks = [
      join(repo.bareDir, 'worktrees', 'main', 'index.lock'),
      join(repo.bareDir, 'refs', 'heads', 'main.lock'),
      join(repo.bareDir, 'HEAD.lock'),
    ];
    for (const l of locks) writeFileSync(l, '');
    // a merge that was in progress in the main worktree when the process died
    mkdirSync(join(repo.bareDir, 'worktrees', 'main'), { recursive: true });
    writeFileSync(
      join(repo.bareDir, 'worktrees', 'main', 'REVERT_HEAD'),
      `${await repo.headSha()}\n`,
    );

    const reopened = await createGitProvider(root).open('room_test'); // a new process: a new provider
    expect(existsSync(stale)).toBe(false);
    expect(sh(reopened.bareDir, 'worktree', 'list')).not.toContain('merge-');
    for (const l of locks) expect(existsSync(l), l).toBe(false);
    expect(existsSync(keep)).toBe(true); // option worktrees are not ours to remove at start
    expect(sh(reopened.mainWorktree, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(reopened.mainWorktree, 'A.md'), 'utf8')).toBe('# A\n\nbase\n');
    expect(existsSync(join(reopened.mainWorktree, 'Scratch.md'))).toBe(false);
    // and it works: the next commit contains only itself
    const sha = await main(reopened, { 'B.md': '# B\n' }, 'Add B');
    expect(sh(reopened.bareDir, 'show', '--name-only', '--format=', sha).trim()).toBe('B.md');
  });
});
