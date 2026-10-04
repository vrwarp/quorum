import {
  RevertConflictError,
  type BlameLine,
  type CommitInfo,
  type CommitMeta,
  type GitProvider,
  type MergeOutcome,
  type RoomRepository,
} from '../../contracts/index.js';

interface FakeCommit {
  sha: string;
  parent: string | null;
  files: Record<string, string>;
  subject: string;
  meta: CommitMeta | null;
}

/** In-memory RoomRepository. Enforces that main writes happen inside withMainLock. */
export class FakeRepository implements RoomRepository {
  readonly bareDir = '/fake/repo.git';
  readonly mainWorktree = '/fake/main';
  commits = new Map<string, FakeCommit>();
  refs = new Map<string, string>();
  tags = new Map<string, string>();
  initialized = false;
  private seq = 0;
  private lockHeld = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingMerge: { branch: string; worktree: string } | null = null;
  aborted: string[] = [];

  constructor(readonly roomId: string) {}

  private newCommit(parent: string | null, files: Record<string, string>, subject: string, meta: CommitMeta | null): string {
    const sha = `c${String(++this.seq).padStart(6, '0')}`;
    this.commits.set(sha, { sha, parent, files, subject, meta });
    return sha;
  }
  private resolve(ref: string): string | null {
    if (this.refs.has(ref)) return this.refs.get(ref)!;
    if (this.commits.has(ref)) return ref;
    const m = /^(.*)~1$/.exec(ref);
    if (m) {
      const base = this.resolve(m[1]!);
      return base ? (this.commits.get(base)?.parent ?? null) : null;
    }
    return null;
  }
  private filesAt(ref: string): Record<string, string> {
    const sha = this.resolve(ref);
    return sha ? this.commits.get(sha)!.files : {};
  }
  private ancestors(sha: string | null): Set<string> {
    const out = new Set<string>();
    while (sha) {
      out.add(sha);
      sha = this.commits.get(sha)?.parent ?? null;
    }
    return out;
  }
  private assertLocked(): void {
    if (!this.lockHeld) throw new Error('main write outside withMainLock');
  }

  async withMainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.lockHeld = true;
      try {
        return await fn();
      } finally {
        this.lockHeld = false;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.refs.set('main', this.newCommit(null, {}, 'Initial commit', null));
  }

  /** test helper: make a commit on a branch (creating it from main when absent) */
  commitOnBranch(branch: string, files: Record<string, string | null>, base = 'main'): string {
    const parent = this.refs.get(branch) ?? this.refs.get(base)!;
    const next = { ...this.commits.get(parent)!.files };
    for (const [p, c] of Object.entries(files)) {
      if (c === null) delete next[p];
      else next[p] = c;
    }
    const sha = this.newCommit(parent, next, `branch ${branch}`, null);
    this.refs.set(branch, sha);
    return sha;
  }

  async headSha(ref = 'main') {
    return this.resolve(ref);
  }
  async readFile(path: string, ref = 'main') {
    return this.filesAt(ref)[path] ?? null;
  }
  async listFiles(ref = 'main') {
    return Object.keys(this.filesAt(ref));
  }

  async commitToMain(files: Record<string, string | null>, subject: string, meta: CommitMeta) {
    this.assertLocked();
    const head = this.refs.get('main')!;
    const next = { ...this.commits.get(head)!.files };
    for (const [p, c] of Object.entries(files)) {
      if (c === null) delete next[p];
      else next[p] = c;
    }
    const sha = this.newCommit(head, next, subject, meta);
    this.refs.set('main', sha);
    return sha;
  }
  async commitWorktree() {
    return null;
  }
  async createBranch(branch: string, fromRef = 'main') {
    const base = this.resolve(fromRef)!;
    this.refs.set(branch, base);
    return { worktreePath: `/fake/wt/${branch}`, baseSha: base };
  }
  async removeWorktree() {}
  async listBranches() {
    return [...this.refs.keys()];
  }
  async deleteBranch(branch: string) {
    this.refs.delete(branch);
  }
  async createDetachedWorktree(name: string) {
    return `/fake/wt/${name}`;
  }

  private info(c: FakeCommit): CommitInfo {
    return {
      sha: c.sha,
      subject: c.subject,
      body: '',
      authorName: 'fake',
      authoredAt: new Date(0).toISOString(),
      trailers: {
        actor: null,
        triggerMessageIds: c.meta?.triggerMessageIds ?? [],
        proposalId: c.meta?.proposalId ?? null,
        revertsSha: c.meta?.revertsSha ?? null,
      },
      files: [],
    };
  }
  async log(_path: string | null, ref = 'main', limit = 50) {
    const out: CommitInfo[] = [];
    let sha = this.resolve(ref);
    while (sha && out.length < limit) {
      const c = this.commits.get(sha)!;
      out.push(this.info(c));
      sha = c.parent;
    }
    return out;
  }
  async show(sha: string) {
    return this.info(this.commits.get(sha)!);
  }
  async logLines() {
    return [] as CommitInfo[];
  }
  async blame(): Promise<BlameLine[]> {
    return [];
  }
  async diff(path: string, fromRef: string, toRef: string) {
    return `diff ${path} ${fromRef}..${toRef}`;
  }
  async changedFiles(fromRef: string, toRef: string) {
    const a = this.filesAt(fromRef);
    const b = this.filesAt(toRef);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
  }
  async mergeBase(a: string, b: string) {
    const anc = this.ancestors(this.resolve(a));
    let sha = this.resolve(b);
    while (sha && !anc.has(sha)) sha = this.commits.get(sha)!.parent;
    return sha!;
  }
  async rewrittenLineCount() {
    return { removed: 0, added: 0 };
  }

  async beginMerge(branch: string): Promise<MergeOutcome & { newMainSha: string | null }> {
    this.assertLocked();
    const main = this.refs.get('main')!;
    const head = this.resolve(branch)!;
    if (this.ancestors(head).has(main)) {
      this.refs.set('main', head);
      return { status: 'fast-forward', worktreePath: null, conflictedFiles: [], newMainSha: head };
    }
    this.pendingMerge = { branch, worktree: `/fake/merge/${branch}` };
    return { status: 'clean', worktreePath: this.pendingMerge.worktree, conflictedFiles: [], newMainSha: null };
  }
  async finishMerge(worktreePath: string, subject: string, meta: CommitMeta) {
    this.assertLocked();
    if (!this.pendingMerge || this.pendingMerge.worktree !== worktreePath) throw new Error('no merge in progress');
    const main = this.refs.get('main')!;
    const base = await this.mergeBase('main', this.pendingMerge.branch);
    const baseFiles = this.commits.get(base)!.files;
    const branchFiles = this.filesAt(this.pendingMerge.branch);
    const next = { ...this.commits.get(main)!.files };
    for (const k of new Set([...Object.keys(baseFiles), ...Object.keys(branchFiles)])) {
      if (baseFiles[k] === branchFiles[k]) continue;
      if (branchFiles[k] === undefined) delete next[k];
      else next[k] = branchFiles[k]!;
    }
    const sha = this.newCommit(main, next, subject, meta);
    this.refs.set('main', sha);
    this.pendingMerge = null;
    return sha;
  }
  async abortMerge(worktreePath: string) {
    this.aborted.push(worktreePath);
    this.pendingMerge = null;
  }

  async revert(sha: string, meta: CommitMeta) {
    this.assertLocked();
    const target = this.commits.get(sha)!;
    const parentFiles = target.parent ? this.commits.get(target.parent)!.files : {};
    const head = this.refs.get('main')!;
    const cur = { ...this.commits.get(head)!.files };
    const touched = [...new Set([...Object.keys(parentFiles), ...Object.keys(target.files)])].filter((k) => parentFiles[k] !== target.files[k]);
    const conflicts = touched.filter((k) => cur[k] !== target.files[k]);
    if (conflicts.length) throw new RevertConflictError(sha, conflicts);
    for (const k of touched) {
      if (parentFiles[k] === undefined) delete cur[k];
      else cur[k] = parentFiles[k]!;
    }
    const rev = this.newCommit(head, cur, `Revert ${sha}`, meta);
    this.refs.set('main', rev);
    return rev;
  }
  async tag(name: string, _message: string, ref = 'main') {
    this.tags.set(name, this.resolve(ref)!);
  }
}

export class FakeGit implements GitProvider {
  repos = new Map<string, FakeRepository>();
  async open(roomId: string) {
    let r = this.repos.get(roomId);
    if (!r) {
      r = new FakeRepository(roomId);
      this.repos.set(roomId, r);
    }
    return r;
  }
}
