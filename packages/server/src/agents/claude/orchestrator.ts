import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT, MODELS, type Message, type RoomId } from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import { errMessage, noopLogger, sleep, type Logger, type Tunables } from '../common.js';
import { PRECOMPACT_REMINDER, REHYDRATE_PREAMBLE, orchestratorSystemPrompt } from '../prompts.js';
import { eventLabel, formatEvent, formatRehydrate, type OrchestratorEvent } from './events.js';
import { makeCanUseTool } from './permissions.js';
import { UsageTracker, recordResultUsage, sdkEnv, userMessage, type QueryFn, type SdkQuery } from './sdk.js';
import { createQuorumServer, mcpToolNames, orchestratorTools, type ExplorationRequest } from './tools.js';

export const ORCHESTRATOR_BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

export interface OrchestratorDeps {
  roomId: RoomId;
  actions: RoomActions;
  repo: RoomRepository;
  queryFn: QueryFn;
  tunables: Tunables;
  logger?: Logger;
  apiKey?: string;
  maxBudgetUsd?: number;
  startExploration: (req: ExplorationRequest) => Promise<unknown>;
}

/**
 * Builds the Agent SDK options for the room's orchestrator session. Exported for tests.
 *
 * Built-in tools are made available through `tools` but deliberately NOT through `allowedTools`: tools listed in
 * `allowedTools` are auto-approved without consulting `canUseTool`, and the Bash/Edit/Write policy lives in
 * `canUseTool`. Only the in-process MCP tools are pre-approved.
 */
export function buildOrchestratorOptions(deps: OrchestratorDeps, hooks: { onCompact: () => void }, abortController: AbortController): Options {
  const tools = orchestratorTools({
    roomId: deps.roomId,
    actions: deps.actions,
    repo: deps.repo,
    logger: deps.logger ?? noopLogger,
    startExploration: deps.startExploration,
  });
  const mcpNames = mcpToolNames(tools);
  return {
    model: MODELS.orchestrator,
    effort: EFFORT.orchestrator,
    cwd: deps.repo.mainWorktree,
    systemPrompt: orchestratorSystemPrompt(deps.tunables),
    tools: ORCHESTRATOR_BUILTIN_TOOLS,
    allowedTools: mcpNames,
    canUseTool: makeCanUseTool({ cwd: deps.repo.mainWorktree, allowedMcpTools: mcpNames }),
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
    env: sdkEnv(deps.apiKey),
  };
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

/**
 * One long-lived Agent SDK session per room. Events are queued as user turns on a streaming-input generator that
 * stays open until stop(). If the session ends unexpectedly it is restarted and rehydrated.
 */
export class Orchestrator {
  private readonly log: Logger;
  private readonly outbox: string[] = [];
  private inFlight: string[] = [];
  private wakers = new Set<() => void>();
  private stopped = false;
  private budgetExhausted = false;
  private needsRehydrate = true;
  private compacted = false;
  private turnsInFlight = 0;
  private generation = 0;
  private current: SdkQuery | null = null;
  private runPromise: Promise<void> | null = null;
  private abort = new AbortController();
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.logger ?? noopLogger;
  }

  start(): void {
    if (this.runPromise) return;
    this.runPromise = this.runLoop();
    this.expiryTimer = setInterval(() => void this.checkExpiry(), this.deps.tunables.expiryCheckMs);
    this.expiryTimer.unref?.();
  }

  /** Queue one event as a user turn. */
  send(event: OrchestratorEvent): void {
    if (this.stopped) return;
    if (this.budgetExhausted) {
      this.log('warn', 'orchestrator budget exhausted; dropping event', { roomId: this.deps.roomId, type: event.type });
      return;
    }
    const others = [...this.inFlight];
    this.inFlight.push(eventLabel(event));
    this.outbox.push(formatEvent(event, others));
    this.wakeUp();
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
    await Promise.race([this.runPromise ?? Promise.resolve(), sleep(3000)]);
  }

  private wakeUp(): void {
    const ws = [...this.wakers];
    this.wakers.clear();
    for (const w of ws) w();
  }

  private async checkExpiry(): Promise<void> {
    if (this.stopped || this.budgetExhausted) return;
    try {
      const state = await this.deps.actions.getRoomState(this.deps.roomId);
      const open = state.proposals.filter((p) => p.state === 'open');
      if (open.length > 0) this.send({ type: 'expiry_check', proposals: open, now: new Date().toISOString() });
    } catch (e) {
      this.log('warn', 'expiry check failed', { roomId: this.deps.roomId, error: errMessage(e) });
    }
  }

  private setStatus(status: 'idle' | 'thinking' | 'unavailable', detail: string | null = null): void {
    void this.deps.actions.setAgentStatus(this.deps.roomId, status, detail).catch(() => undefined);
  }

  private async preamble(): Promise<string> {
    const parts: string[] = [];
    if (this.needsRehydrate) {
      this.needsRehydrate = false;
      try {
        const [state, messages] = await Promise.all([
          this.deps.actions.getRoomState(this.deps.roomId),
          this.deps.actions.readTranscript(this.deps.roomId, { limit: this.deps.tunables.rehydrateMessages }),
        ]);
        parts.push(formatRehydrate(REHYDRATE_PREAMBLE, state, messages as Message[]));
      } catch (e) {
        parts.push(`[event:rehydrate]\n${REHYDRATE_PREAMBLE}\n(room state unavailable: ${errMessage(e)}; call get_room_state)`);
      }
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
      if (this.outbox.length === 0) {
        await new Promise<void>((resolve) => {
          this.wakers.add(resolve);
        });
        continue;
      }
      const text = this.outbox.shift()!;
      const pre = await this.preamble();
      this.turnsInFlight++;
      if (this.turnsInFlight === 1) this.setStatus('thinking');
      yield userMessage(pre ? `${pre}\n\n${text}` : text);
    }
  }

  private async runLoop(): Promise<void> {
    const restarts: number[] = [];
    while (!this.stopped && !this.budgetExhausted) {
      const gen = ++this.generation;
      const tracker = new UsageTracker();
      try {
        const q = this.deps.queryFn({
          prompt: this.input(gen),
          options: buildOrchestratorOptions(this.deps, { onCompact: () => (this.compacted = true) }, this.abort),
        });
        this.current = q;
        for await (const msg of q) await this.onMessage(msg, tracker);
      } catch (e) {
        if (!this.stopped) this.log('error', 'orchestrator session failed', { roomId: this.deps.roomId, error: errMessage(e) });
      } finally {
        this.current = null;
      }
      if (this.stopped || this.budgetExhausted) break;

      const now = Date.now();
      restarts.push(now);
      while (restarts.length > 0 && now - restarts[0]! > RESTART_WINDOW_MS) restarts.shift();
      if (restarts.length > MAX_RESTARTS) {
        this.log('error', 'orchestrator restarting too often; giving up', { roomId: this.deps.roomId });
        this.setStatus('unavailable', 'The agent session keeps failing');
        break;
      }
      this.log('warn', 'orchestrator session ended unexpectedly; restarting', { roomId: this.deps.roomId });
      this.needsRehydrate = true;
      this.turnsInFlight = 0;
      this.setStatus('idle');
      await sleep(Math.min(30_000, 1000 * 2 ** (restarts.length - 1)), this.abort.signal);
    }
  }

  private async onMessage(msg: SDKMessage, tracker: UsageTracker): Promise<void> {
    if (msg.type !== 'result') return;
    await this.onResult(msg, tracker);
  }

  private async onResult(result: SDKResultMessage, tracker: UsageTracker): Promise<void> {
    await recordResultUsage(this.deps.actions, this.deps.roomId, 'orchestrator', result, tracker);
    if (result.subtype === 'error_max_budget_usd') {
      this.budgetExhausted = true;
      this.log('error', 'orchestrator hit its budget', { roomId: this.deps.roomId, cost: result.total_cost_usd });
      this.setStatus('unavailable', 'The agent has reached its spending limit');
      this.wakeUp();
      try {
        this.current?.close();
      } catch {
        /* already closed */
      }
      return;
    }
    if (result.subtype !== 'success' || result.is_error) {
      this.log('warn', 'orchestrator turn ended with an error', { roomId: this.deps.roomId, subtype: result.subtype });
    }
    if ((result.queued_turn_count ?? 0) === 0 && this.outbox.length === 0) {
      this.turnsInFlight = 0;
      this.inFlight = [];
      this.setStatus('idle');
    } else {
      this.turnsInFlight = Math.max(0, this.turnsInFlight - 1);
      this.inFlight.shift();
    }
  }
}
