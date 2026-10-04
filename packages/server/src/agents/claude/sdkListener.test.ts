import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { EFFORT, IntentBatchJsonSchema, MODELS } from '@quorum/shared';
import { createStubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { FakeSdk, hang, oneShot, resultMessage } from '../testing/fakeQuery.js';
import { createSdkListenerClient } from './sdkListener.js';
import { Listener, type ListenerBatch } from './listener.js';
import { LISTENER_SYSTEM } from '../prompts.js';

const params = (
  over: Partial<Anthropic.MessageCreateParamsNonStreaming> = {},
): Anthropic.MessageCreateParamsNonStreaming => ({
  model: MODELS.listener,
  max_tokens: 4096,
  thinking: { type: 'adaptive' },
  output_config: {
    effort: EFFORT.listener,
    format: {
      type: 'json_schema',
      schema: IntentBatchJsonSchema as unknown as Record<string, unknown>,
    },
  },
  system: [
    { type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'ROOM CONTEXT', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '[msg_1] Alice: hello' },
        { type: 'text', text: '[msg_2] Bob: world', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Classify them.' },
      ],
    },
  ],
  ...over,
});

const intents = {
  intents: [
    {
      type: 'question',
      confidence: 0.9,
      documents: [],
      summary: 'asks why',
      messageIds: ['msg_2'],
      positions: [],
      needsResearch: false,
    },
  ],
};
const proc = () => ({
  binary: '/opt/claude',
  env: () => ({ CLAUDE_CONFIG_DIR: '/data/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
});

describe('createSdkListenerClient', () => {
  it('runs the classification as a tool-less one-shot session with the schema as structured output', async () => {
    const sdk = new FakeSdk(
      oneShot(
        undefined,
        resultMessage({
          structured: intents,
          usage: {
            model: MODELS.listener,
            input: 800,
            output: 90,
            cacheRead: 300,
            cacheWrite: 50,
            cost: 0.002,
          },
        }),
      ),
    );
    const client = createSdkListenerClient({ queryFn: sdk.queryFn, process: proc, cwd: '/data' });
    const message = await client.messages.create(params());

    const call = sdk.calls[0]!;
    expect(call.prompt).toBe('[msg_1] Alice: hello\n\n[msg_2] Bob: world\n\nClassify them.');
    expect(call.options).toMatchObject({
      model: MODELS.listener,
      effort: EFFORT.listener,
      systemPrompt: 'SYSTEM PROMPT\n\nROOM CONTEXT',
      tools: [],
      persistSession: false,
      settingSources: [],
      permissionMode: 'default',
      cwd: '/data',
      pathToClaudeCodeExecutable: '/opt/claude',
      outputFormat: { type: 'json_schema', schema: IntentBatchJsonSchema },
    });
    expect(call.options.maxTurns).toBeGreaterThan(1); // structured output ends the turn through a synthetic tool call
    expect(call.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(
      await call.options.canUseTool!('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
      } as never),
    ).toMatchObject({ behavior: 'deny' });

    expect(message.stop_reason).toBe('end_turn');
    expect(message.model).toBe(MODELS.listener);
    expect(message.content).toEqual([
      expect.objectContaining({ type: 'text', text: JSON.stringify(intents) }),
    ]);
    expect(message.usage).toMatchObject({
      input_tokens: 800,
      output_tokens: 90,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    });
    expect(call.closed).toBe(true);
  });

  it('accepts a plain string system prompt and string message content', async () => {
    const sdk = new FakeSdk(oneShot(undefined, resultMessage({ structured: { intents: [] } })));
    const client = createSdkListenerClient({
      queryFn: sdk.queryFn,
      process: () => undefined,
      cwd: '/data',
    });
    await client.messages.create(
      params({ system: 'plain system', messages: [{ role: 'user', content: 'plain content' }] }),
    );
    expect(sdk.calls[0]!.options.systemPrompt).toBe('plain system');
    expect(sdk.calls[0]!.prompt).toBe('plain content');
    expect('pathToClaudeCodeExecutable' in sdk.calls[0]!.options).toBe(false);
  });

  it('falls back to the result text when there is no structured output', async () => {
    const sdk = new FakeSdk(oneShot(undefined, resultMessage({ text: '{"intents":[]}' })));
    const client = createSdkListenerClient({ queryFn: sdk.queryFn, process: proc, cwd: '/data' });
    const message = await client.messages.create(params());
    expect((message.content[0] as Anthropic.TextBlock).text).toBe('{"intents":[]}');
  });

  it('fails on error results, a missing result and a crash', async () => {
    const client = (script: Parameters<FakeSdk['respond']>[0]) =>
      createSdkListenerClient({
        queryFn: new FakeSdk(script).queryFn,
        process: proc,
        cwd: '/data',
      });
    await expect(
      client(oneShot(undefined, resultMessage({ subtype: 'error_max_turns' }))).messages.create(
        params(),
      ),
    ).rejects.toThrow('listener session ended with error_max_turns');
    await expect(
      client(oneShot(undefined, resultMessage({ isError: true, text: 'auth' }))).messages.create(
        params(),
      ),
    ).rejects.toThrow('listener session ended with success');
    await expect(
      client(async function* () {
        /* ends without a result */
      }).messages.create(params()),
    ).rejects.toThrow('listener session ended without a result');
    await expect(
      client(async function* () {
        yield* [];
        throw new Error('spawn ENOENT');
      }).messages.create(params()),
    ).rejects.toThrow('spawn ENOENT');
  });

  it('gives up after the timeout and closes the session', async () => {
    const sdk = new FakeSdk(hang({ ignoreAbort: true }));
    const client = createSdkListenerClient({
      queryFn: sdk.queryFn,
      process: proc,
      cwd: '/data',
      timeoutMs: 30,
    });
    await expect(client.messages.create(params())).rejects.toThrow(
      'listener classification timed out',
    );
    expect(sdk.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(sdk.calls[0]!.closed).toBe(true);
  });

  it('drives the Listener end to end', async () => {
    const sdk = new FakeSdk(
      oneShot(
        undefined,
        resultMessage({
          structured: intents,
          usage: { model: MODELS.listener, input: 100, output: 10, cost: 0.001 },
        }),
      ),
    );
    const stub = createStubActions({
      repo: new MemoryRepo('room_test', { 'Architecture.md': '# Architecture\n' }),
      documents: [{ path: 'Architecture.md', title: 'Architecture' }],
      participants: [{ userId: 'user_alice', displayName: 'Alice' }],
    });
    const batches: ListenerBatch[] = [];
    const listener = new Listener({
      roomId: stub.roomId,
      actions: stub.actions,
      client: createSdkListenerClient({ queryFn: sdk.queryFn, process: proc, cwd: '/data' }),
      onIntents: (b) => batches.push(b),
    });
    const m1 = stub.human('user_alice', 'Alice', 'hello');
    const m2 = stub.human('user_alice', 'Alice', 'why is this 200 ms?');
    listener.push(m1);
    listener.push(m2);
    await listener.flush();
    expect(batches).toHaveLength(1);
    // the scripted answer names an id that is not in the transcript, so the new messages stand in for it
    expect(batches[0]!.intents[0]).toMatchObject({
      type: 'question',
      summary: 'asks why',
      messageIds: [m1.id, m2.id],
    });
    expect(String(sdk.calls[0]!.options.systemPrompt)).toContain(LISTENER_SYSTEM);
    expect(sdk.calls[0]!.prompt).toContain('why is this 200 ms?');
    expect(stub.usage[0]).toMatchObject({ role: 'listener', inputTokens: 100 });
  });
});
