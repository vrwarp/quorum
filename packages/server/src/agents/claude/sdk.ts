import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { RoomId, UsageRecord } from '@quorum/shared';
import type { RoomActions } from '../../contracts/index.js';

/** The Agent SDK `query` function; injected so tests never spawn a process. */
export type QueryFn = typeof query;
export type SdkQuery = ReturnType<QueryFn>;

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/** Environment for the Claude Code subprocess: inherit, plus the API key when one was configured. */
export function sdkEnv(apiKey?: string): Options['env'] | undefined {
  return apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : undefined;
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

/**
 * Result messages carry totals that are cumulative for the query() call (and per-model). This turns them
 * into per-result deltas so usage is recorded once.
 */
export class UsageTracker {
  private seen = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();

  deltas(result: SDKResultMessage): Array<Omit<UsageRecord, 'roomId' | 'role' | 'at'> & { sessionId: string }> {
    const out: Array<Omit<UsageRecord, 'roomId' | 'role' | 'at'> & { sessionId: string }> = [];
    for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
      const prev = this.seen.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const cur = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheWrite: u.cacheCreationInputTokens ?? 0,
        cost: u.costUSD ?? 0,
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
): Promise<void> {
  for (const d of tracker.deltas(result)) {
    await actions.recordUsage({ roomId, role, at: new Date().toISOString(), ...d }).catch(() => undefined);
  }
}

/** Iterate a query to completion and return its (last) result message. */
export async function drainQuery(q: AsyncIterable<SDKMessage>, onMessage?: (m: SDKMessage) => void): Promise<SDKResultMessage | null> {
  let result: SDKResultMessage | null = null;
  for await (const msg of q) {
    onMessage?.(msg);
    if (msg.type === 'result') result = msg;
  }
  return result;
}
