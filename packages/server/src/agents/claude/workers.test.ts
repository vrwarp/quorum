import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, EFFORT, MODELS } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import {
  FakeSdk,
  assistantMessage,
  hang,
  oneShot,
  resultMessage,
  type QueryCall,
} from '../testing/fakeQuery.js';
import { decide, makeProposal, tunables } from '../testing/fixtures.js';
import { RESEARCH_SYSTEM } from '../prompts.js';
import type { StatusSink } from '../status.js';
import {
  runExploration,
  runExplorationWorker,
  runMergeDriver,
  runResearchWorker,
  runSemanticRevert,
  startExploration,
  writeDigest,
  type ExplorationOutcome,
  type WorkerEnv,
} from './workers.js';

const DOC = '# Architecture\n\nIntro.\n';
const WORKER_OUT = {
  summary: 'Drafted the PostgreSQL option.',
  tradeoffs: 'Simple but slower for analytics.',
  assumptions: ['one node'],
  openQuestions: ['backups?'],
  sourcesConsulted: ['postgresql.org'],
};
const claude = {
  binary: '/opt/claude/bin/claude',
  env: () => ({ CLAUDE_CONFIG_DIR: '/data/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
};

class RecordingStatus implements StatusSink {
  events: string[] = [];
  busy(key: string, detail?: string | null) {
    this.events.push(`busy ${key}${detail ? ` (${detail})` : ''}`);
  }
  done(key: string) {
    this.events.push(`done ${key}`);
  }
  fail(key: string, detail: string) {
    this.events.push(`fail ${key} ${detail}`);
  }
  recover(key: string) {
    this.events.push(`recover ${key}`);
  }
}

interface Rig {
  repo: MemoryRepo;
  stub: StubActions;
  sdk: FakeSdk;
  env: WorkerEnv;
  status: RecordingStatus;
  logs: string[];
  dataDir: string;
}

function rig(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Rig {
  const repo = new MemoryRepo('room_test', {
    'Architecture.md': DOC,
    'PRD.md': '# PRD\n\nGoals.\n',
  });
  const stub = createStubActions({
    repo,
    documents: [
      { path: 'Architecture.md', title: 'Architecture' },
      { path: 'PRD.md', title: 'PRD' },
    ],
    participants: [
      { userId: 'user_alice', displayName: 'Alice' },
      { userId: 'user_bob', displayName: 'Bob' },
    ],
  });
  const sdk = new FakeSdk();
  const status = new RecordingStatus();
  const logs: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'quorum-workers-'));
  const env: WorkerEnv = {
    roomId: stub.roomId,
    actions: stub.actions,
    queryFn: sdk.queryFn,
    logger: (level, msg) => logs.push(`${level}:${msg}`),
    tunables: {
      ...DEFAULTS,
      ...(tunables({ workerTimeoutMs: opts.timeoutMs ?? DEFAULTS.workerTimeoutMs }) ?? {}),
    },
    dataDir,
    claude,
    maxBudgetUsd: 3,
    workerBudgetUsd: 1,
    digestBudgetUsd: 0.5,
    signal: opts.signal,
    status,
  };
  return { repo, stub, sdk, env, status, logs, dataDir };
}

const editDoc = (call: QueryCall, text: string, file = 'Architecture.md') =>
  writeFileSync(join(call.options.cwd!, file), text);

const params = (r: Rig, over: Record<string, unknown> = {}) => ({
  repo: r.repo,
  documentPath: 'Architecture.md',
  branch: 'architecture/storage/a',
  thesis: 'PostgreSQL everywhere',
  context: 'Recent chat: ...',
  triggerMessageIds: ['msg_1'],
  ...over,
});

describe('exploration worker', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('drafts on its own branch, commits the work with trailers, and reports the structured summary', async () => {
    r.sdk.respond(
      oneShot(
        (call) => editDoc(call, `${DOC}\n## Storage\n\nUse PostgreSQL.\n`),
        resultMessage({
          structured: WORKER_OUT,
          usage: { model: MODELS.worker, input: 4000, output: 600, cost: 0.02 },
        }),
      ),
    );
    const out = await runExplorationWorker(r.env, params(r));

    expect(out).toMatchObject({
      branch: 'architecture/storage/a',
      thesis: 'PostgreSQL everywhere',
      committed: true,
      changed: true,
      timedOut: false,
      ...WORKER_OUT,
    });
    expect(out.error).toBeUndefined();
    expect(out.baseSha).toBe(await r.repo.headSha('main'));
    expect(out.headSha).toBe(await r.repo.headSha('architecture/storage/a'));
    expect(out.headSha).not.toBe(out.baseSha);
    expect(await r.repo.changedFiles(out.baseSha, 'architecture/storage/a')).toEqual([
      'Architecture.md',
    ]);
    expect((await r.repo.show(out.headSha!)).trailers).toMatchObject({
      actor: 'agent:worker',
      triggerMessageIds: ['msg_1'],
    });
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC); // main untouched
    expect(r.stub.usage).toEqual([
      expect.objectContaining({
        role: 'worker',
        model: MODELS.worker,
        inputTokens: 4000,
        outputTokens: 600,
        costUsd: 0.02,
      }),
    ]);
  });

  it('launches the session with the credentials, the worker model, its worktree and the schema', async () => {
    process.env.QUORUM_PASSWORD = 'hunter2';
    try {
      await runExplorationWorker(r.env, params(r));
    } finally {
      delete process.env.QUORUM_PASSWORD;
    }
    const [call] = r.sdk.calls;
    const o = call!.options;
    expect(o.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
    expect(o.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(o.env!.PATH).toBe(process.env.PATH);
    expect(o.env!.QUORUM_PASSWORD).toBeUndefined(); // the server's own secrets never reach a session
    expect(o.verbatimPrompts).toBe(true); // chat text in the context is never expanded into @path attachments
    expect(o.sandbox).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      filesystem: { allowWrite: [o.cwd] },
    });
    expect(o).toMatchObject({
      model: MODELS.worker,
      effort: EFFORT.worker,
      maxTurns: DEFAULTS.workerMaxTurns,
      maxBudgetUsd: 1, // a worker gets its own, smaller cap than the 3 of the merge driver
      persistSession: false,
      permissionMode: 'default',
      settingSources: [],
    });
    expect(o.cwd).toContain('quorum-memrepo-wt-');
    expect(o.outputFormat).toMatchObject({ type: 'json_schema' });
    expect(o.tools).toEqual([
      'Read',
      'Edit',
      'Write',
      'Grep',
      'Glob',
      'Bash',
      'WebSearch',
      'WebFetch',
    ]);
    expect(o.allowedTools).toBeUndefined(); // every tool goes through canUseTool (see the next test)
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(typeof call!.prompt).toBe('string');
    expect(call!.prompt).toContain('Thesis: PostgreSQL everywhere');
    expect(call!.prompt).toContain('Document: Architecture.md');
  });

  it("confines the session's permissions to its one document", async () => {
    await runExplorationWorker(r.env, params(r));
    const can = r.sdk.calls[0]!.options.canUseTool!;
    const ask = (tool: string, input: Record<string, unknown>) => decide(can, tool, input);
    expect((await ask('Edit', { file_path: 'Architecture.md' })).behavior).toBe('allow');
    expect((await ask('Write', { file_path: 'PRD.md' })).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'git commit -am x' })).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'git log --oneline' })).behavior).toBe('allow');
    expect((await ask('WebFetch', { url: 'https://example.com' })).behavior).toBe('allow');
    expect((await ask('mcp__quorum__post_chat', { body: 'hi' })).behavior).toBe('deny');
    expect((await ask('mcp__quorum__read_transcript', {})).behavior).toBe('allow');
  });

  it('reverts edits outside the assigned document so the branch keeps to one file (scope rule)', async () => {
    r.sdk.respond(
      oneShot(
        (call) => {
          editDoc(call, `${DOC}\nDrafted.\n`);
          editDoc(call, '# PRD\n\nsneaky\n', 'PRD.md');
          editDoc(call, 'stray', 'Extra.md');
        },
        resultMessage({ structured: WORKER_OUT }),
      ),
    );
    const out = await runExplorationWorker(r.env, params(r));
    expect(out.scopeReverted).toEqual(['Extra.md', 'PRD.md']);
    expect(await r.repo.changedFiles(out.baseSha, 'architecture/storage/a')).toEqual([
      'Architecture.md',
    ]);
    expect(r.logs.some((l) => l.startsWith('warn:worker touched files outside its document'))).toBe(
      true,
    );
  });

  it('accepts the structured output from the result text when the field is missing', async () => {
    r.sdk.respond(oneShot(undefined, resultMessage({ text: JSON.stringify(WORKER_OUT) })));
    expect(await runExplorationWorker(r.env, params(r))).toMatchObject(WORKER_OUT);
  });

  it('reports a worker that made no changes as unchanged, with the model text as its summary', async () => {
    r.sdk.respond(
      oneShot(undefined, resultMessage({ text: 'I could not find anything to change.' })),
    );
    const out = await runExplorationWorker(r.env, params(r));
    expect(out).toMatchObject({
      committed: false,
      changed: false,
      summary: 'I could not find anything to change.',
      tradeoffs: '',
      assumptions: [],
    });
  });

  it('reports a crashed session with its error, keeping the branch', async () => {
    r.sdk.respond(async function* () {
      yield* [];
      throw new Error('Claude Code process exited with code 1');
    });
    const out = await runExplorationWorker(r.env, params(r));
    expect(out.error).toBe('Claude Code process exited with code 1');
    expect(out.summary).toMatch(/did not finish: Claude Code process exited with code 1/);
    expect(out.changed).toBe(false);
    expect(await r.repo.listBranches()).toContain('architecture/storage/a');
  });

  it('reports an error result subtype', async () => {
    r.sdk.respond(oneShot(undefined, resultMessage({ subtype: 'error_max_turns' })));
    expect((await runExplorationWorker(r.env, params(r))).error).toBe(
      'worker ended with error_max_turns',
    );
  });
});

describe('worker timeout', () => {
  it('aborts the query, closes it, and still reports the partial work on the branch', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(
      hang({ before: (call) => editDoc(call, `${DOC}\n## Partial\n\nHalf a thought.\n`) }),
    );
    const started = Date.now();
    const out = await runExplorationWorker(r.env, params(r));

    expect(Date.now() - started).toBeLessThan(2000);
    const call = r.sdk.calls[0]!;
    expect(call.options.abortController!.signal.aborted).toBe(true);
    expect(call.closed).toBe(true);
    expect(out.timedOut).toBe(true);
    expect(out.committed).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.summary).toMatch(/timed out after 0s; the branch holds its partial work/);
    expect(await r.repo.readFile('Architecture.md', 'architecture/storage/a')).toContain(
      'Half a thought.',
    );
  });

  it('does not wait for a session that ignores the abort signal', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(hang({ ignoreAbort: true }));
    const out = await Promise.race([
      runExplorationWorker(r.env, params(r)),
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 3000)),
    ]);
    expect(out).not.toBe('stuck');
    expect(r.sdk.calls[0]!.closed).toBe(true); // closing the query is what terminates the subprocess
    expect((out as { timedOut: boolean }).timedOut).toBe(true);
  });

  it('records the tokens a timed-out session spent, which never produced a result message', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(
      hang({
        messages: [assistantMessage({ id: 'm1', model: MODELS.worker, input: 3000, output: 200 })],
      }),
    );
    await runExplorationWorker(r.env, params(r));
    expect(r.stub.usage).toHaveLength(1);
    expect(r.stub.usage[0]).toMatchObject({
      role: 'worker',
      model: MODELS.worker,
      inputTokens: 3000,
      outputTokens: 200,
    });
    expect(r.stub.usage[0]!.costUsd).toBeGreaterThan(0);
  });

  it('is cancelled when the room stops (parent abort), not reported as a timeout', async () => {
    const parent = new AbortController();
    const r = rig({ signal: parent.signal });
    r.sdk.respond(hang());
    const run = runExplorationWorker(r.env, params(r));
    await new Promise((resolve) => setTimeout(resolve, 20));
    parent.abort();
    const out = await run;
    expect(out).toMatchObject({ timedOut: false });
    expect(out.summary).toMatch(/cancelled/);
    expect(r.sdk.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(r.sdk.calls[0]!.closed).toBe(true);
  });

  it('starts already cancelled when the room was stopped before the worker began', async () => {
    const parent = new AbortController();
    parent.abort();
    const r = rig({ signal: parent.signal });
    r.sdk.respond(hang());
    const out = await runExplorationWorker(r.env, params(r));
    expect(out.summary).toMatch(/cancelled/);
  });
});

describe('start_exploration (startExploration, runExploration)', () => {
  const REQ = {
    documentPath: 'Architecture.md',
    topic: 'Storage Engine',
    theses: ['PostgreSQL', 'ClickHouse', 'both'],
    triggerMessageIds: ['msg_1'],
  };
  const draftScript = () =>
    oneShot(
      (call) => editDoc(call, `${DOC}\nDraft ${call.index}.\n`),
      resultMessage({ structured: WORKER_OUT }),
    );

  it('runs one worker per thesis on branches a, b, c from one shared base and returns the outcome', async () => {
    const r = rig();
    r.stub.human('user_alice', 'Alice', "let's use PostgreSQL");
    const created: Array<[string, string | undefined]> = [];
    const original = r.repo.createBranch.bind(r.repo);
    r.repo.createBranch = async (branch, from) => {
      created.push([branch, from]);
      return original(branch, from);
    };
    r.sdk.respond(
      oneShot(
        (call) => {
          editDoc(call, `${DOC}\nDraft ${call.index}.\n`);
          if (call.index === 0) r.stub.human('user_bob', 'Bob', 'actually ClickHouse'); // said while the workers run
        },
        resultMessage({ structured: WORKER_OUT }),
      ),
    );
    const base = await r.repo.headSha('main');

    const out = await runExploration(r.env, r.repo, REQ);

    expect(out.mode).toBe('draft');
    expect(out.branchBase).toBe(base);
    expect(out.workers.map((w) => [w.label, w.branch])).toEqual([
      ['A', 'architecture/storage-engine/a'],
      ['B', 'architecture/storage-engine/b'],
      ['C', 'architecture/storage-engine/c'],
    ]);
    expect(out.workers.every((w) => w.changed && w.baseSha === base)).toBe(true);
    // diff stats come from the branches: one added line and a blank, no paragraph removed
    expect(out.workers[0]!.diffStat).toEqual({ removed: 0, added: 2 });
    expect(out.failures).toEqual([]);
    expect(out.partial).toBe(false);
    // every branch was forked from the same sha, read once, not from "main" three times
    expect(created.map(([, from]) => from)).toEqual([base, base, base]);
    // what the room said while the workers ran comes back with the result (PRD 6.5)
    expect(out.chatSinceStart.map((m) => m.body)).toEqual(['actually ClickHouse']);
    // the status board shows the exploration while it runs
    expect(r.status.events).toEqual([
      `busy exploration:${out.explorationId} (Exploring Storage Engine)`,
      `done exploration:${out.explorationId}`,
    ]);
    // the recent chat reached the workers as context
    expect(r.sdk.calls[0]!.prompt).toContain("Alice: let's use PostgreSQL");
    expect(r.stub.usage).toHaveLength(0); // the scripted results carried no usage
  });

  describe('returns at once and runs the workers in the background', () => {
    /** a worker script that waits on a gate before it finishes */
    function gated() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const script = async function* (call: QueryCall) {
        editDoc(call, `${DOC}\nDraft ${call.index}.\n`);
        await gate;
        yield resultMessage({ structured: WORKER_OUT });
      };
      return { script, release };
    }

    it('answers with the branches and the base before any worker is done, and delivers the outcome later', async () => {
      const r = rig();
      const g = gated();
      r.sdk.respond(g.script);
      const delivered: ExplorationOutcome[] = [];
      const base = await r.repo.headSha('main');

      const started = await startExploration(r.env, r.repo, REQ, {
        onFinished: (o) => delivered.push(o),
      });

      expect(started).toMatchObject({
        mode: 'draft',
        branches: [
          'architecture/storage-engine/a',
          'architecture/storage-engine/b',
          'architecture/storage-engine/c',
        ],
        baseSha: base,
      });
      expect(started.explorationId).toMatch(/^expl_[0-9a-f]{12}$/);
      expect(started.note).toMatch(/exploration_finished/);
      // the branches are reserved already; nothing has finished
      expect(
        (await r.repo.listBranches()).filter((b) => b.startsWith('architecture/')),
      ).toHaveLength(3);
      expect(delivered).toEqual([]);
      expect(r.status.events).toEqual([
        `busy exploration:${started.explorationId} (Exploring Storage Engine)`,
      ]);

      g.release();
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0]).toMatchObject({
        explorationId: started.explorationId,
        documentPath: 'Architecture.md',
        topic: 'Storage Engine',
        branchBase: base,
        partial: false,
      });
      expect(delivered[0]!.workers.map((w) => w.branch)).toEqual(started.branches);
      expect(r.status.events.at(-1)).toBe(`done exploration:${started.explorationId}`);
    });

    it('posts the exploration card itself, before returning (the orchestrator does not post one)', async () => {
      const r = rig();
      r.sdk.respond(draftScript());
      await runExploration(r.env, r.repo, REQ);
      const [card] = r.stub.messages.filter((m) => m.card?.type === 'exploration_started');
      expect(card!.card).toEqual({
        type: 'exploration_started',
        documentId: 'doc_1',
        title: 'Exploring Storage Engine for Architecture',
        theses: ['PostgreSQL', 'ClickHouse', 'both'],
      });
      expect(card!.body).toBe('Exploring Storage Engine for Architecture');
      expect(card!.inReplyTo).toEqual(['msg_1']);
      expect(card!.author).toEqual({ kind: 'agent', role: 'orchestrator' });
    });

    it('uses the announcement the model wrote for the card', async () => {
      const r = rig();
      r.sdk.respond(draftScript());
      await runExploration(r.env, r.repo, {
        ...REQ,
        announcement: 'Exploring PostgreSQL vs ClickHouse for Architecture.md',
      });
      expect(r.stub.messages[0]!.body).toBe(
        'Exploring PostgreSQL vs ClickHouse for Architecture.md',
      );
    });

    it('still explores when the card cannot be posted', async () => {
      const r = rig();
      r.stub.actions.postChat = async () => {
        throw new Error('chat is down');
      };
      r.sdk.respond(draftScript());
      const out = await runExploration(r.env, r.repo, REQ);
      expect(out.workers).toHaveLength(3);
      expect(r.logs).toContain('warn:could not post the exploration card');
    });

    it('removes the worktrees once the results are delivered; the branches stay', async () => {
      const r = rig();
      r.sdk.respond(draftScript());
      const removed: string[] = [];
      const original = r.repo.removeWorktree.bind(r.repo);
      r.repo.removeWorktree = async (branch) => {
        removed.push(branch);
        return original(branch);
      };
      const out = await new Promise<ExplorationOutcome>((resolve) => {
        void startExploration(r.env, r.repo, REQ, { onFinished: resolve });
      });
      await vi.waitFor(() => expect(removed).toHaveLength(3));
      expect(removed.sort()).toEqual(out.workers.map((w) => w.branch).sort());
      for (const w of out.workers) {
        expect(r.repo.worktrees.has(w.branch)).toBe(false);
        expect(await r.repo.headSha(w.branch)).toBe(w.headSha); // the drafts are on their branches
      }
    });

    it('lets the runtime track the background run', async () => {
      const r = rig();
      const g = gated();
      r.sdk.respond(g.script);
      const tracked: Promise<unknown>[] = [];
      await startExploration(r.env, r.repo, REQ, {
        onFinished: () => undefined,
        track: (run) => tracked.push(run),
      });
      expect(tracked).toHaveLength(1);
      let done = false;
      void tracked[0]!.then(() => (done = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(done).toBe(false);
      g.release();
      await tracked[0];
      expect(done).toBe(true);
    });

    it('delivers an outcome even when the exploration blows up, so the orchestrator is never left waiting', async () => {
      const r = rig();
      r.stub.actions.readTranscript = vi
        .fn()
        .mockResolvedValueOnce([]) // start marker
        .mockResolvedValueOnce([]) // recent chat
        .mockRejectedValue(new Error('db gone')); // after the workers
      r.sdk.respond(draftScript());
      const out = await runExploration(r.env, r.repo, REQ);
      // the transcript read after the workers is best effort: the results still arrive
      expect(out.workers).toHaveLength(3);
      expect(out.chatSinceStart).toEqual([]);
    });

    it('keeps cleaning up when delivering the results throws', async () => {
      const r = rig();
      r.sdk.respond(draftScript());
      let removed = 0;
      const original = r.repo.removeWorktree.bind(r.repo);
      r.repo.removeWorktree = async (branch) => {
        removed += 1;
        return original(branch);
      };
      await startExploration(r.env, r.repo, REQ, {
        onFinished: () => {
          throw new Error('listener bug');
        },
      });
      await vi.waitFor(() => expect(removed).toBe(3));
      expect(r.logs).toContain('error:delivering the exploration results failed');
    });
  });

  describe('branch names are allocated atomically', () => {
    it('gives two explorations of the same topic started together different names', async () => {
      const r = rig();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      r.sdk.respond(async function* (call) {
        editDoc(call, `${DOC}\nDraft ${call.index}.\n`);
        await gate;
        yield resultMessage({ structured: WORKER_OUT });
      });
      const hooks = { onFinished: () => undefined };
      const [one, two, three] = await Promise.all([
        startExploration(r.env, r.repo, { ...REQ, theses: ['x', 'y'] }, hooks),
        startExploration(r.env, r.repo, { ...REQ, theses: ['x', 'y'] }, hooks),
        startExploration(r.env, r.repo, { ...REQ, theses: ['x'] }, hooks),
      ]);
      const all = [...one.branches, ...two.branches, ...three.branches];
      expect(new Set(all).size).toBe(all.length); // no name twice
      expect(all.sort()).toEqual([
        'architecture/storage-engine-2/a',
        'architecture/storage-engine-2/b',
        'architecture/storage-engine-3/a',
        'architecture/storage-engine/a',
        'architecture/storage-engine/b',
      ]);
      release();
    });

    it('picks a fresh topic slug when the branches already exist', async () => {
      const r = rig();
      await r.repo.createBranch('architecture/storage/a');
      r.sdk.respond(draftScript());
      const out = await runExploration(r.env, r.repo, {
        documentPath: 'Architecture.md',
        topic: 'storage',
        theses: ['one'],
        triggerMessageIds: [],
      });
      expect(out.workers[0]!.branch).toBe('architecture/storage-2/a');
    });

    it('rolls back the branches it made when it cannot make them all, and tells the caller', async () => {
      const r = rig();
      const original = r.repo.createBranch.bind(r.repo);
      let n = 0;
      r.repo.createBranch = async (branch, from) => {
        if (++n === 2) throw new Error('disk full');
        return original(branch, from);
      };
      await expect(
        startExploration(
          r.env,
          r.repo,
          { ...REQ, theses: ['one', 'two'] },
          { onFinished: () => undefined },
        ),
      ).rejects.toThrow('disk full');
      expect((await r.repo.listBranches()).filter((b) => b.startsWith('architecture/'))).toEqual(
        [],
      );
      expect(r.sdk.calls).toHaveLength(0); // no worker was started
      expect(r.status.events).toEqual([]);
    });
  });

  it('refuses an unknown or archived document before reserving anything', async () => {
    const r = rig();
    await expect(
      startExploration(
        r.env,
        r.repo,
        { ...REQ, documentPath: 'Nope.md' },
        { onFinished: () => undefined },
      ),
    ).rejects.toThrow(/no document with path Nope\.md; known: Architecture\.md, PRD\.md/);
    r.stub.documents[0]!.status = 'archived';
    await expect(
      startExploration(r.env, r.repo, REQ, { onFinished: () => undefined }),
    ).rejects.toThrow(/archived/);
    expect((await r.repo.listBranches()).filter((b) => b.startsWith('architecture/'))).toEqual([]);
  });

  it("reports a worker whose commit failed on that worker, and keeps the others' results", async () => {
    const r = rig();
    r.sdk.respond(draftScript());
    const commit = r.repo.commitWorktree.bind(r.repo);
    r.repo.commitWorktree = async (path, subject, meta) => {
      if (subject.startsWith('Draft: two')) throw new Error('commit exploded');
      return commit(path, subject, meta);
    };
    const out = await runExploration(r.env, r.repo, { ...REQ, theses: ['one', 'two'] });
    expect(out.workers.map((w) => w.label)).toEqual(['A', 'B']);
    // the commit failure is reported on the worker, which keeps whatever the branch holds
    expect(out.workers[1]!.error).toBe('commit exploded');
    expect(out.partial).toBe(true);
    expect(out.failures).toEqual([]);
  });

  it('timed-out workers still come back with their branches, and the outcome says it is partial', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(hang({ before: (call) => editDoc(call, `${DOC}\nPartial.\n`) }));
    const out = await runExploration(r.env, r.repo, { ...REQ, theses: ['one', 'two'] });
    expect(out.workers.map((w) => [w.timedOut, w.changed])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(out.partial).toBe(true);
  });

  it('runs on the room abort signal: stopping the room cancels the workers, which still report their branches', async () => {
    const ac = new AbortController();
    const r = rig({ signal: ac.signal });
    r.sdk.respond(hang({ before: (call) => editDoc(call, `${DOC}\nPartial.\n`) }));
    const finished = new Promise<ExplorationOutcome>((resolve) => {
      void startExploration(r.env, r.repo, { ...REQ, theses: ['one'] }, { onFinished: resolve });
    });
    await vi.waitFor(() => expect(r.sdk.calls).toHaveLength(1));
    ac.abort();
    const out = await finished;
    expect(out.workers[0]).toMatchObject({ timedOut: false, changed: true });
    expect(out.workers[0]!.summary).toMatch(/cancelled/);
    expect(out.partial).toBe(false); // cancelled by the room, not a failure of the work
  });

  it('gives each worker the smaller per-session budget', async () => {
    const r = rig();
    r.sdk.respond(draftScript());
    await runExploration(r.env, r.repo, { ...REQ, theses: ['one', 'two'] });
    expect(r.sdk.calls.map((c) => c.options.maxBudgetUsd)).toEqual([1, 1]);
  });

  describe('research mode (questions that need the web)', () => {
    const RESEARCH = {
      documentPath: 'Architecture.md',
      topic: 'p99 targets',
      theses: ['What p99 latency do comparable systems promise?'],
      triggerMessageIds: ['msg_1'],
      mode: 'research' as const,
    };
    const FINDINGS = {
      summary: 'Comparable systems promise p99 between 100 and 300 ms.',
      tradeoffs: 'Vendor claims, not measurements.',
      assumptions: [],
      openQuestions: [],
      sourcesConsulted: ['https://example.com/latency'],
    };

    it('starts read-only researchers: no branch, no card, no draft', async () => {
      const r = rig();
      r.sdk.respond(oneShot(undefined, resultMessage({ structured: FINDINGS })));
      const branchesBefore = await r.repo.listBranches();
      let started!: Awaited<ReturnType<typeof startExploration>>;
      const out = await new Promise<ExplorationOutcome>((resolve) => {
        void startExploration(r.env, r.repo, RESEARCH, { onFinished: resolve }).then(
          (s) => (started = s),
        );
      });

      expect(started).toMatchObject({ mode: 'research', branches: [] });
      expect(await r.repo.listBranches()).toEqual(branchesBefore); // nothing was created
      expect(r.stub.messages.filter((m) => m.card)).toEqual([]); // no "Exploring" card for a question
      expect(out.mode).toBe('research');
      expect(out.workers).toEqual([]);
      expect(out.findings).toEqual([
        {
          label: 'A',
          question: RESEARCH.theses[0],
          timedOut: false,
          ...FINDINGS,
        },
      ]);
      expect(out.partial).toBe(false);
      expect(r.status.events[0]).toMatch(
        /^busy exploration:expl_[0-9a-f]+ \(Researching p99 targets\)$/,
      );
    });

    it('cannot edit anything: no Edit or Write tool, and the policy denies writes everywhere', async () => {
      const r = rig();
      r.sdk.respond(oneShot(undefined, resultMessage({ structured: FINDINGS })));
      await runExploration(r.env, r.repo, RESEARCH);
      const o = r.sdk.calls[0]!.options;
      expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch']);
      expect(o.systemPrompt).toBe(RESEARCH_SYSTEM);
      expect(o.maxBudgetUsd).toBe(1);
      expect(o.verbatimPrompts).toBe(true);
      const ask = (tool: string, input: Record<string, unknown>) =>
        decide(o.canUseTool!, tool, input);
      expect((await ask('Write', { file_path: 'Architecture.md' })).behavior).toBe('deny');
      expect((await ask('Edit', { file_path: 'Architecture.md' })).behavior).toBe('deny');
      expect((await ask('Write', { file_path: 'Anything.md' })).behavior).toBe('deny');
      expect((await ask('Read', { file_path: 'Architecture.md' })).behavior).toBe('allow');
      expect((await ask('WebFetch', { url: 'https://example.com/x' })).behavior).toBe('allow');
      expect((await ask('WebFetch', { url: 'http://169.254.169.254/' })).behavior).toBe('deny');
      expect((await ask('mcp__quorum__post_chat', { body: 'hi' })).behavior).toBe('deny');
      expect((await ask('mcp__quorum__read_transcript', {})).behavior).toBe('allow');
      expect(r.sdk.calls[0]!.prompt).toContain(`Question: ${RESEARCH.theses[0]}`);
      expect(r.sdk.calls[0]!.prompt).not.toMatch(/Draft the change/);
    });

    it('works in a throwaway worktree at the exploration base, which is removed afterwards', async () => {
      const r = rig();
      r.sdk.respond(oneShot(undefined, resultMessage({ structured: FINDINGS })));
      const removed: string[] = [];
      const original = r.repo.removeWorktree.bind(r.repo);
      r.repo.removeWorktree = async (name) => {
        removed.push(name);
        return original(name);
      };
      const out = await runExploration(r.env, r.repo, RESEARCH);
      expect(r.sdk.calls[0]!.options.cwd).toContain('quorum-memrepo-detached-');
      await vi.waitFor(() => expect(removed).toContain(`research-${out.explorationId}-a`));
    });

    it('runs one researcher per question, and reports a researcher that timed out as partial', async () => {
      const r = rig({ timeoutMs: 40 });
      r.sdk.respond(hang());
      const out = await runExploration(r.env, r.repo, {
        ...RESEARCH,
        theses: ['first question', 'second question'],
      });
      expect(out.findings.map((f) => [f.label, f.question, f.timedOut])).toEqual([
        ['A', 'first question', true],
        ['B', 'second question', true],
      ]);
      expect(out.findings[0]!.summary).toMatch(/timed out/);
      expect(out.partial).toBe(true);
    });

    it('runResearchWorker reports a crash as findings with an error, not as a thrown exception', async () => {
      const r = rig();
      r.sdk.respond(oneShot(undefined, resultMessage({ subtype: 'error_during_execution' })));
      const base = (await r.repo.headSha('main'))!;
      const f = await runResearchWorker(r.env, {
        repo: r.repo,
        id: 'expl_x',
        label: 'a',
        documentPath: 'Architecture.md',
        question: 'q',
        context: '',
        baseSha: base,
      });
      expect(f.error).toBe('worker ended with error_during_execution');
      expect(f.summary).toMatch(/did not finish/);
    });
  });
});

describe('merge driver', () => {
  const CONFLICTED =
    '# Architecture\n\n<<<<<<< HEAD\nMain side.\n=======\nProposal side.\n>>>>>>> architecture/storage/a\n';

  async function mergeRig(timeoutMs?: number) {
    const r = rig({ timeoutMs });
    const worktreePath = await r.repo.createDetachedWorktree('merge-1', 'main');
    writeFileSync(join(worktreePath, 'Architecture.md'), CONFLICTED);
    const input = {
      proposal: makeProposal(),
      optionId: 'opt_a',
      worktreePath,
      conflictedFiles: ['Architecture.md'],
      documentPath: 'Architecture.md',
    };
    return { r, worktreePath, input };
  }

  it('leaves a clean document and returns the structured verdict', async () => {
    const { r, worktreePath, input } = await mergeRig();
    r.sdk.respond(
      oneShot(
        (call) =>
          writeFileSync(
            join(call.options.cwd!, 'Architecture.md'),
            '# Architecture\n\nProposal side, adjusted for main.\n',
          ),
        resultMessage({
          structured: {
            reconciled: true,
            summary: 'Kept the proposal text and updated one sentence.',
          },
          usage: { model: MODELS.merge, input: 900, output: 100, cost: 0.01 },
        }),
      ),
    );
    const out = await runMergeDriver(r.env, input);
    expect(out).toEqual({
      reconciled: true,
      summary: 'Kept the proposal text and updated one sentence.',
    });
    const o = r.sdk.calls[0]!.options;
    expect(o).toMatchObject({
      model: MODELS.merge,
      effort: EFFORT.merge,
      cwd: worktreePath,
      persistSession: false,
      maxTurns: DEFAULTS.workerMaxTurns,
      maxBudgetUsd: 3, // the merge driver keeps the whole per-session cap: one Opus session, serialized by the queue
      verbatimPrompts: true,
      sandbox: { enabled: true, filesystem: { allowWrite: [worktreePath] } },
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
    });
    expect(o.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude' });
    expect(o.tools).toEqual(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']);
    expect(r.sdk.calls[0]!.prompt).toContain('Files with conflict markers: Architecture.md');
    expect(r.stub.usage).toEqual([
      expect.objectContaining({ role: 'merge', model: MODELS.merge, inputTokens: 900 }),
    ]);
    expect(r.status.events).toEqual([
      `busy merge:prop_1 (Merging PostgreSQL vs ClickHouse)`,
      'done merge:prop_1',
    ]);
  });

  it('may only edit the document and the conflicted files', async () => {
    const { r, input } = await mergeRig();
    await runMergeDriver(r.env, input).catch(() => undefined);
    const can = r.sdk.calls[0]!.options.canUseTool!;
    const ask = (tool: string, input: Record<string, unknown>) => decide(can, tool, input);
    expect((await ask('Edit', { file_path: 'Architecture.md' })).behavior).toBe('allow');
    expect((await ask('Write', { file_path: 'PRD.md' })).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'git show MERGE_HEAD:Architecture.md' })).behavior).toBe(
      'allow',
    );
    expect((await ask('Bash', { command: 'git commit -m x' })).behavior).toBe('deny');
  });

  it('refuses a result that still has conflict markers: they never reach main', async () => {
    const { r, input } = await mergeRig();
    r.sdk.respond(
      oneShot(undefined, resultMessage({ structured: { reconciled: true, summary: 'resolved' } })),
    ); // but the file still has markers
    await expect(runMergeDriver(r.env, input)).rejects.toThrow(
      'merge driver left conflict markers in Architecture.md',
    );
  });

  it('falls back to the result text when there is no structured output', async () => {
    const { r, worktreePath, input } = await mergeRig();
    r.sdk.respond(
      oneShot(
        () => writeFileSync(join(worktreePath, 'Architecture.md'), '# Architecture\n\nResolved.\n'),
        resultMessage({ text: 'Resolved by keeping both.' }),
      ),
    );
    expect(await runMergeDriver(r.env, input)).toEqual({
      reconciled: true,
      summary: 'Resolved by keeping both.',
    });
    // without conflicts the default is "nothing reconciled"
    r.sdk.respond(oneShot(undefined, resultMessage({ text: '' })));
    expect(await runMergeDriver(r.env, { ...input, conflictedFiles: [] })).toEqual({
      reconciled: false,
      summary: 'Merged.',
    });
  });

  it('fails clearly on timeout, cancellation, crash and error results', async () => {
    const { r, input } = await mergeRig(40);
    r.sdk.respond(hang());
    await expect(runMergeDriver(r.env, input)).rejects.toThrow('merge driver timed out');
    expect(r.sdk.calls[0]!.closed).toBe(true);

    r.sdk.respond(async function* () {
      yield* [];
      throw new Error('spawn ENOENT');
    });
    await expect(runMergeDriver(r.env, input)).rejects.toThrow('merge driver failed: spawn ENOENT');

    r.sdk.respond(oneShot(undefined, resultMessage({ subtype: 'error_max_turns' })));
    await expect(runMergeDriver(r.env, input)).rejects.toThrow(
      'merge driver ended with error_max_turns',
    );

    r.sdk.respond(async function* () {
      /* ends without a result */
    });
    await expect(runMergeDriver(r.env, input)).rejects.toThrow('merge driver ended with no result');
  });
});

describe('semantic revert', () => {
  async function revertRig(timeoutMs?: number) {
    const r = rig({ timeoutMs });
    const first = await r.repo.commitToMain(
      { 'Architecture.md': `${DOC}\n## Latency\n\np99 under 200 ms.\n` },
      'Add latency section',
      { actor: { kind: 'agent', role: 'orchestrator' }, triggerMessageIds: ['msg_7'] },
    );
    await r.repo.commitToMain(
      {
        'Architecture.md': `${DOC}\n## Latency\n\np99 under 200 ms.\n\n## Throughput\n\n10k writes per second.\n`,
      },
      'Add throughput',
      { actor: { kind: 'agent', role: 'orchestrator' }, triggerMessageIds: [] },
    );
    const change = {
      sha: first,
      roomId: 'room_test',
      documentId: 'doc_1',
      actor: { kind: 'agent', role: 'orchestrator' } as const,
      summary: 'Added a latency section',
      triggerMessageIds: ['msg_7'],
      proposalId: null,
      revertsSha: null,
      revertedBySha: null,
      createdAt: '',
    };
    return { r, change };
  }

  it('edits the main worktree under the write queue and commits the revert as the participant', async () => {
    const { r, change } = await revertRig();
    let locks = 0;
    const withLock = r.repo.withMainLock.bind(r.repo);
    r.repo.withMainLock = (fn) => {
      locks += 1;
      return withLock(fn);
    };
    // the main worktree is shared, so the revert commits only the document it changed
    const commitPaths: Array<string[] | undefined> = [];
    const commit = r.repo.commitWorktree.bind(r.repo);
    r.repo.commitWorktree = (path, subject, meta, paths) => {
      commitPaths.push(paths);
      return commit(path, subject, meta);
    };
    r.sdk.respond(
      oneShot(
        (call) => editDoc(call, `${DOC}\n## Throughput\n\n10k writes per second.\n`),
        resultMessage({
          structured: {
            reconciled: true,
            summary: 'Removed the latency section; kept throughput.',
          },
          usage: { model: MODELS.merge, input: 500, output: 50, cost: 0.005 },
        }),
      ),
    );
    const sha = await runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' });

    expect(locks).toBe(1);
    expect(commitPaths).toEqual([['Architecture.md']]);
    expect(await r.repo.headSha('main')).toBe(sha);
    expect(await r.repo.readFile('Architecture.md')).toBe(
      `${DOC}\n## Throughput\n\n10k writes per second.\n`,
    );
    const info = await r.repo.show(sha);
    expect(info.subject).toBe(`Revert ${change.sha.slice(0, 7)}: Add latency section`);
    expect(info.trailers).toMatchObject({
      actor: 'user:user_bob',
      revertsSha: change.sha,
      triggerMessageIds: ['msg_7'],
    });
    expect(r.sdk.calls[0]!.options.cwd).toBe(r.repo.mainWorktree);
    expect(r.sdk.calls[0]!.prompt).toContain(`Undo commit ${change.sha}`);
    expect(r.stub.usage).toEqual([expect.objectContaining({ role: 'merge', inputTokens: 500 })]);
  });

  it('only keeps edits to the changed document', async () => {
    const { r, change } = await revertRig();
    r.sdk.respond(
      oneShot(
        (call) => {
          editDoc(call, `${DOC}\n## Throughput\n\n10k writes per second.\n`);
          editDoc(call, '# PRD\n\nsneaky\n', 'PRD.md');
        },
        resultMessage({ structured: { reconciled: true, summary: 'done' } }),
      ),
    );
    const sha = await runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' });
    expect((await r.repo.show(sha)).files).toEqual(['Architecture.md']);
    expect(await r.repo.readFile('PRD.md')).toBe('# PRD\n\nGoals.\n');
  });

  it('discards a half-finished edit when the run fails, instead of leaving it for the next commit', async () => {
    const { r, change } = await revertRig(40);
    const head = await r.repo.headSha('main');
    r.sdk.respond(hang({ before: (call) => editDoc(call, '# Architecture\n\nHALF DONE') }));
    await expect(
      runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' }),
    ).rejects.toThrow('semantic revert timed out');
    expect(await r.repo.headSha('main')).toBe(head);
    expect(readFileSync(join(r.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(
      await r.repo.readFile('Architecture.md'),
    );
    expect(r.sdk.calls[0]!.closed).toBe(true);
  });

  it('fails when nothing changed, or the result is an error, or markers remain', async () => {
    const { r, change } = await revertRig();
    r.sdk.respond(
      oneShot(undefined, resultMessage({ structured: { reconciled: true, summary: 'x' } })),
    );
    await expect(
      runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' }),
    ).rejects.toThrow('semantic revert changed nothing');

    r.sdk.respond(oneShot(undefined, resultMessage({ subtype: 'error_during_execution' })));
    await expect(
      runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' }),
    ).rejects.toThrow('semantic revert ended with error_during_execution');

    r.sdk.respond(
      oneShot(
        (call) => editDoc(call, '# Architecture\n\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n'),
        resultMessage({ structured: { reconciled: true, summary: 'x' } }),
      ),
    );
    await expect(
      runSemanticRevert(r.env, r.repo, { change, byUserId: 'user_bob' }),
    ).rejects.toThrow('semantic revert left conflict markers in Architecture.md');
  });
});

describe('digest writer', () => {
  const input = {
    userId: 'user_dave',
    sinceMessageId: 'msg_5',
    events: ['Change on Architecture by Alice: Added latency', 'Proposal opened: PG vs CH'],
  };

  it('returns the trimmed digest text and may only read the transcript', async () => {
    const r = rig();
    r.sdk.respond(
      oneShot(
        undefined,
        resultMessage({
          text: '\n- Alice added a latency section.\n- A vote is open.\n',
          usage: { model: MODELS.digest, input: 700, output: 60, cost: 0.003 },
        }),
      ),
    );
    expect(await writeDigest(r.env, r.repo, input)).toBe(
      '- Alice added a latency section.\n- A vote is open.',
    );

    const call = r.sdk.calls[0]!;
    expect(call.options).toMatchObject({
      model: MODELS.digest,
      effort: EFFORT.digest,
      cwd: r.dataDir,
      tools: [],
      maxTurns: 8,
      maxBudgetUsd: 0.5, // a small fixed cap, not the per-session cap of the big sessions
      verbatimPrompts: true,
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
    });
    expect(call.options.sandbox).toBeUndefined(); // no Bash, nothing to isolate
    expect(call.options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(call.prompt).toContain('The participant last saw message msg_5');
    expect(call.prompt).toContain('- Proposal opened: PG vs CH');
    const ask = (tool: string, i: Record<string, unknown>) =>
      decide(call.options.canUseTool!, tool, i);
    expect((await ask('Read', { file_path: 'x.md' })).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'ls' })).behavior).toBe('deny');
    expect((await ask('mcp__quorum__read_transcript', {})).behavior).toBe('allow');
    expect((await ask('mcp__quorum__post_chat', {})).behavior).toBe('deny');
    expect(r.stub.usage).toEqual([
      expect.objectContaining({ role: 'digest', model: MODELS.digest, inputTokens: 700 }),
    ]);
  });

  it('reads from the start of the room when the participant has no last message, and lists no events gracefully', async () => {
    const r = rig();
    r.sdk.respond(oneShot(undefined, resultMessage({ text: 'ok' })));
    await writeDigest(r.env, r.repo, { userId: 'u', sinceMessageId: null, events: [] });
    expect(r.sdk.calls[0]!.prompt).toContain('Read the transcript from the start of the room.');
    expect(r.sdk.calls[0]!.prompt).toContain('- (none recorded)');
  });

  it('fails on timeout, crash, missing result and error results', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(hang());
    await expect(writeDigest(r.env, r.repo, input)).rejects.toThrow('digest writer timed out');
    r.sdk.respond(async function* () {
      yield* [];
      throw new Error('boom');
    });
    await expect(writeDigest(r.env, r.repo, input)).rejects.toThrow('digest writer failed: boom');
    r.sdk.respond(async function* () {
      /* no result */
    });
    await expect(writeDigest(r.env, r.repo, input)).rejects.toThrow(
      'digest writer ended with no result',
    );
    r.sdk.respond(oneShot(undefined, resultMessage({ isError: true, text: 'rate limited' })));
    await expect(writeDigest(r.env, r.repo, input)).rejects.toThrow(
      'digest writer ended with success',
    );
  });
});
