import type Anthropic from '@anthropic-ai/sdk';
import type { ListenerClient } from '../claude/listener.js';

export interface FakeReply {
  /** the model's text; objects are JSON-stringified */
  text?: string | object;
  stop_reason?: Anthropic.Message['stop_reason'];
  usage?: Partial<Anthropic.Usage>;
  /** reject instead of answering */
  error?: Error;
}

export interface FakeListenerClient extends ListenerClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[];
}

/** Text of the user message of a listener request, one entry per content block. */
export function requestLines(params: Anthropic.MessageCreateParamsNonStreaming): string[] {
  const content = params.messages[0]!.content;
  return typeof content === 'string'
    ? [content]
    : content.map((b) => (b.type === 'text' ? b.text : ''));
}

/** A Messages API stand-in. `respond` gets the request and the 0-based call number. */
export function createFakeListenerClient(
  respond: (
    params: Anthropic.MessageCreateParamsNonStreaming,
    n: number,
  ) => FakeReply | Promise<FakeReply> = () => ({ text: { intents: [] } }),
): FakeListenerClient {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        const n = calls.length;
        calls.push(params);
        const reply = await respond(params, n);
        if (reply.error) throw reply.error;
        const text =
          typeof reply.text === 'string'
            ? reply.text
            : JSON.stringify(reply.text ?? { intents: [] });
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
      },
    },
  };
}
