import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type { RoomId, UsageRecord } from '@quorum/shared';
import type { RoomActions } from '../../contracts/index.js';
import { estimateCostUsd } from '../common.js';

/** The Agent SDK `query` function; injected so tests never spawn a process. */
export type QueryFn = typeof query;
export type SdkQuery = ReturnType<QueryFn>;

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/** How the Claude Code subprocess is launched and authenticated. Applied to every `query()` the runtime makes. */
export interface ClaudeProcessConfig {
  /** Claude Code executable the SDK spawns (pathToClaudeCodeExecutable); omit to use the SDK's bundled binary. */
  binary?: string;
  /** Extra environment variables (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN). Read at each query() so a new login applies at once. */
  env?: () => Record<string, string>;
  /** ANTHROPIC_API_KEY handed to the subprocess when it is not already in the server's environment. */
  apiKey?: string;
}

/**
 * `Options.env` REPLACES the subprocess environment, so the server's own environment is spread in first (PATH, HOME,
 * and an ambient ANTHROPIC_API_KEY), then the configured API key, then the credential environment from the sign-in
 * service.
 */
export function sdkProcessOptions(
  cfg?: ClaudeProcessConfig,
): Pick<Options, 'env' | 'pathToClaudeCodeExecutable'> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (cfg?.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  Object.assign(env, cfg?.env?.() ?? {});
  return { env, ...(cfg?.binary ? { pathToClaudeCodeExecutable: cfg.binary } : {}) };
}

/** Single-consumer async queue used as streaming input. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

type RecordShape = Omit<UsageRecord, 'roomId' | 'role' | 'at'>;

interface UsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/**
 * Result messages carry totals that are cumulative for the query() call (and per-model). This turns them
 * into per-result deltas so usage is recorded once.
 */
export class UsageTracker {
  private seen = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  >();

  /**
   * `fallbackModel` covers results that carry no per-model breakdown (crash or older producers): the main-loop totals
   * in `usage` and `total_cost_usd` are then recorded against the model the session was asked to run.
   */
  deltas(result: SDKResultMessage, fallbackModel?: string): RecordShape[] {
    const out: RecordShape[] = [];
    const entries: Array<[string, UsageEntry]> = Object.entries(result.modelUsage ?? {}).map(
      ([model, u]) => [
        model,
        {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
          costUSD: u.costUSD ?? 0,
        },
      ],
    );
    if (entries.length === 0 && fallbackModel && result.usage) {
      entries.push([
        fallbackModel,
        {
          inputTokens: result.usage.input_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? 0,
          costUSD: result.total_cost_usd ?? 0,
        },
      ]);
    }
    for (const [model, u] of entries) {
      const prev = this.seen.get(model) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      };
      const cur = {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheRead: u.cacheReadInputTokens,
        cacheWrite: u.cacheCreationInputTokens,
        cost: u.costUSD,
      };
      this.seen.set(model, cur);
      const d = {
        input: Math.max(0, cur.input - prev.input),
        output: Math.max(0, cur.output - prev.output),
        cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
        cost: Math.max(0, cur.cost - prev.cost),
      };
      if (d.input + d.output + d.cacheRead + d.cacheWrite === 0 && d.cost === 0) continue;
      out.push({
        sessionId: result.session_id,
        model,
        inputTokens: d.input + d.cacheWrite,
        outputTokens: d.output,
        cacheReadTokens: d.cacheRead,
        costUsd: d.cost,
      });
    }
    return out;
  }
}

export async function recordResultUsage(
  actions: RoomActions,
  roomId: RoomId,
  role: UsageRecord['role'],
  result: SDKResultMessage,
  tracker: UsageTracker = new UsageTracker(),
  fallbackModel?: string,
): Promise<void> {
  for (const d of tracker.deltas(result, fallbackModel)) {
    await actions
      .recordUsage({ roomId, role, at: new Date().toISOString(), ...d })
      .catch(() => undefined);
  }
}

/**
 * Token usage read off the assistant messages of a session. A timed-out or cancelled one-shot never produces a result
 * message, but it still spent tokens; this is what gets recorded for it (cost estimated from list prices).
 */
export class AssistantUsage {
  private readonly byMessage = new Map<
    string,
    { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  >();
  private sessionId: string | null = null;

  observe(msg: SDKMessage): void {
    if (msg.type !== 'assistant') return;
    const m = msg.message;
    const u = m?.usage;
    if (!u) return;
    this.sessionId ??= msg.session_id;
    // one API response can arrive as several assistant messages sharing an id: keep the latest totals for each id
    this.byMessage.set(m.id ?? `anon-${this.byMessage.size}`, {
      model: m.model ?? 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }

  get empty(): boolean {
    return this.byMessage.size === 0;
  }

  records(): RecordShape[] {
    const byModel = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    for (const u of this.byMessage.values()) {
      const t = byModel.get(u.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      t.cacheWrite += u.cacheWrite;
      byModel.set(u.model, t);
    }
    return [...byModel.entries()].map(([model, t]) => ({
      sessionId: this.sessionId ?? 'unknown',
      model,
      inputTokens: t.input + t.cacheWrite,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      costUsd: estimateCostUsd(model, t),
    }));
  }
}

export async function recordAssistantUsage(
  actions: RoomActions,
  roomId: RoomId,
  role: UsageRecord['role'],
  usage: AssistantUsage,
): Promise<void> {
  for (const d of usage.records()) {
    await actions
      .recordUsage({ roomId, role, at: new Date().toISOString(), ...d })
      .catch(() => undefined);
  }
}

/** Iterate a query to completion and return its (last) result message. */
export async function drainQuery(
  q: AsyncIterable<SDKMessage>,
  onMessage?: (m: SDKMessage) => void,
): Promise<SDKResultMessage | null> {
  let result: SDKResultMessage | null = null;
  for await (const msg of q) {
    onMessage?.(msg);
    if (msg.type === 'result') result = msg;
  }
  return result;
}
