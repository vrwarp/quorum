import type { ActorRef, Document, Message } from '@quorum/shared';
import { DEFAULTS } from '@quorum/shared';
import type { AgentRuntimeOptions } from '../contracts/index.js';

export type Logger = NonNullable<AgentRuntimeOptions['logger']>;
export const noopLogger: Logger = () => {};

export type Tunables = typeof DEFAULTS;

export function resolveTunables(options: AgentRuntimeOptions): Tunables {
  return { ...DEFAULTS, ...(options.tunables ?? {}) } as Tunables;
}

export const ORCHESTRATOR_ACTOR: ActorRef = { kind: 'agent', role: 'orchestrator' };
export const WORKER_ACTOR: ActorRef = { kind: 'agent', role: 'worker' };
export const MERGE_ACTOR: ActorRef = { kind: 'agent', role: 'merge' };

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      done();
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function authorName(m: Pick<Message, 'author'>): string {
  return m.author.kind === 'user' ? m.author.displayName : `agent:${m.author.role}`;
}

export function authorUserId(m: Pick<Message, 'author'>): string | null {
  return m.author.kind === 'user' ? m.author.userId : null;
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function activeDocs<T extends Document>(docs: T[]): T[] {
  return docs.filter((d) => d.status === 'active');
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** True when text contains git conflict markers (start or end marker on a line of its own). */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?:\s|$)/m.test(text) || /^>{7}(?:\s|$)/m.test(text);
}
