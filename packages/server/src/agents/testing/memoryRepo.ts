import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch, diffArrays } from 'diff';
import type { Sha } from '@quorum/shared';
import type {
  BlameLine,
  CommitInfo,
  CommitMeta,
  MergeOutcome,
  RoomRepository,
} from '../../contracts/index.js';

interface StoredCommit {
  sha: Sha;
  parent: Sha | null;
  files: Record<string, string>;
  info: CommitInfo;
}

/**
 * Minimal in-memory RoomRepository for agent unit tests. Branch worktrees are real temp directories so code
 * that edits files with fs and calls commitWorktree behaves like it does against the git implementation.
 * Flat repositories only (files at the root). Merge/revert operations are intentionally unsupported; mergeBase is.
 */
export class MemoryRepo implements RoomRepository {
  readonly roomId: string;
  readonly bareDir: string;
  readonly mainWorktree: string;
  readonly commits = new Map<Sha, StoredCommit>();
  readonly refs = new Map<string, Sha>();
  readonly worktrees = new Map<string, string>(); // branch -> dir
  private counter = 0;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(roomId = 'room_test', initialFiles: Record<string, string> = {}) {
    this.roomId = roomId;
    const base = mkdtempSync(join(tmpdir(), 'quorum-memrepo-'));
    this.bareDir = join(base, 'repo.git');
    this.mainWorktree = join(base, 'main');
    mkdirSync(this.mainWorktree, { recursive: true });
    const root = this.addCommit(null, initialFiles, 'Initial commit', {
      actor: { kind: 'agent', role: 'system' },
      triggerMessageIds: [],
    });
    this.refs.set('main', root.sha);
    this.worktrees.set('main', this.mainWorktree);
    this.writeDir(this.mainWorktree, initialFiles);
  }

  // --- helpers -----------------------------------------------------------------------------

  private writeDir(dir: string, files: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  }

  private readDir(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      out[name] = readFileSync(join(dir, name), 'utf8');
    }
    return out;
  }

  private resolve(ref: string): Sha | null {
    if (ref.endsWith('^')) {
      const base = this.resolve(ref.slice(0, -1));
      return base ? (this.commits.get(base)?.parent ?? null) : null;
    }
    const viaRef = this.refs.get(ref);
    if (viaRef) return viaRef;
    if (this.commits.has(ref)) return ref;
    const prefix = [...this.commits.keys()].find((s) => s.startsWith(ref));
    return prefix ?? null;
  }

  private commitAt(ref: string): StoredCommit | null {
    const sha = this.resolve(ref);
    return sha ? (this.commits.get(sha) ?? null) : null;
  }

  private addCommit(
    parent: Sha | null,
    files: Record<string, string>,
    subject: string,
    meta: CommitMeta,
  ): StoredCommit {
    const sha = createHash('sha1')
      .update(`${++this.counter}:${subject}:${JSON.stringify(files)}`)
      .digest('hex');
    const actor =
      meta.actor.kind === 'user'
        ? `user:${meta.actor.userId}`
        : meta.actor.role === 'worker'
          ? 'agent:worker'
          : `agent:${meta.actor.role}`;
    const prev = parent ? this.commits.get(parent) : null;
    const touched = new Set<string>([...Object.keys(files), ...Object.keys(prev?.files ?? {})]);
    const changed = [...touched].filter((f) => (files[f] ?? null) !== (prev?.files[f] ?? null));
    const info: CommitInfo = {
      sha,
      subject,
      body: '',
      authorName: meta.actor.kind === 'user' ? meta.actor.displayName : `agent:${meta.actor.role}`,
      authoredAt: new Date().toISOString(),
      trailers: {
        actor,
        triggerMessageIds: meta.triggerMessageIds,
        proposalId: meta.proposalId ?? null,
        revertsSha: meta.revertsSha ?? null,
      },
      files: changed,
    };
    const c: StoredCommit = { sha, parent, files: { ...files }, info };
    this.commits.set(sha, c);
    return c;
  }

  private chain(ref: string): StoredCommit[] {
    const out: StoredCommit[] = [];
    let cur = this.commitAt(ref);
    while (cur) {
      out.push(cur);
      cur = cur.parent ? (this.commits.get(cur.parent) ?? null) : null;
    }
    return out; // newest first
  }

  // --- RoomRepository ----------------------------------------------------------------------

  withMainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async headSha(ref = 'main'): Promise<Sha | null> {
    return this.resolve(ref);
  }

  async readFile(path: string, ref = 'main'): Promise<string | null> {
    return this.commitAt(ref)?.files[path] ?? null;
  }

  async listFiles(ref = 'main'): Promise<string[]> {
    return Object.keys(this.commitAt(ref)?.files ?? {}).sort();
  }

  async commitToMain(
    files: Record<string, string | null>,
    subject: string,
    meta: CommitMeta,
  ): Promise<Sha> {
    const head = this.commitAt('main')!;
    const next = { ...head.files };
    for (const [f, content] of Object.entries(files)) {
      if (content === null) delete next[f];
      else next[f] = content;
    }
    if (JSON.stringify(next) === JSON.stringify(head.files)) throw new Error('nothing to commit');
    const c = this.addCommit(head.sha, next, subject, meta);
    this.refs.set('main', c.sha);
    this.writeDir(this.mainWorktree, next);
    return c.sha;
  }

  async commitWorktree(
    worktreePath: string,
    subject: string,
    meta: CommitMeta,
    paths?: string[],
  ): Promise<Sha | null> {
    const branch = [...this.worktrees.entries()].find(([, dir]) => dir === worktreePath)?.[0];
    if (!branch) throw new Error(`unknown worktree ${worktreePath}`);
    const head = this.commitAt(branch)!;
    let snapshot = this.readDir(worktreePath);
    if (paths) {
      // only these paths are committed; everything else stays as the branch has it
      const only = { ...head.files };
      for (const f of paths) {
        if (f in snapshot) only[f] = snapshot[f]!;
        else delete only[f];
      }
      snapshot = only;
    }
    if (JSON.stringify(sortKeys(snapshot)) === JSON.stringify(sortKeys(head.files))) return null;
    const c = this.addCommit(head.sha, snapshot, subject, meta);
    this.refs.set(branch, c.sha);
    return c.sha;
  }

  async createBranch(
    branch: string,
    fromRef = 'main',
  ): Promise<{ worktreePath: string; baseSha: Sha }> {
    if (this.refs.has(branch)) throw new Error(`branch exists: ${branch}`);
    const base = this.commitAt(fromRef);
    if (!base) throw new Error(`unknown ref ${fromRef}`);
    const dir = mkdtempSync(join(tmpdir(), 'quorum-memrepo-wt-'));
    this.writeDir(dir, base.files);
    this.refs.set(branch, base.sha);
    this.worktrees.set(branch, dir);
    return { worktreePath: dir, baseSha: base.sha };
  }

  async removeWorktree(branch: string): Promise<void> {
    this.worktrees.delete(branch);
  }

  async listBranches(): Promise<string[]> {
    return [...this.refs.keys()];
  }

  async deleteBranch(branch: string): Promise<void> {
    this.refs.delete(branch);
    this.worktrees.delete(branch);
  }

  async createDetachedWorktree(_name: string, ref: string): Promise<string> {
    const base = this.commitAt(ref);
    if (!base) throw new Error(`unknown ref ${ref}`);
    const dir = mkdtempSync(join(tmpdir(), 'quorum-memrepo-detached-'));
    this.writeDir(dir, base.files);
    return dir;
  }

  async log(path: string | null, ref = 'main', limit = 100): Promise<CommitInfo[]> {
    const chain = this.chain(ref);
    const out: CommitInfo[] = [];
    for (const c of chain) {
      const parent = c.parent ? this.commits.get(c.parent) : null;
      if (path === null || (c.files[path] ?? null) !== (parent?.files[path] ?? null))
        out.push(c.info);
      if (out.length >= limit) break;
    }
    return out;
  }

  async show(sha: Sha): Promise<CommitInfo> {
    const c = this.commitAt(sha);
    if (!c) throw new Error(`unknown commit ${sha}`);
    return c.info;
  }

  async logLines(
    path: string,
    startLine: number,
    endLine: number,
    ref = 'main',
  ): Promise<CommitInfo[]> {
    const blame = await this.blame(path, ref);
    const shas = new Set(
      blame.filter((b) => b.line >= startLine && b.line <= endLine).map((b) => b.sha),
    );
    const all = await this.log(path, ref);
    const hit = all.filter((c) => shas.has(c.sha));
    return hit.length > 0 ? hit : all;
  }

  async blame(path: string, ref = 'main'): Promise<BlameLine[]> {
    const chain = this.chain(ref).reverse(); // oldest first
    let entries: Array<{ text: string; sha: Sha }> = [];
    for (const c of chain) {
      const content = c.files[path];
      if (content === undefined) {
        entries = [];
        continue;
      }
      const lines = splitLines(content);
      const parts = diffArrays(
        entries.map((e) => e.text),
        lines,
      );
      const next: Array<{ text: string; sha: Sha }> = [];
      let oldIdx = 0;
      for (const part of parts) {
        const n = part.value.length;
        if (part.added) for (const t of part.value) next.push({ text: t, sha: c.sha });
        else if (part.removed) oldIdx += n;
        else {
          next.push(...entries.slice(oldIdx, oldIdx + n));
          oldIdx += n;
        }
      }
      entries = next;
    }
    return entries.map((e, i) => ({ line: i + 1, sha: e.sha, text: e.text }));
  }

  async diff(path: string, fromRef: string, toRef: string): Promise<string> {
    const a = (await this.readFile(path, fromRef)) ?? '';
    const b = (await this.readFile(path, toRef)) ?? '';
    return createTwoFilesPatch(`a/${path}`, `b/${path}`, a, b, '', '', { context: 3 });
  }

  async changedFiles(fromRef: string, toRef: string): Promise<string[]> {
    const a = this.commitAt(fromRef)?.files ?? {};
    const b = this.commitAt(toRef)?.files ?? {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
  }

  async mergeBase(refA: string, refB: string): Promise<Sha> {
    const ancestorsOfA = new Set(this.chain(refA).map((c) => c.sha));
    const hit = this.chain(refB).find((c) => ancestorsOfA.has(c.sha));
    if (!hit) throw new Error(`no merge base for ${refA} and ${refB}`);
    return hit.sha;
  }

  async rewrittenLineCount(
    path: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ removed: number; added: number }> {
    const parts = diffArrays(
      splitLines((await this.readFile(path, fromRef)) ?? ''),
      splitLines((await this.readFile(path, toRef)) ?? ''),
    );
    let removed = 0;
    let added = 0;
    for (const p of parts) {
      if (p.added) added += p.value.length;
      if (p.removed) removed += p.value.length;
    }
    return { removed, added };
  }

  async beginMerge(): Promise<MergeOutcome & { newMainSha: Sha | null }> {
    throw new Error('MemoryRepo: beginMerge not supported');
  }
  async finishMerge(): Promise<Sha> {
    throw new Error('MemoryRepo: finishMerge not supported');
  }
  async abortMerge(): Promise<void> {}
  async revert(): Promise<Sha> {
    throw new Error('MemoryRepo: revert not supported');
  }
  async tag(): Promise<void> {}
  async init(): Promise<void> {}
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
