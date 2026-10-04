import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ListenerClient } from './listener.js';
import type { QueryFn, SdkQuery } from './sdk.js';

/** Where agent activity is recorded (the server's debug trace); structural so agents keep depending on contracts only. */
export interface TraceSink {
  record(kind: string, data?: Record<string, unknown>): void;
}

/** Option keys that are callbacks, process plumbing or credentials: left out of the trace. */
const SKIPPED_OPTIONS = new Set([
  'env',
  'abortController',
  'canUseTool',
  'stderr',
  'spawnClaudeCodeProcess',
  'executable',
  'executableArgs',
  'pathToClaudeCodeExecutable',
]);

/** The parts of a session's options worth seeing when analysing it: model, prompt, tools, budget, cwd, resume… */
export function describeOptions(options: Options | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (SKIPPED_OPTIONS.has(key) || typeof value === 'function') continue;
    if (key === 'hooks' || key === 'mcpServers' || key === 'agents')
      out[key] = value && typeof value === 'object' ? Object.keys(value) : value;
    else out[key] = value;
  }
  return out;
}

/** `rooms/<roomId>/…` in a working directory names the room a session belongs to. */
export function roomFromCwd(cwd: string | undefined): string | undefined {
  return cwd ? /[\\/]rooms[\\/]([^\\/]+)/.exec(cwd)?.[1] : undefined;
}

let queryCounter = 0;

/**
 * Wraps the Agent SDK `query` so every session is recorded: its options and prompt (`sdk.query.start`), each message
 * streamed into it (`sdk.input`), each message it produces (`sdk.message`; partial stream events are counted, not
 * kept) and how it ended (`sdk.query.end`). The returned object is the SDK's own, so interrupt() and friends still work.
 */
export function tracedQueryFn(queryFn: QueryFn, trace: TraceSink): QueryFn {
  return ((params: Parameters<QueryFn>[0]) => {
    const qid = `q${++queryCounter}_${Date.now().toString(36)}`;
    const started = Date.now();
    const { prompt, options } = params;
    const roomId = roomFromCwd(options?.cwd);
    trace.record('sdk.query.start', {
      qid,
      roomId,
      options: describeOptions(options),
      ...(typeof prompt === 'string' ? { prompt } : { streaming: true }),
    });
    const input =
      typeof prompt === 'string'
        ? prompt
        : (async function* (): AsyncGenerator<SDKUserMessage> {
            for await (const message of prompt) {
              trace.record('sdk.input', { qid, roomId, message });
              yield message;
            }
          })();
    let q: SdkQuery;
    try {
      q = queryFn({ ...params, prompt: input });
    } catch (error) {
      trace.record('sdk.query.end', { qid, roomId, outcome: 'throw', error, ms: 0 });
      throw error;
    }
    return traceMessages(q, trace, { qid, roomId, started });
  }) as QueryFn;
}

function traceMessages(
  q: SdkQuery,
  trace: TraceSink,
  ctx: { qid: string; roomId: string | undefined; started: number },
): SdkQuery {
  let messages = 0;
  let partials = 0;
  let ended = false;
  const end = (outcome: string, error?: unknown) => {
    if (ended) return;
    ended = true;
    trace.record('sdk.query.end', {
      qid: ctx.qid,
      roomId: ctx.roomId,
      outcome,
      messages,
      partials,
      ms: Date.now() - ctx.started,
      ...(error !== undefined ? { error } : {}),
    });
  };
  const observe = (r: IteratorResult<SDKMessage, void>) => {
    if (r.done) return end('done');
    const message = r.value;
    if (message.type === 'stream_event') {
      partials += 1;
      return;
    }
    messages += 1;
    trace.record('sdk.message', { qid: ctx.qid, roomId: ctx.roomId, message });
  };
  const proxy: SdkQuery = new Proxy(q, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return () => proxy;
      if (prop === 'next')
        return async (...args: [] | [unknown]) => {
          try {
            const r = await target.next(...(args as []));
            observe(r);
            return r;
          } catch (error) {
            end('error', error);
            throw error;
          }
        };
      if (prop === 'return')
        return async (value?: unknown) => {
          end('return');
          return target.return(value as void);
        };
      if (prop === 'throw')
        return async (error?: unknown) => {
          end('error', error);
          return target.throw(error);
        };
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return proxy;
}

let listenerCounter = 0;

/** Records every listener classification: the request (`listener.request`) and the reply or error. */
export function tracedListenerClient(
  client: ListenerClient,
  trace: TraceSink,
  roomId?: string,
): ListenerClient {
  function wrap<P, R>(
    api: { create(params: P, options?: never): Promise<R> },
    name: string,
  ): { create(params: P, options?: never): Promise<R> } {
    return {
      async create(params: P, options?: never): Promise<R> {
        const lid = `l${++listenerCounter}_${Date.now().toString(36)}`;
        const started = Date.now();
        trace.record('listener.request', { lid, roomId, api: name, params });
        try {
          const response = await api.create(params, options);
          trace.record('listener.response', { lid, roomId, ms: Date.now() - started, response });
          return response;
        } catch (error) {
          trace.record('listener.error', { lid, roomId, ms: Date.now() - started, error });
          throw error;
        }
      },
    };
  }
  const messages = client.messages as unknown as Parameters<typeof wrap>[0];
  const beta = client.beta?.messages as unknown as Parameters<typeof wrap>[0] | undefined;
  return {
    messages: wrap(messages, 'messages'),
    ...(beta ? { beta: { messages: wrap(beta, 'beta.messages') } } : {}),
  } as unknown as ListenerClient;
}
