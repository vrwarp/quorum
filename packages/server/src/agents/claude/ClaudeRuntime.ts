import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Change,
  Message,
  MessageId,
  OptionId,
  Proposal,
  RoomId,
  Sha,
  UserId,
} from '@quorum/shared';
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RoomActions,
  RoomRepository,
} from '../../contracts/index.js';
import {
  DIGEST_BUDGET_USD,
  SIGN_IN_DETAIL,
  errMessage,
  fallbackDigest,
  noopLogger,
  resolveTunables,
  workerBudgetUsd,
  type Logger,
  type Tunables,
} from '../common.js';
import { StatusBoard } from '../status.js';
import { Listener, type ListenerBatch, type ListenerClient } from './listener.js';
import { Orchestrator } from './orchestrator.js';
import { createSdkListenerClient } from './sdkListener.js';
import type { ClaudeProcessConfig, QueryFn, SandboxMode } from './sdk.js';
import { tryApplySuggestion, type SuggestionOutcome } from './suggestions.js';
import type { ExplorationRequest } from './tools.js';
import {
  runMergeDriver,
  runSemanticRevert,
  startExploration,
  writeDigest,
  type WorkerEnv,
} from './workers.js';

export interface ClaudeRuntimeOptions extends AgentRuntimeOptions {
  /** API key for the listener's Messages API calls and for the Claude Code subprocess */
  anthropicApiKey?: string;
  /**
   * Per-session spending cap handed to the Agent SDK (maxBudgetUsd). The SDK counts a cap per `query()` call, so this is
   * a cap per session, not per room: the orchestrator, the merge driver and the semantic revert get it whole,
   * exploration workers a share of it (workerBudgetUsd) and the digest writer a small fixed one. There is no per-room
   * ledger yet.
   */
  maxBudgetUsd?: number;
  /** Per-session cap of an exploration or research worker. Default: a quarter of maxBudgetUsd, at least $1. */
  workerBudgetUsd?: number;
  /** Bash isolation in agent sessions: 'auto' (default; needs bubblewrap on Linux, runs unsandboxed with a warning without it), 'required' or 'off'. */
  sandbox?: SandboxMode;
  /**
   * A room's sessions (orchestrator process, listener, timers) are stopped after this long with nobody connected and
   * nothing in flight, and started again by the next event. Default 15 minutes; 0 keeps every room running.
   */
  idleAfterMs?: number;
  /** How often rooms are checked for idleness (default 30 s). */
  idleCheckMs?: number;
  /** Claude Code executable the Agent SDK spawns (`pathToClaudeCodeExecutable`); omit for the SDK's bundled binary */
  claudeBinary?: string;
  /** Credential environment added to every Claude Code subprocess (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN). Read at each query(). */
  claudeEnv?: () => Record<string, string>;
  /** Whether a Claude credential is usable. While false the agent is unavailable and does no model work. Omit to assume it is. */
  claudeAvailable?: () => Promise<boolean>;
  /** Subscribe to sign-in / sign-out. The runtime calls its listener with no arguments; a returned function unsubscribes. */
  onCredentialsChanged?: (listener: () => void) => void | (() => unknown);
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
  /** work the queues of the listener and orchestrator do not show: background explorations, merges, digests */
  ops: InFlight;
}

/** Counts work in flight, so a room that has some is not taken for idle. */
class InFlight {
  private n = 0;
  get active(): number {
    return this.n;
  }
  begin(): void {
    this.n += 1;
  }
  end(): void {
    this.n = Math.max(0, this.n - 1);
  }
  track(run: Promise<unknown>): void {
    this.begin();
    run.then(
      () => this.end(),
      () => this.end(),
    );
  }
}

const DEFAULT_IDLE_AFTER_MS = 15 * 60_000;
const DEFAULT_IDLE_CHECK_MS = 30_000;
/** Events that arrive after a suggestion wait this long for its direct application, so they keep their order. */
const SUGGESTION_ORDER_WAIT_MS = 2000;

/** Resolves when `p` settles or after `ms`, whichever is first (it never rejects). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** Status details are shown to everyone in the room: keep them to one short line. */
function statusDetail(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
}

export class ClaudeRuntime implements AgentRuntime {
  /** live sessions (listener + orchestrator) per room; only exist while a credential is available */
  private readonly rooms = new Map<RoomId, Promise<RoomRuntime>>();
  /** rooms the server asked us to run; sessions are (re)started for these when credentials appear */
  private readonly active = new Set<RoomId>();
  /** per-room FIFO of work, so events keep their order across async credential checks and session starts */
  private readonly queues = new Map<RoomId, Promise<void>>();
  private readonly boards = new Map<RoomId, StatusBoard>();
  private readonly log: Logger;
  private readonly tunables: Tunables;
  private readonly queryFn: QueryFn;
  private readonly claude: ClaudeProcessConfig;
  private listenerClient: ListenerClient | null = null;
  private lastAvailable: boolean | null = null;
  private unsubscribe: (() => unknown) | null = null;
  private closed = false;
  /** when each live room last had an event, work or a connected participant */
  private readonly lastActive = new Map<RoomId, number>();
  /** rooms whose sessions were stopped for idleness: they stay idle (also across sign-ins) until the next event */
  private readonly idleRooms = new Set<RoomId>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleAfterMs: number;

  constructor(
    private readonly actions: RoomActions,
    private readonly options: ClaudeRuntimeOptions,
    private readonly deps: ClaudeRuntimeDeps = {},
  ) {
    this.log = options.logger ?? noopLogger;
    this.tunables = resolveTunables(options);
    this.queryFn = deps.queryFn ?? query;
    const claudeEnv = options.claudeEnv;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.claude = {
      binary: options.claudeBinary,
      apiKey: options.anthropicApiKey,
      sandbox: options.sandbox,
      env: claudeEnv
        ? () => {
            try {
              return claudeEnv();
            } catch (e) {
              this.log('warn', 'claudeEnv failed; using the server environment alone', {
                error: errMessage(e),
              });
              return {};
            }
          }
        : undefined,
    };
    if (options.onCredentialsChanged) {
      const off = options.onCredentialsChanged(() => this.credentialsChanged());
      this.unsubscribe = typeof off === 'function' ? off : null;
    }
    if (this.idleAfterMs > 0) {
      this.idleTimer = setInterval(
        () => this.sweepIdle(),
        options.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS,
      );
      this.idleTimer.unref?.();
    }
  }

  // --- credentials ------------------------------------------------------------------------

  /** True when a Claude credential is usable. A failing probe keeps the last known answer (initially: available). */
  private async isAvailable(): Promise<boolean> {
    const check = this.options.claudeAvailable;
    if (!check) return true;
    try {
      this.lastAvailable = await check();
    } catch (e) {
      this.log('warn', 'claudeAvailable failed; keeping the last known answer', {
        error: errMessage(e),
      });
    }
    return this.lastAvailable ?? true;
  }

  /**
   * Sign-in or sign-out happened. With a credential: restart every active room's sessions so the new login applies
   * (and the status returns to idle). Without one: stop the sessions and show "unavailable". Runs on each room's queue,
   * so events that arrive meanwhile are handled by the state this leaves behind, in order.
   */
  private credentialsChanged(): void {
    if (this.closed) return;
    for (const roomId of [...this.active]) {
      void this.enqueue(roomId, 'credentials change', async () => {
        const available = await this.isAvailable();
        await this.teardown(roomId);
        if (this.closed || !this.active.has(roomId)) return;
        const board = this.board(roomId);
        if (this.idleRooms.has(roomId)) {
          // nobody is there and nothing runs: the next event starts the sessions with whatever login exists then
          if (available) board.reset();
          else board.reset({ key: 'credentials', detail: SIGN_IN_DETAIL });
          return;
        }
        if (!available) {
          this.log('info', 'claude credentials gone; agent unavailable', { roomId });
          board.reset({ key: 'credentials', detail: SIGN_IN_DETAIL });
          return;
        }
        this.log('info', 'claude credentials available; starting agent sessions', { roomId });
        board.reset();
        await this.room(roomId);
      });
    }
  }

  /** The room's sessions, or null (and status "unavailable") when there is no credential. */
  private async sessions(roomId: RoomId): Promise<RoomRuntime | null> {
    if (this.closed) return null;
    this.active.add(roomId);
    if (!(await this.isAvailable())) {
      this.board(roomId).fail('credentials', SIGN_IN_DETAIL);
      return null;
    }
    this.board(roomId).recover('credentials');
    this.idleRooms.delete(roomId);
    this.touch(roomId);
    return this.room(roomId);
  }

  // --- idle rooms (M4) --------------------------------------------------------------------

  private touch(roomId: RoomId): void {
    this.lastActive.set(roomId, Date.now());
  }

  /** Looks for rooms with live sessions that have had nobody and nothing for `idleAfterMs`, and stops them. */
  private sweepIdle(): void {
    if (this.closed) return;
    for (const roomId of [...this.rooms.keys()]) {
      // on the room's queue, so an event that arrives meanwhile is handled before the check or after the teardown
      void this.enqueue(roomId, 'idle check', async () => {
        if (this.closed || !(await this.isIdle(roomId))) return;
        this.log('info', 'room idle; stopping its agent sessions until the next event', { roomId });
        this.idleRooms.add(roomId);
        await this.teardown(roomId);
        this.boards.get(roomId)?.reset();
      });
    }
  }

  private async isIdle(roomId: RoomId): Promise<boolean> {
    const pending = this.rooms.get(roomId);
    if (!pending) return false;
    let r: RoomRuntime;
    try {
      r = await pending;
    } catch {
      return false;
    }
    const quietFor = Date.now() - (this.lastActive.get(roomId) ?? 0);
    if (quietFor < this.idleAfterMs) return false;
    if (
      r.orchestrator.pendingCount > 0 ||
      r.listener.pendingCount > 0 ||
      r.ops.active > 0 ||
      this.board(roomId).current.status === 'thinking'
    ) {
      this.touch(roomId);
      return false;
    }
    try {
      const { presence } = await this.actions.getRoomState(roomId);
      if (presence.some((p) => p.connected)) {
        this.touch(roomId);
        return false;
      }
    } catch (e) {
      this.log('warn', 'could not read presence to check for an idle room', {
        roomId,
        error: errMessage(e),
      });
      return false;
    }
    return true;
  }

  // --- lifecycle --------------------------------------------------------------------------

  async startRoom(roomId: RoomId): Promise<void> {
    this.active.add(roomId);
    await this.enqueue(roomId, 'startRoom', async () => {
      await this.sessions(roomId);
    });
  }

  async stopRoom(roomId: RoomId): Promise<void> {
    this.active.delete(roomId);
    this.idleRooms.delete(roomId);
    this.lastActive.delete(roomId);
    await this.teardown(roomId);
    this.boards.get(roomId)?.reset();
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    try {
      this.unsubscribe?.();
    } catch {
      /* ignore */
    }
    this.unsubscribe = null;
    await Promise.all(
      [...new Set([...this.rooms.keys(), ...this.active])].map((id) => this.stopRoom(id)),
    );
  }

  /** Stops the room's sessions; the room stays active. */
  private async teardown(roomId: RoomId): Promise<void> {
    const p = this.rooms.get(roomId);
    this.rooms.delete(roomId);
    if (!p) return;
    try {
      const r = await p;
      r.listener.stop();
      r.abort.abort();
      await r.orchestrator.stop();
    } catch (e) {
      this.log('warn', 'stopping room sessions failed', { roomId, error: errMessage(e) });
    }
  }

  private board(roomId: RoomId): StatusBoard {
    let b = this.boards.get(roomId);
    if (!b) {
      b = new StatusBoard(roomId, this.actions, this.log);
      this.boards.set(roomId, b);
    }
    return b;
  }

  private enqueue(roomId: RoomId, what: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(roomId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((e) => this.log('error', `${what} failed`, { roomId, error: errMessage(e) }));
    this.queues.set(roomId, next);
    return next;
  }

  private room(roomId: RoomId): Promise<RoomRuntime> {
    let p = this.rooms.get(roomId);
    if (!p) {
      const created = this.createRoom(roomId);
      p = created;
      this.rooms.set(roomId, created);
      created.catch(() => {
        if (this.rooms.get(roomId) === created) this.rooms.delete(roomId);
      });
    }
    return p;
  }

  /**
   * The listener talks to the Messages API when there is an API key (explicit prompt-cache breakpoints, no process per
   * call). Without one (a Claude login or a long-lived token) only the Claude Code subprocess can authenticate, so the
   * listener runs through the Agent SDK instead.
   */
  private client(): ListenerClient {
    if (this.listenerClient) return this.listenerClient;
    const apiKey = this.options.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
    if (this.deps.createClient) this.listenerClient = this.deps.createClient(apiKey);
    else if (apiKey) this.listenerClient = new Anthropic({ apiKey }) as unknown as ListenerClient;
    else
      this.listenerClient = createSdkListenerClient({
        queryFn: this.queryFn,
        process: () => this.claude,
        cwd: this.options.dataDir,
        logger: this.log,
      });
    return this.listenerClient;
  }

  private workerEnv(roomId: RoomId, signal?: AbortSignal): WorkerEnv {
    return {
      roomId,
      actions: this.actions,
      queryFn: this.queryFn,
      logger: this.log,
      tunables: this.tunables,
      dataDir: this.options.dataDir,
      claude: this.claude,
      maxBudgetUsd: this.options.maxBudgetUsd,
      workerBudgetUsd: workerBudgetUsd(this.options.maxBudgetUsd, this.options.workerBudgetUsd),
      digestBudgetUsd: Math.min(this.options.maxBudgetUsd ?? Infinity, DIGEST_BUDGET_USD),
      signal,
      status: this.board(roomId),
    };
  }

  private async createRoom(roomId: RoomId): Promise<RoomRuntime> {
    const repo = await this.actions.repo(roomId);
    const abort = new AbortController();
    const board = this.board(roomId);
    const ops = new InFlight();
    const orchestrator: Orchestrator = new Orchestrator({
      roomId,
      actions: this.actions,
      repo,
      queryFn: this.queryFn,
      tunables: this.tunables,
      logger: this.log,
      claude: this.claude,
      maxBudgetUsd: this.options.maxBudgetUsd,
      status: board,
      // Returns as soon as the workers are started; their results come back to the orchestrator as an event, so it is
      // free to handle suggestions and chat meanwhile. The workers run on the room's abort signal.
      startExploration: (req: ExplorationRequest) =>
        startExploration(this.workerEnv(roomId, abort.signal), repo, req, {
          onFinished: (outcome) => orchestrator.send({ type: 'exploration_finished', outcome }),
          track: (run) => ops.track(run),
        }),
    });
    const listener = new Listener({
      roomId,
      actions: this.actions,
      client: this.client(),
      tunables: this.options.tunables,
      logger: this.log,
      onIntents: (batch) => this.forwardIntents(roomId, orchestrator, ops, batch),
      onHealth: (ok, detail) => {
        if (ok) board.recover('listener');
        else board.fail('listener', statusDetail(detail ?? 'The listener is failing'));
      },
    });
    orchestrator.start();
    return { repo, listener, orchestrator, abort, ops };
  }

  /**
   * Hands listener intents to the orchestrator. Each intent carries the messages it names, resolved across the whole
   * classified slice (a divergence points at an earlier message), and the proposals that are open right now, so the
   * orchestrator can also judge expiry on every listener cycle (PRD 7.4).
   */
  private forwardIntents(
    roomId: RoomId,
    orchestrator: Orchestrator,
    ops: InFlight,
    batch: ListenerBatch,
  ): void {
    const byId = new Map(batch.context.map((m) => [m.id, m]));
    ops.begin();
    void (async () => {
      let openProposals: Proposal[] = [];
      try {
        openProposals = (await this.actions.getRoomState(roomId)).proposals.filter(
          (p) => p.state === 'open',
        );
      } catch (e) {
        this.log('warn', 'could not read open proposals for an intent', {
          roomId,
          error: errMessage(e),
        });
      }
      for (const intent of batch.intents) {
        const referenced = intent.messageIds
          .map((id) => byId.get(id))
          .filter((m): m is Message => m !== undefined);
        orchestrator.send({
          type: 'intent',
          intent,
          messages: referenced.length > 0 ? referenced : batch.messages,
          openProposals,
        });
      }
    })()
      .catch((e) =>
        this.log('error', 'forwarding intents failed', { roomId, error: errMessage(e) }),
      )
      .finally(() => ops.end());
  }

  /** Runs `fn` against the room's sessions in arrival order. Never throws; without a credential the event is dropped. */
  private dispatch(
    roomId: RoomId,
    what: string,
    fn: (r: RoomRuntime) => void | Promise<void>,
  ): void {
    this.active.add(roomId);
    this.touch(roomId);
    void this.enqueue(roomId, what, async () => {
      const r = await this.sessions(roomId);
      if (!r) {
        this.log(
          'info',
          `dropping ${what}: ${this.closed ? 'the runtime is stopped' : SIGN_IN_DETAIL}`,
          { roomId },
        );
        return;
      }
      await fn(r);
    });
  }

  // --- AgentRuntime: events ---------------------------------------------------------------

  onChatMessage(roomId: RoomId, message: Message): void {
    if (message?.author?.kind !== 'user') return;
    this.dispatch(roomId, 'onChatMessage', (r) => r.listener.push(message));
  }

  /**
   * A suggestion whose anchored lines on main still match its text hash, and that is within the size rule, is applied
   * here, under the write queue, with no model turn (PRD 5.2, 12: within 10 s); the orchestrator is only told.
   * Everything else reaches it as a suggestion event, as before. Later events wait for the direct application for a
   * moment (SUGGESTION_ORDER_WAIT_MS), so they keep their order; they do not wait longer: the write queue can be busy
   * for minutes (a semantic revert), and chat must not wait behind it.
   */
  onSuggestion(roomId: RoomId, message: Message): void {
    this.dispatch(roomId, 'onSuggestion', async (r) => {
      r.ops.begin();
      const work = this.applyOrForward(roomId, r, message).finally(() => r.ops.end());
      await within(work, SUGGESTION_ORDER_WAIT_MS);
    });
  }

  private async applyOrForward(roomId: RoomId, r: RoomRuntime, message: Message): Promise<void> {
    let outcome: SuggestionOutcome;
    try {
      outcome = await tryApplySuggestion(
        {
          roomId,
          actions: this.actions,
          repo: r.repo,
          rewriteLimit: this.tunables.immediateRewriteLimit,
          logger: this.log,
        },
        message,
      );
    } catch (e) {
      this.log('warn', 'applying a suggestion directly failed; handing it to the orchestrator', {
        roomId,
        messageId: message?.id,
        error: errMessage(e),
      });
      outcome = { applied: false, reason: `applying it directly failed: ${errMessage(e)}` };
    }
    if (outcome.applied)
      r.orchestrator.send({
        type: 'suggestion_applied',
        message,
        sha: outcome.sha,
        documentPath: outcome.documentPath,
        bookkeepingFailed: outcome.bookkeepingFailed,
      });
    else r.orchestrator.send({ type: 'suggestion', message, notApplied: outcome.reason });
  }

  onAsk(roomId: RoomId, message: Message): void {
    this.dispatch(roomId, 'onAsk', (r) => r.orchestrator.send({ type: 'ask', message }));
  }

  onProposalEvent(roomId: RoomId, event: Parameters<AgentRuntime['onProposalEvent']>[1]): void {
    this.dispatch(roomId, 'onProposalEvent', (r) =>
      r.orchestrator.send({ type: 'proposal_event', event }),
    );
  }

  onReverted(roomId: RoomId, change: Change, revertSha: Sha, byUserId: UserId): void {
    this.dispatch(roomId, 'onReverted', (r) =>
      r.orchestrator.send({ type: 'revert', change, revertSha, byUserId }),
    );
  }

  // --- one-shot sessions ------------------------------------------------------------------

  /** Without a credential these throw "Sign in to Claude in Settings": the merge stays open / the revert is refused with that reason. */
  async runMergeDriver(
    roomId: RoomId,
    input: {
      proposal: Proposal;
      optionId: OptionId;
      worktreePath: string;
      conflictedFiles: string[];
      documentPath: string;
    },
  ): Promise<{ reconciled: boolean; summary: string }> {
    const r = await this.sessions(roomId);
    if (!r) throw new Error(SIGN_IN_DETAIL);
    r.ops.begin();
    try {
      return await runMergeDriver(this.workerEnv(roomId, r.abort.signal), input);
    } finally {
      r.ops.end();
    }
  }

  async runSemanticRevert(
    roomId: RoomId,
    input: { change: Change; byUserId: UserId },
  ): Promise<Sha> {
    const r = await this.sessions(roomId);
    if (!r) throw new Error(SIGN_IN_DETAIL);
    r.ops.begin();
    try {
      return await runSemanticRevert(this.workerEnv(roomId, r.abort.signal), r.repo, input);
    } finally {
      r.ops.end();
    }
  }

  /**
   * The digest writer when Claude is available; a plain-text digest of the events when it is not, or when the writer
   * fails or returns nothing. A returning participant always learns what happened.
   */
  async writeDigest(
    roomId: RoomId,
    input: { userId: UserId; sinceMessageId: MessageId | null; events: string[] },
  ): Promise<string> {
    try {
      const r = await this.sessions(roomId);
      if (!r) return fallbackDigest(input.events);
      r.ops.begin();
      let text: string;
      try {
        text = await writeDigest(this.workerEnv(roomId, r.abort.signal), r.repo, input);
      } finally {
        r.ops.end();
      }
      if (text) return text;
      this.log('warn', 'digest writer returned nothing; using the plain digest', { roomId });
    } catch (e) {
      this.log('warn', 'digest writer failed; using the plain digest', {
        roomId,
        error: errMessage(e),
      });
    }
    return fallbackDigest(input.events);
  }
}
