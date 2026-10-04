import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
import type { StatusSink } from '../status.js';
import {
  runExploration,
  runExplorationWorker,
  runMergeDriver,
  runSemanticRevert,
  writeDigest,
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
    await runExplorationWorker(r.env, params(r));
    const [call] = r.sdk.calls;
    const o = call!.options;
    expect(o.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
    expect(o.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(o.env!.PATH).toBe(process.env.PATH);
    expect(o).toMatchObject({
      model: MODELS.worker,
      effort: EFFORT.worker,
      maxTurns: DEFAULTS.workerMaxTurns,
      maxBudgetUsd: 3,
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

describe('start_exploration (runExploration)', () => {
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

    const out = await runExploration(r.env, r.repo, {
      documentPath: 'Architecture.md',
      topic: 'Storage Engine',
      theses: ['PostgreSQL', 'ClickHouse', 'both'],
      triggerMessageIds: ['msg_1'],
    });

    expect(out.branchBase).toBe(base);
    expect(out.workers.map((w) => [w.label, w.branch])).toEqual([
      ['A', 'architecture/storage-engine/a'],
      ['B', 'architecture/storage-engine/b'],
      ['C', 'architecture/storage-engine/c'],
    ]);
    expect(out.workers.every((w) => w.changed && w.baseSha === base)).toBe(true);
    expect(out.failures).toEqual([]);
    // every branch was forked from the same sha, read once, not from "main" three times
    expect(created.map(([, from]) => from)).toEqual([base, base, base]);
    // what the room said while the workers ran comes back with the result (PRD 6.5)
    expect(out.chatSinceStart.map((m) => m.body)).toEqual(['actually ClickHouse']);
    // the status board shows the exploration
    expect(r.status.events).toEqual([
      'busy exploration:storage-engine (Exploring Storage Engine)',
      'done exploration:storage-engine',
    ]);
    // the recent chat reached the workers as context
    expect(r.sdk.calls[0]!.prompt).toContain("Alice: let's use PostgreSQL");
    // three result messages, three usage records
    expect(r.stub.usage).toHaveLength(0); // the scripted results carried no usage
  });

  it('picks a fresh topic slug when the branches already exist', async () => {
    const r = rig();
    await r.repo.createBranch('architecture/storage/a');
    r.sdk.respond(
      oneShot((call) => editDoc(call, `${DOC}\nx\n`), resultMessage({ structured: WORKER_OUT })),
    );
    const out = await runExploration(r.env, r.repo, {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['one'],
      triggerMessageIds: [],
    });
    expect(out.workers[0]!.branch).toBe('architecture/storage-2/a');
  });

  it('reports a worker that could not even start under failures and keeps the others', async () => {
    const r = rig();
    await r.repo.createBranch('architecture/storage/b'); // thesis 2 cannot create its branch
    r.sdk.respond(
      oneShot((call) => editDoc(call, `${DOC}\nx\n`), resultMessage({ structured: WORKER_OUT })),
    );
    const out = await runExploration(r.env, r.repo, {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['one', 'two'],
      triggerMessageIds: [],
    });
    expect(out.workers.map((w) => w.label)).toEqual(['A']);
    expect(out.failures).toEqual([
      { thesis: 'two', error: 'branch exists: architecture/storage/b' },
    ]);
    expect(r.logs.some((l) => l.startsWith('error:exploration worker failed'))).toBe(true);
  });

  it('timed-out workers still come back with their branches', async () => {
    const r = rig({ timeoutMs: 40 });
    r.sdk.respond(hang({ before: (call) => editDoc(call, `${DOC}\nPartial.\n`) }));
    const out = await runExploration(r.env, r.repo, {
      documentPath: 'Architecture.md',
      topic: 'storage',
      theses: ['one', 'two'],
      triggerMessageIds: [],
    });
    expect(out.workers.map((w) => [w.timedOut, w.changed])).toEqual([
      [true, true],
      [true, true],
    ]);
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
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
    });
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
