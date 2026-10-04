import { afterEach, describe, expect, it } from 'vitest';
import { MODELS } from '@quorum/shared';
import { createStubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { assistantMessage, resultMessage } from '../testing/fakeQuery.js';
import {
  AssistantUsage,
  AsyncQueue,
  UsageTracker,
  drainQuery,
  recordAssistantUsage,
  agentEnvironment,
  recordResultUsage,
  sandboxOptions,
  sdkProcessOptions,
  userMessage,
} from './sdk.js';
import { estimateCostUsd, fallbackDigest, priceFor, SIGN_IN_DETAIL } from '../common.js';

describe('sdkProcessOptions', () => {
  const saved = {
    marker: process.env.OTHER_TEST_MARKER,
    password: process.env.QUORUM_PASSWORD,
    quorum: process.env.QUORUM_DATA_DIR,
    token: process.env.QUORUM_SESSION_TOKEN,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore('OTHER_TEST_MARKER', saved.marker);
    restore('QUORUM_PASSWORD', saved.password);
    restore('QUORUM_DATA_DIR', saved.quorum);
    restore('QUORUM_SESSION_TOKEN', saved.token);
  });

  it('spreads the server environment, then the credential environment, and names the binary', () => {
    process.env.OTHER_TEST_MARKER = 'inherited';
    const o = sdkProcessOptions({
      binary: '/opt/claude',
      env: () => ({ CLAUDE_CONFIG_DIR: '/data/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
    });
    expect(o.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(o.env).toMatchObject({
      OTHER_TEST_MARKER: 'inherited',
      CLAUDE_CONFIG_DIR: '/data/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(o.env!.PATH).toBe(process.env.PATH);
    expect(o.env!.HOME).toBe(process.env.HOME);
  });

  it('lets the credential environment win over the server environment', () => {
    process.env.OTHER_TEST_MARKER = 'from process';
    expect(
      sdkProcessOptions({ env: () => ({ OTHER_TEST_MARKER: 'from auth' }) }).env!.OTHER_TEST_MARKER,
    ).toBe('from auth');
  });

  it("never hands the server's own configuration to an agent session (QUORUM_PASSWORD and every QUORUM_* setting)", () => {
    process.env.QUORUM_PASSWORD = 'hunter2';
    process.env.QUORUM_DATA_DIR = '/data';
    process.env.QUORUM_SESSION_TOKEN = 'secret';
    const o = sdkProcessOptions({ apiKey: 'sk-test', env: () => ({ CLAUDE_CONFIG_DIR: '/c' }) });
    expect(Object.keys(o.env!).filter((k) => k.toUpperCase().startsWith('QUORUM_'))).toEqual([]);
    expect(JSON.stringify(o.env)).not.toContain('hunter2');
    // what the CLI needs stays
    expect(o.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: '/c' });
    expect(o.env!.PATH).toBe(process.env.PATH);
    expect(
      agentEnvironment({ QUORUM_PASSWORD: 'x', quorum_lower: 'y', PATH: '/bin', HOME: '/h' }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
    });
  });

  it('asks the CLI to take prompts verbatim, so chat text is never expanded into @path attachments or slash commands', () => {
    expect(sdkProcessOptions().verbatimPrompts).toBe(true);
    expect(sdkProcessOptions({ binary: '/x', apiKey: 'k' }).verbatimPrompts).toBe(true);
  });

  it('adds the API key, and omits the binary when none is configured', () => {
    const o = sdkProcessOptions({ apiKey: 'sk-test' });
    expect(o.env!.ANTHROPIC_API_KEY).toBe('sk-test');
    expect('pathToClaudeCodeExecutable' in o).toBe(false);
  });

  it('reads the credential environment at every call', () => {
    let token = 'one';
    const cfg = { env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: token }) };
    expect(sdkProcessOptions(cfg).env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('one');
    token = 'two';
    expect(sdkProcessOptions(cfg).env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('two');
  });

  it('inherits the server environment when nothing is configured', () => {
    expect(sdkProcessOptions().env!.PATH).toBe(process.env.PATH);
  });
});

describe('sandboxOptions', () => {
  it('isolates Bash with writes limited to the working directory, and leaves every decision to canUseTool', () => {
    const { sandbox } = sandboxOptions('/work/room/worktrees/orchestrator');
    expect(sandbox).toEqual({
      enabled: true,
      // without a sandbox the session still runs (the permission callback is the gate); with 'required' it would not
      failIfUnavailable: false,
      // sandboxed commands would otherwise be approved without asking canUseTool at all
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ['/work/room/worktrees/orchestrator'] },
    });
  });

  it("'required' makes a session fail when the host cannot sandbox, and 'off' leaves the option out", () => {
    expect(sandboxOptions('/w', { sandbox: 'required' }).sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
    });
    expect(sandboxOptions('/w', { sandbox: 'off' })).toEqual({});
    expect(sandboxOptions('/w', { sandbox: 'auto' }).sandbox?.enabled).toBe(true);
  });
});

describe('UsageTracker', () => {
  const model = MODELS.orchestrator;

  it('turns cumulative totals into per-result deltas', () => {
    const t = new UsageTracker();
    const first = t.deltas(
      resultMessage({
        usage: { model, input: 1000, output: 100, cacheRead: 500, cacheWrite: 200, cost: 0.05 },
      }),
    );
    expect(first).toEqual([
      {
        sessionId: 'sess_fake',
        model,
        inputTokens: 1200,
        outputTokens: 100,
        cacheReadTokens: 500,
        costUsd: 0.05,
      },
    ]);
    const second = t.deltas(
      resultMessage({
        usage: { model, input: 1500, output: 160, cacheRead: 900, cacheWrite: 200, cost: 0.08 },
      }),
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 400 });
    expect(second[0]!.costUsd).toBeCloseTo(0.03, 10);
  });

  it('counts a resumed session once: its first result carries the totals saved with the transcript', () => {
    const t = new UsageTracker();
    t.deltas(resultMessage({ usage: { model, input: 1000, output: 100, cost: 0.05 } }));
    // the session died and was resumed; the new process starts from the saved 1000/100/$0.05 and adds 200/20/$0.01
    const resumed = t.deltas(
      resultMessage({ usage: { model, input: 1200, output: 120, cost: 0.06 } }),
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    expect(resumed[0]!.costUsd).toBeCloseTo(0.01, 10);
  });

  it('counts the new totals in full when they start over (a fresh session, or a /clear)', () => {
    const t = new UsageTracker();
    t.deltas(resultMessage({ usage: { model, input: 1000, output: 100, cost: 0.05 } }));
    const fresh = t.deltas(resultMessage({ usage: { model, input: 300, output: 30, cost: 0.02 } }));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    expect(fresh[0]!.costUsd).toBeCloseTo(0.02, 10);
    // and counting continues from the new totals
    const next = t.deltas(resultMessage({ usage: { model, input: 350, output: 35, cost: 0.025 } }));
    expect(next[0]).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('records nothing for a result that adds nothing', () => {
    const t = new UsageTracker();
    const r = resultMessage({ usage: { model, input: 10, output: 1, cost: 0.001 } });
    expect(t.deltas(r)).toHaveLength(1);
    expect(t.deltas(r)).toEqual([]);
  });

  it('keeps models apart', () => {
    const t = new UsageTracker();
    const r = resultMessage({ usage: { model, input: 10, output: 1, cost: 0.001 } });
    (r as { modelUsage: Record<string, unknown> }).modelUsage[MODELS.worker] = {
      inputTokens: 5,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.002,
    };
    expect(
      t
        .deltas(r)
        .map((d) => d.model)
        .sort(),
    ).toEqual([MODELS.orchestrator, MODELS.worker].sort());
  });

  it('falls back to the main-loop totals when a result has no per-model breakdown', () => {
    const r = resultMessage({
      usage: { model, input: 300, output: 40, cacheRead: 10, cacheWrite: 20, cost: 0.02 },
    });
    (r as { modelUsage: unknown }).modelUsage = {};
    expect(new UsageTracker().deltas(r)).toEqual([]); // no model to blame without a fallback
    expect(new UsageTracker().deltas(r, MODELS.merge)).toEqual([
      {
        sessionId: 'sess_fake',
        model: MODELS.merge,
        inputTokens: 320,
        outputTokens: 40,
        cacheReadTokens: 10,
        costUsd: 0.02,
      },
    ]);
  });

  it('recordResultUsage writes each delta to RoomActions.recordUsage with role and room', async () => {
    const stub = createStubActions({ repo: new MemoryRepo() });
    const tracker = new UsageTracker();
    await recordResultUsage(
      stub.actions,
      'room_test',
      'orchestrator',
      resultMessage({ usage: { model, input: 100, output: 10, cost: 0.01 } }),
      tracker,
    );
    await recordResultUsage(
      stub.actions,
      'room_test',
      'orchestrator',
      resultMessage({ usage: { model, input: 250, output: 30, cost: 0.03 } }),
      tracker,
    );
    expect(stub.usage.map((u) => [u.role, u.roomId, u.inputTokens, u.outputTokens])).toEqual([
      ['orchestrator', 'room_test', 100, 10],
      ['orchestrator', 'room_test', 150, 20],
    ]);
    expect(stub.usage.every((u) => /^\d{4}-\d\d-\d\dT/.test(u.at))).toBe(true);
  });

  it('never throws when recording fails', async () => {
    const stub = createStubActions({ repo: new MemoryRepo() });
    stub.actions.recordUsage = async () => {
      throw new Error('db closed');
    };
    await expect(
      recordResultUsage(
        stub.actions,
        'room_test',
        'worker',
        resultMessage({ usage: { model, input: 1, cost: 0.1 } }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('AssistantUsage', () => {
  it('sums usage by model and counts one API response once however many messages carry it', async () => {
    const u = new AssistantUsage();
    expect(u.empty).toBe(true);
    u.observe(
      assistantMessage({
        id: 'm1',
        model: MODELS.worker,
        input: 1000,
        output: 10,
        cacheRead: 200,
        cacheWrite: 50,
      }),
    );
    // the same response, streamed in a second frame with the final output count
    u.observe(
      assistantMessage({
        id: 'm1',
        model: MODELS.worker,
        input: 1000,
        output: 80,
        cacheRead: 200,
        cacheWrite: 50,
      }),
    );
    u.observe(assistantMessage({ id: 'm2', model: MODELS.worker, input: 500, output: 20 }));
    u.observe(resultMessage()); // not an assistant message: ignored
    expect(u.empty).toBe(false);
    const [r] = u.records();
    expect(r).toMatchObject({
      model: MODELS.worker,
      inputTokens: 1000 + 50 + 500,
      outputTokens: 100,
      cacheReadTokens: 200,
    });
    expect(r!.costUsd).toBeCloseTo((1500 * 2 + 100 * 10 + 200 * 0.2 + 50 * 2.5) / 1_000_000, 10);
  });

  it('records the partial usage of a session that never produced a result', async () => {
    const stub = createStubActions({ repo: new MemoryRepo() });
    const u = new AssistantUsage();
    u.observe(assistantMessage({ id: 'm1', model: MODELS.worker, input: 2000, output: 300 }));
    await recordAssistantUsage(stub.actions, 'room_test', 'worker', u);
    expect(stub.usage).toHaveLength(1);
    expect(stub.usage[0]).toMatchObject({
      role: 'worker',
      model: MODELS.worker,
      inputTokens: 2000,
      outputTokens: 300,
    });
    expect(stub.usage[0]!.costUsd).toBeCloseTo((2000 * 2 + 300 * 10) / 1_000_000, 10);
  });
});

describe('helpers', () => {
  it('drainQuery returns the last result and shows every message to the callback', async () => {
    async function* gen() {
      yield assistantMessage({ model: MODELS.worker });
      yield resultMessage({ text: 'first' });
      yield resultMessage({ text: 'second' });
    }
    const seen: string[] = [];
    const result = await drainQuery(gen(), (m) => seen.push(m.type));
    expect(seen).toEqual(['assistant', 'result', 'result']);
    expect(result).toMatchObject({ subtype: 'success', result: 'second' });
    async function* empty() {}
    expect(await drainQuery(empty())).toBeNull();
  });

  it('userMessage wraps text as a streaming user turn', () => {
    expect(userMessage('hello')).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
    });
  });

  it('AsyncQueue yields what was pushed in order and ends when closed', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    const got: number[] = [];
    const reader = (async () => {
      for await (const n of q) got.push(n);
    })();
    q.push(3);
    q.close();
    q.push(4); // ignored after close
    await reader;
    expect(got).toEqual([1, 2, 3]);
  });

  it('prices the two model tiers and estimates cost from tokens', () => {
    expect(priceFor(MODELS.listener)).toMatchObject({ input: 2, output: 10 });
    expect(priceFor(MODELS.orchestrator)).toMatchObject({ input: 4, output: 20 });
    expect(priceFor('some-other-model')).toBeNull();
    expect(
      estimateCostUsd(MODELS.orchestrator, {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(24);
    expect(
      estimateCostUsd('some-other-model', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }),
    ).toBe(0);
  });

  it('builds a plain-text digest from the events', () => {
    expect(
      fallbackDigest([
        'Change on Architecture by Alice: Added latency',
        'Proposal opened: PG vs CH',
      ]),
    ).toBe(
      'While you were away:\n- Change on Architecture by Alice: Added latency\n- Proposal opened: PG vs CH',
    );
    expect(fallbackDigest([])).toBe('While you were away:\n- Nothing notable was recorded.');
    expect(SIGN_IN_DETAIL).toBe('Sign in to Claude in Settings');
  });
});
