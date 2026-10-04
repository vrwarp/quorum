import { describe, expect, it } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn, SdkQuery } from './sdk.js';
import { AsyncQueue, userMessage } from './sdk.js';
import { describeOptions, roomFromCwd, tracedListenerClient, tracedQueryFn } from './trace.js';
import type { ListenerClient } from './listener.js';

function sink() {
  const lines: Array<{ kind: string } & Record<string, any>> = [];
  return {
    lines,
    record: (kind: string, data: Record<string, unknown> = {}) => lines.push({ kind, ...data }),
  };
}

/** A fake query: yields the given messages after consuming the streamed prompt, and has an extra method. */
function fakeQueryFn(messages: SDKMessage[], fail?: Error): QueryFn {
  return (({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) => {
    const gen = (async function* () {
      if (typeof prompt !== 'string') for await (const _ of prompt) void _;
      for (const m of messages) yield m;
      if (fail) throw fail;
    })();
    return Object.assign(gen, { interrupt: async () => 'interrupted' }) as unknown as SdkQuery;
  }) as unknown as QueryFn;
}

const assistant = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hi' }] },
} as unknown as SDKMessage;
const partial = { type: 'stream_event' } as unknown as SDKMessage;
const result = { type: 'result', subtype: 'success' } as unknown as SDKMessage;

describe('tracedQueryFn', () => {
  it('records the options, the streamed input, every message and the end, and keeps the query methods', async () => {
    const t = sink();
    const q = tracedQueryFn(fakeQueryFn([assistant, partial, result]), t);
    const input = new AsyncQueue<SDKUserMessage>();
    input.push(userMessage('hello'));
    input.close();
    const query = q({
      prompt: input,
      options: {
        model: 'm',
        cwd: '/data/rooms/room_1/worktrees/main',
        env: { ANTHROPIC_API_KEY: 'sk' },
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        mcpServers: { quorum: {} as never },
      },
    });
    const seen: string[] = [];
    for await (const m of query) seen.push(m.type);
    expect(seen).toEqual(['assistant', 'stream_event', 'result']);
    expect(await (query as unknown as { interrupt(): Promise<string> }).interrupt()).toBe(
      'interrupted',
    );

    expect(t.lines.map((l) => l.kind)).toEqual([
      'sdk.query.start',
      'sdk.input',
      'sdk.message',
      'sdk.message',
      'sdk.query.end',
    ]);
    const start = t.lines[0]!;
    expect(start.roomId).toBe('room_1');
    expect(start.options).toEqual({
      model: 'm',
      cwd: '/data/rooms/room_1/worktrees/main',
      mcpServers: ['quorum'],
    });
    expect(t.lines[1]!.message.message.content).toBe('hello');
    expect(t.lines.at(-1)).toMatchObject({ outcome: 'done', messages: 2, partials: 1 });
    expect(new Set(t.lines.map((l) => l.qid)).size).toBe(1);
  });

  it('records a string prompt and a session that fails', async () => {
    const t = sink();
    const q = tracedQueryFn(fakeQueryFn([assistant], new Error('crashed')), t);
    await expect(
      (async () => {
        for await (const _ of q({ prompt: 'do it', options: {} })) void _;
      })(),
    ).rejects.toThrow('crashed');
    expect(t.lines[0]).toMatchObject({ kind: 'sdk.query.start', prompt: 'do it' });
    expect(t.lines.at(-1)).toMatchObject({ kind: 'sdk.query.end', outcome: 'error' });
  });

  it('records a session the caller abandons', async () => {
    const t = sink();
    const q = tracedQueryFn(fakeQueryFn([assistant, result]), t);
    for await (const _ of q({ prompt: 'x', options: {} })) break;
    expect(t.lines.at(-1)).toMatchObject({ kind: 'sdk.query.end', outcome: 'return', messages: 1 });
  });
});

describe('helpers', () => {
  it('names the room from a working directory', () => {
    expect(roomFromCwd('/x/rooms/room_9/worktrees/a')).toBe('room_9');
    expect(roomFromCwd('/x/data')).toBeUndefined();
    expect(roomFromCwd(undefined)).toBeUndefined();
  });
  it('drops callbacks and the environment from options', () => {
    expect(describeOptions({ env: { A: '1' }, stderr: () => undefined, model: 'm' })).toEqual({
      model: 'm',
    });
  });
});

describe('tracedListenerClient', () => {
  it('records requests, replies and errors, calling the original client', async () => {
    const t = sink();
    let calls = 0;
    const client = {
      messages: {
        create: async (params: { fail?: boolean }) => {
          calls += 1;
          if (params.fail) throw new Error('overloaded');
          return { content: [{ type: 'text', text: '{"intents":[]}' }] };
        },
      },
    } as unknown as ListenerClient;
    const traced = tracedListenerClient(client, t, 'room_1');
    expect(traced.beta).toBeUndefined();
    await traced.messages.create({ model: 'm' } as never);
    await expect(traced.messages.create({ fail: true } as never)).rejects.toThrow('overloaded');
    expect(calls).toBe(2);
    expect(t.lines.map((l) => l.kind)).toEqual([
      'listener.request',
      'listener.response',
      'listener.request',
      'listener.error',
    ]);
    expect(t.lines[1]).toMatchObject({
      roomId: 'room_1',
      response: { content: [{ text: '{"intents":[]}' }] },
    });
  });
});
