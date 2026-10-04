import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../claude/sdk.js';

/** One `query()` call the code under test made. */
export interface QueryCall {
  index: number;
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
  /** text of every user turn consumed from a streaming prompt (see `session`) */
  turns: string[];
  closed: boolean;
  /** resolves when the code under test closes the query (query.close()) */
  whenClosed: Promise<void>;
  /** resolves when options.abortController is aborted */
  whenAborted: Promise<void>;
}

/** What a fake `query()` does: an async generator yielding SDK messages. Throw to simulate a crash. */
export type QueryScript = (call: QueryCall) => AsyncGenerator<SDKMessage, void, unknown>;

export function userText(msg: SDKUserMessage): string {
  const c = msg.message.content;
  return typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export interface ResultInit {
  /** cumulative usage to report for the model (modelUsage) */
  usage?: {
    model: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  structured?: unknown;
  text?: string;
  subtype?: SDKResultMessage['subtype'];
  isError?: boolean;
  queued?: number;
  sessionId?: string;
}

/** A result message with only the fields the runtime reads. */
export function resultMessage(init: ResultInit = {}): SDKResultMessage {
  const subtype = init.subtype ?? 'success';
  const u = init.usage;
  const base = {
    type: 'result',
    subtype,
    is_error: init.isError ?? subtype !== 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: u?.cost ?? 0,
    usage: {
      input_tokens: u?.input ?? 0,
      output_tokens: u?.output ?? 0,
      cache_read_input_tokens: u?.cacheRead ?? 0,
      cache_creation_input_tokens: u?.cacheWrite ?? 0,
    },
    modelUsage: u
      ? {
          [u.model]: {
            inputTokens: u.input ?? 0,
            outputTokens: u.output ?? 0,
            cacheReadInputTokens: u.cacheRead ?? 0,
            cacheCreationInputTokens: u.cacheWrite ?? 0,
            webSearchRequests: 0,
            costUSD: u.cost ?? 0,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        }
      : {},
    permission_denials: [],
    queued_turn_count: init.queued ?? 0,
    errors: [],
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: init.sessionId ?? 'sess_fake',
  };
  const success = {
    ...base,
    result: init.text ?? '',
    ...(init.structured !== undefined ? { structured_output: init.structured } : {}),
  };
  return (subtype === 'success' ? success : base) as unknown as SDKResultMessage;
}

/** An assistant message carrying token usage (what a timed-out session leaves behind instead of a result). */
export function assistantMessage(opts: {
  id?: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  error?: SDKAssistantMessage['error'];
  sessionId?: string;
}): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: opts.id ?? 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [{ type: 'text', text: 'working' }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
    parent_tool_use_id: null,
    ...(opts.error ? { error: opts.error } : {}),
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: opts.sessionId ?? 'sess_fake',
  } as unknown as SDKAssistantMessage;
}

/**
 * Script for a streaming-input session. Like the real SDK it pulls user turns from the prompt eagerly (they pile up in
 * its queue while an earlier turn is still running) and answers them one at a time with `onTurn`'s messages (default:
 * one clean result whose queued_turn_count is the number of turns still waiting).
 */
export function session(
  onTurn?: (text: string, call: QueryCall) => SDKMessage[] | void | Promise<SDKMessage[] | void>,
): QueryScript {
  return async function* (call) {
    const prompt = call.prompt;
    if (typeof prompt === 'string') throw new Error('session() needs a streaming prompt');
    const queue: string[] = [];
    const state: { ended: boolean; wake: (() => void) | null } = { ended: false, wake: null };
    const pump = (async () => {
      for await (const msg of prompt) {
        const text = userText(msg);
        call.turns.push(text);
        queue.push(text);
        state.wake?.();
      }
      state.ended = true;
      state.wake?.();
    })();
    pump.catch(() => undefined);
    for (;;) {
      const text = queue.shift();
      if (text === undefined) {
        if (state.ended) return;
        await new Promise<void>((resolve) => (state.wake = resolve));
        state.wake = null;
        continue;
      }
      const out = (await onTurn?.(text, call)) ?? [resultMessage({ queued: queue.length })];
      for (const m of out) yield m;
    }
  };
}

/** Script for a one-shot session: runs `work` (which may edit files in options.cwd) and then reports `result`. */
export function oneShot(
  work?: (call: QueryCall) => void | Promise<void>,
  result: SDKMessage | ((call: QueryCall) => SDKMessage) = resultMessage(),
): QueryScript {
  return async function* (call) {
    await work?.(call);
    yield typeof result === 'function' ? result(call) : result;
  };
}

/** Script for a session that never finishes on its own: it ends (as the real SDK does) when aborted, or never when `ignoreAbort`. */
export function hang(
  opts: {
    ignoreAbort?: boolean;
    before?: (call: QueryCall) => void | Promise<void>;
    messages?: SDKMessage[];
  } = {},
): QueryScript {
  return async function* (call) {
    await opts.before?.(call);
    for (const m of opts.messages ?? []) yield m;
    if (opts.ignoreAbort) await new Promise<void>(() => undefined);
    else await call.whenAborted;
  };
}

class FakeQuery {
  constructor(
    private readonly gen: AsyncGenerator<SDKMessage, void, unknown>,
    private readonly call: QueryCall,
    private readonly onClose: () => void,
  ) {}
  next(): Promise<IteratorResult<SDKMessage, void>> {
    // After close() no further messages arrive, whatever the script is waiting for (as with the real SDK).
    const closed = this.call.whenClosed.then((): IteratorResult<SDKMessage, void> => ({
      done: true,
      value: undefined,
    }));
    return Promise.race([this.gen.next(), closed]);
  }
  return(): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.resolve({ done: true, value: undefined });
  }
  throw(e: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return this.gen.throw(e);
  }
  [Symbol.asyncIterator](): this {
    return this;
  }
  close(): void {
    this.call.closed = true;
    this.onClose();
  }
}

/** A stand-in for the Agent SDK's `query`. Every call is recorded in `calls`; `respond` decides what it yields. */
export class FakeSdk {
  readonly calls: QueryCall[] = [];
  private script: QueryScript;
  readonly queryFn: QueryFn;

  constructor(script: QueryScript = oneShot()) {
    this.script = script;
    this.queryFn = ((params: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Options;
    }) => {
      const options = params.options ?? {};
      let closeNow!: () => void;
      const whenClosed = new Promise<void>((resolve) => (closeNow = resolve));
      const abort = options.abortController?.signal;
      const whenAborted = new Promise<void>((resolve) => {
        if (!abort) return;
        if (abort.aborted) resolve();
        else abort.addEventListener('abort', () => resolve(), { once: true });
      });
      const call: QueryCall = {
        index: this.calls.length,
        prompt: params.prompt,
        options,
        turns: [],
        closed: false,
        whenClosed,
        whenAborted,
      };
      this.calls.push(call);
      return new FakeQuery(this.script(call), call, closeNow);
    }) as unknown as QueryFn;
  }

  /** Replace the behavior of calls made from now on. */
  respond(script: QueryScript): this {
    this.script = script;
    return this;
  }
}
