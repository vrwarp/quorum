import type Anthropic from '@anthropic-ai/sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { errMessage, noopLogger, type Logger } from '../common.js';
import type { ListenerClient } from './listener.js';
import { drainQuery, sdkProcessOptions, type ClaudeProcessConfig, type QueryFn } from './sdk.js';

export interface SdkListenerDeps {
  queryFn: QueryFn;
  /** launch and auth settings for the Claude Code subprocess (read per call) */
  process: () => ClaudeProcessConfig | undefined;
  /** working directory for the one-shot sessions; no tools are enabled, so it is never read */
  cwd: string;
  logger?: Logger;
  /** wall-clock cap per classification */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Structured output ends the turn through a synthetic tool call, so a single classification needs a few turns. */
const MAX_TURNS = 4;

function flattenText(blocks: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') return blocks;
  return blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n\n');
}

/**
 * A ListenerClient that runs each classification as a one-shot Agent SDK session instead of a Messages API call.
 *
 * The Messages API needs an API key, but the server can also be signed in with a Claude login or a long-lived token,
 * which only the Claude Code subprocess can use. In that case the listener goes through the subprocess too: no tools,
 * the same system prompt, the same JSON schema as structured output. It is slower than the direct call (a process per
 * classification) and has no explicit prompt-cache breakpoints, which is why an API key is still preferred when present.
 */
export function createSdkListenerClient(deps: SdkListenerDeps): ListenerClient {
  const log = deps.logger ?? noopLogger;
  return {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        timer.unref?.();
        const schema =
          params.output_config?.format && 'schema' in params.output_config.format
            ? (params.output_config.format.schema as Record<string, unknown>)
            : undefined;
        const prompt = params.messages
          .map((m) => flattenText(m.content as string | Array<{ type: string; text?: string }>))
          .join('\n\n');
        const options: Options = {
          model: params.model,
          effort: params.output_config?.effort ?? 'low',
          systemPrompt: flattenText(
            params.system as string | Array<{ type: string; text?: string }> | undefined,
          ),
          tools: [],
          canUseTool: async () => ({ behavior: 'deny', message: 'no tools in the listener' }),
          maxTurns: MAX_TURNS,
          permissionMode: 'default',
          settingSources: [],
          persistSession: false,
          cwd: deps.cwd,
          abortController: ac,
          ...(schema ? { outputFormat: { type: 'json_schema', schema } } : {}),
          ...sdkProcessOptions(deps.process()),
        };
        let q: ReturnType<QueryFn> | null = null;
        try {
          q = deps.queryFn({ prompt, options });
          let aborted = false;
          const onAbort = new Promise<null>((resolve) =>
            ac.signal.addEventListener('abort', () => ((aborted = true), resolve(null)), {
              once: true,
            }),
          );
          const drained = drainQuery(q as AsyncIterable<SDKMessage>);
          drained.catch(() => undefined);
          const result = await Promise.race([drained, onAbort]);
          if (aborted) throw new Error('listener classification timed out');
          if (!result) throw new Error('listener session ended without a result');
          if (result.subtype !== 'success' || result.is_error) {
            throw new Error(
              `listener session ended with ${result.subtype}${'errors' in result && result.errors?.length ? `: ${result.errors.join('; ')}` : ''}`,
            );
          }
          const text =
            result.structured_output !== undefined
              ? JSON.stringify(result.structured_output)
              : result.result;
          const u = result.usage;
          return {
            id: `sdk_${result.session_id}`,
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'text', text, citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: u?.input_tokens ?? 0,
              output_tokens: u?.output_tokens ?? 0,
              cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
            },
          } as unknown as Anthropic.Message;
        } catch (e) {
          log('debug', 'sdk listener classification failed', { error: errMessage(e) });
          throw e;
        } finally {
          clearTimeout(timer);
          try {
            q?.close();
          } catch {
            /* already closed */
          }
        }
      },
    },
  };
}
