import type { ActorRef, Document, Message } from '@quorum/shared';
import { DEFAULTS, MODELS } from '@quorum/shared';
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

/** Message and proposal ids end up in commit trailers (Quorum-Trigger, Quorum-Proposal): only well-formed ones may. */
const MESSAGE_ID = /^msg_[A-Za-z0-9]+$/;
const PROPOSAL_ID = /^prop_[A-Za-z0-9]+$/;

/** Splits model-supplied message ids into the well-formed ones (in order, without duplicates) and the rest. */
export function splitMessageIds(ids: readonly string[] | undefined): {
  valid: string[];
  rejected: string[];
} {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const id of ids ?? []) {
    if (MESSAGE_ID.test(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else rejected.push(id);
  }
  return { valid, rejected };
}

export function isProposalId(id: unknown): id is string {
  return typeof id === 'string' && PROPOSAL_ID.test(id);
}

/** Shows rejected ids in a tool result without letting a long or odd one flood it. */
export function describeRejectedIds(ids: readonly string[]): string {
  return ids.map((id) => JSON.stringify(id.length > 40 ? `${id.slice(0, 39)}…` : id)).join(', ');
}

/** True when text contains git conflict markers (start or end marker on a line of its own). */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?:\s|$)/m.test(text) || /^>{7}(?:\s|$)/m.test(text);
}

/** Spending cap of one digest writer session: a short summary of a few messages. */
export const DIGEST_BUDGET_USD = 0.5;

/**
 * Per-session cap for an exploration or research worker. Several run at once and each is its own `query()` call (whose
 * cap counts only its own spend), so they get a share of the configured cap: a quarter by default, at least $1 and never
 * more than the cap itself. `undefined` (no cap configured) stays uncapped.
 */
export function workerBudgetUsd(cap: number | undefined, override?: number): number | undefined {
  if (override !== undefined) return override;
  if (cap === undefined) return undefined;
  return Math.min(cap, Math.max(1, cap / 4));
}

/** Agent status detail shown to the room while the server has no usable Claude credential. */
export const SIGN_IN_DETAIL = 'Sign in to Claude in Settings';

/** USD per million tokens (PRD section 9). Cache writes are billed at 1.25x the input price. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const SONNET_PRICE: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
export const OPUS_PRICE: Price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

/** List price for a model id, or null when the model is not one of the tiers in the PRD. */
export function priceFor(model: string): Price | null {
  if (model === MODELS.orchestrator || model.startsWith('claude-opus')) return OPUS_PRICE;
  if (model === MODELS.listener || model.startsWith('claude-sonnet')) return SONNET_PRICE;
  return null;
}

/** Estimated cost from token counts; 0 for models without a known price. Used when the SDK reports no cost. */
export function estimateCostUsd(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}

/**
 * Plain-text digest built from the notable events alone. Used when the digest writer cannot run (no Claude
 * credential) or fails, so a returning participant still learns what happened.
 */
export function fallbackDigest(events: string[]): string {
  const lines = ['While you were away:'];
  if (events.length === 0) lines.push('- Nothing notable was recorded.');
  for (const e of events) lines.push(`- ${e}`);
  return lines.join('\n');
}
