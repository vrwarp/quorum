import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS, textHash, type Anchor, type Message } from '@quorum/shared';
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
    expect(call.options.env!.HOME).toBe(process.env.HOME);
    // the server's own configuration is not: no QUORUM_PASSWORD (or any QUORUM_*) in an agent session
    expect(Object.keys(call.options.env!).filter((k) => k.startsWith('QUORUM_'))).toEqual([]);
    // chat text in prompts is taken verbatim: no @path expansion, no slash commands (M3)
    expect(call.options.verbatimPrompts).toBe(true);
  };

  let savedPassword: string | undefined;
  beforeEach(() => {
    savedPassword = process.env.QUORUM_PASSWORD;
    process.env.QUORUM_PASSWORD = 'hunter2';
  });
  afterEach(() => {
    if (savedPassword === undefined) delete process.env.QUORUM_PASSWORD;
    else process.env.QUORUM_PASSWORD = savedPassword;
  });

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
    // the workers run in the background: start_exploration has already returned
    await vi.waitFor(() => expect(r.sdk.calls.at(-1)!.options.model).toBe(MODELS.worker));
    const worker = r.sdk.calls.at(-1)!;
    expectProcess(worker);
    expect(worker.options.verbatimPrompts).toBe(true);

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

// ---------------------------------------------------------------------------------------------------------------------

const WORKER_OUT = {
  summary: 'Drafted it.',
  tradeoffs: 'Simple.',
  assumptions: [],
  openQuestions: [],
  sourcesConsulted: [],
};

type RegisteredTools = Record<
  string,
  { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }
>;
const toolsOf = (call: QueryCall): RegisteredTools =>
  (
    call.options.mcpServers!.quorum as unknown as {
      instance: { _registeredTools: RegisteredTools };
    }
  ).instance._registeredTools;

/** Line numbers of the rig document: 1 "# Architecture", 2 blank, 3 "Intro.". */
async function suggestionFor(
  r: Rig,
  opts: { replacement: string; start?: number; end?: number; hash?: string },
): Promise<Message> {
  const start = opts.start ?? 3;
  const end = opts.end ?? start;
  const text = ((await r.repo.readFile('Architecture.md')) ?? '')
    .split('\n')
    .slice(start - 1, end)
    .join('\n');
  const anchor: Anchor = {
    documentId: 'doc_1',
    baseSha: (await r.repo.headSha('main'))!,
    startLine: start,
    endLine: end,
    textHash: opts.hash ?? textHash(text),
    text,
  };
  return r.stub.human('user_bob', 'Bob', 'suggestion', {
    kind: 'card',
    anchor,
    card: {
      type: 'suggestion',
      anchor,
      replacement: opts.replacement,
      status: 'pending',
      resolutionSha: null,
      note: null,
    },
  });
}

const turnsWith = (r: Rig, marker: string) =>
  (r.sessions()[0]?.turns ?? []).filter((t) => t.includes(marker));

describe('explorations run in the background (H2)', () => {
  /** Orchestrator turns answer at once; exploration workers (string prompts) wait for `release()`. */
  function gated(r: Rig, onAsk: (call: QueryCall) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const orchestrate = session(async (text, call) => {
      if (text.includes('[event:ask]')) await onAsk(call);
    });
    r.sdk.respond(async function* (call) {
      if (typeof call.prompt === 'string') {
        writeFileSync(
          join(call.options.cwd!, 'Architecture.md'),
          `# Architecture\n\nIntro.\n\nDraft ${call.index}.\n`,
        );
        await gate;
        yield resultMessage({ structured: WORKER_OUT });
        return;
      }
      yield* orchestrate(call);
    });
    return release;
  }

  it('start_exploration returns at once, and a suggestion is processed while the exploration is pending', async () => {
    const r = rig();
    let started: { explorationId: string; branches: string[]; baseSha: string } | null = null;
    const release = gated(r, async (call) => {
      const out = await toolsOf(call).start_exploration!.handler(
        {
          documentPath: 'Architecture.md',
          topic: 'storage',
          theses: ['PostgreSQL', 'ClickHouse'],
          triggerMessageIds: [],
        },
        {},
      );
      started = JSON.parse(out.content[0]!.text);
    });
    await r.runtime.startRoom(r.stub.roomId);
    const id = r.stub.roomId;
    const baseSha = await r.repo.headSha('main');

    r.runtime.onAsk(id, r.alice('what should we do about storage?'));
    await vi.waitFor(() => expect(started).not.toBeNull());
    expect(started).toMatchObject({
      branches: ['architecture/storage/a', 'architecture/storage/b'],
      baseSha,
    });
    expect(started!.explorationId).toMatch(/^expl_/);
    // the orchestrator's turn is over although both workers are still running
    await vi.waitFor(() => expect(r.statuses()).toContain('thinking:Exploring storage'));
    expect(r.sdk.calls.filter((c) => typeof c.prompt === 'string')).toHaveLength(2);
    expect(turnsWith(r, '[event:exploration_finished]')).toEqual([]);

    // Carol's typo fix arrives now. A suggestion whose paragraph changed goes to the orchestrator ...
    const stale = await suggestionFor(r, {
      replacement: 'Intro, fixed.',
      hash: 'feedfacefeedface',
    });
    r.runtime.onSuggestion(id, stale);
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion]')).toHaveLength(1));
    expect(turnsWith(r, '[event:suggestion]')[0]).toContain('"notAppliedByServer"');
    // ... and one that matches is applied straight away
    const exact = await suggestionFor(r, { replacement: 'Intro, fixed.' });
    r.runtime.onSuggestion(id, exact);
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion_applied]')).toHaveLength(1));
    expect(await r.repo.readFile('Architecture.md')).toBe('# Architecture\n\nIntro, fixed.\n');
    // all of that happened with the workers still running
    expect(turnsWith(r, '[event:exploration_finished]')).toEqual([]);

    // the workers finish: the orchestrator is told, with summaries, diff stats and what was said meanwhile
    release();
    await vi.waitFor(() => expect(turnsWith(r, '[event:exploration_finished]')).toHaveLength(1));
    const turn = turnsWith(r, '[event:exploration_finished]')[0]!;
    const payload = JSON.parse(
      turn.slice(turn.indexOf('{', turn.indexOf('[event:exploration_finished]'))),
    );
    expect(payload).toMatchObject({
      explorationId: started!.explorationId,
      mode: 'draft',
      document: 'Architecture.md',
      partial: false,
      branchBase: baseSha,
    });
    expect(
      payload.workers.map((w: { branch: string; summary: string; changed: boolean }) => [
        w.branch,
        w.summary,
        w.changed,
      ]),
    ).toEqual([
      ['architecture/storage/a', 'Drafted it.', true],
      ['architecture/storage/b', 'Drafted it.', true],
    ]);
    expect(payload.workers[0].diffStat).toEqual({ removed: 0, added: 2 });
    // chatSinceStart: what the room said while the workers ran (here the two suggestions)
    expect(payload.chatSinceStart.map((m: { id: string }) => m.id)).toEqual([stale.id, exact.id]);
    await vi.waitFor(() => expect(r.statuses().at(-1)).toBe('idle'));
    // the worktrees are gone, the branches are not
    expect([...r.repo.worktrees.keys()].filter((b) => b.startsWith('architecture/'))).toEqual([]);
    expect((await r.repo.listBranches()).filter((b) => b.startsWith('architecture/'))).toHaveLength(
      2,
    );
    await r.runtime.stopAll();
  });

  it('two explorations of the same topic can run at once, with their own branches', async () => {
    const r = rig();
    const started: Array<{ branches: string[] }> = [];
    const release = gated(r, async (call) => {
      const out = await toolsOf(call).start_exploration!.handler(
        {
          documentPath: 'Architecture.md',
          topic: 'storage',
          theses: ['x', 'y'],
          triggerMessageIds: [],
        },
        {},
      );
      started.push(JSON.parse(out.content[0]!.text));
    });
    await r.runtime.startRoom(r.stub.roomId);
    r.runtime.onAsk(r.stub.roomId, r.alice('first'));
    r.runtime.onAsk(r.stub.roomId, r.alice('second'));
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started.flatMap((s) => s.branches).sort()).toEqual([
      'architecture/storage-2/a',
      'architecture/storage-2/b',
      'architecture/storage/a',
      'architecture/storage/b',
    ]);
    release();
    await vi.waitFor(() => expect(turnsWith(r, '[event:exploration_finished]')).toHaveLength(2));
    await r.runtime.stopAll();
  });

  it('stopping the room cancels the workers, and the room is not revived by their results', async () => {
    const r = rig();
    gated(r, async (call) => {
      await toolsOf(call).start_exploration!.handler(
        { documentPath: 'Architecture.md', topic: 'storage', theses: ['x'], triggerMessageIds: [] },
        {},
      );
    });
    await r.runtime.startRoom(r.stub.roomId);
    r.runtime.onAsk(r.stub.roomId, r.alice('go'));
    await vi.waitFor(() =>
      expect(r.sdk.calls.filter((c) => typeof c.prompt === 'string')).toHaveLength(1),
    );
    await r.runtime.stopRoom(r.stub.roomId);
    const worker = r.sdk.calls.find((c) => typeof c.prompt === 'string')!;
    expect(worker.options.abortController!.signal.aborted).toBe(true); // on the room's abort signal
    await settle();
    expect(r.sessions()).toHaveLength(1);
    expect(r.statuses().at(-1)).toBe('idle');
  });
});

describe('suggestions: the exact-match fast path (M5)', () => {
  it('applies a suggestion whose anchored text still matches without asking the orchestrator to edit, then notifies it', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    const m = await suggestionFor(r, { replacement: 'Intro, tightened.' });
    r.runtime.onSuggestion(r.stub.roomId, m);

    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion_applied]')).toHaveLength(1));
    expect(await r.repo.readFile('Architecture.md')).toBe('# Architecture\n\nIntro, tightened.\n');
    const sha = await r.repo.headSha('main');
    expect((await r.repo.show(sha!)).trailers).toMatchObject({
      actor: 'user:user_bob',
      triggerMessageIds: [m.id],
    });
    expect(r.stub.changes).toEqual([
      expect.objectContaining({ sha, documentId: 'doc_1', triggerMessageIds: [m.id] }),
    ]);
    expect(m.card).toMatchObject({ type: 'suggestion', status: 'applied', resolutionSha: sha });
    // the orchestrator got a short notification, not a request to edit
    expect(turnsWith(r, '[event:suggestion]\n')).toEqual([]);
    const note = turnsWith(r, '[event:suggestion_applied]')[0]!;
    expect(note).toContain(sha!);
    expect(note).toMatch(/Nothing to edit or resolve/);
    await r.runtime.stopAll();
  });

  it('hands a suggestion over to the orchestrator when its paragraph changed meanwhile, with the reason', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    const m = await suggestionFor(r, { replacement: 'Intro, tightened.' });
    await r.repo.commitToMain(
      { 'Architecture.md': '# Architecture\n\nIntro, by Alice.\n' },
      'Edit',
      {
        actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
        triggerMessageIds: [],
      },
    );
    r.runtime.onSuggestion(r.stub.roomId, m);
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion]')).toHaveLength(1));
    expect(turnsWith(r, '[event:suggestion]')[0]).toContain(
      '"notAppliedByServer": "the anchored text changed since the suggestion was made"',
    );
    expect(turnsWith(r, '[event:suggestion_applied]')).toEqual([]);
    expect(await r.repo.readFile('Architecture.md')).toBe('# Architecture\n\nIntro, by Alice.\n');
    expect(r.stub.changes).toEqual([]);
    expect(m.card).toMatchObject({ status: 'pending' });
    await r.runtime.stopAll();
  });

  it('hands an oversized suggestion over to the orchestrator (it becomes a Review proposal)', async () => {
    const r = rig();
    const five = '# Architecture\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n';
    await r.repo.commitToMain({ 'Architecture.md': five }, 'Five paragraphs', {
      actor: { kind: 'agent', role: 'orchestrator' },
      triggerMessageIds: [],
    });
    await r.runtime.startRoom(r.stub.roomId);
    // lines 3-9: four paragraphs rewritten into one, more than the limit of three
    const m = await suggestionFor(r, { start: 3, end: 9, replacement: 'Merged.' });
    r.runtime.onSuggestion(r.stub.roomId, m);
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion]')).toHaveLength(1));
    expect(turnsWith(r, '[event:suggestion]')[0]).toMatch(
      /notAppliedByServer.*4 existing paragraphs/,
    );
    expect(await r.repo.readFile('Architecture.md')).toBe(five);
    await r.runtime.stopAll();
  });

  it('hands the suggestion over when applying it directly fails', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    const m = await suggestionFor(r, { replacement: 'Intro, tightened.' });
    r.repo.commitToMain = async () => {
      throw new Error('disk full');
    };
    r.runtime.onSuggestion(r.stub.roomId, m);
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion]')).toHaveLength(1));
    expect(turnsWith(r, '[event:suggestion]')[0]).toContain(
      'applying it directly failed: disk full',
    );
    expect(r.logs.some((l) => l.startsWith('warn:applying a suggestion directly failed'))).toBe(
      true,
    );
    await r.runtime.stopAll();
  });

  it('keeps the chat moving while the write queue is busy: events after a suggestion wait only a moment for it', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    void r.repo.withMainLock(() => hold); // e.g. a semantic revert holding the queue for minutes
    const m = await suggestionFor(r, { replacement: 'Intro, tightened.' });
    r.runtime.onSuggestion(r.stub.roomId, m);
    r.runtime.onAsk(r.stub.roomId, r.alice('a question meanwhile'));
    // the ask is not stuck behind the suggestion
    await vi.waitFor(() => expect(turnsWith(r, '[event:ask]')).toHaveLength(1), { timeout: 5000 });
    expect(r.stub.changes).toEqual([]);
    release();
    await vi.waitFor(() => expect(turnsWith(r, '[event:suggestion_applied]')).toHaveLength(1));
    expect(await r.repo.readFile('Architecture.md')).toContain('Intro, tightened.');
    await r.runtime.stopAll();
  });

  it('keeps events in order in the common case: a suggestion is handled before the event that follows it', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    const m = await suggestionFor(r, { replacement: 'Intro, tightened.' });
    r.runtime.onSuggestion(r.stub.roomId, m);
    r.runtime.onAsk(r.stub.roomId, r.alice('and a question'));
    await vi.waitFor(() => expect(r.sessions()[0]?.turns).toHaveLength(2));
    const kinds = r
      .sessions()[0]!
      .turns.map((t) => /\[event:(suggestion_applied|ask)\]/.exec(t)?.[1]);
    expect(kinds).toEqual(['suggestion_applied', 'ask']);
    await r.runtime.stopAll();
  });
});

describe('budgets per session (M1)', () => {
  /** Runs a worker, the merge driver and the digest writer, and returns the caps they were given. */
  async function caps(options: Partial<ClaudeRuntimeOptions>) {
    const r = rig({ options });
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const orchestratorCap = r.sessions()[0]!.options.maxBudgetUsd;
    r.runtime.onAsk(r.stub.roomId, r.alice('x'));
    await vi.waitFor(() => expect(r.sessions()[0]!.turns.length).toBeGreaterThan(0));

    r.sdk.respond(oneShot(undefined, resultMessage({ structured: WORKER_OUT })));
    await toolsOf(r.sessions()[0]!).start_exploration!.handler(
      { documentPath: 'Architecture.md', topic: 'x', theses: ['one'], triggerMessageIds: [] },
      {},
    );
    await vi.waitFor(() =>
      expect(r.sdk.calls.filter((c) => c.options.model === MODELS.worker)).toHaveLength(1),
    );
    const worker = r.sdk.calls.find((c) => c.options.model === MODELS.worker)!.options.maxBudgetUsd;

    const worktree = await r.repo.createDetachedWorktree('merge-1', 'main');
    r.sdk.respond(
      oneShot(undefined, resultMessage({ structured: { reconciled: false, summary: 's' } })),
    );
    await r.runtime.runMergeDriver(r.stub.roomId, {
      proposal: makeProposal(),
      optionId: 'opt_a',
      worktreePath: worktree,
      conflictedFiles: [],
      documentPath: 'Architecture.md',
    });
    const merge = r.sdk.calls.at(-1)!.options.maxBudgetUsd;

    r.sdk.respond(oneShot(undefined, resultMessage({ text: '- x' })));
    await r.runtime.writeDigest(r.stub.roomId, {
      userId: 'u',
      sinceMessageId: null,
      events: ['e'],
    });
    const digest = r.sdk.calls.at(-1)!.options.maxBudgetUsd;
    await r.runtime.stopAll();
    return { orchestrator: orchestratorCap, worker, merge, digest };
  }

  it('gives a worker a quarter of the configured cap, the orchestrator and merge driver the whole of it, and the digest writer a small fixed one', async () => {
    expect(await caps({ maxBudgetUsd: 20 })).toEqual({
      orchestrator: 20,
      worker: 5,
      merge: 20,
      digest: 0.5,
    });
  });

  it('never gives a worker less than $1, nor more than the cap itself', async () => {
    expect((await caps({ maxBudgetUsd: 2 })).worker).toBe(1); // a quarter would be $0.50
    const tiny = await caps({ maxBudgetUsd: 0.4 });
    expect(tiny.worker).toBe(0.4); // the floor does not exceed the cap
    expect(tiny.digest).toBe(0.4);
  });

  it('takes an explicit worker cap', async () => {
    expect((await caps({ maxBudgetUsd: 20, workerBudgetUsd: 2.5 })).worker).toBe(2.5);
  });

  it('leaves everything uncapped when no cap is configured, except the digest writer', async () => {
    expect(await caps({ maxBudgetUsd: undefined })).toEqual({
      orchestrator: undefined,
      worker: undefined,
      merge: undefined,
      digest: 0.5,
    });
  });
});

describe('idle rooms (M4)', () => {
  const IDLE = { idleAfterMs: 80, idleCheckMs: 10 };

  /** Presence is read from the room state: this lets a test decide who is connected. */
  function presence(r: Rig, initial: boolean) {
    const state = { connected: initial, broken: false };
    const original = r.stub.actions.getRoomState;
    r.stub.actions.getRoomState = async (roomId) => {
      if (state.broken) throw new Error('db busy');
      const s = await original(roomId);
      return { ...s, presence: s.presence.map((p) => ({ ...p, connected: state.connected })) };
    };
    return state;
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('stops the sessions of a room nobody is in and nothing is happening in, and starts them again with the next event', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    const removed: string[] = [];
    const original = r.repo.removeWorktree.bind(r.repo);
    r.repo.removeWorktree = async (name) => {
      removed.push(name);
      return original(name);
    };
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    const first = r.sessions()[0]!;

    await vi.waitFor(() => expect(first.closed).toBe(true), { timeout: 3000 });
    expect(first.options.abortController!.signal.aborted).toBe(true);
    expect(r.logs).toContain('info:room idle; stopping its agent sessions until the next event');
    expect(removed.filter((n) => n === 'orchestrator')).toHaveLength(2); // the stale one at start, its own at teardown
    expect(r.statuses()).toEqual([]); // the room never showed anything but idle
    await wait(150);
    expect(r.sessions()).toHaveLength(1); // nothing came back by itself

    // the next event brings it back, transparently: a new session that rehydrates and handles the event
    r.runtime.onAsk(r.stub.roomId, r.alice('anyone there?'));
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(2));
    await vi.waitFor(() => expect(r.sessions()[1]!.turns.length).toBe(1));
    expect(r.sessions()[1]!.turns[0]).toContain('[event:rehydrate]');
    expect(r.sessions()[1]!.turns[0]).toContain('anyone there?');
    await r.runtime.stopAll();
  });

  it('does it again after the room has been quiet for as long once more', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()[0]?.closed).toBe(true), { timeout: 3000 });
    r.runtime.onAsk(r.stub.roomId, r.alice('back'));
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(2));
    await vi.waitFor(() => expect(r.sessions()[1]!.closed).toBe(true), { timeout: 3000 });
    await r.runtime.stopAll();
  });

  it('also stops the listener: chat after the teardown gets a new one', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()[0]?.closed).toBe(true), { timeout: 3000 });
    r.runtime.onChatMessage(r.stub.roomId, r.alice('we should add a latency section'));
    await vi.waitFor(() => expect(r.client.calls).toHaveLength(1)); // the new listener classifies it
    await r.runtime.stopAll();
  });

  it('keeps a room with someone connected, however quiet it is', async () => {
    const r = rig({ options: IDLE });
    presence(r, true);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    await wait(400); // five times the idle time
    expect(r.sessions()[0]!.closed).toBe(false);
    expect(r.sessions()).toHaveLength(1);
    await r.runtime.stopAll();
  });

  it('treats presence it cannot read as somebody being there', async () => {
    const r = rig({ options: IDLE });
    const p = presence(r, false);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    p.broken = true;
    await wait(300);
    expect(r.sessions()[0]!.closed).toBe(false);
    expect(r.logs.some((l) => l.startsWith('warn:could not read presence'))).toBe(true);
    await r.runtime.stopAll();
  });

  it('keeps a room that is busy: an orchestrator turn in progress, then stops it once it is over', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    r.sdk.respond(
      session(async () => {
        await gate;
      }),
    );
    await r.runtime.startRoom(r.stub.roomId);
    r.runtime.onAsk(r.stub.roomId, r.alice('a long one'));
    await vi.waitFor(() => expect(r.sessions()[0]?.turns).toHaveLength(1));
    await wait(300);
    expect(r.sessions()[0]!.closed).toBe(false);
    release();
    await vi.waitFor(() => expect(r.sessions()[0]!.closed).toBe(true), { timeout: 3000 });
    await r.runtime.stopAll();
  });

  it('keeps a room whose exploration is still running', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const orchestrate = session(async (text, call) => {
      if (text.includes('[event:ask]'))
        await toolsOf(call).start_exploration!.handler(
          { documentPath: 'Architecture.md', topic: 'x', theses: ['one'], triggerMessageIds: [] },
          {},
        );
    });
    r.sdk.respond(async function* (call) {
      if (typeof call.prompt === 'string') {
        await gate;
        yield resultMessage({ structured: WORKER_OUT });
        return;
      }
      yield* orchestrate(call);
    });
    await r.runtime.startRoom(r.stub.roomId);
    r.runtime.onAsk(r.stub.roomId, r.alice('explore'));
    await vi.waitFor(() =>
      expect(r.sdk.calls.filter((c) => typeof c.prompt === 'string')).toHaveLength(1),
    );
    await wait(300); // the orchestrator has long been idle, the workers have not finished
    expect(r.sessions()[0]!.closed).toBe(false);
    release();
    // the results are delivered to the orchestrator first; only then does the room go quiet and idle
    await vi.waitFor(() => expect(turnsWith(r, '[event:exploration_finished]')).toHaveLength(1));
    await vi.waitFor(() => expect(r.sessions()[0]!.closed).toBe(true), { timeout: 3000 });
    await r.runtime.stopAll();
  });

  it('keeps a room while a merge is running', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    r.sdk.respond(async function* () {
      await gate;
      yield resultMessage({ structured: { reconciled: false, summary: 'clean' } });
    });
    const worktree = await r.repo.createDetachedWorktree('merge-1', 'main');
    const merging = r.runtime.runMergeDriver(r.stub.roomId, {
      proposal: makeProposal(),
      optionId: 'opt_a',
      worktreePath: worktree,
      conflictedFiles: [],
      documentPath: 'Architecture.md',
    });
    await wait(300);
    expect(r.sessions()[0]!.closed).toBe(false);
    release();
    await merging;
    await vi.waitFor(() => expect(r.sessions()[0]!.closed).toBe(true), { timeout: 3000 });
    await r.runtime.stopAll();
  });

  it('is kept alive by events', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(1));
    for (let i = 0; i < 8; i++) {
      r.runtime.onAsk(r.stub.roomId, r.alice(`question ${i}`));
      await wait(30); // well inside the 80 ms idle time
    }
    expect(r.sessions()).toHaveLength(1);
    expect(r.sessions()[0]!.closed).toBe(false);
    await r.runtime.stopAll();
  });

  it('leaves an idle room idle across a sign-in, and does not show it as unavailable after a sign-out', async () => {
    const r = rig({ options: IDLE });
    presence(r, false);
    await r.runtime.startRoom(r.stub.roomId);
    await vi.waitFor(() => expect(r.sessions()[0]?.closed).toBe(true), { timeout: 3000 });
    r.creds.set(true); // a new login while nobody is there
    await settle();
    expect(r.sessions()).toHaveLength(1); // no process was started for an empty room
    r.creds.set(false);
    await settle();
    r.creds.set(true);
    await settle();
    expect(r.sessions()).toHaveLength(1);
    r.runtime.onAsk(r.stub.roomId, r.alice('someone is back'));
    await vi.waitFor(() => expect(r.sessions()).toHaveLength(2));
    await r.runtime.stopAll();
  });

  it('can be switched off, and is on by default with a 15 minute idle time', async () => {
    const off = rig({ options: { idleAfterMs: 0, idleCheckMs: 10 } });
    presence(off, false);
    await off.runtime.startRoom(off.stub.roomId);
    await vi.waitFor(() => expect(off.sessions()).toHaveLength(1));
    await wait(200);
    expect(off.sessions()[0]!.closed).toBe(false);
    await off.runtime.stopAll();

    // with the defaults a room is not stopped within the first minutes (the timer is armed but far from due)
    const normal = rig();
    presence(normal, false);
    await normal.runtime.startRoom(normal.stub.roomId);
    await vi.waitFor(() => expect(normal.sessions()).toHaveLength(1));
    await wait(100);
    expect(normal.sessions()[0]!.closed).toBe(false);
    await normal.runtime.stopAll();
  });
});
