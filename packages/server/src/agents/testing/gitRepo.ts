import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomRepository } from '../../contracts/index.js';
import { createGitProvider } from '../../git/index.js';

export interface GitRepoRig {
  repo: RoomRepository;
  root: string;
  cleanup(): void;
}

/**
 * A real room repository (bare repo, main worktree, formatter hook) in a temp directory, seeded with `files` in one
 * commit. For the tests that must see what git does: concurrent writers, worktree resets, merges.
 */
export async function createGitRepo(files: Record<string, string> = {}): Promise<GitRepoRig> {
  const root = mkdtempSync(join(tmpdir(), 'quorum-agents-git-'));
  const repo = await createGitProvider(root).open('room_test');
  if (Object.keys(files).length > 0) {
    await repo.withMainLock(() =>
      repo.commitToMain(files, 'Seed documents', {
        actor: { kind: 'agent', role: 'system' },
        triggerMessageIds: [],
      }),
    );
  }
  return { repo, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
