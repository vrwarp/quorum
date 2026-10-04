import type { ActorRef, MessageId, ProposalId, Sha } from '@quorum/shared';

/** Trailers written into every commit message (PRD §4.2). */
export interface CommitMeta {
  actor: ActorRef;
  triggerMessageIds: MessageId[];
  proposalId?: ProposalId | null;
  revertsSha?: Sha | null;
}

export interface CommitInfo {
  sha: Sha;
  subject: string;
  body: string;
  authorName: string;
  authoredAt: string;
  trailers: {
    actor: string | null;
    triggerMessageIds: MessageId[];
    proposalId: ProposalId | null;
    revertsSha: Sha | null;
  };
  /** files touched */
  files: string[];
}

export interface BlameLine {
  line: number; // 1-based
  sha: Sha;
  text: string;
}

export interface MergeOutcome {
  /**
   * Every merge is recorded as a merge commit (`git merge --no-ff --no-commit` in a detached worktree), so that
   * `revert -m 1` of the resulting commit undoes the whole proposal and every proposal commit carries a Quorum-Proposal
   * trailer. The status says how much reconciliation the caller owes:
   *  - 'fast-forward': main has not moved since the branch point, so NO reconciliation is needed. The merge in the
   *    worktree is clean and its tree equals the voted branch; the caller skips the merge driver and calls
   *    `finishMerge` directly (the name is kept for compatibility; the history is no longer a fast-forward);
   *  - 'clean': main moved and git merged without conflicts; the merge is uncommitted in the worktree for semantic review
   *    by the merge driver;
   *  - 'conflict': conflict markers are present (see `conflictedFiles`) and the merge driver must resolve them.
   */
  status: 'fast-forward' | 'clean' | 'conflict';
  /** worktree path holding the merge in progress; set for all three statuses */
  worktreePath: string | null;
  /** files with conflicts */
  conflictedFiles: string[];
}

/**
 * One git repository per room (bare repo + worktrees). Implemented in packages/server/src/git.
 * Paths are file names at the repository root (e.g. "Architecture.md").
 * All write operations to main MUST go through `withMainLock` (the write queue, PRD §4.3).
 */
export interface RoomRepository {
  readonly roomId: string;
  readonly bareDir: string;
  readonly mainWorktree: string;

  /** Serialize writes to main. Reentrant calls are NOT supported; do not nest. */
  withMainLock<T>(fn: () => Promise<T>): Promise<T>;

  headSha(ref?: string): Promise<Sha | null>; // null if the ref does not exist
  readFile(path: string, ref?: string): Promise<string | null>; // null if the file does not exist at ref
  listFiles(ref?: string): Promise<string[]>;

  /** Write files in the main worktree and commit (call inside withMainLock). Returns the new sha.
   *  Runs the formatter before committing. Throws if nothing changed. */
  commitToMain(
    files: Record<string, string | null>,
    subject: string,
    meta: CommitMeta,
  ): Promise<Sha>;

  /**
   * Commit what is currently modified in a worktree (used after an agent edited files directly); null if clean.
   * With `paths` (repo-relative file names) ONLY those paths are formatted, staged and committed: anything else that is
   * dirty or staged in the worktree is left exactly as it is. Callers that edit the main worktree must pass `paths`
   * and hold `withMainLock` across the edit and the commit (PRD §4.3). Without `paths` everything dirty is committed,
   * which is right only for a worktree that belongs to one agent (a branch worktree).
   */
  commitWorktree(
    worktreePath: string,
    subject: string,
    meta: CommitMeta,
    paths?: string[],
  ): Promise<Sha | null>;

  /** Create a branch from `fromRef` (default main) with its own worktree; returns the worktree path. */
  createBranch(branch: string, fromRef?: string): Promise<{ worktreePath: string; baseSha: Sha }>;
  removeWorktree(branch: string): Promise<void>;
  listBranches(): Promise<string[]>;
  deleteBranch(branch: string): Promise<void>;
  /** detached worktree at a ref, for the merge driver */
  createDetachedWorktree(name: string, ref: string): Promise<string>;

  /** git log for a path on a ref, newest first */
  log(path: string | null, ref?: string, limit?: number): Promise<CommitInfo[]>;
  show(sha: Sha): Promise<CommitInfo>;
  /** history of a line range: `git log -L start,end:path ref` */
  logLines(path: string, startLine: number, endLine: number, ref?: string): Promise<CommitInfo[]>;
  blame(path: string, ref?: string): Promise<BlameLine[]>;

  /** unified diff of a single file between two refs */
  diff(path: string, fromRef: string, toRef: string): Promise<string>;
  /** files changed between refs */
  changedFiles(fromRef: string, toRef: string): Promise<string[]>;
  /** merge-base of main and a branch */
  mergeBase(refA: string, refB: string): Promise<Sha>;
  /** number of existing lines deleted/modified in `path` between refs (for the size rule) */
  rewrittenLineCount(
    path: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ removed: number; added: number }>;

  /**
   * Begin merging `branch` into main (call inside withMainLock): runs `git merge --no-ff --no-commit` in a detached
   * worktree at main's head and returns it (see MergeOutcome.status for what the caller owes); the caller finishes with
   * `finishMerge` or abandons with `abortMerge`. Main is never touched here. Throws when everything on the branch is
   * already contained in main. `newMainSha` is always null (kept for compatibility: nothing is fast-forwarded any more).
   */
  beginMerge(branch: string): Promise<MergeOutcome & { newMainSha: Sha | null }>;
  /**
   * Commit the merge in the worktree (must have no conflict markers) and advance main to it atomically: main's ref and
   * its checkout move together (`merge --ff-only` in the main worktree, retried briefly on `index.lock`) or not at all.
   * `opts.paths`, when given, are the only files the merge commit may change relative to main; anything else fails the
   * merge before it is committed.
   */
  finishMerge(
    worktreePath: string,
    subject: string,
    meta: CommitMeta,
    opts?: { paths?: string[] },
  ): Promise<Sha>;
  abortMerge(worktreePath: string): Promise<void>;

  /**
   * git revert on main (call inside withMainLock); a merge commit is reverted against its first parent. Throws
   * RevertConflictError when it conflicts. Only the files the revert changes are committed, and a failed revert is
   * aborted without discarding unrelated uncommitted edits in the main worktree.
   */
  revert(sha: Sha, meta: CommitMeta): Promise<Sha>;
  tag(name: string, message: string, ref?: string): Promise<void>;

  /** Installs the formatter pre-commit hook and initial commit; idempotent. */
  init(): Promise<void>;
}

export class RevertConflictError extends Error {
  constructor(
    public readonly sha: Sha,
    public readonly conflictedFiles: string[],
  ) {
    super(`revert of ${sha} conflicts`);
  }
}

export interface GitProvider {
  /** open or create the repository for a room */
  open(roomId: string): Promise<RoomRepository>;
}
