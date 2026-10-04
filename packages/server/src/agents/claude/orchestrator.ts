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
import {
  UsageTracker,
  recordResultUsage,
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
  startExploration: (req: ExplorationRequest) => Promise<unknown>;
}

/**
 * Builds the Agent SDK options for the room's orchestrator session. Exported for tests.
 *
 * Nothing is pre-approved through `allowedTools`: tools listed there are auto-approved without consulting
 * `canUseTool` (the SDK warns about the overlap on every session start), and the whole policy lives in `canUseTool`:
 * restricted Bash, document-only writes, and exactly the in-process quorum tools.
 */
export function buildOrchestratorOptions(
  deps: OrchestratorDeps,
  hooks: { onCompact: () => void },
  abortController: AbortController,
  /** resume: continue this earlier session of the room instead of starting a fresh conversation */
  extra: { resume?: string } = {},
): Options {
  const status = deps.status;
  const tools = orchestratorTools({
    roomId: deps.roomId,
    actions: deps.actions,
    repo: deps.repo,
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
    cwd: deps.repo.mainWorktree,
    systemPrompt: orchestratorSystemPrompt(deps.tunables),
    tools: ORCHESTRATOR_BUILTIN_TOOLS,
    canUseTool: makeCanUseTool({
      cwd: deps.repo.mainWorktree,
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

/** Queue bound while the session is down or busy: oldest events are dropped beyond it. */
const MAX_OUTBOX = 100;
/** Unchanged open proposals are re-checked for expiry at most every this many timer ticks. */
const UNCHANGED_EXPIRY_TICKS = 6;

const RESUME_NOTE =
  '[note] The agent process restarted and this conversation was resumed where it ended. Your earlier context is intact, but the room may have changed meanwhile: call get_room_state before acting.';

const REDELIVERY_NOTE =
  '[note] The previous agent session ended while this event was being handled, so it is being delivered again. Before acting, check the transcript and room state (for a suggestion, the card status) to see whether it was already handled.';

interface Turn {
  type: OrchestratorEvent['type'];
  text: string;
  label: string;
  redelivered: boolean;
}

/**
 * One long-lived Agent SDK session per room. Events are queued as user turns on a streaming-input generator that
 * stays open until stop(). If the session ends unexpectedly it is restarted and rehydrated, and events that were
 * handed to the dead session without a result are delivered again (once).
 */
export class Orchestrator {
  private readonly log: Logger;
  private readonly policy: RestartPolicy;
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
  private lastExpiry: { signature: string; at: number } | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.logger ?? noopLogger;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...(deps.restart ?? {}) };
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
  }

  private wakeUp(): void {
    const ws = [...this.wakers];
    this.wakers.clear();
    for (const w of ws) w();
  }

  /**
   * The 5 minute expiry timer (PRD 7.4). At most one check is queued at a time, and unchanged proposals (same votes,
   * no new chat) are only re-checked every few ticks: the model's answer depends on elapsed time, not on being asked
   * every five minutes, and each check is an Opus turn.
   */
  private async checkExpiry(): Promise<void> {
    if (this.stopped || this.budgetExhausted) return;
    if ([...this.unacked, ...this.outbox].some((t) => t.type === 'expiry_check')) return;
    const state = await this.deps.actions.getRoomState(this.deps.roomId);
    const open = state.proposals.filter((p) => p.state === 'open');
    if (open.length === 0) {
      this.lastExpiry = null;
      return;
    }
    const signature = JSON.stringify([
      open.map((p) => [p.id, p.votes.length]),
      state.recentMessages.at(-1)?.id ?? null,
    ]);
    const now = Date.now();
    if (
      this.lastExpiry &&
      this.lastExpiry.signature === signature &&
      now - this.lastExpiry.at < this.deps.tunables.expiryCheckMs * UNCHANGED_EXPIRY_TICKS
    )
      return;
    this.lastExpiry = { signature, at: now };
    this.send({ type: 'expiry_check', proposals: open, now: new Date(now).toISOString() });
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

  /** Streaming input: yields queued events one user turn at a time and stays open until stop() or restart. */
  private async *input(gen: number): AsyncGenerator<SDKUserMessage> {
    while (!this.stopped && gen === this.generation) {
      const turn = this.outbox.shift();
      if (!turn) {
        await new Promise<void>((resolve) => {
          this.wakers.add(resolve);
        });
        continue;
      }
      // Counted as handed over before anything is awaited: if the session dies from here on, the event is re-delivered.
      this.unacked.push(turn);
      if (this.unacked.length === 1) this.deps.status?.busy('orchestrator');
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
      const tracker = new UsageTracker();
      const resume = this.resumeId;
      this.answered = false;
      try {
        const q = this.deps.queryFn({
          prompt: this.input(gen),
          options: buildOrchestratorOptions(
            this.deps,
            { onCompact: () => (this.compacted = true) },
            this.abort,
            { resume: resume ?? undefined },
          ),
        });
        this.current = q;
        for await (const msg of q) await this.onMessage(msg, tracker);
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
      if (resume && !this.answered) {
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

  private async onMessage(msg: SDKMessage, tracker: UsageTracker): Promise<void> {
    if (msg.type === 'assistant' && msg.error) {
      this.log('warn', 'orchestrator got an API error', {
        roomId: this.deps.roomId,
        error: msg.error,
      });
      if (AUTH_ERRORS.has(msg.error)) this.deps.status?.fail('auth', SIGN_IN_DETAIL);
      else if (msg.error === 'billing_error')
        this.deps.status?.fail('billing', 'The Claude account has a billing problem');
      return;
    }
    if (msg.type !== 'result') return;
    await this.onResult(msg, tracker);
  }

  private async onResult(result: SDKResultMessage, tracker: UsageTracker): Promise<void> {
    await recordResultUsage(
      this.deps.actions,
      this.deps.roomId,
      'orchestrator',
      result,
      tracker,
      MODELS.orchestrator,
    );
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
    if (result.subtype !== 'success' || result.is_error) {
      this.log('warn', 'orchestrator turn ended with an error', {
        roomId: this.deps.roomId,
        subtype: result.subtype,
      });
    } else {
      // a clean turn: whatever was wrong is over, and this session is worth resuming if the process dies
      for (const key of ['auth', 'billing', 'orchestrator']) this.deps.status?.recover(key);
      this.answered = true;
      this.resumeId = result.session_id;
    }
    // queued_turn_count 0: everything handed over so far is answered; otherwise one more result is coming per queued turn
    if ((result.queued_turn_count ?? 0) === 0) this.unacked = [];
    else this.unacked.shift();
    if (this.unacked.length === 0 && this.outbox.length === 0)
      this.deps.status?.done('orchestrator');
  }
}
