import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS, type Message } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import {
  FakeSdk,
  oneShot,
  resultMessage,
  session,
  type QueryCall,
  type QueryScript,
} from '../testing/fakeQuery.js';
import {
  createFakeListenerClient,
  requestLines,
  type FakeListenerClient,
  type FakeReply,
} from '../testing/fakeAnthropic.js';
import { makeChange, makeProposal, tunables } from '../testing/fixtures.js';
import { SIGN_IN_DETAIL } from '../common.js';
import { ClaudeRuntime, type ClaudeRuntimeOptions } from './ClaudeRuntime.js';

const BINARY = '/opt/claude/bin/claude';
const CONFIG_DIR = '/data/claude';

interface Creds {
  signedIn: boolean;
  listeners: Set<() => void>;
  unsubscribed: number;
  /** flip the credential state and fire the change listeners, as ClaudeAuthService does */
  set(signedIn: boolean): void;
}

interface Rig {
  stub: StubActions;
  repo: MemoryRepo;
  sdk: FakeSdk;
  client: FakeListenerClient;
  creds: Creds;
  runtime: ClaudeRuntime;
  logs: string[];
  alice(text: string): Message;
  /** streaming (orchestrator) sessions only */
  sessions(): QueryCall[];
  statuses(): string[];
}

/** Streaming sessions behave like the orchestrator; string prompts are one-shot sessions that answer with `oneShotText`. */
function defaultScript(oneShotText = 'digest text'): QueryScript {
  return async function* (call) {
    if (typeof call.prompt === 'string') {
      yield resultMessage({
        text: oneShotText,
        structured: { reconciled: true, summary: 'merged' },
      });
      return;
    }
    yield* session()(call);
  };
}

type ListenerParams = Parameters<FakeListenerClient['messages']['create']>[0];

function rig(
  opts: {
    signedIn?: boolean;
    options?: Partial<ClaudeRuntimeOptions>;
    injectClient?: boolean;
    reply?: (params: ListenerParams) => object;
    clientReply?: (params: ListenerParams, n: number) => FakeReply;
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
  const sdk = new FakeSdk(defaultScript());
  const client = createFakeListenerClient((params, n) =>
    opts.clientReply
      ? opts.clientReply(params, n)
      : { text: opts.reply ? opts.reply(params) : { intents: [] } },
  );
  const logs: string[] = [];
  const creds: Creds = {
    signedIn: opts.signedIn ?? true,
    listeners: new Set(),
    unsubscribed: 0,
    set(signedIn) {
      this.signedIn = signedIn;
      for (const l of [...this.listeners]) l();
    },
  };
  const runtime = new ClaudeRuntime(
    stub.actions,
    {
      dataDir: '/tmp/quorum-test-data',
      tunables: tunables({ listenerDebounceMs: 10, listenerMaxWaitMs: 200 }),
      logger: (level, msg, meta) =>
        logs.push(`${level}:${msg}${meta?.error ? ` (${String(meta.error)})` : ''}`),
      claudeBinary: BINARY,
      claudeEnv: () => ({ CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
      claudeAvailable: async () => creds.signedIn,
      onCredentialsChanged: (listener) => {
        creds.listeners.add(listener);
        return () => {
          creds.unsubscribed += 1;
          creds.listeners.delete(listener);
        };
      },
      ...(opts.options ?? {}),
    },
    {
      queryFn: sdk.queryFn,
      ...(opts.injectClient === false ? {} : { createClient: () => client }),
    },
  );
  return {
    stub,
    repo,
    sdk,
    client,
    creds,
    runtime,
    logs,
    alice: (text) => stub.human('user_alice', 'Alice', text),
    sessions: () =>
      sdk.calls.filter((c) => typeof c.prompt !== 'string' && !c.options.outputFormat),
    statuses: () => stub.statuses.map((s) => (s.detail ? `${s.status}:${s.detail}` : s.status)),
  };
}

/** let queued promise work (credential probes, session starts) settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe('without a Claude credential', () => {
  it('sets the agent unavailable with the sign-in detail and starts no model work', async () => {
    const r = rig({ signedIn: false });
    await r.runtime.startRoom(r.stub.roomId);
    expect(r.stub.statuses).toEqual([
      { status: 'unavailable', detail: 'Sign in to Claude in Settings' },
    ]);
    expect(r.sdk.calls).toHaveLength(0); // the injected query function was never called
    expect(r.client.calls).toHaveLength(0);
    await r.runtime.stopAll();
  });

  it('drops every event with a log line, never calls the model, and never throws', async () => {
    const r = rig({ signedIn: false });
    await r.runtime.startRoom(r.stub.roomId);
    const m = r.alice('we should add a section on latency requirements');
    const roomId = r.stub.roomId;
    expect(() => {
      r.runtime.onChatMessage(roomId, m);
      r.runtime.onSuggestion(roomId, m);
      r.runtime.onAsk(roomId, m);
      r.runtime.onProposalEvent(roomId, { type: 'expired', proposal: makeProposal() });
      r.runtime.onReverted(roomId, makeChange(), 'e'.repeat(40), 'user_bob');
      r.runtime.onChatMessage(roomId, null as unknown as Message); // malformed: still no throw
    }).not.toThrow();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 100)); // far longer than the rig's 10 ms debounce

    expect(r.sdk.calls).toHaveLength(0);
    expect(r.client.calls).toHaveLength(0);
    for (const what of [
      'onChatMessage',
      'onSuggestion',
      'onAsk',
      'onProposalEvent',
      'onReverted',
    ]) {
      expect(r.logs).toContain(`info:dropping ${what}: Sign in to Claude in Settings`);
    }
    // the status was set once, not once per dropped event
    expect(r.statuses()).toEqual([`unavailable:${SIGN_IN_DETAIL}`]);
    await r.runtime.stopAll();
  });

  it('ignores chat from the agent and from the system without any credential check', async () => {
    const r = rig({ signedIn: false });
    const agent = {
      ...r.alice('hello'),
      author: { kind: 'agent', role: 'orchestrator' },
    } as Message;
    r.runtime.onChatMessage(r.stub.roomId, agent);
    await settle();
    expect(r.logs.filter((l) => l.includes('dropping'))).toEqual([]);
    expect(r.stub.statuses).toEqual([]);
    await r.runtime.stopAll();
  });

  it('writeDigest returns a plain-text digest of the events, without calling the model', async () => {
    const r = rig({ signedIn: false });
    const events = [
      'Change on Architecture by Alice: Added a latency section',
      'Proposal opened: PostgreSQL vs ClickHouse',
    ];
    const digest = await r.runtime.writeDigest(r.stub.roomId, {
      userId: 'user_dave',
      sinceMessageId: null,
      events,
    });
    expect(digest).toBe(`While you were away:\n- ${events[0]}\n- ${events[1]}`);
    expect(r.sdk.calls).toHaveLength(0);
    expect(r.client.calls).toHaveLength(0);
    // it reports the missing credential too
    expect(r.statuses()).toEqual([`unavailable:${SIGN_IN_DETAIL}`]);
    await r.runtime.stopAll();
  });

  it('the merge driver and semantic revert fail with the sign-in message, so the merge stays open', async () => {
    const r = rig({ signedIn: false });
    await expect(
      r.runtime.runMergeDriver(r.stub.roomId, {
        proposal: makeProposal(),
        optionId: 'opt_a',
        worktreePath: '/tmp/x',
        conflictedFiles: [],
        documentPath: 'Architecture.md',
      }),
    ).rejects.toThrow('Sign in to Claude in Settings');
    await expect(
      r.runtime.runSemanticRevert(r.stub.roomId, { change: makeChange(), byUserId: 'user_bob' }),
    ).rejects.toThrow('Sign in to Claude in Settings');
    expect(r.sdk.calls).toHaveLength(0);
    await r.runtime.stopAll();
  });
});

describe('credentials appearing and disappearing', () => {
  it('starts the sessions of active rooms and shows idle when a sign-in completes', async () => {
    const r = rig({ signedIn: false });
    await r.runtime.startRoom(r.stub.roomId);
    expect(r.sessions()).toHaveLength(0);

    r.creds.set(true);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe('idle'));
    expect(r.statuses()).toEqual([`unavailable:${SIGN_IN_DETAIL}`, 'idle']);

    // and the agent works: a suggestion reaches the new orchestrator session
    const m = r.alice('tighten this');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:suggestion]'))).toBe(true),
    );
    await r.runtime.stopAll();
  });

  it('stops the sessions and shows unavailable when the login is removed, then drops events', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const session0 = r.sessions()[0]!;

    r.creds.set(false);
    await vi.waitFor(() => expect(session0.closed).toBe(true));
    expect(session0.options.abortController!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe(`unavailable:${SIGN_IN_DETAIL}`));

    r.runtime.onAsk(r.stub.roomId, r.alice('why?'));
    await settle();
    expect(r.sessions()).toHaveLength(1); // no new session
    expect(r.logs).toContain('info:dropping onAsk: Sign in to Claude in Settings');
    await r.runtime.stopAll();
  });

  it('restarts running sessions when the credentials change but stay available (a new login applies at once)', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    r.creds.set(true); // signed in again, possibly as someone else
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(2));
    expect(r.sessions()[0]!.closed).toBe(true);
    expect(r.sessions()[1]!.closed).toBe(false);
    await r.runtime.stopAll();
  });

  it('does not restart rooms that were stopped, and unsubscribes on stopAll', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    await r.runtime.stopRoom(r.stub.roomId);
    expect(r.sessions()[0]!.closed).toBe(true);
    r.creds.set(true);
    await settle();
    expect(r.sessions()).toHaveLength(1);

    expect(r.creds.listeners.size).toBe(1);
    await r.runtime.stopAll();
    expect(r.creds.unsubscribed).toBe(1);
    expect(r.creds.listeners.size).toBe(0);
  });

  it('treats a failing credential probe as "keep the last known answer"', async () => {
    let fail = false;
    const r = rig({
      options: {
        claudeAvailable: async () => {
          if (fail) throw new Error('probe crashed');
          return true;
        },
      },
    });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    fail = true;
    r.runtime.onAsk(r.stub.roomId, r.alice('still works?'));
    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:ask]'))).toBe(true),
    );
    expect(
      r.logs.some((l) =>
        l.startsWith('warn:claudeAvailable failed; keeping the last known answer'),
      ),
    ).toBe(true);
    await r.runtime.stopAll();
  });

  it('assumes a credential is available when no probe is configured (and does not need a subscription)', async () => {
    const r = rig({ options: { claudeAvailable: undefined, onCredentialsChanged: undefined } });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    expect(r.stub.statuses).toEqual([]);
    await r.runtime.stopAll();
  });
});

describe('every query() gets the binary and the credential environment', () => {
  const expectProcess = (call: QueryCall) => {
    expect(call.options.pathToClaudeCodeExecutable).toBe(BINARY);
    expect(call.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(call.options.env!.PATH).toBe(process.env.PATH); // the server environment is kept
  };

  it('orchestrator, exploration workers, merge driver, semantic revert and digest writer', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    expectProcess(r.sessions()[0]!);
    r.runtime.onAsk(r.stub.roomId, r.alice('anything'));
    await vi.waitFor(() => expect(r.sessions()[0]!.turns.length).toBeGreaterThan(0));

    // an exploration worker, started through the orchestrator's start_exploration tool
    const quorum = r.sessions()[0]!.options.mcpServers!.quorum as unknown as {
      instance: {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
      };
    };
    r.sdk.respond(
      oneShot(
        (c) => void c,
        resultMessage({
          structured: {
            summary: 's',
            tradeoffs: 't',
            assumptions: [],
            openQuestions: [],
            sourcesConsulted: [],
          },
        }),
      ),
    );
    await quorum.instance._registeredTools.start_exploration!.handler(
      {
        documentPath: 'Architecture.md',
        topic: 'storage',
        theses: ['PostgreSQL'],
        triggerMessageIds: [],
      },
      {},
    );
    const worker = r.sdk.calls.at(-1)!;
    expect(worker.options.model).toBe(MODELS.worker);
    expectProcess(worker);

    // the merge driver (a merge in progress in a detached worktree)
    const worktree = await r.repo.createDetachedWorktree('merge-1', 'main');
    r.sdk.respond(
      oneShot(undefined, resultMessage({ structured: { reconciled: false, summary: 'clean' } })),
    );
    expect(
      await r.runtime.runMergeDriver(r.stub.roomId, {
        proposal: makeProposal(),
        optionId: 'opt_a',
        worktreePath: worktree,
        conflictedFiles: [],
        documentPath: 'Architecture.md',
      }),
    ).toEqual({ reconciled: false, summary: 'clean' });
    expect(r.sdk.calls.at(-1)!.options.model).toBe(MODELS.merge);
    expectProcess(r.sdk.calls.at(-1)!);

    // the digest writer
    r.sdk.respond(oneShot(undefined, resultMessage({ text: '- Alice asked something.' })));
    expect(
      await r.runtime.writeDigest(r.stub.roomId, {
        userId: 'user_dave',
        sinceMessageId: null,
        events: ['e'],
      }),
    ).toBe('- Alice asked something.');
    expect(r.sdk.calls.at(-1)!.options.model).toBe(MODELS.digest);
    expectProcess(r.sdk.calls.at(-1)!);

    // the semantic revert
    const first = await r.repo.commitToMain(
      { 'Architecture.md': '# Architecture\n\nIntro.\n\nAdded.\n' },
      'Add',
      { actor: { kind: 'agent', role: 'orchestrator' }, triggerMessageIds: [] },
    );
    r.sdk.respond(
      oneShot((c) => void c, resultMessage({ structured: { reconciled: true, summary: 'ok' } })),
    );
    await expect(
      r.runtime.runSemanticRevert(r.stub.roomId, {
        change: makeChange({ sha: first }),
        byUserId: 'user_bob',
      }),
    ).rejects.toThrow('semantic revert changed nothing');
    expect(r.sdk.calls.at(-1)!.options.model).toBe(MODELS.merge);
    expectProcess(r.sdk.calls.at(-1)!);
    await r.runtime.stopAll();
  });

  it('reads the credential environment at each query, so a new login is picked up', async () => {
    let token = 'tok-1';
    const r = rig({ options: { claudeEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: token }) } });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    expect(r.sessions()[0]!.options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-1');
    token = 'tok-2';
    r.creds.set(true);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(2));
    expect(r.sessions()[1]!.options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-2');
    await r.runtime.stopAll();
  });

  it('survives claudeEnv throwing and passes the API key to the subprocess', async () => {
    const r = rig({
      options: {
        claudeEnv: () => {
          throw new Error('no config');
        },
        anthropicApiKey: 'sk-test',
      },
    });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    expect(r.sessions()[0]!.options.env!.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(r.logs.some((l) => l.startsWith('warn:claudeEnv failed'))).toBe(true);
    await r.runtime.stopAll();
  });

  it('omits the binary when none is configured (the SDK uses its bundled one)', async () => {
    const r = rig({ options: { claudeBinary: undefined } });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    expect('pathToClaudeCodeExecutable' in r.sessions()[0]!.options).toBe(false);
    await r.runtime.stopAll();
  });
});

describe('events reach the orchestrator', () => {
  it('chat goes through the listener; intents (with the open proposals) become orchestrator events', async () => {
    const r = rig({
      reply: (params) => {
        const id = /\[(msg_[^\]]+)\]/.exec(requestLines(params)[0]!)![1]!;
        return {
          intents: [
            {
              type: 'edit_request',
              confidence: 0.93,
              documents: ['Architecture.md'],
              summary: 'add a latency section',
              messageIds: [id],
              positions: [],
              needsResearch: false,
            },
          ],
        };
      },
    });
    r.stub.proposals.push(makeProposal());
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const m = r.alice('we should add a section on latency requirements');
    r.runtime.onChatMessage(r.stub.roomId, m);

    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:intent]'))).toBe(true),
    );
    const turn = r.sessions()[0]!.turns.find((t) => t.includes('[event:intent]'))!;
    expect(turn).toContain('add a latency section');
    expect(turn).toContain(m.id);
    expect(turn).toContain('"openProposals"');
    expect(r.client.calls).toHaveLength(1);
    await r.runtime.stopAll();
  });

  it('resolves the messages an intent names across earlier, already classified messages', async () => {
    let firstId = '';
    const r = rig({
      reply: (params) => {
        const lines = requestLines(params);
        if (lines.length === 2) return { intents: [] }; // first pass: one message + instruction
        return {
          intents: [
            {
              type: 'divergence',
              confidence: 0.9,
              documents: [],
              summary: 'PostgreSQL vs ClickHouse',
              messageIds: [firstId],
              positions: [],
              needsResearch: false,
            },
          ],
        };
      },
    });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const a = r.alice("let's use PostgreSQL");
    firstId = a.id;
    r.runtime.onChatMessage(r.stub.roomId, a);
    await vi.waitFor(() => expect(r.client.calls).toHaveLength(1));
    const b = r.stub.human('user_bob', 'Bob', 'ClickHouse makes more sense');
    r.runtime.onChatMessage(r.stub.roomId, b);
    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:intent]'))).toBe(true),
    );
    const turn = r.sessions()[0]!.turns.find((t) => t.includes('[event:intent]'))!;
    expect(turn).toContain("let's use PostgreSQL"); // Alice's earlier message came along
    await r.runtime.stopAll();
  });

  it('suggestions, asks, proposal events and reverts become events in order', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    const id = r.stub.roomId;
    r.runtime.onSuggestion(id, r.alice('s'));
    r.runtime.onAsk(id, r.alice('a'));
    r.runtime.onProposalEvent(id, {
      type: 'merged',
      proposal: makeProposal(),
      optionId: 'opt_a',
      sha: 'd'.repeat(40),
      reconciled: false,
    });
    r.runtime.onReverted(id, makeChange(), 'e'.repeat(40), 'user_bob');
    await vi.waitFor(() => expect(r.sessions()[0]?.turns).toHaveLength(4));
    const turns = r.sessions()[0]!.turns;
    expect(turns[0]!.startsWith('[event:rehydrate]')).toBe(true); // the first turn carries the rehydrate preamble ahead of its event
    expect(
      turns.map((t) => /\[event:(suggestion|ask|proposal_event|revert)\]/.exec(t)![1]),
    ).toEqual(['suggestion', 'ask', 'proposal_event', 'revert']);
    await r.runtime.stopAll();
  });

  it('starting a room twice, or stopping one that never started, is harmless', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    await r.runtime.stopRoom('room_unknown');
    await r.runtime.stopAll();
    expect(r.sessions()[0]!.closed).toBe(true);
    // after stopAll the runtime is finished: late events are dropped, not revived
    r.runtime.onAsk(r.stub.roomId, r.alice('late'));
    await settle();
    expect(r.sessions()).toHaveLength(1);
  });

  it('a failure to start a room is logged, not thrown, and a later event retries', async () => {
    const r = rig();
    let fail = true;
    const original = r.stub.actions.repo;
    r.stub.actions.repo = async (roomId) => {
      if (fail) throw new Error('git unavailable');
      return original(roomId);
    };
    await expect(r.runtime.startRoom(r.stub.roomId)).resolves.toBeUndefined();
    expect(
      r.logs.some((l) => l.startsWith('error:startRoom failed') && l.includes('git unavailable')),
    ).toBe(true);
    fail = false;
    r.runtime.onAsk(r.stub.roomId, r.alice('retry'));
    await vi.waitFor(() =>
      expect(r.sessions()[0]?.turns.some((t) => t.includes('[event:ask]'))).toBe(true),
    );
    await r.runtime.stopAll();
  });
});

describe('agent status ownership', () => {
  it('a failing listener makes the room unavailable, and the next good classification brings it back', async () => {
    const r = rig({
      clientReply: (_params, n) =>
        n === 0 ? { error: new Error('529 overloaded') } : { text: { intents: [] } },
    });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    r.runtime.onChatMessage(r.stub.roomId, r.alice('hello'));
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe('unavailable:529 overloaded'));
    r.runtime.onChatMessage(r.stub.roomId, r.alice('anyone there?')); // a new message retries the pending ones
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe('idle'));
    expect(r.statuses()).toEqual(['unavailable:529 overloaded', 'idle']);
    await r.runtime.stopAll();
  });

  it('shows a long, multi-line listener error as one short line', async () => {
    const r = rig({
      clientReply: () => ({
        error: new Error(`Claude Code process exited with code 1.\nstderr: ${'x'.repeat(400)}`),
      }),
    });
    await r.runtime.startRoom(r.stub.roomId);
    r.runtime.onChatMessage(r.stub.roomId, r.alice('hello'));
    await vi.waitFor(() => expect(r.statuses().at(-1)?.startsWith('unavailable:')).toBe(true));
    const detail = r.stub.statuses.at(-1)!.detail!;
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail.startsWith('Claude Code process exited with code 1. stderr: xxx')).toBe(true);
    expect(detail.endsWith('…')).toBe(true);
    await r.runtime.stopAll();
  });

  it('a listener failure is not hidden by the orchestrator finishing a turn', async () => {
    const r = rig({ clientReply: () => ({ error: new Error('listener down') }) });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    r.runtime.onChatMessage(r.stub.roomId, r.alice('hello'));
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe('unavailable:listener down'));
    r.runtime.onAsk(r.stub.roomId, r.alice('an ask is handled meanwhile'));
    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:ask]'))).toBe(true),
    );
    await settle();
    expect(r.statuses().at(-1)).toBe('unavailable:listener down');
    await r.runtime.stopAll();
  });

  it('shows thinking while the merge driver works and idle afterwards', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const worktree = await r.repo.createDetachedWorktree('merge-2', 'main');
    r.sdk.respond(
      oneShot(undefined, resultMessage({ structured: { reconciled: false, summary: 'clean' } })),
    );
    await r.runtime.runMergeDriver(r.stub.roomId, {
      proposal: makeProposal({ title: 'PG vs CH' }),
      optionId: 'opt_a',
      worktreePath: worktree,
      conflictedFiles: [],
      documentPath: 'Architecture.md',
    });
    expect(r.statuses()).toEqual(['thinking:Merging PG vs CH', 'idle']);
    await r.runtime.stopAll();
  });
});

describe('digest', () => {
  it('uses the digest writer when Claude is available', async () => {
    const r = rig();
    r.sdk.respond(oneShot(undefined, resultMessage({ text: '- Alice added a section.' })));
    expect(
      await r.runtime.writeDigest(r.stub.roomId, {
        userId: 'user_dave',
        sinceMessageId: null,
        events: ['Change: x'],
      }),
    ).toBe('- Alice added a section.');
    await r.runtime.stopAll();
  });

  it('falls back to the plain digest when the writer fails or returns nothing', async () => {
    const r = rig();
    const events = ['Change on Architecture by Alice: Added latency'];
    r.sdk.respond(async function* () {
      yield* [];
      throw new Error('spawn failed');
    });
    expect(
      await r.runtime.writeDigest(r.stub.roomId, { userId: 'u', sinceMessageId: null, events }),
    ).toBe(`While you were away:\n- ${events[0]}`);
    expect(
      r.logs.some((l) => l.startsWith('warn:digest writer failed; using the plain digest')),
    ).toBe(true);

    r.sdk.respond(oneShot(undefined, resultMessage({ text: '   ' })));
    expect(
      await r.runtime.writeDigest(r.stub.roomId, { userId: 'u', sinceMessageId: null, events }),
    ).toBe(`While you were away:\n- ${events[0]}`);
    await r.runtime.stopAll();
  });
});

describe('listener client', () => {
  it('uses the Messages API client with the API key when there is one', async () => {
    const keys: Array<string | undefined> = [];
    const r = rig({ options: { anthropicApiKey: 'sk-ant-test' } });
    const rr = new ClaudeRuntime(
      r.stub.actions,
      {
        dataDir: '/tmp/x',
        tunables: tunables({ listenerDebounceMs: 5 }),
        anthropicApiKey: 'sk-ant-test',
        claudeAvailable: async () => true,
      },
      {
        queryFn: r.sdk.queryFn,
        createClient: (key) => {
          keys.push(key);
          return r.client;
        },
      },
    );
    await rr.startRoom(r.stub.roomId);
    rr.onChatMessage(r.stub.roomId, r.alice('hello'));
    await vi.waitFor(() => expect(r.client.calls).toHaveLength(1));
    expect(keys).toEqual(['sk-ant-test']);
    await rr.stopAll();
    await r.runtime.stopAll();
  });

  it('without an API key the listener runs through the Agent SDK with the same credentials (login or token only)', async () => {
    const r = rig({
      injectClient: false,
      reply: () => ({}),
    });
    r.sdk.respond(async function* (call) {
      if (typeof call.prompt !== 'string') {
        yield* session()(call);
        return;
      }
      // the listener's classification: a one-shot, tool-less session with the intents schema
      yield resultMessage({
        structured: {
          intents: [
            {
              type: 'question',
              confidence: 0.9,
              documents: [],
              summary: 'asks why',
              messageIds: [],
              positions: [],
              needsResearch: false,
            },
          ],
        },
        usage: { model: MODELS.listener, input: 120, output: 30, cost: 0.001 },
      });
    });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    r.runtime.onChatMessage(r.stub.roomId, r.alice('why is it 200 ms?'));

    await vi.waitFor(() =>
      expect(r.sessions()[0]!.turns.some((t) => t.includes('[event:intent]'))).toBe(true),
    );
    const listenerCall = r.sdk.calls.find((c) => c.options.outputFormat)!;
    expect(listenerCall.options.model).toBe(MODELS.listener);
    expect(listenerCall.options.tools).toEqual([]);
    expect(listenerCall.options.pathToClaudeCodeExecutable).toBe(BINARY);
    expect(listenerCall.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(typeof listenerCall.prompt).toBe('string');
    expect(listenerCall.prompt).toContain('why is it 200 ms?');
    expect(listenerCall.options.systemPrompt).toContain('You are the listener for Quorum');
    expect(r.client.calls).toHaveLength(0); // the Messages API was not used
    expect(r.stub.usage.some((u) => u.role === 'listener' && u.inputTokens === 120)).toBe(true);
    await r.runtime.stopAll();
  });
});
