import { GitRoomRepository } from './repository.js';
import type { MarkdownFormatter } from './format.js';
import type { GitProvider, RoomRepository } from '../contracts/git.js';

export { RevertConflictError } from '../contracts/git.js';
export { serializeActor } from './repository.js';
export type { MarkdownFormatter } from './format.js';

/**
 * Git provider storing each room under `<rootDir>/rooms/<roomId>/` (bare `repo.git` + `worktrees/`).
 * `open` returns one shared repository instance per room (so the main write lock is shared) and
 * initializes it on first use (idempotent).
 */
export function createGitProvider(
  rootDir: string,
  opts?: { formatter?: (markdown: string) => Promise<string> | string },
): GitProvider {
  const repos = new Map<string, GitRoomRepository>();
  const formatter: MarkdownFormatter | undefined = opts?.formatter;
  return {
    async open(roomId: string): Promise<RoomRepository> {
      let repo = repos.get(roomId);
      if (!repo) {
        repo = new GitRoomRepository(rootDir, roomId, formatter);
        repos.set(roomId, repo);
      }
      await repo.init();
      return repo;
    },
  };
}
