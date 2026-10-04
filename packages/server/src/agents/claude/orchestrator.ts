import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { EFFORT, MODELS, type Message, type RoomId } from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import {
  SIGN_IN_DETAIL,
  errMessage,
  noopLogger,
  sleep,
  type Logger,
  type Tunables,
} from '../common.js';
import { PRECOMPACT_REMINDER, REHYDRATE_PREAMBLE, orchestratorSystemPrompt } from '../prompts.js';
import type { StatusSink } from '../status.js';
import { eventLabel, formatEvent, formatRehydrate, type OrchestratorEvent } from './events.js';
import { makeCanUseTool } from './permissions.js';
import { ScratchWorktree, type Scratch } from './scratch.js';
import {
  UsageTracker,
  recordResultUsage,
  sandboxOptions,
  sdkProcessOptions,
  userMessage,
  type ClaudeProcessConfig,
  type QueryFn,
  type SdkQuery,
} from './sdk.js';
import {
  createQuorumServer,
  mcpToolNames,
  orchestratorTools,
  type ExplorationRequest,
} from './tools.js';

export const ORCHESTRATOR_BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

export interface RestartPolicy {
  /** restarts allowed within `windowMs` before the session cools down */
  max: number;
  windowMs: number;
  /** pause after too many restarts; then the session is tried again (the room shows as unavailable meanwhile) */
  cooldownMs: number;
  /** delay before the first restart; doubles with each consecutive one, up to `maxDelayMs` */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  max: 5,
  windowMs: 10 * 60_000,
  cooldownMs: 5 * 60_000,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export interface OrchestratorDeps {
  roomId: RoomId;
  actions: RoomActions;
  repo: RoomRepository;
  queryFn: QueryFn;
  tunables: Tunables;
  logger?: Logger;
  /** how the Claude Code subprocess is launched and authenticated (binary, credential environment, API key) */
  claude?: ClaudeProcessConfig;
  maxBudgetUsd?: number;
  /** the room's status board; without one the orchestrator reports nothing */
  status?: StatusSink;
  restart?: Partial<RestartPolicy>;
  /** how a temporary API failure (429, 5xx, overloaded) is retried */
  apiRetry?: Partial<ApiRetryPolicy>;
  /** starts exploration workers in the background; returns once they are started (their results come back as an
   *  exploration_finished event, sent to this orchestrator by whoever runs the workers) */
  startExploration: (req: ExplorationRequest) => Promise<unknown>;
  /** the session's working directory; by default the orchestrator creates its own scratch worktree at start() */
  scratch?: Scratch;
}

export interface ApiRetryPolicy {
  /** delay before the first retry of an event; doubles with each consecutive failure */
  baseMs: number;
  maxMs: number;
  /** an event that has been failing for this long is dropped (the room has moved on) */
  maxAgeMs: number;
}

export const DEFAULT_API_RETRY: ApiRetryPolicy = {
  baseMs: 5_000,
  maxMs: 2 * 60_000,
  maxAgeMs: 30 * 60_000,
};

/**
 * Builds the Agent SDK options for the room's orchestrator session. Exported for tests.
 *
 * The session works in `extra.scratch`, a worktree of its own: it never sees or touches the main worktree, so what it
 * edits cannot be swept into anyone else's commit, and it reaches main only through commit_main under the write queue.
 *
 * Nothing is pre-approved through `allowedTools`: tools listed there are auto-approved without consulting
 * `canUseTool` (the SDK warns about the overlap on every session start), and the whole policy lives in `canUseTool`:
 * restricted Bash, document-only writes, and exactly the in-process quorum tools.
 */
export function buildOrchestratorOptions(
  deps: OrchestratorDeps,
  hooks: { onCompact: () => void },
  abortController: AbortController,
  extra: {
    /** the session's working directory */
    scratch: Scratch;
    /** resume: continue this earlier session of the room instead of starting a fresh conversation */
    resume?: string;
  },
): Options {
  const status = deps.status;
  const scratch = extra.scratch;
  const tools = orchestratorTools({
    roomId: deps.roomId,
    actions: deps.actions,
    repo: deps.repo,
    scratch,
    logger: deps.logger ?? noopLogger,
    startExploration: deps.startExploration,
    immediateRewriteLimit: deps.tunables.immediateRewriteLimit,
    // the model may describe what it is doing; going idle is decided by the end of its turns, not by the model
    setStatus: status
      ? (s, detail) => status.busy('orchestrator', s === 'thinking' ? detail : null)
      : undefined,
  });
  const mcpNames = mcpToolNames(tools);
  return {
    model: MODELS.orchestrator,
    effort: EFFORT.orchestrator,
    cwd: scratch.dir,
    systemPrompt: orchestratorSystemPrompt(deps.tunables),
    tools: ORCHESTRATOR_BUILTIN_TOOLS,
    canUseTool: makeCanUseTool({
      cwd: scratch.dir,
      allowedMcpTools: mcpNames,
      writableRootMarkdown: true,
    }),
    mcpServers: { quorum: createQuorumServer(tools) },
    hooks: {
      PreCompact: [
        {
          hooks: [
            async () => {
              hooks.onCompact();
              return { systemMessage: PRECOMPACT_REMINDER };
            },
          ],
        },
      ],
    },
    maxBudgetUsd: deps.maxBudgetUsd,
    permissionMode: 'default',
    settingSources: [],
    abortController,
    ...(extra.resume ? { resume: extra.resume } : {}),
    ...sdkProcessOptions(deps.claude),
    ...sandboxOptions(scratch.dir, deps.claude),
  };
}

/** Assistant-message errors that mean the login, not the request, is the problem. */
const AUTH_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]);

/** Assistant-message errors that pass: the API said no for now (rate limit, overload, server error). */
const TRANSIENT_ERRORS = new Set(['rate_limit', 'overloaded', 'server_error']);
const TRANSIENT_TEXT =
  /\b(429|5\d\d)\b|overloaded|rate[ _-]?limit|server error|temporarily unavailable/i;

/** Queue bound while the session is down or busy: oldest events are dropped beyond it. */
const MAX_OUTBOX = 100;

const API_UNAVAILABLE_DETAIL = 'The Claude API is unavailable; retrying';
const API_RETRY_NOTE =
  '[note] The previous attempt at this event failed because the Claude API was temporarily unavailable (rate limit, overload or a server error), so it is being delivered again. Before acting, check the transcript and room state: part of it may already be done.';

/** A failed result that says the API, not the request, was the problem. */
function isTransientFailure(result: SDKResultMessage): boolean {
  if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd')
    return false;
  if (result.subtype === 'success' && !result.is_error) return false;
  const text = 'result' in result && typeof result.result === 'string' ? result.result : '';
  const errors = 'errors' in result && Array.isArray(result.errors) ? result.errors.join(' ') : '';
  return TRANSIENT_TEXT.test(`${text} ${errors}`);
}

const RESUME_NOTE =
  '[note] The agent process restarted and this conversation was resumed where it ended. Your earlier context is intact, but the room may have changed meanwhile: call get_room_state before acting.';

const REDELIVERY_NOTE =
  '[note] The previous agent session ended while this event was being handled, so it is being delivered again. Before acting, check the transcript and room state (for a suggestion, the card status) to see whether it was already handled.';

interface Turn {
  type: OrchestratorEvent['type'];
  text: string;
  label: string;
  redelivered: boolean;
  /** when the API first failed this event (temporary errors), for the give-up age */
  firstFailedAt?: number;
}

/**
 * One long-lived Agent SDK session per room. Events are queued as user turns on a streaming-input generator that
 * stays open until stop(). If the session ends unexpectedly it is restarted and rehydrated, and events that were
 * handed to the dead session without a result are delivered again (once).
 *
 * Events are handed over one at a time: the next one only after the previous one was answered. A turn therefore never
 * starts while another is still working in the session's scratch directory, which is reset to main's head between
 * turns. A turn that fails because the API is temporarily unavailable is retried with a backoff; the room shows the
 * agent as unavailable meanwhile and recovers by itself at the first clean turn.
 */
export class Orchestrator {
  private readonly log: Logger;
  private readonly policy: RestartPolicy;
  private readonly apiRetry: ApiRetryPolicy;
  /** the orchestrator's own working copy of main (see ScratchWorktree); created by the first session start */
  private scratch: Scratch | null;
  private readonly ownsScratch: boolean;
  /** usage totals of the session's conversation: it outlives a session that is resumed, and starts over with a fresh one */
  private usage = new UsageTracker();
  /** do not hand the next event over before this time (backoff after a temporary API failure) */
  private notBefore = 0;
  private apiFailures = 0;
  /** the current turn saw a temporary API error */
  private turnApiError = false;
  /** queued, not yet handed to the session */
  private readonly outbox: Turn[] = [];
  /** handed to the session, no result yet */
  private unacked: Turn[] = [];
  private wakers = new Set<() => void>();
  private stopped = false;
  private budgetExhausted = false;
  private needsRehydrate = true;
  /** the first turn of a resumed session carries RESUME_NOTE instead of a rehydrate block */
  private resumeNote = false;
  /** session id of the last clean result: where a restart tries to continue (PRD 12) before starting fresh */
  private resumeId: string | null = null;
  /** the current session has answered at least one turn cleanly */
  private answered = false;
  private compacted = false;
  private generation = 0;
  private current: SdkQuery | null = null;
  private runPromise: Promise<void> | null = null;
  private abort = new AbortController();
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.logger ?? noopLogger;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...(deps.restart ?? {}) };
    this.apiRetry = { ...DEFAULT_API_RETRY, ...(deps.apiRetry ?? {}) };
    this.scratch = deps.scratch ?? null;
    this.ownsScratch = !deps.scratch;
  }

  start(): void {
    if (this.runPromise) return;
    this.runPromise = this.runLoop().catch((e) => {
      this.log('error', 'orchestrator loop crashed', {
        roomId: this.deps.roomId,
        error: errMessage(e),
      });
    });
    this.expiryTimer = setInterval(() => {
      this.checkExpiry().catch((e) =>
        this.log('warn', 'expiry check failed', { roomId: this.deps.roomId, error: errMessage(e) }),
      );
    }, this.deps.tunables.expiryCheckMs);
    this.expiryTimer.unref?.();
  }

  /** Queue one event as a user turn. Never throws. */
  send(event: OrchestratorEvent): void {
    if (this.stopped) return;
    if (this.budgetExhausted) {
      this.log('warn', 'orchestrator budget exhausted; dropping event', {
        roomId: this.deps.roomId,
        type: event.type,
      });
      return;
    }
    let turn: Turn;
    try {
      const others = [...this.unacked, ...this.outbox].map((t) => t.label);
      turn = {
        type: event.type,
        text: formatEvent(event, others),
        label: eventLabel(event),
        redelivered: false,
      };
    } catch (e) {
      this.log('error', 'could not format an orchestrator event', {
        roomId: this.deps.roomId,
        type: event.type,
        error: errMessage(e),
      });
      return;
    }
    this.outbox.push(turn);
    while (this.outbox.length > MAX_OUTBOX) {
      const dropped = this.outbox.shift()!;
      this.log('warn', 'orchestrator queue full; dropping the oldest event', {
        roomId: this.deps.roomId,
        dropped: dropped.label,
      });
    }
    this.wakeUp();
  }

  /** Events not yet answered (queued or in the session); used to avoid piling up timer-driven checks. */
  get pendingCount(): number {
    return this.unacked.length + this.outbox.length;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    this.wakeUp();
    this.abort.abort();
    try {
      this.current?.close();
    } catch {
      /* already closed */
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.runPromise ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(timer);
    this.deps.status?.done('orchestrator');
    if (this.ownsScratch) await this.scratch?.dispose?.();
  }

  private wakeUp(): void {
    for (const w of [...this.wakers]) w();
  }

  /** Resolves at the next wakeUp(), or after `timeoutMs`. */
  private waitForWake(timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      this.wakers.add(done);
      if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
    });
  }

  private async ensureScratch(): Promise<Scratch> {
    this.scratch ??= await ScratchWorktree.create(this.deps.repo);
    return this.scratch;
  }

  /** The scratch directory follows main at the start of every turn: yesterday's half-finished edit is gone. */
  private async resetScratch(): Promise<void> {
    try {
      await this.scratch?.reset();
    } catch (e) {
      this.log('warn', 'could not reset the orchestrator working directory', {
        roomId: this.deps.roomId,
        error: errMessage(e),
      });
    }
  }

  /**
   * The 5 minute expiry timer (PRD 7.4). While any proposal is open, every tick asks the orchestrator to judge them:
   * the answer depends on elapsed time (no vote for a sustained period), not only on what changed, so an unchanged room
   * is asked again at the same cadence. At most one check is queued at a time, and with nothing open a tick costs one
   * state read and no model turn.
   */
  private async checkExpiry(): Promise<void> {
    if (this.stopped || this.budgetExhausted) return;
    if ([...this.unacked, ...this.outbox].some((t) => t.type === 'expiry_check')) return;
    const state = await this.deps.actions.getRoomState(this.deps.roomId);
    const open = state.proposals.filter((p) => p.state === 'open');
    if (open.length === 0) return;
    this.send({ type: 'expiry_check', proposals: open, now: new Date().toISOString() });
  }

  private async preamble(): Promise<string> {
    const parts: string[] = [];
    if (this.needsRehydrate) {
      this.needsRehydrate = false;
      try {
        const [state, messages] = await Promise.all([
          this.deps.actions.getRoomState(this.deps.roomId),
          this.deps.actions.readTranscript(this.deps.roomId, {
            limit: this.deps.tunables.rehydrateMessages,
          }),
        ]);
        parts.push(formatRehydrate(REHYDRATE_PREAMBLE, state, messages as Message[]));
      } catch (e) {
        parts.push(
          `[event:rehydrate]\n${REHYDRATE_PREAMBLE}\n(room state unavailable: ${errMessage(e)}; call get_room_state)`,
        );
      }
    }
    if (this.resumeNote) {
      this.resumeNote = false;
      parts.push(RESUME_NOTE);
    }
    if (this.compacted) {
      this.compacted = false;
      parts.push(`[note] ${PRECOMPACT_REMINDER}`);
    }
    return parts.join('\n\n');
  }

  /**
   * Streaming input: yields queued events one user turn at a time and stays open until stop() or restart. An event is
   * handed over only when the previous one has been answered and any retry backoff has passed.
   */
  private async *input(gen: number): AsyncGenerator<SDKUserMessage> {
    while (!this.stopped && gen === this.generation) {
      const turn = this.outbox[0];
      if (!turn || this.unacked.length > 0) {
        await this.waitForWake();
        continue;
      }
      const backoff = this.notBefore - Date.now();
      if (backoff > 0) {
        await this.waitForWake(backoff);
        continue;
      }
      this.outbox.shift();
      // Counted as handed over before anything is awaited: if the session dies from here on, the event is re-delivered.
      this.unacked.push(turn);
      this.deps.status?.busy('orchestrator');
      await this.resetScratch();
      const pre = await this.preamble();
      if (this.stopped || gen !== this.generation) return;
      yield userMessage(pre ? `${pre}\n\n${turn.text}` : turn.text);
    }
  }

  /** Events the dead session never answered go back to the front of the queue, once. */
  private requeueUnacked(): void {
    const lost = this.unacked.splice(0);
    if (lost.length === 0) return;
    const again = lost
      .filter((t) => !t.redelivered)
      .map((t) => ({ ...t, redelivered: true, text: `${t.text}\n\n${REDELIVERY_NOTE}` }));
    const dropped = lost.length - again.length;
    if (dropped > 0)
      this.log('warn', 'dropping events that failed twice', {
        roomId: this.deps.roomId,
        count: dropped,
      });
    this.outbox.unshift(...again);
  }

  private async runLoop(): Promise<void> {
    const restarts: number[] = [];
    while (!this.stopped && !this.budgetExhausted) {
      const gen = ++this.generation;
      const resume = this.resumeId;
      // A resumed session's first result carries the totals saved with its conversation, which this tracker has seen;
      // a fresh session starts again from zero.
      if (!resume) this.usage = new UsageTracker();
      this.answered = false;
      this.turnApiError = false;
      let launched = false;
      try {
        const scratch = await this.ensureScratch();
        if (this.stopped) break;
        const q = this.deps.queryFn({
          prompt: this.input(gen),
          options: buildOrchestratorOptions(
            this.deps,
            { onCompact: () => (this.compacted = true) },
            this.abort,
            { resume: resume ?? undefined, scratch },
          ),
        });
        this.current = q;
        launched = true;
        for await (const msg of q) await this.onMessage(msg);
      } catch (e) {
        if (!this.stopped)
          this.log('error', 'orchestrator session failed', {
            roomId: this.deps.roomId,
            error: errMessage(e),
          });
      } finally {
        this.current = null;
      }
      if (this.stopped || this.budgetExhausted) break;

      // The session ended on its own. Restart it: first by resuming the conversation (PRD 12), and when a resumed
      // session dies without answering anything, fresh and rehydrated from room state and the transcript. Events the
      // dead session never answered are handed to the new one.
      this.requeueUnacked();
      // (a failure before the session even started, such as the working directory, says nothing about resuming it)
      if (resume && launched && !this.answered) {
        this.log('warn', 'resuming the orchestrator session failed; starting fresh', {
          roomId: this.deps.roomId,
        });
        this.resumeId = null;
      }
      this.needsRehydrate = this.resumeId === null;
      this.resumeNote = this.resumeId !== null;
      const now = Date.now();
      restarts.push(now);
      while (restarts.length > 0 && now - restarts[0]! > this.policy.windowMs) restarts.shift();
      if (restarts.length > this.policy.max) {
        // Keep trying, slowly: PRD 12 wants queued events processed once the API recovers.
        this.log('error', 'orchestrator restarting too often; cooling down', {
          roomId: this.deps.roomId,
          cooldownMs: this.policy.cooldownMs,
        });
        this.deps.status?.done('orchestrator');
        this.deps.status?.fail('orchestrator', 'The agent session keeps failing');
        await sleep(this.policy.cooldownMs, this.abort.signal);
        restarts.length = 0;
        continue;
      }
      this.log('warn', 'orchestrator session ended unexpectedly; restarting', {
        roomId: this.deps.roomId,
        restarts: restarts.length,
      });
      this.deps.status?.done('orchestrator');
      await sleep(
        Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (restarts.length - 1)),
        this.abort.signal,
      );
    }
  }

  private async onMessage(msg: SDKMessage): Promise<void> {
    if (msg.type === 'assistant' && msg.error) {
      this.log('warn', 'orchestrator got an API error', {
        roomId: this.deps.roomId,
        error: msg.error,
      });
      if (AUTH_ERRORS.has(msg.error)) this.deps.status?.fail('auth', SIGN_IN_DETAIL);
      else if (msg.error === 'billing_error')
        this.deps.status?.fail('billing', 'The Claude account has a billing problem');
      else if (TRANSIENT_ERRORS.has(msg.error)) this.turnApiError = true;
      return;
    }
    if (msg.type !== 'result') return;
    await this.onResult(msg);
  }

  /**
   * The turn failed because the API is temporarily unavailable (429, 5xx, overloaded): the event goes back to the front
   * of the queue to be handed over again after a backoff that doubles with each consecutive failure, and the room shows
   * the agent as unavailable until a turn succeeds. An event that has kept failing for `maxAgeMs` is dropped.
   */
  private retryAfterApiFailure(): void {
    const turn = this.unacked.shift();
    this.unacked = [];
    this.apiFailures += 1;
    const delay = Math.min(
      this.apiRetry.maxMs,
      this.apiRetry.baseMs * 2 ** Math.min(this.apiFailures - 1, 20),
    );
    this.notBefore = Date.now() + delay;
    this.deps.status?.done('orchestrator');
    this.deps.status?.fail('api', API_UNAVAILABLE_DETAIL);
    if (turn) {
      const firstFailedAt = turn.firstFailedAt ?? Date.now();
      if (Date.now() - firstFailedAt > this.apiRetry.maxAgeMs) {
        this.log('warn', 'dropping an event that the API kept failing', {
          roomId: this.deps.roomId,
          event: turn.label,
        });
        if (this.outbox.length === 0) this.deps.status?.recover('api');
      } else {
        this.outbox.unshift({
          ...turn,
          firstFailedAt,
          text: turn.text.includes(API_RETRY_NOTE)
            ? turn.text
            : `${turn.text}\n\n${API_RETRY_NOTE}`,
        });
      }
    }
    this.log('warn', 'orchestrator turn failed with a temporary API error; retrying', {
      roomId: this.deps.roomId,
      attempt: this.apiFailures,
      delayMs: delay,
    });
    this.wakeUp();
  }

  private async onResult(result: SDKResultMessage): Promise<void> {
    await recordResultUsage(
      this.deps.actions,
      this.deps.roomId,
      'orchestrator',
      result,
      this.usage,
      MODELS.orchestrator,
    );
    const sawApiError = this.turnApiError;
    this.turnApiError = false;
    if (result.subtype === 'error_max_budget_usd') {
      this.budgetExhausted = true;
      this.log('error', 'orchestrator hit its budget', {
        roomId: this.deps.roomId,
        cost: result.total_cost_usd,
      });
      this.unacked = [];
      this.deps.status?.done('orchestrator');
      this.deps.status?.fail('orchestrator', 'The agent has reached its spending limit');
      this.wakeUp();
      try {
        this.current?.close();
      } catch {
        /* already closed */
      }
      return;
    }
    const failed = result.subtype !== 'success' || result.is_error;
    if (failed && (sawApiError || isTransientFailure(result))) {
      this.retryAfterApiFailure();
      return;
    }
    if (failed) {
      this.log('warn', 'orchestrator turn ended with an error', {
        roomId: this.deps.roomId,
        subtype: result.subtype,
      });
    } else {
      // a clean turn: whatever was wrong is over, and this session is worth resuming if the process dies
      for (const key of ['auth', 'billing', 'api', 'orchestrator']) this.deps.status?.recover(key);
      this.apiFailures = 0;
      this.notBefore = 0;
      this.answered = true;
      this.resumeId = result.session_id;
    }
    // queued_turn_count 0: everything handed over so far is answered; otherwise one more result is coming per queued turn
    if ((result.queued_turn_count ?? 0) === 0) this.unacked = [];
    else this.unacked.shift();
    if (this.unacked.length === 0 && this.outbox.length === 0)
      this.deps.status?.done('orchestrator');
    // the next event can be handed over now
    this.wakeUp();
  }
}
