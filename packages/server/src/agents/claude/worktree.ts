import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diffArrays } from 'diff';
import type { RoomRepository } from '../../contracts/index.js';

/**
 * Helpers that compare a git worktree on disk with a ref, using only the RoomRepository contract and fs. They back the
 * mechanical rules the server relies on: a change touches exactly one document, and the size rule counts how many
 * existing paragraphs a change rewrites. Repositories are flat (documents are files at the root), but nested paths are
 * handled so a stray subdirectory cannot hide a change.
 */

/** Relative (posix) paths of every file under `dir`, skipping git metadata. */
export function listWorktreeFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  const here = rel === '' ? dir : join(dir, rel);
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listWorktreeFiles(dir, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Files whose content in `dir` differs from `ref` (modified, added or deleted), sorted. */
export async function dirtyFiles(
  repo: RoomRepository,
  dir: string,
  ref: string,
): Promise<string[]> {
  const tracked = new Set(await repo.listFiles(ref));
  const present = new Set(existsSync(dir) ? listWorktreeFiles(dir) : []);
  const out: string[] = [];
  for (const rel of new Set([...tracked, ...present])) {
    const base = tracked.has(rel) ? await repo.readFile(rel, ref) : null;
    const current = present.has(rel) ? readFileSync(join(dir, rel), 'utf8') : null;
    if (base !== current) out.push(rel);
  }
  return out.sort();
}

/** Put `files` in `dir` back to their content at `ref` (deleting the ones that did not exist there). */
export async function restoreFiles(
  repo: RoomRepository,
  dir: string,
  ref: string,
  files: string[],
): Promise<void> {
  for (const rel of files) {
    const abs = join(dir, rel);
    const base = await repo.readFile(rel, ref);
    if (base === null) {
      rmSync(abs, { force: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, base);
    }
  }
}

/**
 * Restores every dirty file in `dir` that is not in `allowed` and returns what it reverted. This is the safety net
 * behind the single-document scope rule: whatever a session managed to touch, only the assigned document is kept.
 */
export async function enforceScope(
  repo: RoomRepository,
  dir: string,
  ref: string,
  allowed: string[],
): Promise<string[]> {
  const stray = (await dirtyFiles(repo, dir, ref)).filter((f) => !allowed.includes(f));
  if (stray.length > 0) await restoreFiles(repo, dir, ref, stray);
  return stray;
}

/** Non-blank lines (one paragraph per line, PRD 4.1). */
function paragraphs(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

/**
 * How many existing paragraphs a change removes or rewrites (`removed`), and how many it adds. The size rule (PRD 6.3)
 * applies to `removed`: additions of any size are immediate.
 */
export function paragraphChange(before: string, after: string): { removed: number; added: number } {
  let removed = 0;
  let added = 0;
  for (const part of diffArrays(paragraphs(before), paragraphs(after))) {
    if (part.removed) removed += part.value.length;
    else if (part.added) added += part.value.length;
  }
  return { removed, added };
}
