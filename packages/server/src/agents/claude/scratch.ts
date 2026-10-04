import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Sha } from '@quorum/shared';
import type { RoomRepository } from '../../contracts/index.js';
import { sleep } from '../common.js';
import { runGit } from '../../git/exec.js';
import { dirtyFiles, restoreFiles } from './worktree.js';

/** The orchestrator's view of its scratch worktree (see ScratchWorktree). */
export interface Scratch {
  /** the directory the session works in */
  readonly dir: string;
  /** the main sha the directory currently mirrors: what `commit_main` compares the model's edit against */
  readonly base: Sha;
  /** make the directory a clean copy of main's current head, and return that head */
  reset(): Promise<Sha>;
  /** remove the worktree (the session is over) */
  dispose?(): Promise<void>;
}

/** Name of the orchestrator's worktree under the room's worktrees. */
export const SCRATCH_NAME = 'orchestrator';

/**
 * The orchestrator's working directory: a detached worktree of its own, never the main worktree. The model edits a
 * document there at its own pace; nothing it does is visible to main, so another writer (a participant creating a
 * document, a merge, a revert) can never commit or wipe a half-finished edit, and nothing the orchestrator does needs
 * the write queue until `commit_main` takes the finished text to main under the lock (PRD 4.3).
 *
 * The directory is reset to main's head at the start of every turn and after every commit, in place: the CLI process
 * keeps it as its working directory, so it must never be deleted and recreated while a session is alive.
 */
export class ScratchWorktree implements Scratch {
  private head: Sha;

  private constructor(
    readonly dir: string,
    private readonly repo: RoomRepository,
    head: Sha,
    private readonly name: string,
  ) {
    this.head = head;
  }

  /** Creates the worktree (replacing one a previous run left behind) at main's head. */
  static async create(repo: RoomRepository, name = SCRATCH_NAME): Promise<ScratchWorktree> {
    await repo.removeWorktree(name).catch(() => undefined);
    const head = await repo.headSha('main');
    if (!head) throw new Error('main has no commits');
    const dir = await repo.createDetachedWorktree(name, head);
    return new ScratchWorktree(dir, repo, head, name);
  }

  get base(): Sha {
    return this.head;
  }

  async reset(): Promise<Sha> {
    const head = await this.repo.headSha('main');
    if (!head) throw new Error('main has no commits');
    if (existsSync(join(this.dir, '.git'))) {
      // A real worktree: HEAD, index and files move to main together, and nothing untracked survives. HEAD has to move
      // too, or `git status`, `git diff` and `git blame` in the session would show main's newer commits as edits.
      await this.git(['reset', '--hard', '--quiet', head]);
      await this.git(['clean', '-fdxq']);
    } else {
      // no git directory (a test double): bring the files to main's content
      await restoreFiles(this.repo, this.dir, head, await dirtyFiles(this.repo, this.dir, head));
    }
    this.head = head;
    return head;
  }

  /** git can briefly hold the index of a worktree (the session's own `git status`); try again before giving up. */
  private async git(args: string[]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await runGit(args, { cwd: this.dir });
        return;
      } catch (e) {
        if (attempt >= 4 || !/index\.lock|Unable to create/.test(String((e as Error).message)))
          throw e;
        await sleep(50 * attempt);
      }
    }
  }

  async dispose(): Promise<void> {
    await this.repo.removeWorktree(this.name).catch(() => undefined);
  }
}
