import type Anthropic from '@anthropic-ai/sdk';
import type { ListenerClient, ListenerRequestOptions } from '../claude/listener.js';

export interface FakeReply {
  /** the model's text; objects are JSON-stringified */
  text?: string | object;
  stop_reason?: Anthropic.Message['stop_reason'];
  usage?: Partial<Anthropic.Usage>;
  /** reject instead of answering */
  error?: Error;
  /** never answer (until the request is aborted, when the client honors its signal) */
  hang?: boolean;
}

export interface FakeListenerClient extends ListenerClient {
  /** every request, whichever endpoint it went to */
  calls: Anthropic.MessageCreateParamsNonStreaming[];
  /** the options each request carried (signal, timeout) */
  options: Array<ListenerRequestOptions | undefined>;
  /** requests that went to the beta endpoint (a subset of `calls`), with their beta parameters */
  betaCalls: Array<Record<string, unknown>>;
}

const textBlocks = (params: Anthropic.MessageCreateParamsNonStreaming) => {
  const content = params.messages[0]!.content;
  return typeof content === 'string'
    ? [content]
    : content.map((b) => (b.type === 'text' ? b.text : ''));
};

/**
 * Text of the transcript part of a listener request, one entry per block: the transcript lines and, last, the
 * instruction. The first user block (the room context) is `requestContext`.
 */
export function requestLines(params: Anthropic.MessageCreateParamsNonStreaming): string[] {
  return textBlocks(params).slice(1);
}

/** The room context block: first block of the user message (room, participants, document outlines, open proposals). */
export function requestContext(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return textBlocks(params)[0] ?? '';
}

/**
 * A Messages API stand-in. `respond` gets the request and the 0-based call number. With `beta` the client also has
 * `beta.messages.create`, which answers through the same `respond` (so a test can make it fail with a 400).
 */
export function createFakeListenerClient(
  respond: (
    params: Anthropic.MessageCreateParamsNonStreaming,
    n: number,
  ) => FakeReply | Promise<FakeReply> = () => ({ text: { intents: [] } }),
  opts: { beta?: boolean } = {},
): FakeListenerClient {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const options: FakeListenerClient['options'] = [];
  const betaCalls: Array<Record<string, unknown>> = [];
  const answer = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    o?: ListenerRequestOptions,
  ) => {
    const n = calls.length;
    calls.push(params);
    options.push(o);
    const reply = await respond(params, n);
    if (reply.hang)
      await new Promise<void>((_, reject) => {
        o?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    if (reply.error) throw reply.error;
    const text =
      typeof reply.text === 'string' ? reply.text : JSON.stringify(reply.text ?? { intents: [] });
    return {
      id: `msg_fake_${n}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text, citations: null }],
      stop_reason: reply.stop_reason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...reply.usage,
      },
    } as unknown as Anthropic.Message;
  };
  const client: FakeListenerClient = {
    calls,
    options,
    betaCalls,
    messages: { create: (params, o) => answer(params, o) },
  };
  if (opts.beta)
    client.beta = {
      messages: {
        create: (params, o) => {
          betaCalls.push(params as unknown as Record<string, unknown>);
          return answer(
            params as unknown as Anthropic.MessageCreateParamsNonStreaming,
            o,
          ) as unknown as Promise<Anthropic.Beta.Messages.BetaMessage>;
        },
      },
    };
  return client;
}
