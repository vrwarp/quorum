import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../testing/memoryRepo.js';
import {
  dirtyFiles,
  enforceScope,
  listWorktreeFiles,
  paragraphChange,
  restoreFiles,
} from './worktree.js';

const FILES = {
  'Architecture.md': '# Architecture\n\nOne.\n\nTwo.\n',
  'PRD.md': '# PRD\n\nGoals.\n',
};

async function branch() {
  const repo = new MemoryRepo('room_test', FILES);
  const { worktreePath } = await repo.createBranch('architecture/topic/a');
  return { repo, dir: worktreePath, ref: 'architecture/topic/a' };
}

describe('dirtyFiles / restoreFiles / enforceScope', () => {
  it('reports modified, added, deleted and nested files, sorted', async () => {
    const { repo, dir, ref } = await branch();
    expect(await dirtyFiles(repo, dir, ref)).toEqual([]);

    writeFileSync(join(dir, 'Architecture.md'), '# Architecture\n\nOne, edited.\n');
    writeFileSync(join(dir, 'New.md'), 'new');
    rmSync(join(dir, 'PRD.md'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.md'), 'nested');
    expect(await dirtyFiles(repo, dir, ref)).toEqual([
      'Architecture.md',
      'New.md',
      'PRD.md',
      'sub/nested.md',
    ]);
    expect(listWorktreeFiles(dir)).toEqual(['Architecture.md', 'New.md', 'sub/nested.md']);
  });

  it('restores files to their content at the ref, deleting those that did not exist', async () => {
    const { repo, dir, ref } = await branch();
    writeFileSync(join(dir, 'PRD.md'), 'vandalized');
    writeFileSync(join(dir, 'New.md'), 'new');
    await restoreFiles(repo, dir, ref, ['PRD.md', 'New.md']);
    expect(readFileSync(join(dir, 'PRD.md'), 'utf8')).toBe(FILES['PRD.md']);
    expect(existsSync(join(dir, 'New.md'))).toBe(false);
  });

  it('keeps only the allowed file: the single-document scope rule', async () => {
    const { repo, dir, ref } = await branch();
    writeFileSync(join(dir, 'Architecture.md'), '# Architecture\n\nRewritten.\n');
    writeFileSync(join(dir, 'PRD.md'), 'also edited');
    writeFileSync(join(dir, 'Extra.md'), 'created');
    const reverted = await enforceScope(repo, dir, ref, ['Architecture.md']);
    expect(reverted).toEqual(['Extra.md', 'PRD.md']);
    expect(readFileSync(join(dir, 'Architecture.md'), 'utf8')).toBe(
      '# Architecture\n\nRewritten.\n',
    );
    expect(readFileSync(join(dir, 'PRD.md'), 'utf8')).toBe(FILES['PRD.md']);
    expect(existsSync(join(dir, 'Extra.md'))).toBe(false);
    expect(await dirtyFiles(repo, dir, ref)).toEqual(['Architecture.md']);
    // nothing further to revert
    expect(await enforceScope(repo, dir, ref, ['Architecture.md'])).toEqual([]);
  });

  it('then lets the branch commit exactly one changed file', async () => {
    const { repo, dir, ref } = await branch();
    writeFileSync(join(dir, 'Architecture.md'), '# Architecture\n\nDrafted.\n');
    writeFileSync(join(dir, 'PRD.md'), 'oops');
    await enforceScope(repo, dir, ref, ['Architecture.md']);
    const base = await repo.headSha('main');
    await repo.commitWorktree(dir, 'Draft', {
      actor: { kind: 'agent', role: 'worker' },
      triggerMessageIds: [],
    });
    expect(await repo.changedFiles(base!, ref)).toEqual(['Architecture.md']);
  });
});

describe('paragraphChange', () => {
  const doc = '# T\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n';

  it('counts nothing for identical text or blank-line-only differences', () => {
    expect(paragraphChange(doc, doc)).toEqual({ removed: 0, added: 0 });
    expect(paragraphChange(doc, doc.replace(/\n\n/g, '\n\n\n'))).toEqual({ removed: 0, added: 0 });
  });

  it('treats additions of any size as free', () => {
    const more = `${doc}\nFive.\n\nSix.\n\nSeven.\n\nEight.\n\nNine.\n`;
    expect(paragraphChange(doc, more)).toEqual({ removed: 0, added: 5 });
  });

  it('counts a rewritten paragraph as one removed and one added', () => {
    expect(paragraphChange(doc, doc.replace('Two.', 'Two, reworded.'))).toEqual({
      removed: 1,
      added: 1,
    });
  });

  it('counts deleted paragraphs', () => {
    expect(paragraphChange(doc, '# T\n\nOne.\n')).toEqual({ removed: 3, added: 0 });
  });

  it('counts every rewritten line of a wholesale rewrite', () => {
    expect(paragraphChange(doc, '# New\n\nCompletely different.\n')).toEqual({
      removed: 5,
      added: 2,
    });
  });
});
