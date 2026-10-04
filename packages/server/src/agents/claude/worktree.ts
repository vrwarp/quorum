import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffArrays } from 'diff';
import type { RoomRepository } from '../../contracts/index.js';
import { runGit } from '../../git/exec.js';

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

export type TextMerge = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Line-based three-way merge of one file's text (`git merge-file`): what `theirs` changed relative to `base` is applied
 * on top of `ours`. Documents keep one paragraph per line (PRD 4.1), so edits to different paragraphs merge and edits
 * to the same paragraph conflict. A conflict never produces text: the caller refuses and the model redoes its edit.
 */
export async function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
): Promise<TextMerge> {
  if (ours === base) return { ok: true, text: theirs };
  if (theirs === base || theirs === ours) return { ok: true, text: ours };
  const dir = await mkdtemp(join(tmpdir(), 'quorum-merge-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => join(dir, n)) as [
      string,
      string,
      string,
    ];
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    const r = await runGit(
      ['merge-file', '-p', '-L', 'main', '-L', 'base', '-L', 'edit', o, b, t],
      {
        cwd: dir,
        allowFail: true,
      },
    );
    if (r.code === 0) return { ok: true, text: r.stdout };
    // the exit status is the number of conflicts (at most 127); anything else is a failure to merge at all
    if (r.code > 0 && r.code < 128) return { ok: false, reason: `${r.code} conflicting change(s)` };
    return { ok: false, reason: r.stderr.trim() || `git merge-file exited with ${r.code}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
