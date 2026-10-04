import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Change, Message, MessageId, OptionId, Proposal, RoomId, Sha, UserId } from '@quorum/shared';
import type { AgentRuntime, AgentRuntimeOptions, RoomActions, RoomRepository } from '../../contracts/index.js';
import { errMessage, noopLogger, resolveTunables, type Logger, type Tunables } from '../common.js';
import { Listener, type ListenerClient } from './listener.js';
import { Orchestrator } from './orchestrator.js';
import type { QueryFn } from './sdk.js';
import { runExploration, runMergeDriver, runSemanticRevert, writeDigest, type WorkerEnv } from './workers.js';
import type { ExplorationRequest } from './tools.js';

export interface ClaudeRuntimeOptions extends AgentRuntimeOptions {
  anthropicApiKey?: string;
  /** per-session spending cap handed to the Agent SDK (maxBudgetUsd) */
  maxBudgetUsd?: number;
}

export interface ClaudeRuntimeDeps {
  /** builds the Messages API client (tests inject a mock) */
  createClient?: (apiKey?: string) => ListenerClient;
  /** the Agent SDK query function (tests inject a mock) */
  queryFn?: QueryFn;
}

interface RoomRuntime {
  repo: RoomRepository;
  listener: Listener;
  orchestrator: Orchestrator;
  abort: AbortController;
}

export class ClaudeRuntime implements AgentRuntime {
  private readonly rooms = new Map<RoomId, Promise<RoomRuntime>>();
  private readonly log: Logger;
  private readonly tunables: Tunables;
  private readonly createClient: (apiKey?: string) => ListenerClient;
  private readonly queryFn: QueryFn;
  private listenerClient: ListenerClient | null = null;
  private readonly unhealthy = new Set<RoomId>();

  constructor(
    private readonly actions: RoomActions,
    private readonly options: ClaudeRuntimeOptions,
    deps: ClaudeRuntimeDeps = {},
  ) {
    this.log = options.logger ?? noopLogger;
    this.tunables = resolveTunables(options);
    this.createClient = deps.createClient ?? ((apiKey) => new Anthropic({ apiKey }) as unknown as ListenerClient);
    this.queryFn = deps.queryFn ?? query;
  }

  // --- lifecycle --------------------------------------------------------------------------

  startRoom(roomId: RoomId): Promise<void> {
    return this.room(roomId).then(
      () => undefined,
      (e) => this.log('error', 'startRoom failed', { roomId, error: errMessage(e) }),
    );
  }

  async stopRoom(roomId: RoomId): Promise<void> {
    const p = this.rooms.get(roomId);
    if (!p) return;
    this.rooms.delete(roomId);
    try {
      const r = await p;
      r.listener.stop();
      r.abort.abort();
      await r.orchestrator.stop();
    } catch (e) {
      this.log('warn', 'stopRoom failed', { roomId, error: errMessage(e) });
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((id) => this.stopRoom(id)));
  }

  private room(roomId: RoomId): Promise<RoomRuntime> {
    let p = this.rooms.get(roomId);
    if (!p) {
      p = this.createRoom(roomId);
      this.rooms.set(roomId, p);
      p.catch(() => this.rooms.delete(roomId));
    }
    return p;
  }

  private client(): ListenerClient {
    return (this.listenerClient ??= this.createClient(this.options.anthropicApiKey));
  }

  private workerEnv(roomId: RoomId, signal?: AbortSignal): WorkerEnv {
    return {
      roomId,
      actions: this.actions,
      queryFn: this.queryFn,
      logger: this.log,
      tunables: this.tunables,
      dataDir: this.options.dataDir,
      apiKey: this.options.anthropicApiKey,
      maxBudgetUsd: this.options.maxBudgetUsd,
      signal,
    };
  }

  private async createRoom(roomId: RoomId): Promise<RoomRuntime> {
    const repo = await this.actions.repo(roomId);
    const abort = new AbortController();
    const orchestrator = new Orchestrator({
      roomId,
      actions: this.actions,
      repo,
      queryFn: this.queryFn,
      tunables: this.tunables,
      logger: this.log,
      apiKey: this.options.anthropicApiKey,
      maxBudgetUsd: this.options.maxBudgetUsd,
      startExploration: (req: ExplorationRequest) => runExploration(this.workerEnv(roomId, abort.signal), repo, req),
    });
    const listener = new Listener({
      roomId,
      actions: this.actions,
      client: this.client(),
      tunables: this.options.tunables,
      logger: this.log,
      onIntents: ({ intents, messages }) => {
        for (const intent of intents) {
          const referenced = messages.filter((m) => intent.messageIds.includes(m.id));
          orchestrator.send({ type: 'intent', intent, messages: referenced.length > 0 ? referenced : messages });
        }
      },
      onHealth: (ok, detail) => {
        if (!ok && !this.unhealthy.has(roomId)) {
          this.unhealthy.add(roomId);
          void this.actions.setAgentStatus(roomId, 'unavailable', detail ?? 'The listener is failing').catch(() => undefined);
        } else if (ok && this.unhealthy.delete(roomId)) {
          void this.actions.setAgentStatus(roomId, 'idle', null).catch(() => undefined);
        }
      },
    });
    orchestrator.start();
    return { repo, listener, orchestrator, abort };
  }

  /** Run `fn` against the room's runtime; never throws. */
  private withRoom(roomId: RoomId, what: string, fn: (r: RoomRuntime) => void): void {
    this.room(roomId).then(fn).catch((e) => this.log('error', `${what} failed`, { roomId, error: errMessage(e) }));
  }

  // --- AgentRuntime: events ---------------------------------------------------------------

  onChatMessage(roomId: RoomId, message: Message): void {
    if (message.author.kind !== 'user') return;
    this.withRoom(roomId, 'onChatMessage', (r) => r.listener.push(message));
  }

  onSuggestion(roomId: RoomId, message: Message): void {
    this.withRoom(roomId, 'onSuggestion', (r) => r.orchestrator.send({ type: 'suggestion', message }));
  }

  onAsk(roomId: RoomId, message: Message): void {
    this.withRoom(roomId, 'onAsk', (r) => r.orchestrator.send({ type: 'ask', message }));
  }

  onProposalEvent(roomId: RoomId, event: Parameters<AgentRuntime['onProposalEvent']>[1]): void {
    this.withRoom(roomId, 'onProposalEvent', (r) => r.orchestrator.send({ type: 'proposal_event', event }));
  }

  onReverted(roomId: RoomId, change: Change, revertSha: Sha, byUserId: UserId): void {
    this.withRoom(roomId, 'onReverted', (r) => r.orchestrator.send({ type: 'revert', change, revertSha, byUserId }));
  }

  // --- one-shot sessions ------------------------------------------------------------------

  async runMergeDriver(
    roomId: RoomId,
    input: { proposal: Proposal; optionId: OptionId; worktreePath: string; conflictedFiles: string[]; documentPath: string },
  ): Promise<{ reconciled: boolean; summary: string }> {
    const r = await this.room(roomId);
    return runMergeDriver(this.workerEnv(roomId, r.abort.signal), input);
  }

  async runSemanticRevert(roomId: RoomId, input: { change: Change; byUserId: UserId }): Promise<Sha> {
    const r = await this.room(roomId);
    return runSemanticRevert(this.workerEnv(roomId, r.abort.signal), r.repo, input);
  }

  async writeDigest(roomId: RoomId, input: { userId: UserId; sinceMessageId: MessageId | null; events: string[] }): Promise<string> {
    const r = await this.room(roomId);
    return writeDigest(this.workerEnv(roomId, r.abort.signal), r.repo, input);
  }
}
