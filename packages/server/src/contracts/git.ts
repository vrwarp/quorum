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
  /** 'fast-forward' when main had not moved; 'clean' when git merged without conflicts (uncommitted,
   *  left in the worktree for semantic review); 'conflict' when conflict markers are present */
  status: 'fast-forward' | 'clean' | 'conflict';
  /** worktree path holding the merge in progress (clean/conflict); null for fast-forward */
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
  commitToMain(files: Record<string, string | null>, subject: string, meta: CommitMeta): Promise<Sha>;

  /** Commit whatever is currently modified in a worktree (used after an agent edited files directly). */
  commitWorktree(worktreePath: string, subject: string, meta: CommitMeta): Promise<Sha | null>; // null if clean

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
  rewrittenLineCount(path: string, fromRef: string, toRef: string): Promise<{ removed: number; added: number }>;

  /**
   * Begin merging `branch` into main (call inside withMainLock). Fast-forwards when possible and
   * returns status 'fast-forward' with main already advanced. Otherwise runs `git merge --no-commit`
   * in a detached worktree and returns it for review; the caller finishes with `finishMerge`.
   */
  beginMerge(branch: string): Promise<MergeOutcome & { newMainSha: Sha | null }>;
  /** Commit the merge in the worktree (must have no conflict markers) and advance main to it. */
  finishMerge(worktreePath: string, subject: string, meta: CommitMeta): Promise<Sha>;
  abortMerge(worktreePath: string): Promise<void>;

  /** git revert on main (call inside withMainLock). Throws RevertConflictError when it conflicts. */
  revert(sha: Sha, meta: CommitMeta): Promise<Sha>;
  tag(name: string, message: string, ref?: string): Promise<void>;

  /** Installs the formatter pre-commit hook and initial commit; idempotent. */
  init(): Promise<void>;
}

export class RevertConflictError extends Error {
  constructor(public readonly sha: Sha, public readonly conflictedFiles: string[]) {
    super(`revert of ${sha} conflicts`);
  }
}

export interface GitProvider {
  /** open or create the repository for a room */
  open(roomId: string): Promise<RoomRepository>;
}
