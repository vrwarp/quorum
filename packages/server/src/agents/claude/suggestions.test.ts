import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { textHash, type Anchor, type Message } from '@quorum/shared';
import { createGitRepo, type GitRepoRig } from '../testing/gitRepo.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import type { RoomRepository } from '../../contracts/index.js';
import { tryApplySuggestion } from './suggestions.js';

// line numbers: 1 title, 2 blank, 3 Para 1, 4 blank, 5 Para 2, 6 blank, 7 Para 3, 8 blank, 9 Para 4, 10 blank, 11 Para 5
const DOC = '# Architecture\n\nPara 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n\nPara 5.\n';

interface Rig {
  repo: RoomRepository;
  stub: StubActions;
  logs: string[];
  /** a suggestion card from Bob for the given lines of the document as it is now */
  suggest(opts: {
    start: number;
    end?: number;
    replacement: string;
    over?: Partial<Anchor>;
    status?: 'pending' | 'applied';
  }): Promise<Message>;
  apply(message: Message): ReturnType<typeof tryApplySuggestion>;
}

async function setup(repo: RoomRepository): Promise<Rig> {
  const stub = createStubActions({
    repo,
    documents: [
      { path: 'Architecture.md', title: 'Architecture' },
      { path: 'PRD.md', title: 'PRD' },
    ],
    participants: [{ userId: 'user_bob', displayName: 'Bob' }],
  });
  const logs: string[] = [];
  return {
    repo,
    stub,
    logs,
    async suggest({ start, end = start, replacement, over = {}, status = 'pending' }) {
      const text = ((await repo.readFile('Architecture.md')) ?? '')
        .split('\n')
        .slice(start - 1, end)
        .join('\n');
      const anchor: Anchor = {
        documentId: 'doc_1',
        baseSha: (await repo.headSha('main'))!,
        startLine: start,
        endLine: end,
        textHash: textHash(text),
        text,
        ...over,
      };
      return stub.human('user_bob', 'Bob', 'suggestion', {
        kind: 'card',
        anchor,
        card: { type: 'suggestion', anchor, replacement, status, resolutionSha: null, note: null },
      });
    },
    apply: (message) =>
      tryApplySuggestion(
        {
          roomId: stub.roomId,
          actions: stub.actions,
          repo,
          rewriteLimit: 3,
          logger: (_l, msg) => logs.push(msg),
        },
        message,
      ),
  };
}

async function memoryRig(): Promise<Rig> {
  return setup(new MemoryRepo('room_test', { 'Architecture.md': DOC, 'PRD.md': '# PRD\n' }));
}

describe('the exact-match fast path for suggestions (PRD 5.2)', () => {
  it('applies the replacement as given when the anchored text is unchanged, as the author, without the orchestrator', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    const out = await r.apply(m);

    expect(out).toMatchObject({ applied: true, documentPath: 'Architecture.md' });
    if (!out.applied) throw new Error('not applied');
    expect(await r.repo.readFile('Architecture.md')).toBe(
      DOC.replace('Para 2.', 'Para two, tightened.'),
    );
    expect(await r.repo.headSha('main')).toBe(out.sha);
    const info = await r.repo.show(out.sha);
    expect(info.subject).toBe('Update paragraph in Architecture (suggestion)');
    expect(info.trailers).toMatchObject({ actor: 'user:user_bob', triggerMessageIds: [m.id] });
    expect(info.files).toEqual(['Architecture.md']);
    // the Change card
    expect(r.stub.changes).toEqual([
      expect.objectContaining({
        sha: out.sha,
        documentId: 'doc_1',
        actor: { kind: 'user', userId: 'user_bob', displayName: 'Bob' },
        summary: "Updated a paragraph in Architecture from Bob's suggestion",
        triggerMessageIds: [m.id],
        proposalId: null,
        revertsSha: null,
      }),
    ]);
    // the suggestion card is resolved, with the commit
    expect(m.card).toMatchObject({
      type: 'suggestion',
      status: 'applied',
      resolutionSha: out.sha,
      note: null,
    });
    expect(r.stub.calls.filter((c) => c === 'postChat')).toHaveLength(0); // nothing said in chat
  });

  it('deletes the paragraph and its blank separator line for an empty replacement', async () => {
    const r = await memoryRig();
    const out = await r.apply(await r.suggest({ start: 5, replacement: '' }));
    expect(out.applied).toBe(true);
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC.replace('Para 2.\n\n', ''));
    expect((await r.repo.show((out as { sha: string }).sha)).subject).toBe(
      'Delete paragraph in Architecture (suggestion)',
    );
    expect(r.stub.changes[0]!.summary).toBe(
      "Deleted a paragraph in Architecture from Bob's suggestion",
    );
  });

  it('replaces a line range with several lines', async () => {
    const r = await memoryRig();
    const out = await r.apply(
      await r.suggest({ start: 5, end: 7, replacement: 'First.\n\nSecond.' }),
    );
    expect(out.applied).toBe(true);
    expect(await r.repo.readFile('Architecture.md')).toBe(
      DOC.replace('Para 2.\n\nPara 3.', 'First.\n\nSecond.'),
    );
  });

  it('hands the suggestion back, untouched, when the anchored text changed since it was made', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    // someone edited that paragraph meanwhile
    await r.repo.commitToMain(
      { 'Architecture.md': DOC.replace('Para 2.', 'Para two, by Alice.') },
      'Edit',
      {
        actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
        triggerMessageIds: [],
      },
    );
    const head = await r.repo.headSha('main');
    const out = await r.apply(m);
    expect(out).toEqual({
      applied: false,
      reason: 'the anchored text changed since the suggestion was made',
    });
    expect(await r.repo.headSha('main')).toBe(head);
    expect(r.stub.changes).toEqual([]);
    expect(m.card).toMatchObject({ status: 'pending' }); // the orchestrator reconciles it
  });

  it('hands back a suggestion whose lines moved: the text at those line numbers is not the anchored text', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 7, replacement: 'Para three, tightened.' });
    // a paragraph was inserted above: line 7 now holds something else
    await r.repo.commitToMain(
      { 'Architecture.md': DOC.replace('Para 1.\n\n', 'Para 1.\n\nInserted.\n\n') },
      'Insert',
      {
        actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
        triggerMessageIds: [],
      },
    );
    expect((await r.apply(m)).applied).toBe(false);
  });

  it('hands back a suggestion for lines that no longer exist', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 11, replacement: 'x' });
    await r.repo.commitToMain({ 'Architecture.md': '# Architecture\n\nShort now.\n' }, 'Cut', {
      actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
      triggerMessageIds: [],
    });
    expect(await r.apply(m)).toEqual({
      applied: false,
      reason: 'the anchored lines are outside the document now',
    });
  });

  it('hands back a suggestion that rewrites more paragraphs than the size rule allows (a Review proposal, not an immediate change)', async () => {
    const r = await memoryRig();
    const head = await r.repo.headSha('main');
    // lines 3-9 hold four paragraphs: more than the limit of three
    const out = await r.apply(
      await r.suggest({ start: 3, end: 9, replacement: 'One big paragraph.' }),
    );
    expect(out).toEqual({
      applied: false,
      reason:
        'it deletes or rewrites 4 existing paragraphs, more than the 3 an immediate change may',
    });
    expect(await r.repo.headSha('main')).toBe(head);
    // exactly the limit is still immediate
    const ok = await r.apply(
      await r.suggest({ start: 3, end: 7, replacement: 'Two paragraphs, rewritten.' }),
    );
    expect(ok.applied).toBe(true);
  });

  it('does nothing for a suggestion that is not pending, or has no card, or is not from a participant, or whose document is gone', async () => {
    const r = await memoryRig();
    const resolved = await r.suggest({ start: 5, replacement: 'x', status: 'applied' });
    expect(await r.apply(resolved)).toEqual({
      applied: false,
      reason: 'the suggestion is already applied',
    });

    const plain = r.stub.human('user_bob', 'Bob', 'just chatting');
    expect(await r.apply(plain)).toEqual({
      applied: false,
      reason: 'the message has no suggestion card',
    });

    const byAgent = await r.suggest({ start: 5, replacement: 'x' });
    byAgent.author = { kind: 'agent', role: 'orchestrator' };
    expect(await r.apply(byAgent)).toEqual({
      applied: false,
      reason: 'the suggestion was not made by a participant',
    });

    const gone = await r.suggest({
      start: 5,
      replacement: 'x',
      over: { documentId: 'doc_missing' },
    });
    expect(await r.apply(gone)).toEqual({
      applied: false,
      reason: 'the document no longer exists',
    });

    r.stub.documents[0]!.status = 'archived';
    expect(await r.apply(await r.suggest({ start: 5, replacement: 'x' }))).toEqual({
      applied: false,
      reason: 'Architecture.md is archived',
    });
    expect(r.stub.changes).toEqual([]);
  });

  it('hands back a suggestion that would change nothing', async () => {
    const r = await memoryRig();
    expect(await r.apply(await r.suggest({ start: 5, replacement: 'Para 2.' }))).toEqual({
      applied: false,
      reason: 'the suggestion changes nothing',
    });
  });

  it('takes the write queue: it waits behind a writer that holds it, and checks the text only once it has the lock', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const holder = r.repo.withMainLock(async () => {
      await hold;
      // the writer holding the queue changes the very paragraph while the suggestion waits
      await r.repo.commitToMain(
        { 'Architecture.md': DOC.replace('Para 2.', 'Para two, by Alice.') },
        'Edit',
        {
          actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
          triggerMessageIds: [],
        },
      );
    });
    const applying = r.apply(m);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.stub.changes).toEqual([]); // still waiting
    release();
    await holder;
    expect(await applying).toMatchObject({ applied: false }); // judged against the text after the writer
    expect(await r.repo.readFile('Architecture.md')).toContain('Para two, by Alice.');
  });

  it('two suggestions for the same paragraph: the first is applied, the second goes to the orchestrator', async () => {
    const r = await memoryRig();
    const first = await r.suggest({ start: 5, replacement: "Para two, Bob's way." });
    const second = await r.suggest({ start: 5, replacement: "Para two, Carol's way." });
    const [a, b] = await Promise.all([r.apply(first), r.apply(second)]);
    expect(a.applied).toBe(true);
    expect(b).toEqual({
      applied: false,
      reason: 'the anchored text changed since the suggestion was made',
    });
  });

  it('reports a commit that landed whose bookkeeping failed, so the orchestrator can finish it', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    r.stub.actions.updateCard = async () => {
      throw new Error('db busy');
    };
    const out = await r.apply(m);
    expect(out).toMatchObject({
      applied: true,
      bookkeepingFailed: 'could not resolve the suggestion card: db busy',
    });
    expect(await r.repo.readFile('Architecture.md')).toContain('Para two, tightened.'); // the text is on main
    expect(r.stub.changes).toHaveLength(1);
    expect(r.logs).toContain('suggestion applied, but its bookkeeping failed');
  });

  it('throws what it cannot handle (the caller then hands the suggestion to the orchestrator)', async () => {
    const r = await memoryRig();
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    r.repo.commitToMain = async () => {
      throw new Error('disk full');
    };
    await expect(r.apply(m)).rejects.toThrow('disk full');
    expect(r.stub.changes).toEqual([]);
  });
});

describe('the fast path on a real repository', () => {
  let g: GitRepoRig;
  afterEach(() => g.cleanup());

  it('commits through the formatter under the lock, leaving the main worktree clean and in step', async () => {
    g = await createGitRepo({ 'Architecture.md': DOC, 'PRD.md': '# PRD\n' });
    const r = await setup(g.repo);
    const m = await r.suggest({ start: 5, replacement: 'Para two, tightened.' });
    const out = await r.apply(m);
    expect(out.applied).toBe(true);
    const text = await g.repo.readFile('Architecture.md');
    expect(text).toBe(DOC.replace('Para 2.', 'Para two, tightened.'));
    expect(readFileSync(join(g.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(text);
    const info = await g.repo.show((out as { sha: string }).sha);
    expect(info.trailers.actor).toBe('user:user_bob');
    expect(info.trailers.triggerMessageIds).toEqual([m.id]);
  });
});
