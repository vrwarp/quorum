import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULTS, EFFORT, MODELS, type Message } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import {
  FakeSdk,
  assistantMessage,
  resultMessage,
  session,
  userText,
  type QueryCall,
} from '../testing/fakeQuery.js';
import { decide, makeProposal, tunables } from '../testing/fixtures.js';
import { StatusBoard } from '../status.js';
import { SIGN_IN_DETAIL } from '../common.js';
import { ScratchWorktree } from './scratch.js';
import {
  ORCHESTRATOR_BUILTIN_TOOLS,
  Orchestrator,
  buildOrchestratorOptions,
  type ApiRetryPolicy,
  type OrchestratorDeps,
  type RestartPolicy,
} from './orchestrator.js';

const claude = {
  binary: '/opt/claude/bin/claude',
  env: () => ({ CLAUDE_CONFIG_DIR: '/data/claude' }),
};
const FAST: Partial<RestartPolicy> = {
  baseDelayMs: 1,
  maxDelayMs: 2,
  cooldownMs: 40,
  max: 3,
  windowMs: 60_000,
};

interface Rig {
  stub: StubActions;
  repo: MemoryRepo;
  sdk: FakeSdk;
  board: StatusBoard;
  orch: Orchestrator;
  logs: string[];
  deps: OrchestratorDeps;
  ask(text?: string): Message;
}

function rig(
  opts: {
    restart?: Partial<RestartPolicy>;
    apiRetry?: Partial<ApiRetryPolicy>;
    tunables?: Record<string, number>;
    withStatus?: boolean;
  } = {},
): Rig {
  const repo = new MemoryRepo('room_test', { 'Architecture.md': '# Architecture\n\nIntro.\n' });
  const stub = createStubActions({
    repo,
    documents: [{ path: 'Architecture.md', title: 'Architecture' }],
    participants: [
      { userId: 'user_alice', displayName: 'Alice' },
      { userId: 'user_bob', displayName: 'Bob' },
    ],
  });
  const sdk = new FakeSdk(session());
  const logs: string[] = [];
  const logger = (level: string, msg: string) => logs.push(`${level}:${msg}`);
  const board = new StatusBoard(stub.roomId, stub.actions, logger as never);
  const deps: OrchestratorDeps = {
    roomId: stub.roomId,
    actions: stub.actions,
    repo,
    queryFn: sdk.queryFn,
    tunables: { ...DEFAULTS, ...(tunables(opts.tunables ?? {}) ?? {}) },
    logger: logger as never,
    claude,
    maxBudgetUsd: 7,
    status: opts.withStatus === false ? undefined : board,
    restart: opts.restart ?? FAST,
    apiRetry: opts.apiRetry,
    startExploration: async () => ({ workers: [] }),
  };
  const orch = new Orchestrator(deps);
  return {
    stub,
    repo,
    sdk,
    board,
    orch,
    logs,
    deps,
    ask: (text = 'why does this say 200 ms?') => stub.human('user_bob', 'Bob', text),
  };
}

const askEvent = (m: Message) => ({ type: 'ask' as const, message: m });

const statuses = (r: Rig) =>
  r.stub.statuses.map((s) => (s.detail ? `${s.status}:${s.detail}` : s.status));

afterEach(() => vi.useRealTimers());

describe('buildOrchestratorOptions', () => {
  it("describes the PRD session: Opus at medium effort in its own scratch worktree (not main's) with the quorum tools and a restricted Bash", async () => {
    const r = rig();
    let compacted = 0;
    const abort = new AbortController();
    const scratch = await ScratchWorktree.create(r.repo);
    const o = buildOrchestratorOptions(r.deps, { onCompact: () => compacted++ }, abort, {
      scratch,
    });

    expect(o).toMatchObject({
      model: MODELS.orchestrator,
      effort: EFFORT.orchestrator,
      cwd: scratch.dir,
      maxBudgetUsd: 7,
      permissionMode: 'default',
      settingSources: [],
      abortController: abort,
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      verbatimPrompts: true,
    });
    expect(scratch.dir).not.toBe(r.repo.mainWorktree);
    // Bash is isolated, with writes limited to the session's own directory, and still goes through canUseTool
    expect(o.sandbox).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [scratch.dir] },
    });
    expect(o.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude' });
    expect(o.systemPrompt).toContain('You are the Quorum orchestrator');
    expect(o.systemPrompt).toContain(
      `at most ${DEFAULTS.immediateRewriteLimit} existing paragraphs`,
    );
    expect(o.tools).toEqual(ORCHESTRATOR_BUILTIN_TOOLS);
    expect(Object.keys(o.mcpServers!)).toEqual(['quorum']);
    // Nothing is pre-approved: every tool call, the quorum tools included, goes through canUseTool (so the SDK has no
    // allowedTools/canUseTool overlap to warn about).
    expect(o.allowedTools).toBeUndefined();

    const ask = (tool: string, input: Record<string, unknown>) =>
      decide(o.canUseTool!, tool, input);
    for (const name of [
      'post_chat',
      'read_transcript',
      'get_room_state',
      'commit_main',
      'resolve_suggestion',
      'start_exploration',
      'open_proposal',
      'close_proposal',
      'request_merge',
      'set_status',
    ]) {
      expect((await ask(`mcp__quorum__${name}`, {})).behavior).toBe('allow');
    }
    expect((await ask('mcp__other__anything', {})).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'git log --oneline' })).behavior).toBe('allow');
    expect((await ask('Bash', { command: 'git commit -m x' })).behavior).toBe('deny');
    expect((await ask('Bash', { command: 'cat $HOME/.claude/.credentials.json' })).behavior).toBe(
      'deny',
    );
    expect((await ask('Edit', { file_path: `${scratch.dir}/Architecture.md` })).behavior).toBe(
      'allow',
    );
    expect((await ask('Write', { file_path: `${scratch.dir}/.prettierrc.js` })).behavior).toBe(
      'deny',
    );
    // the main worktree is outside the session's reach altogether
    expect(
      (await ask('Edit', { file_path: `${r.repo.mainWorktree}/Architecture.md` })).behavior,
    ).toBe('deny');
    expect((await ask('Bash', { command: 'git add Architecture.md' })).behavior).toBe('deny');
    expect((await ask('WebFetch', { url: 'https://example.com' })).behavior).toBe('deny');

    // the PreCompact hook reminds the session and arms the reminder for the next turn
    const hook = o.hooks!.PreCompact![0]!.hooks[0]!;
    const out = await hook({ hook_event_name: 'PreCompact' } as never, undefined, {
      signal: abort.signal,
    });
    expect(out).toMatchObject({ systemMessage: expect.stringContaining('get_room_state') });
    expect(compacted).toBe(1);
  });

  it('omits the credential environment when none is configured (the subprocess inherits the server environment)', async () => {
    const r = rig();
    const o = buildOrchestratorOptions(
      { ...r.deps, claude: undefined },
      { onCompact: () => undefined },
      new AbortController(),
      { scratch: await ScratchWorktree.create(r.repo) },
    );
    expect('pathToClaudeCodeExecutable' in o).toBe(false);
    expect(o.env!.PATH).toBe(process.env.PATH);
  });

  it("routes the model's set_status through the status board without ever letting it go idle early", async () => {
    const r = rig();
    const o = buildOrchestratorOptions(
      r.deps,
      { onCompact: () => undefined },
      new AbortController(),
      { scratch: await ScratchWorktree.create(r.repo) },
    );
    const server = o.mcpServers!.quorum as unknown as {
      instance: {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
      };
    };
    const tools = server.instance._registeredTools;
    await tools.set_status!.handler(
      { status: 'thinking', detail: 'Exploring PostgreSQL vs ClickHouse' },
      {},
    );
    expect(r.board.current).toEqual({
      status: 'thinking',
      detail: 'Exploring PostgreSQL vs ClickHouse',
    });
    await tools.set_status!.handler({ status: 'idle' }, {});
    expect(r.board.current).toEqual({ status: 'thinking', detail: null }); // clears the detail, the turn is still running
  });
});

describe('Orchestrator turns', () => {
  it('streams each event in as a user turn, with a rehydrate preamble on the first only', async () => {
    const r = rig();
    const earlier = r.stub.human('user_alice', 'Alice', 'earlier chat message');
    r.orch.start();
    const m1 = r.ask('first question');
    r.orch.send(askEvent(m1));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    const first = r.sdk.calls[0]!.turns[0]!;
    expect(first.startsWith('[event:rehydrate]')).toBe(true);
    expect(first).toContain('earlier chat message'); // from the last-messages list
    expect(first).toContain(earlier.id);
    expect(first).toContain('[event:ask]');
    expect(first).toContain('first question');

    const m2 = r.ask('second question');
    r.orch.send(askEvent(m2));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(2));
    const second = r.sdk.calls[0]!.turns[1]!;
    expect(second.startsWith('[event:ask]')).toBe(true);
    expect(second).not.toContain('[event:rehydrate]');
    await r.orch.stop();
  });

  it('still rehydrates when the room state cannot be read', async () => {
    const r = rig();
    r.stub.actions.getRoomState = async () => {
      throw new Error('db busy');
    };
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    expect(r.sdk.calls[0]!.turns[0]).toContain(
      '(room state unavailable: db busy; call get_room_state)',
    );
    await r.orch.stop();
  });

  it('adds the compaction reminder to the next turn after the PreCompact hook ran', async () => {
    const r = rig();
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    const options = r.sdk.calls[0]!.options;
    await options.hooks!.PreCompact![0]!.hooks[0]!(
      { hook_event_name: 'PreCompact' } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    r.orch.send(askEvent(r.ask('two')));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(2));
    expect(r.sdk.calls[0]!.turns[1]).toContain('[note] The conversation was compacted');
    await r.orch.stop();
  });

  it('tells the orchestrator which other events are in flight', async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handled = 0;
    r.sdk.respond(
      session(async () => {
        if (++handled === 1) await gate; // the first turn is still being handled
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    r.orch.send(askEvent(r.ask('two')));
    release();
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(2));
    expect(r.sdk.calls[0]!.turns[1]).toContain('"otherEventsInFlight"');
    expect(r.sdk.calls[0]!.turns[1]).toMatch(/ask msg_/);
    await r.orch.stop();
  });

  it('never throws from send(), even for an event that cannot be serialized', () => {
    const r = rig();
    const bad = { ...r.ask(), body: 10n as unknown as string };
    expect(() => r.orch.send(askEvent(bad))).not.toThrow();
    expect(r.orch.pendingCount).toBe(0);
    expect(r.logs.some((l) => l.startsWith('error:could not format an orchestrator event'))).toBe(
      true,
    );
  });

  it('bounds the queue while nothing is consuming it', () => {
    const r = rig();
    for (let i = 0; i < 105; i++) r.orch.send(askEvent(r.ask(`q${i}`)));
    expect(r.orch.pendingCount).toBe(100);
    expect(r.logs.filter((l) => l.startsWith('warn:orchestrator queue full')).length).toBe(5);
  });

  it('records the usage of every result as deltas of the cumulative totals', async () => {
    const r = rig();
    let n = 0;
    r.sdk.respond(
      session(() => {
        n += 1;
        return [
          resultMessage({
            usage: { model: MODELS.orchestrator, input: n * 1000, output: n * 100, cost: n * 0.05 },
            sessionId: 'sess_orch',
          }),
        ];
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('a')));
    await vi.waitFor(() => expect(r.stub.usage).toHaveLength(1));
    r.orch.send(askEvent(r.ask('b')));
    await vi.waitFor(() => expect(r.stub.usage).toHaveLength(2));
    expect(r.stub.usage.map((u) => [u.role, u.sessionId, u.inputTokens, u.outputTokens])).toEqual([
      ['orchestrator', 'sess_orch', 1000, 100],
      ['orchestrator', 'sess_orch', 1000, 100],
    ]);
    expect(r.stub.usage[1]!.costUsd).toBeCloseTo(0.05, 10);
    await r.orch.stop();
  });
});

describe('agent status', () => {
  it('is thinking while events are being handled and idle once the queue drains', async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handled = 0;
    r.sdk.respond(
      session(async () => {
        if (++handled === 1) await gate;
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    r.orch.send(askEvent(r.ask('two')));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1)); // the second waits its turn
    await r.board.settled();
    expect(statuses(r)).toEqual(['thinking']);
    release();
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(2));
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.board.settled();
    // one stretch of thinking across both events, not a flicker to idle in between
    expect(statuses(r)).toEqual(['thinking', 'idle']);
    await r.orch.stop();
  });

  it('reports nothing when no status board is attached', async () => {
    const r = rig({ withStatus: false });
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    await r.orch.stop();
    expect(r.stub.statuses).toEqual([]);
  });

  it('goes unavailable with the sign-in detail when the API reports an authentication error, and recovers on the next clean turn', async () => {
    const r = rig();
    let n = 0;
    r.sdk.respond(
      session(() => {
        n += 1;
        return n === 1
          ? [
              assistantMessage({ model: MODELS.orchestrator, error: 'authentication_failed' }),
              resultMessage({ isError: true, subtype: 'success', text: 'Invalid API key' }),
            ]
          : [resultMessage()];
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() =>
      expect(r.board.current).toEqual({ status: 'unavailable', detail: SIGN_IN_DETAIL }),
    );
    r.orch.send(askEvent(r.ask('two')));
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.orch.stop();
  });

  it('shows a billing problem as unavailable too', async () => {
    const r = rig();
    r.sdk.respond(
      session(() => [
        assistantMessage({ model: MODELS.orchestrator, error: 'billing_error' }),
        resultMessage({ isError: true }),
      ]),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.waitFor(() =>
      expect(r.board.current).toEqual({
        status: 'unavailable',
        detail: 'The Claude account has a billing problem',
      }),
    );
    await r.orch.stop();
  });

  it('stops for good when the spending limit is reached: unavailable, no restart, later events dropped', async () => {
    const r = rig();
    r.sdk.respond(
      session(() => [
        resultMessage({
          subtype: 'error_max_budget_usd',
          usage: { model: MODELS.orchestrator, input: 10, cost: 7.01 },
        }),
      ]),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() =>
      expect(r.board.current).toEqual({
        status: 'unavailable',
        detail: 'The agent has reached its spending limit',
      }),
    );
    r.orch.send(askEvent(r.ask('two')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.sdk.calls).toHaveLength(1);
    expect(r.sdk.calls[0]!.turns).toHaveLength(1);
    expect(
      r.logs.some((l) => l.startsWith('warn:orchestrator budget exhausted; dropping event')),
    ).toBe(true);
    expect(r.stub.usage).toHaveLength(1); // the result that ended it was still recorded
    await r.orch.stop();
  });
});

describe('restart and recovery', () => {
  const crashFirst = (crashes: number) => {
    let n = 0;
    return async function* (call: QueryCall) {
      n += 1;
      const prompt = call.prompt as AsyncIterable<SDKUserMessage>;
      for await (const msg of prompt) {
        call.turns.push(userText(msg));
        if (n <= crashes) throw new Error('Claude Code process exited with code 1');
        yield resultMessage();
      }
    };
  };

  describe('resuming the conversation (PRD 12: resume by session id if possible, otherwise start fresh and rehydrate)', () => {
    /** per-session behavior: 'ok' answers every turn cleanly, 'answer-then-die' answers once then crashes, 'die' crashes at the first turn */
    const sessions = (plan: Array<'ok' | 'answer-then-die' | 'die'>) => {
      let n = 0;
      return async function* (call: QueryCall) {
        const mode = plan[Math.min(n, plan.length - 1)]!;
        const id = `sess_${'ABCDEF'[n]}`;
        n += 1;
        let answered = 0;
        const prompt = call.prompt as AsyncIterable<SDKUserMessage>;
        for await (const msg of prompt) {
          call.turns.push(userText(msg));
          if (mode === 'die' || (mode === 'answer-then-die' && answered >= 1))
            throw new Error('process died');
          answered += 1;
          yield resultMessage({ sessionId: id });
        }
      };
    };

    it('starts fresh the first time, resumes the last clean session after a crash, and does not rehydrate a resumed session', async () => {
      const r = rig();
      r.sdk.respond(sessions(['answer-then-die', 'ok']));
      r.orch.start();
      r.orch.send(askEvent(r.ask('first')));
      await vi.waitFor(() => expect(r.stub.statuses.at(-1)?.status).toBe('idle'));
      expect(r.sdk.calls[0]!.options.resume).toBeUndefined();

      r.orch.send(askEvent(r.ask('second, which kills the session')));
      await vi.waitFor(() => expect(r.sdk.calls[1]?.turns).toHaveLength(1));
      const second = r.sdk.calls[1]!;
      expect(second.options.resume).toBe('sess_A'); // continues the conversation that was running
      expect(second.turns[0]).not.toContain('[event:rehydrate]'); // its context is intact
      expect(second.turns[0]).toContain('this conversation was resumed');
      expect(second.turns[0]).toContain('call get_room_state before acting');
      expect(second.turns[0]).toContain('second, which kills the session'); // the event the dead session never answered
      expect(second.turns[0]).toContain('is being delivered again');
      expect(second.options.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
      await r.orch.stop();
    });

    it('falls back to a fresh, rehydrated session when the resumed one dies without answering', async () => {
      const r = rig({ restart: { ...FAST, max: 10 } });
      r.sdk.respond(sessions(['answer-then-die', 'die', 'ok']));
      r.orch.start();
      r.orch.send(askEvent(r.ask('first')));
      await vi.waitFor(() => expect(r.stub.statuses.at(-1)?.status).toBe('idle'));
      r.orch.send(askEvent(r.ask('second'))); // kills session A; the resumed session B dies on it too
      await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(3));
      r.orch.send(askEvent(r.ask('third')));
      await vi.waitFor(() => expect(r.sdk.calls[2]?.turns.length).toBeGreaterThan(0));

      expect(r.sdk.calls[1]!.options.resume).toBe('sess_A'); // tried to resume ...
      expect(r.sdk.calls[2]!.options.resume).toBeUndefined(); // ... and, when that failed, started over
      expect(r.sdk.calls[2]!.turns[0]!.startsWith('[event:rehydrate]')).toBe(true);
      expect(r.sdk.calls[2]!.turns[0]).toContain('third');
      expect(
        r.logs.some((l) =>
          l.startsWith('warn:resuming the orchestrator session failed; starting fresh'),
        ),
      ).toBe(true);
      await r.orch.stop();
    });

    it('keeps resuming the newest clean session', async () => {
      const r = rig({ restart: { ...FAST, max: 10 } });
      r.sdk.respond(sessions(['answer-then-die', 'answer-then-die', 'ok']));
      r.orch.start();
      r.orch.send(askEvent(r.ask('one')));
      await vi.waitFor(() => expect(r.stub.statuses.at(-1)?.status).toBe('idle'));
      r.orch.send(askEvent(r.ask('two'))); // kills session A; B resumes A and answers 'two'?
      await vi.waitFor(() => expect(r.sdk.calls[1]?.turns.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(r.stub.statuses.at(-1)?.status).toBe('idle'));
      r.orch.send(askEvent(r.ask('three'))); // kills session B; C resumes B
      await vi.waitFor(() => expect(r.sdk.calls[2]?.turns.length).toBeGreaterThan(0));
      expect(r.sdk.calls.map((c) => c.options.resume)).toEqual([undefined, 'sess_A', 'sess_B']);
      await r.orch.stop();
    });

    describe('usage totals across a restart', () => {
      /**
       * Result messages carry totals cumulative for the conversation. A resumed session continues from the totals saved with
       * its transcript, so its first result already includes everything the earlier process spent.
       */
      const totals = (i: number, o: number, c: number) => ({
        model: MODELS.orchestrator,
        input: i,
        output: o,
        cost: c,
      });
      const sum = (r: Rig, key: 'inputTokens' | 'outputTokens' | 'costUsd') =>
        r.stub.usage.reduce((total, u) => total + u[key], 0);

      it('records a resumed session once: the totals it inherits are not counted again (M2)', async () => {
        const r = rig({ restart: { ...FAST, max: 10 } });
        let n = 0;
        r.sdk.respond(async function* (call) {
          const resumed = call.options.resume !== undefined;
          const id = n++ === 0 ? 'sess_A' : 'sess_B';
          let turns = 0;
          for await (const msg of call.prompt as AsyncIterable<SDKUserMessage>) {
            call.turns.push(userText(msg));
            turns += 1;
            if (!resumed && turns === 3) throw new Error('process died');
            const usage = resumed
              ? totals(1800, 190, 0.1) // the saved 1500/160/$0.08 plus this turn's 300/30/$0.02
              : turns === 1
                ? totals(1000, 100, 0.05)
                : totals(1500, 160, 0.08);
            yield resultMessage({ sessionId: id, usage });
          }
        });
        r.orch.start();
        r.orch.send(askEvent(r.ask('one')));
        await vi.waitFor(() => expect(r.stub.usage).toHaveLength(1));
        r.orch.send(askEvent(r.ask('two')));
        await vi.waitFor(() => expect(r.stub.usage).toHaveLength(2));
        r.orch.send(askEvent(r.ask('three, which kills the session')));
        await vi.waitFor(() => expect(r.sdk.calls[1]?.turns.length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(r.stub.usage).toHaveLength(3));

        expect(r.sdk.calls[1]!.options.resume).toBe('sess_A');
        expect(r.stub.usage.map((u) => [u.sessionId, u.inputTokens, u.outputTokens])).toEqual([
          ['sess_A', 1000, 100],
          ['sess_A', 500, 60],
          ['sess_B', 300, 30], // not 1800/190: the first 1500/160 was recorded by session A
        ]);
        // the room's recorded total is exactly what the conversation has spent
        expect(sum(r, 'inputTokens')).toBe(1800);
        expect(sum(r, 'outputTokens')).toBe(190);
        expect(sum(r, 'costUsd')).toBeCloseTo(0.1, 10);
        await r.orch.stop();
      });

      it('counts a session that starts over in full, even when its totals are below what the dead one had', async () => {
        const r = rig({ restart: { ...FAST, max: 10 } });
        let n = 0;
        r.sdk.respond(async function* (call) {
          const mode = n++; // 0 answers once then dies, 1 (resumed) dies unanswered, 2 (fresh) answers
          let turns = 0;
          for await (const msg of call.prompt as AsyncIterable<SDKUserMessage>) {
            call.turns.push(userText(msg));
            turns += 1;
            if (mode === 0 && turns === 2) throw new Error('process died');
            if (mode === 1) throw new Error('process died');
            yield resultMessage({
              sessionId: mode === 0 ? 'sess_A' : 'sess_C',
              usage: mode === 0 ? totals(1000, 100, 0.05) : totals(400, 40, 0.02),
            });
          }
        });
        r.orch.start();
        r.orch.send(askEvent(r.ask('one')));
        await vi.waitFor(() => expect(r.stub.usage).toHaveLength(1));
        r.orch.send(askEvent(r.ask('two, which kills the session')));
        await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(3));
        r.orch.send(askEvent(r.ask('three')));
        await vi.waitFor(() => expect(r.stub.usage).toHaveLength(2));

        expect(r.sdk.calls[2]!.options.resume).toBeUndefined(); // started over
        // the fresh conversation's 400/40/$0.02 is new spend, although it is below the dead session's 1000/100/$0.05
        expect(r.stub.usage.map((u) => [u.sessionId, u.inputTokens, u.outputTokens])).toEqual([
          ['sess_A', 1000, 100],
          ['sess_C', 400, 40],
        ]);
        expect(sum(r, 'costUsd')).toBeCloseTo(0.07, 10);
        await r.orch.stop();
      });
    });

    it('does not resume after a session that never answered anything', async () => {
      const r = rig();
      r.sdk.respond(crashFirst(2));
      r.orch.start();
      r.orch.send(askEvent(r.ask('poison')));
      await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(3));
      expect(r.sdk.calls.map((c) => c.options.resume)).toEqual([undefined, undefined, undefined]);
      await r.orch.stop();
    });
  });

  it('restarts a session that dies, rehydrates it, and hands it the event it never answered', async () => {
    const r = rig();
    r.sdk.respond(crashFirst(1));
    r.orch.start();
    const m = r.ask('please look at this');
    r.orch.send(askEvent(m));

    await vi.waitFor(() => expect(r.sdk.calls[1]?.turns).toHaveLength(1));
    expect(r.sdk.calls).toHaveLength(2);
    const redelivered = r.sdk.calls[1]!.turns[0]!;
    expect(redelivered.startsWith('[event:rehydrate]')).toBe(true); // fresh session: re-read room state and the transcript
    expect(redelivered).toContain('[event:ask]');
    expect(redelivered).toContain('please look at this');
    expect(redelivered).toContain('is being delivered again');
    expect(
      r.logs.some((l) => l.startsWith('warn:orchestrator session ended unexpectedly; restarting')),
    ).toBe(true);
    expect(r.logs.some((l) => l.startsWith('error:orchestrator session failed'))).toBe(true);
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.orch.stop();
  });

  it('delivers an event again only once, so a poison event cannot loop', async () => {
    const r = rig({ restart: { ...FAST, max: 10 } });
    r.sdk.respond(crashFirst(2));
    r.orch.start();
    r.orch.send(askEvent(r.ask('poison')));
    await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() =>
      expect(r.logs.some((l) => l.startsWith('warn:dropping events that failed twice'))).toBe(true),
    );
    expect(r.sdk.calls[0]!.turns).toHaveLength(1);
    expect(r.sdk.calls[1]!.turns).toHaveLength(1);
    expect(r.sdk.calls[2]?.turns ?? []).toHaveLength(0); // the third session starts with nothing to redo
    await r.orch.stop();
  });

  it('restarts when the session ends without an error as well', async () => {
    const r = rig();
    let n = 0;
    r.sdk.respond(async function* (call) {
      n += 1;
      if (n === 1) return; // ends immediately, quietly
      yield* session()(call);
    });
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.waitFor(() => expect(r.sdk.calls[1]?.turns).toHaveLength(1));
    await r.orch.stop();
  });

  it('keeps events that arrive while the session is down and processes them on recovery', async () => {
    const r = rig();
    let n = 0;
    r.sdk.respond(async function* (call) {
      n += 1;
      if (n === 1) throw new Error('boom'); // dies before any turn
      yield* session()(call);
    });
    r.orch.start();
    await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(1));
    r.orch.send(askEvent(r.ask('sent during the outage')));
    await vi.waitFor(() => expect(r.sdk.calls[1]?.turns).toHaveLength(1));
    expect(r.sdk.calls[1]!.turns[0]).toContain('sent during the outage');
    expect(r.sdk.calls[1]!.turns[0]).not.toContain('is being delivered again'); // it was never handed to the dead session
    await r.orch.stop();
  });

  it('cools down after too many restarts (unavailable), then tries again and recovers instead of giving up for good', async () => {
    const r = rig({
      restart: { baseDelayMs: 1, maxDelayMs: 2, cooldownMs: 80, max: 2, windowMs: 60_000 },
    });
    let healthy = false;
    r.sdk.respond(async function* (call) {
      if (!healthy) throw new Error('API outage');
      yield* session()(call);
    });
    r.orch.start();
    r.orch.send(askEvent(r.ask('during the outage')));
    await vi.waitFor(() =>
      expect(r.board.current).toEqual({
        status: 'unavailable',
        detail: 'The agent session keeps failing',
      }),
    );
    const callsAtCooldown = r.sdk.calls.length;
    expect(callsAtCooldown).toBeGreaterThanOrEqual(3);
    expect(
      r.logs.some((l) => l.startsWith('error:orchestrator restarting too often; cooling down')),
    ).toBe(true);

    healthy = true; // the API is back
    await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThan(callsAtCooldown), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(r.sdk.calls.at(-1)?.turns.length).toBe(1), { timeout: 2000 });
    expect(r.sdk.calls.at(-1)!.turns[0]).toContain('during the outage'); // queued events are processed on recovery
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.orch.stop();
  });

  it('stop() ends the session, does not restart it, and returns promptly', async () => {
    const r = rig();
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    const started = Date.now();
    await r.orch.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.sdk.calls[0]!.closed).toBe(true);
    expect(r.sdk.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.sdk.calls).toHaveLength(1);
    r.orch.send(askEvent(r.ask('after stop')));
    expect(r.orch.pendingCount).toBe(0);
  });
});

describe('expiry timer (5 minutes)', () => {
  const FIVE = DEFAULTS.expiryCheckMs;

  function expiryRig() {
    vi.useFakeTimers();
    const r = rig();
    r.stub.proposals.push(makeProposal());
    return r;
  }
  const expiryTurns = (r: Rig) =>
    (r.sdk.calls[0]?.turns ?? []).filter((t) => t.includes('[event:expiry_check]'));

  it('asks the orchestrator to judge open proposals every 5 minutes', async () => {
    const r = expiryRig();
    r.orch.start();
    await vi.advanceTimersByTimeAsync(FIVE - 1);
    expect(r.sdk.calls[0]?.turns ?? []).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(expiryTurns(r)).toHaveLength(1);
    const payload = JSON.parse(
      expiryTurns(r)[0]!.slice(
        expiryTurns(r)[0]!.indexOf('{', expiryTurns(r)[0]!.indexOf('[event:expiry_check]')),
      ),
    );
    expect(payload.openProposals).toHaveLength(1);
    expect(payload.openProposals[0]).toMatchObject({ id: 'prop_1', state: 'open' });
    expect(payload.now).toBe(new Date(Date.now()).toISOString());
    await r.orch.stop();
  });

  it('does nothing when no proposal is open', async () => {
    const r = expiryRig();
    r.stub.proposals[0]!.state = 'merged';
    r.orch.start();
    await vi.advanceTimersByTimeAsync(FIVE * 3);
    expect(r.sdk.calls[0]?.turns ?? []).toHaveLength(0);
    await r.orch.stop();
  });

  it('does not pile up checks while the previous one is still unanswered', async () => {
    const r = expiryRig();
    r.sdk.respond(session(() => new Promise<never>(() => undefined))); // the turn never finishes
    r.orch.start();
    await vi.advanceTimersByTimeAsync(FIVE * 5);
    expect(expiryTurns(r)).toHaveLength(1);
    await r.orch.stop();
  });

  it('asks again at every 5 minute tick while a proposal is open, changed or not (the answer depends on elapsed time)', async () => {
    const r = expiryRig();
    r.orch.start();
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(expiryTurns(r)).toHaveLength(1);

    // quiet ticks: same proposal, no votes, no chat. The cadence is not stretched.
    for (let tick = 2; tick <= 8; tick++) {
      await vi.advanceTimersByTimeAsync(FIVE);
      expect(expiryTurns(r)).toHaveLength(tick);
    }
    // a vote or new chat does not change the cadence either
    r.stub.proposals[0]!.votes.push({
      proposalId: 'prop_1',
      userId: 'user_alice',
      optionId: 'opt_a',
      decision: 'approve',
      castAt: new Date().toISOString(),
    });
    r.stub.human('user_bob', 'Bob', 'never mind the vote');
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(expiryTurns(r)).toHaveLength(9);
    await r.orch.stop();
  });

  it('stops asking as soon as nothing is open, and starts again when something is', async () => {
    const r = expiryRig();
    r.orch.start();
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(expiryTurns(r)).toHaveLength(1);
    r.stub.proposals[0]!.state = 'merged';
    await vi.advanceTimersByTimeAsync(FIVE * 3);
    expect(expiryTurns(r)).toHaveLength(1);
    r.stub.proposals.push(makeProposal({ id: 'prop_2' }));
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(expiryTurns(r)).toHaveLength(2); // the very next tick: no quiet-room multiplier delays a new proposal
    await r.orch.stop();
  });

  it('stop() clears its timers', async () => {
    const r = expiryRig();
    r.orch.start();
    r.orch.send(askEvent(r.ask()));
    await vi.advanceTimersByTimeAsync(10);
    await r.orch.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FIVE * 2);
    expect(expiryTurns(r)).toHaveLength(0);
  });
});

describe('one event at a time, in a scratch worktree', () => {
  /** a spy standing in for the scratch worktree, to count resets */
  function spyScratch(r: Rig) {
    const events: string[] = [];
    return {
      events,
      dir: r.repo.mainWorktree, // only a stand-in directory; nothing is edited here
      base: 'b'.repeat(40),
      reset: async () => {
        events.push('reset');
        return 'b'.repeat(40);
      },
    };
  }

  it('hands an event over only after the previous one was answered (the SDK is never given a backlog)', async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handled = 0;
    r.sdk.respond(
      session(async () => {
        if (++handled === 1) await gate;
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('alpha')));
    r.orch.send(askEvent(r.ask('bravo')));
    r.orch.send(askEvent(r.ask('charlie')));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.sdk.calls[0]!.turns).toHaveLength(1); // bravo and charlie wait in the orchestrator, not in the CLI
    expect(r.orch.pendingCount).toBe(3);
    release();
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(3));
    const order = r.sdk.calls[0]!.turns.map((t) => /alpha|bravo|charlie/.exec(t)?.[0]);
    expect(order).toEqual(['alpha', 'bravo', 'charlie']);
    await r.orch.stop();
  });

  it('resets the working copy before every turn: once per event, before the event is handed over', async () => {
    const r = rig();
    const scratch = spyScratch(r);
    r.deps.scratch = scratch;
    const orch = new Orchestrator(r.deps);
    r.sdk.respond(
      session((text) => {
        scratch.events.push(`turn:${/\[event:[a-z_]+\]/.exec(text)?.[0]}`);
      }),
    );
    orch.start();
    orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(scratch.events).toHaveLength(2));
    orch.send(askEvent(r.ask('two')));
    await vi.waitFor(() => expect(scratch.events).toHaveLength(4));
    expect(scratch.events).toEqual([
      'reset',
      'turn:[event:rehydrate]',
      'reset',
      'turn:[event:ask]',
    ]);
    await orch.stop();
    expect(scratch.events).toHaveLength(4); // an injected scratch is not the orchestrator's to remove
  });

  it("works in a worktree of its own: an edit left over from one turn is gone at the start of the next, and main's news is in", async () => {
    const r = rig();
    const seen: string[] = [];
    let turn = 0;
    r.sdk.respond(
      session((_text, call) => {
        const doc = join(call.options.cwd!, 'Architecture.md');
        seen.push(readFileSync(doc, 'utf8'));
        if (++turn === 1) writeFileSync(doc, 'a half-finished edit the model never committed');
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));

    // main moves between the turns (another writer)
    await r.repo.commitToMain(
      { 'Architecture.md': '# Architecture\n\nIntro, edited by Bob.\n' },
      'Edit',
      {
        actor: { kind: 'user', userId: 'user_bob', displayName: 'Bob' },
        triggerMessageIds: [],
      },
    );
    r.orch.send(askEvent(r.ask('two')));
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(seen[0]).toBe('# Architecture\n\nIntro.\n');
    expect(seen[1]).toBe('# Architecture\n\nIntro, edited by Bob.\n'); // neither the stale edit nor the stale text
    expect(r.sdk.calls[0]!.options.cwd).not.toBe(r.repo.mainWorktree);
    // main's own worktree was never touched
    expect(readFileSync(join(r.repo.mainWorktree, 'Architecture.md'), 'utf8')).toBe(
      '# Architecture\n\nIntro, edited by Bob.\n',
    );
    await r.orch.stop();
  });

  it('keeps the same working directory across a restart of the session, and removes it on stop()', async () => {
    const r = rig();
    r.sdk.respond(
      session(() => {
        throw new Error('boom');
      }),
    );
    const removed: string[] = [];
    const original = r.repo.removeWorktree.bind(r.repo);
    r.repo.removeWorktree = async (name) => {
      removed.push(name);
      return original(name);
    };
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(r.sdk.calls.length).toBeGreaterThanOrEqual(2));
    expect(r.sdk.calls[1]!.options.cwd).toBe(r.sdk.calls[0]!.options.cwd);
    expect(removed).toEqual(['orchestrator']); // only the stale one it replaced at start
    await r.orch.stop();
    expect(removed).toEqual(['orchestrator', 'orchestrator']);
  });

  it('treats a failure to create the working directory like any session failure: unavailable, retried, recovers', async () => {
    const r = rig({ restart: { ...FAST, max: 10 } });
    let attempts = 0;
    const original = r.repo.createDetachedWorktree.bind(r.repo);
    r.repo.createDetachedWorktree = async (name, ref) => {
      if (++attempts === 1) throw new Error('worktree add failed');
      return original(name, ref);
    };
    r.orch.start();
    r.orch.send(askEvent(r.ask('one')));
    await vi.waitFor(() => expect(r.sdk.calls[0]?.turns).toHaveLength(1));
    expect(attempts).toBe(2);
    expect(r.logs.some((l) => l.startsWith('error:orchestrator session failed'))).toBe(true);
    await r.orch.stop();
  });
});

describe('temporary API failures (429, 5xx, overloaded)', () => {
  const RETRY = { baseMs: 20, maxMs: 80, maxAgeMs: 60_000 };
  const overloaded = () => [
    assistantMessage({ model: MODELS.orchestrator, error: 'overloaded' }),
    resultMessage({ isError: true, text: 'API Error: 529 {"type":"overloaded_error"}' }),
  ];
  const detail = 'The Claude API is unavailable; retrying';

  it('hands the event over again after a growing backoff, shows the agent as unavailable meanwhile, and recovers by itself', async () => {
    const r = rig({ apiRetry: RETRY });
    const arrivals: number[] = [];
    r.sdk.respond(
      session(() => {
        arrivals.push(Date.now());
        return arrivals.length <= 2 ? overloaded() : [resultMessage({ sessionId: 'sess_ok' })];
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('please answer this')));
    await vi.waitFor(() => expect(r.board.current).toEqual({ status: 'unavailable', detail }));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(3)); // two failures, then the answer
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle')); // no sign-in, no restart needed

    const turns = r.sdk.calls[0]!.turns;
    for (const t of turns) expect(t).toContain('please answer this');
    expect(turns[0]).not.toContain('temporarily unavailable');
    expect(turns[1]).toContain('the Claude API was temporarily unavailable');
    expect(turns[2]!.match(/temporarily unavailable/g)).toHaveLength(1); // the note is not stacked
    // the backoff doubles: 20 ms, then 40 ms
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThanOrEqual(15);
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(30);
    expect(
      r.logs.filter((l) =>
        l.startsWith('warn:orchestrator turn failed with a temporary API error'),
      ),
    ).toHaveLength(2);
    // one session throughout: nothing was restarted
    expect(r.sdk.calls).toHaveLength(1);
    await r.orch.stop();
  });

  it('does not lose the events queued behind the failing one, and keeps their order', async () => {
    const r = rig({ apiRetry: RETRY });
    let n = 0;
    r.sdk.respond(session(() => (++n === 1 ? overloaded() : [resultMessage()])));
    r.orch.start();
    r.orch.send(askEvent(r.ask('first')));
    r.orch.send(askEvent(r.ask('second')));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(3));
    const order = r.sdk.calls[0]!.turns.map((t) => (t.includes('first') ? 'first' : 'second'));
    expect(order).toEqual(['first', 'first', 'second']);
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.orch.stop();
  });

  it('recognizes a rate limit or server error from the error message alone', async () => {
    const r = rig({ apiRetry: RETRY });
    let n = 0;
    r.sdk.respond(
      session(() => {
        n += 1;
        if (n === 1)
          return [
            assistantMessage({ model: MODELS.orchestrator, error: 'rate_limit' }),
            resultMessage({ isError: true }),
          ];
        if (n === 2)
          return [resultMessage({ isError: true, text: 'API Error: 503 Service Unavailable' })];
        return [resultMessage()];
      }),
    );
    r.orch.start();
    r.orch.send(askEvent(r.ask('x')));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(3));
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    await r.orch.stop();
  });

  it('does not retry what is not a temporary failure: a rejected request, a failed turn, a 5xx number in a good answer', async () => {
    const r = rig({ apiRetry: RETRY });
    let n = 0;
    r.sdk.respond(
      session(() => {
        n += 1;
        if (n === 1)
          return [
            assistantMessage({ model: MODELS.orchestrator, error: 'invalid_request' }),
            resultMessage({ isError: true, text: 'API Error: 400 invalid request' }),
          ];
        if (n === 2) return [resultMessage({ subtype: 'error_max_turns' })];
        return [resultMessage({ text: 'The log showed 500 errors and a 429 or two; fixed.' })];
      }),
    );
    r.orch.start();
    for (const w of ['a', 'b', 'c']) r.orch.send(askEvent(r.ask(`question ${w}`)));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns).toHaveLength(3));
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    expect(r.sdk.calls[0]!.turns.some((t) => t.includes('temporarily unavailable'))).toBe(false);
    expect(r.board.current.status).toBe('idle');
    await r.orch.stop();
  });

  it('gives up on an event the API keeps failing for too long, and does not leave the room unavailable', async () => {
    const r = rig({ apiRetry: { baseMs: 5, maxMs: 10, maxAgeMs: 40 } });
    let outage = true;
    r.sdk.respond(session(() => (outage ? overloaded() : [resultMessage()])));
    r.orch.start();
    r.orch.send(askEvent(r.ask('stale by the time the API is back')));
    await vi.waitFor(() =>
      expect(
        r.logs.some((l) => l.startsWith('warn:dropping an event that the API kept failing')),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(r.board.current.status).toBe('idle'));
    const delivered = r.sdk.calls[0]!.turns.length;
    outage = false;
    r.orch.send(askEvent(r.ask('fresh')));
    await vi.waitFor(() => expect(r.sdk.calls[0]!.turns.length).toBe(delivered + 1));
    expect(r.sdk.calls[0]!.turns.at(-1)).toContain('fresh');
    expect(r.sdk.calls[0]!.turns.at(-1)).not.toContain('temporarily unavailable');
    await r.orch.stop();
  });

  it('stop() during a backoff returns promptly and hands nothing over', async () => {
    const r = rig({ apiRetry: { baseMs: 60_000, maxMs: 60_000, maxAgeMs: 600_000 } });
    r.sdk.respond(session(() => overloaded()));
    r.orch.start();
    r.orch.send(askEvent(r.ask('x')));
    await vi.waitFor(() => expect(r.board.current.status).toBe('unavailable'));
    const started = Date.now();
    await r.orch.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.sdk.calls[0]!.turns).toHaveLength(1);
  });
});
