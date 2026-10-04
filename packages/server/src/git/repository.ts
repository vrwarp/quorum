import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile as fsReadFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { TRAILERS, type ActorRef, type Sha } from '@quorum/shared';
import {
  RevertConflictError,
  type BlameLine,
  type CommitInfo,
  type CommitMeta,
  type MergeOutcome,
  type RoomRepository,
} from '../contracts/git.js';
import { runGit, type GitResult } from './exec.js';
import {
  preCommitHookScript,
  prettierFormatter,
  resolvePrettierBin,
  type MarkdownFormatter,
} from './format.js';

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}:+-]*$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_FORMAT = '%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%(trailers:only,unfold)%x1f';

export function serializeActor(actor: ActorRef): string {
  return actor.kind === 'user' ? `user:${actor.userId}` : `agent:${actor.role}`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function assertRef(ref: string): string {
  if (!SAFE_REF.test(ref)) throw new Error(`invalid ref: ${JSON.stringify(ref)}`);
  return ref;
}

function assertBranch(branch: string): string {
  if (
    !SAFE_BRANCH.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock')
  ) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
  return branch;
}

/** Normalize a repo-relative path; rejects absolute paths and parent traversal. */
function safePath(path: string): string {
  const n = posix.normalize(path);
  if (
    !path ||
    path.includes('\0') ||
    posix.isAbsolute(n) ||
    n === '..' ||
    n.startsWith('../') ||
    n === '.'
  ) {
    throw new Error(`invalid path: ${JSON.stringify(path)}`);
  }
  return n;
}

function worktreeDirName(name: string): string {
  return name.replace(/\//g, '__');
}

const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);
const nulList = (s: string) => s.split('\0').filter((l) => l.length > 0);

export class GitRoomRepository implements RoomRepository {
  readonly roomId: string;
  readonly bareDir: string;
  readonly mainWorktree: string;
  private readonly roomDir: string;
  private readonly worktreesDir: string;
  private readonly hooksDir: string;
  private readonly format: MarkdownFormatter;
  private lockTail: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<void> | null = null;

  constructor(rootDir: string, roomId: string, formatter?: MarkdownFormatter) {
    if (!SAFE_NAME.test(roomId)) throw new Error(`invalid room id: ${JSON.stringify(roomId)}`);
    this.roomId = roomId;
    this.roomDir = resolve(rootDir, 'rooms', roomId);
    this.bareDir = join(this.roomDir, 'repo.git');
    this.worktreesDir = join(this.roomDir, 'worktrees');
    this.mainWorktree = join(this.worktreesDir, 'main');
    this.hooksDir = join(this.roomDir, 'hooks');
    this.format = formatter ?? prettierFormatter;
  }

  // ---- plumbing helpers ----

  private git(args: string[], cwd: string = this.bareDir): Promise<GitResult> {
    return runGit(args, { cwd });
  }

  private gitTry(args: string[], cwd: string = this.bareDir): Promise<GitResult> {
    return runGit(args, { cwd, allowFail: true });
  }

  private async out(args: string[], cwd?: string): Promise<string> {
    return (await this.git(args, cwd)).stdout;
  }

  private async revParse(ref: string, cwd?: string): Promise<Sha> {
    return (await this.out(['rev-parse', '--verify', `${assertRef(ref)}^{commit}`], cwd)).trim();
  }

  private assertWorktree(path: string): string {
    const p = resolve(path);
    if (!p.startsWith(this.worktreesDir + sep) || p === this.mainWorktree) {
      throw new Error(`not a managed worktree: ${path}`);
    }
    return p;
  }

  private worktreePathFor(name: string): string {
    const dir = worktreeDirName(name);
    if (!SAFE_NAME.test(dir) || dir.includes('..'))
      throw new Error(`invalid worktree name: ${JSON.stringify(name)}`);
    return join(this.worktreesDir, dir);
  }

  withMainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(() => fn());
    this.lockTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- init ----

  init(): Promise<void> {
    this.initPromise ??= this.doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await mkdir(this.worktreesDir, { recursive: true });
    if (!existsSync(join(this.bareDir, 'HEAD'))) {
      await this.git(['init', '--bare', '--initial-branch=main', this.bareDir], this.roomDir);
    }

    // hook + repo-level config (rewritten every time so a moved node_modules heals itself)
    await mkdir(this.hooksDir, { recursive: true });
    const hookPath = join(this.hooksDir, 'pre-commit');
    await writeFile(hookPath, preCommitHookScript(process.execPath, resolvePrettierBin()), 'utf8');
    await chmod(hookPath, 0o755);
    const config: Array<[string, string]> = [
      ['user.name', 'Quorum'],
      ['user.email', 'quorum@localhost'],
      ['core.hooksPath', this.hooksDir],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['gc.auto', '0'],
    ];
    for (const [k, v] of config) await this.git(['config', k, v]);

    if ((await this.headSha('main')) === null) {
      const tree = (
        await runGit(['hash-object', '-t', 'tree', '-w', '--stdin'], {
          cwd: this.bareDir,
          input: '',
        })
      ).stdout.trim();
      const commit = (
        await this.out([
          'commit-tree',
          tree,
          '-m',
          'Initialize room',
          '-m',
          `${TRAILERS.actor}: agent:system`,
        ])
      ).trim();
      await this.git(['update-ref', 'refs/heads/main', commit]);
    }

    await this.git(['worktree', 'prune']);
    if (!existsSync(join(this.mainWorktree, '.git'))) {
      await rm(this.mainWorktree, { recursive: true, force: true });
      await this.git(['worktree', 'add', this.mainWorktree, 'main']);
    }
  }

  // ---- commits ----

  private trailerArgs(meta: CommitMeta, extra?: { reverts?: string }): string[] {
    const t: string[] = [`${TRAILERS.actor}: ${serializeActor(meta.actor)}`];
    if (meta.triggerMessageIds.length > 0)
      t.push(`${TRAILERS.trigger}: ${meta.triggerMessageIds.map(oneLine).join(',')}`);
    if (meta.proposalId) t.push(`${TRAILERS.proposal}: ${oneLine(meta.proposalId)}`);
    const reverts = meta.revertsSha ?? extra?.reverts;
    if (reverts) t.push(`${TRAILERS.reverts}: ${oneLine(reverts)}`);
    return t.flatMap((x) => ['--trailer', x]);
  }

  private async hasStaged(cwd: string): Promise<boolean> {
    return (await this.gitTry(['diff', '--cached', '--quiet'], cwd)).code !== 0;
  }

  /** Commit the index in `cwd` with trailers; returns the new HEAD sha. */
  private async commit(
    cwd: string,
    subject: string,
    meta: CommitMeta,
    body?: string,
    extra?: { reverts?: string },
  ): Promise<Sha> {
    const args = [
      '-c',
      'trailer.ifexists=addIfDifferent',
      'commit',
      '-m',
      oneLine(subject) || 'Update',
    ];
    if (body) args.push('-m', body);
    args.push(...this.trailerArgs(meta, extra));
    await this.git(args, cwd);
    return (await this.out(['rev-parse', 'HEAD'], cwd)).trim();
  }

  private async formatMarkdownFiles(cwd: string, files: string[]): Promise<void> {
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const abs = join(cwd, f);
      if (!existsSync(abs)) continue;
      const before = await fsReadFile(abs, 'utf8');
      const after = await this.format(before);
      if (after !== before) await writeFile(abs, after, 'utf8');
    }
  }

  /** format every modified or untracked markdown file of a worktree (relative to HEAD) */
  private async formatDirtyMarkdown(cwd: string): Promise<void> {
    const changed = nulList(await this.out(['diff', '--name-only', '-z', 'HEAD'], cwd));
    const untracked = nulList(await this.out(['ls-files', '-o', '--exclude-standard', '-z'], cwd));
    await this.formatMarkdownFiles(cwd, [...new Set([...changed, ...untracked])]);
  }

  async commitToMain(
    files: Record<string, string | null>,
    subject: string,
    meta: CommitMeta,
  ): Promise<Sha> {
    for (const [rawPath, content] of Object.entries(files)) {
      const path = safePath(rawPath);
      const abs = join(this.mainWorktree, path);
      if (content === null) {
        await rm(abs, { force: true });
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, path.endsWith('.md') ? await this.format(content) : content, 'utf8');
    }
    await this.git(['add', '-A'], this.mainWorktree);
    if (!(await this.hasStaged(this.mainWorktree))) throw new Error('nothing to commit');
    return this.commit(this.mainWorktree, subject, meta);
  }

  async commitWorktree(
    worktreePath: string,
    subject: string,
    meta: CommitMeta,
  ): Promise<Sha | null> {
    const cwd = resolve(worktreePath);
    if (cwd !== this.mainWorktree) this.assertWorktree(cwd);
    await this.formatDirtyMarkdown(cwd);
    await this.git(['add', '-A'], cwd);
    if (!(await this.hasStaged(cwd))) return null;
    return this.commit(cwd, subject, meta);
  }

  // ---- reads ----

  async headSha(ref = 'main'): Promise<Sha | null> {
    const r = await this.gitTry(['rev-parse', '--verify', '--quiet', `${assertRef(ref)}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async readFile(path: string, ref = 'main'): Promise<string | null> {
    const r = await this.gitTry(['show', `${assertRef(ref)}:${safePath(path)}`]);
    return r.code === 0 ? r.stdout : null;
  }

  async listFiles(ref = 'main'): Promise<string[]> {
    return nulList(await this.out(['ls-tree', '-r', '--name-only', '-z', assertRef(ref)]));
  }

  private parseCommits(stdout: string, fallbackFiles?: string[]): CommitInfo[] {
    return stdout
      .split('\x1e')
      .slice(1)
      .map((rec) => {
        const [sha, authorName, authoredAt, subject, rawBody, trailerText, rest] =
          rec.split('\x1f');
        const trailers: CommitInfo['trailers'] = {
          actor: null,
          triggerMessageIds: [],
          proposalId: null,
          revertsSha: null,
        };
        let hasTrailers = false;
        for (const line of lines(trailerText ?? '')) {
          const m = /^([^:\s]+):\s*(.*)$/.exec(line);
          if (!m) continue;
          hasTrailers = true;
          const key = m[1]!.toLowerCase();
          const value = m[2]!.trim();
          if (key === TRAILERS.actor.toLowerCase()) trailers.actor = value;
          else if (key === TRAILERS.trigger.toLowerCase())
            trailers.triggerMessageIds.push(
              ...value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            );
          else if (key === TRAILERS.proposal.toLowerCase()) trailers.proposalId = value;
          else if (key === TRAILERS.reverts.toLowerCase()) trailers.revertsSha = value;
        }
        let body = (rawBody ?? '').replace(/\s+$/, '');
        if (hasTrailers) {
          const idx = body.lastIndexOf('\n\n');
          body = idx === -1 ? '' : body.slice(0, idx).replace(/\s+$/, '');
        }
        return {
          sha: sha!,
          subject: subject ?? '',
          body,
          authorName: authorName ?? '',
          authoredAt: authoredAt ?? '',
          trailers,
          files: fallbackFiles ?? lines(rest ?? ''),
        };
      });
  }

  async log(path: string | null, ref = 'main', limit?: number): Promise<CommitInfo[]> {
    const args = ['log', `--format=${COMMIT_FORMAT}`, '--name-only', '--diff-merges=first-parent'];
    if (limit !== undefined) args.push('-n', String(Math.max(1, Math.floor(limit))));
    args.push(assertRef(ref), '--');
    if (path !== null) args.push(safePath(path));
    return this.parseCommits(await this.out(args));
  }

  async show(sha: Sha): Promise<CommitInfo> {
    const out = await this.out([
      'log',
      '-n',
      '1',
      `--format=${COMMIT_FORMAT}`,
      '--name-only',
      '--diff-merges=first-parent',
      assertRef(sha),
      '--',
    ]);
    const [c] = this.parseCommits(out);
    if (!c) throw new Error(`commit not found: ${sha}`);
    return c;
  }

  async logLines(
    path: string,
    startLine: number,
    endLine: number,
    ref = 'main',
  ): Promise<CommitInfo[]> {
    const p = safePath(path);
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.max(start, Math.floor(endLine));
    const out = await this.out([
      'log',
      '-s',
      `--format=${COMMIT_FORMAT}`,
      `-L${start},${end}:${p}`,
      assertRef(ref),
    ]);
    return this.parseCommits(out, [p]);
  }

  async blame(path: string, ref = 'main'): Promise<BlameLine[]> {
    const out = await this.out(['blame', '--porcelain', assertRef(ref), '--', safePath(path)]);
    const result: BlameLine[] = [];
    let sha = '';
    let finalLine = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('\t')) {
        result.push({ line: finalLine, sha, text: line.slice(1) });
        continue;
      }
      const m = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
      if (m) {
        sha = m[1]!;
        finalLine = Number(m[2]);
      }
    }
    return result;
  }

  async diff(path: string, fromRef: string, toRef: string): Promise<string> {
    return this.out([
      'diff',
      '--no-color',
      '--no-ext-diff',
      assertRef(fromRef),
      assertRef(toRef),
      '--',
      safePath(path),
    ]);
  }

  async changedFiles(fromRef: string, toRef: string): Promise<string[]> {
    return nulList(
      await this.out(['diff', '--name-only', '-z', assertRef(fromRef), assertRef(toRef), '--']),
    );
  }

  async mergeBase(refA: string, refB: string): Promise<Sha> {
    return (await this.out(['merge-base', assertRef(refA), assertRef(refB)])).trim();
  }

  async rewrittenLineCount(
    path: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ removed: number; added: number }> {
    const out = await this.out([
      'diff',
      '--numstat',
      assertRef(fromRef),
      assertRef(toRef),
      '--',
      safePath(path),
    ]);
    let added = 0;
    let removed = 0;
    for (const line of lines(out)) {
      const [a, r] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    return { removed, added };
  }

  // ---- branches and worktrees ----

  async createBranch(
    branch: string,
    fromRef = 'main',
  ): Promise<{ worktreePath: string; baseSha: Sha }> {
    assertBranch(branch);
    const baseSha = await this.revParse(fromRef);
    const worktreePath = this.worktreePathFor(branch);
    await this.git(['worktree', 'prune']);
    await this.git(['worktree', 'add', '-b', branch, worktreePath, baseSha]);
    return { worktreePath, baseSha };
  }

  async removeWorktree(branch: string): Promise<void> {
    const path = this.worktreePathFor(branch);
    if (path === this.mainWorktree) throw new Error('cannot remove the main worktree');
    await this.gitTry(['worktree', 'remove', '--force', path]);
    await rm(path, { recursive: true, force: true });
    await this.git(['worktree', 'prune']);
  }

  async listBranches(): Promise<string[]> {
    return lines(await this.out(['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  }

  async deleteBranch(branch: string): Promise<void> {
    if (assertBranch(branch) === 'main') throw new Error('cannot delete main');
    await this.git(['branch', '-D', branch]);
  }

  async createDetachedWorktree(name: string, ref: string): Promise<string> {
    const path = this.worktreePathFor(name);
    if (path === this.mainWorktree) throw new Error('reserved worktree name');
    await this.git(['worktree', 'prune']);
    await this.git(['worktree', 'add', '--detach', path, await this.revParse(ref)]);
    return path;
  }

  // ---- merging ----

  private async conflictedFiles(cwd: string): Promise<string[]> {
    return nulList(await this.out(['diff', '--name-only', '-z', '--diff-filter=U'], cwd));
  }

  private async fastForwardMain(newSha: Sha, oldSha: Sha): Promise<void> {
    await this.git(['update-ref', 'refs/heads/main', newSha, oldSha]);
    await this.git(['reset', '--hard'], this.mainWorktree);
  }

  async beginMerge(branch: string): Promise<MergeOutcome & { newMainSha: Sha | null }> {
    assertBranch(branch);
    const branchSha = await this.revParse(`refs/heads/${branch}`);
    const mainSha = await this.revParse('refs/heads/main');
    const isAncestor = async (a: string, b: string) =>
      (await this.gitTry(['merge-base', '--is-ancestor', a, b])).code === 0;

    if (await isAncestor(mainSha, branchSha)) {
      if (branchSha !== mainSha) await this.fastForwardMain(branchSha, mainSha);
      return {
        status: 'fast-forward',
        newMainSha: branchSha,
        worktreePath: null,
        conflictedFiles: [],
      };
    }
    if (await isAncestor(branchSha, mainSha)) {
      // everything on the branch is already in main
      return {
        status: 'fast-forward',
        newMainSha: mainSha,
        worktreePath: null,
        conflictedFiles: [],
      };
    }

    const name = `merge-${worktreeDirName(branch)}-${randomBytes(3).toString('hex')}`;
    const worktreePath = await this.createDetachedWorktree(name, mainSha);
    const r = await this.gitTry(['merge', '--no-commit', '--no-ff', branchSha], worktreePath);
    const conflicted = await this.conflictedFiles(worktreePath);
    if (conflicted.length > 0) {
      return { status: 'conflict', newMainSha: null, worktreePath, conflictedFiles: conflicted };
    }
    if (r.code !== 0) {
      await this.removeDir(worktreePath);
      throw new Error(`git merge failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return { status: 'clean', newMainSha: null, worktreePath, conflictedFiles: [] };
  }

  private async removeDir(path: string): Promise<void> {
    await this.gitTry(['worktree', 'remove', '--force', path]);
    await rm(path, { recursive: true, force: true });
    await this.git(['worktree', 'prune']);
  }

  async finishMerge(worktreePath: string, subject: string, meta: CommitMeta): Promise<Sha> {
    const cwd = this.assertWorktree(worktreePath);
    // files the merge left unmerged may have been resolved in the working tree without `git add`
    const unmerged = await this.conflictedFiles(cwd);
    const mdFiles = nulList(
      await this.out(['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', '*.md'], cwd),
    );
    for (const f of new Set([...mdFiles, ...unmerged])) {
      if (!existsSync(join(cwd, f))) continue;
      const text = await fsReadFile(join(cwd, f), 'utf8');
      if (/^(<{7}|>{7})( |$)/m.test(text)) throw new Error(`conflict markers remain in ${f}`);
    }

    const oldMain = (await this.out(['rev-parse', 'HEAD'], cwd)).trim();
    await this.formatDirtyMarkdown(cwd);
    await this.git(['add', '-A'], cwd);
    if ((await this.conflictedFiles(cwd)).length > 0)
      throw new Error('merge still has unresolved conflicts');
    const sha = await this.commit(cwd, subject, meta);
    try {
      await this.fastForwardMain(sha, oldMain);
    } catch (err) {
      throw new Error(`main moved while merging; merge not applied: ${(err as Error).message}`);
    }
    await this.removeDir(cwd);
    return sha;
  }

  async abortMerge(worktreePath: string): Promise<void> {
    const cwd = this.assertWorktree(worktreePath);
    if (existsSync(cwd)) await this.gitTry(['merge', '--abort'], cwd);
    await this.removeDir(cwd);
  }

  // ---- revert / tag ----

  async revert(sha: Sha, meta: CommitMeta): Promise<Sha> {
    const target = await this.revParse(sha);
    const parents =
      (await this.out(['rev-list', '--parents', '-n', '1', target])).trim().split(/\s+/).length - 1;
    const args = ['revert', '--no-commit'];
    if (parents > 1) args.push('-m', '1');
    args.push(target);
    const r = await this.gitTry(args, this.mainWorktree);
    if (r.code !== 0) {
      const conflicted = await this.conflictedFiles(this.mainWorktree);
      await this.gitTry(['revert', '--abort'], this.mainWorktree);
      await this.gitTry(['reset', '--hard', 'HEAD'], this.mainWorktree);
      if (conflicted.length > 0) throw new RevertConflictError(target, conflicted);
      throw new Error(`git revert failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    await this.formatDirtyMarkdown(this.mainWorktree);
    await this.git(['add', '-A'], this.mainWorktree);
    if (!(await this.hasStaged(this.mainWorktree))) {
      await this.gitTry(['revert', '--abort'], this.mainWorktree);
      throw new Error(`revert of ${target} produced no changes`);
    }
    const original = await this.show(target);
    return this.commit(
      this.mainWorktree,
      `Revert "${original.subject}"`,
      meta,
      `This reverts commit ${target}.`,
      { reverts: target },
    );
  }

  async tag(name: string, message: string, ref = 'main'): Promise<void> {
    assertBranch(name);
    await this.git(['tag', '-a', name, '-m', message || name, await this.revParse(ref)]);
  }
}
