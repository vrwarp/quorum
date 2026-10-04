import {
  DEFAULTS,
  newId,
  type ActorRef,
  type Anchor,
  type Card,
  type Change,
  type ClientCommand,
  type Document,
  type DocumentId,
  type Message,
  type MessageId,
  type OptionId,
  type Proposal,
  type ProposalId,
  type ProposalKind,
  type ProposalOption,
  type ProposalState,
  type Room,
  type RoomId,
  type RoomState,
  type ServerEvent,
  type Sha,
  type UsageRecord,
  type UserId,
  type Vote,
  type VotingRule,
} from '@quorum/shared';
import {
  RevertConflictError,
  type AgentRuntime,
  type CommitMeta,
  type GitProvider,
  type RoomActions,
  type RoomRepository,
  type Storage,
} from '../contracts/index.js';
import { RoomError, type Hub, type Logger } from './types.js';

export type ResolvedTunables = { -readonly [K in keyof typeof DEFAULTS]: number };

export interface RoomServiceOptions {
  storage: Storage;
  git: GitProvider;
  tunables?: Partial<typeof DEFAULTS>;
  logger?: Logger;
  now?: () => Date;
  /** how long a room may sit without a connected participant before its agent session is stopped (default 15 min) */
  idleStopMs?: number;
}

interface Connection {
  id: number;
  userId: UserId;
  send: (ev: ServerEvent) => void;
}

const RECENT_CLOSED_PROPOSALS = 30;
const OPEN_STATES: ProposalState[] = ['drafting', 'open', 'merging'];
const DEFAULT_IDLE_STOP_MS = 15 * 60_000;
/** `abc1234` for log lines and messages */
const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 8);

export class RoomService implements RoomActions, Hub {
  private readonly storage: Storage;
  private readonly git: GitProvider;
  private readonly tunables: ResolvedTunables;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private runtime: AgentRuntime | null = null;

  private readonly conns = new Map<RoomId, Map<number, Connection>>();
  private nextConnId = 1;
  private readonly repos = new Map<RoomId, Promise<RoomRepository>>();
  private readonly agentStatus = new Map<
    RoomId,
    { status: 'idle' | 'thinking' | 'unavailable'; detail: string | null }
  >();
  private readonly windowTimers = new Map<ProposalId, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private readonly idleStopMs: number;
  private readonly background = new Set<Promise<unknown>>();
  /** merge pipelines in flight: shutdown waits for these (drain) before it stops the agents */
  private readonly merges = new Set<Promise<unknown>>();
  /** a merge that failed is not retried by presence changes until the votes change (PRD §7.3, review F8) */
  private readonly failedMerges = new Map<ProposalId, string>();
  /** changes whose revert is being computed: a second request is refused at once */
  private readonly reverting = new Set<Sha>();
  /** per-room tail of the structural mutex (document create/rename/archive and proposal registration) */
  private readonly structureTails = new Map<RoomId, Promise<unknown>>();
  private closed = false;
  private stopping = false;

  constructor(opts: RoomServiceOptions) {
    this.storage = opts.storage;
    this.git = opts.git;
    this.tunables = { ...DEFAULTS, ...(opts.tunables ?? {}) } as ResolvedTunables;
    this.log = opts.logger ?? (() => undefined);
    this.clock = opts.now ?? (() => new Date());
    this.idleStopMs = opts.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
  }

  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Call once after startup. Finishes or reopens proposals a restart left in `merging` (the merge either reached main
   * or it did not), and re-arms Review windows for proposals that were open. Resolves when the recoveries are done.
   */
  async start(): Promise<void> {
    const recoveries: Promise<void>[] = [];
    for (const room of this.storage.rooms.list()) {
      for (const p of this.storage.proposals.list(room.id, { states: ['merging'] })) {
        const recovery = this.recoverMerging(room.id, p.id);
        this.track(recovery);
        recoveries.push(recovery);
      }
      if (room.archivedAt) continue;
      for (const p of this.storage.proposals.list(room.id, { states: ['open'] })) {
        this.armWindow(p);
        this.evaluate(room.id, p.id);
      }
    }
    await Promise.allSettled(recoveries);
  }

  /** Resolves when all fire-and-forget work (merges, digests) started so far has settled. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /**
   * First step of a shutdown: no merge is started from now on (votes still count, nothing is evaluated), and the merges
   * already running get up to `timeoutMs` to finish. Resolves true when none is left. Stop the agents after this, not
   * before: stopping them aborts the merge driver mid-merge.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    if (this.merges.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = (async () => {
      while (this.merges.size > 0) await Promise.allSettled([...this.merges]);
      return true as const;
    })();
    const done = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (!done) this.log('warn', 'a merge was still running when the drain period ended');
    return done;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.windowTimers.values()) clearTimeout(t);
    this.windowTimers.clear();
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    await this.idle();
    this.conns.clear();
  }

  // ---------------------------------------------------------------- helpers

  private now(): Date {
    return this.clock();
  }
  private nowIso(): string {
    return this.now().toISOString();
  }

  private track<T>(p: Promise<T>): void {
    const wrapped: Promise<unknown> = p.catch((err) =>
      this.log('error', 'background task failed', { err: String((err as Error)?.stack ?? err) }),
    );
    this.background.add(wrapped);
    void wrapped.finally(() => this.background.delete(wrapped));
  }

  /** Run a merge pipeline so that `drain` can wait for it. Resolves or rejects like `p`. */
  private runMerge<T>(p: Promise<T>): Promise<T> {
    const entry: Promise<unknown> = p.then(
      () => undefined,
      () => undefined,
    );
    this.merges.add(entry);
    void entry.finally(() => this.merges.delete(entry));
    return p;
  }

  /**
   * Structural changes to a room (create, rename, archive a document; registering a proposal) run one at a time, so a
   * check ("the name is free", "no proposal is open") is still true when the change is made. This is separate from the
   * main write lock on purpose: registering a proposal must never queue behind a merge that holds that lock.
   */
  private structural<T>(roomId: RoomId, fn: () => Promise<T>): Promise<T> {
    const run = (this.structureTails.get(roomId) ?? Promise.resolve()).then(() => fn());
    this.structureTails.set(
      roomId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Call into the runtime; never throws (sync throws and rejections are logged). */
  private rt(name: string, fn: (r: AgentRuntime) => unknown): void {
    const r = this.runtime;
    if (!r) return;
    try {
      const out = fn(r);
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).catch((err) =>
          this.log('error', `runtime.${name} failed`, {
            err: String((err as Error)?.message ?? err),
          }),
        );
      }
    } catch (err) {
      this.log('error', `runtime.${name} threw`, { err: String((err as Error)?.message ?? err) });
    }
  }

  private repo_(roomId: RoomId): Promise<RoomRepository> {
    let p = this.repos.get(roomId);
    if (!p) {
      p = this.git.open(roomId);
      this.repos.set(roomId, p);
      p.catch(() => this.repos.delete(roomId));
    }
    return p;
  }

  private requireRoom(roomId: RoomId): Room {
    const room = this.storage.rooms.get(roomId);
    if (!room) throw new RoomError('not_found', `room ${roomId} not found`);
    return room;
  }

  private requireParticipant(roomId: RoomId, userId: UserId): void {
    if (!this.storage.rooms.listParticipants(roomId).some((p) => p.userId === userId)) {
      throw new RoomError('forbidden', 'not a participant of this room');
    }
  }

  private actorFor(userId: UserId): ActorRef {
    const user = this.storage.users.get(userId);
    return { kind: 'user', userId, displayName: user?.displayName ?? userId };
  }

  private requireDocument(roomId: RoomId, documentId: DocumentId): Document {
    const doc = this.storage.documents.get(documentId);
    if (!doc || doc.roomId !== roomId)
      throw new RoomError('not_found', `document ${documentId} not found`);
    return doc;
  }

  private broadcast(roomId: RoomId, ev: ServerEvent, privateTo?: UserId | null): void {
    const conns = this.conns.get(roomId);
    if (!conns) return;
    for (const c of conns.values()) {
      if (privateTo && c.userId !== privateTo) continue;
      this.safeSend(c, ev);
    }
  }

  private safeSend(c: Connection, ev: ServerEvent): void {
    try {
      c.send(ev);
    } catch (err) {
      this.log('warn', 'send failed', { err: String((err as Error)?.message ?? err) });
    }
  }

  private createMessage(
    roomId: RoomId,
    input: {
      author: ActorRef;
      kind?: Message['kind'];
      body: string;
      card?: Card | null;
      anchor?: Anchor | null;
      privateTo?: UserId | null;
      inReplyTo?: MessageId[];
    },
  ): Message {
    const message: Message = {
      id: newId('msg'),
      roomId,
      author: input.author,
      kind: input.kind ?? (input.card ? 'card' : 'text'),
      body: input.body,
      card: input.card ?? null,
      anchor: input.anchor ?? null,
      privateTo: input.privateTo ?? null,
      inReplyTo: input.inReplyTo ?? [],
      createdAt: this.nowIso(),
    };
    this.storage.messages.insert(message);
    this.broadcast(roomId, { type: 'chat.message', message }, message.privateTo);
    return message;
  }

  private systemMessage(roomId: RoomId, body: string, card?: Card | null): Message {
    return this.createMessage(roomId, {
      author: { kind: 'agent', role: 'system' },
      kind: card ? 'card' : 'system',
      body,
      card,
    });
  }

  private publishProposal(proposalId: ProposalId): Proposal | null {
    const p = this.storage.proposals.get(proposalId);
    if (p) this.broadcast(p.roomId, { type: 'proposal.updated', proposal: p });
    return p;
  }

  // ---------------------------------------------------------------- rooms

  async createRoom(ownerId: UserId, name: string): Promise<Room> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100)
      throw new RoomError('invalid', 'room name must be 1-100 characters');
    const owner = this.storage.users.get(ownerId);
    if (!owner) throw new RoomError('not_found', 'user not found');
    const room = this.storage.rooms.create({ name: trimmed, ownerId });
    this.storage.rooms.addParticipant({
      roomId: room.id,
      userId: ownerId,
      displayName: owner.displayName,
      role: 'owner',
    });
    const repo = await this.repo_(room.id);
    await repo.init();
    return room;
  }

  /** Rooms that can be joined: archived rooms are history and are left out unless asked for. */
  listRooms(opts: { includeArchived?: boolean } = {}): Room[] {
    const all = this.storage.rooms.list();
    return opts.includeArchived ? all : all.filter((r) => !r.archivedAt);
  }

  getRoom(roomId: RoomId): Room | null {
    return this.storage.rooms.get(roomId);
  }

  async getState(roomId: RoomId, forUserId?: UserId): Promise<RoomState> {
    const room = this.requireRoom(roomId);
    const repo = await this.repo_(roomId);
    const head = await repo.headSha();
    const participants = this.storage.rooms.listParticipants(roomId);
    const stored = new Map(this.storage.rooms.listPresence(roomId).map((p) => [p.userId, p]));
    const connected = this.connectedUserIds(roomId);
    const presence = participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      connected: connected.has(p.userId),
      lastSeenAt: stored.get(p.userId)?.lastSeenAt ?? room.createdAt,
    }));
    const documents = this.storage.documents.list(roomId).map((d) => ({ ...d, headSha: head }));
    const all = this.storage.proposals.list(roomId);
    const live = all.filter((p) => OPEN_STATES.includes(p.state));
    const closed = all
      .filter((p) => !OPEN_STATES.includes(p.state))
      .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
      .slice(0, RECENT_CLOSED_PROPOSALS);
    const recentMessages = this.storage.messages
      .list(roomId, { limit: this.tunables.recentMessagesInHello, forUser: forUserId })
      .filter((m) => m.privateTo === null || m.privateTo === forUserId);
    return {
      room,
      participants,
      presence,
      documents,
      proposals: [...live, ...closed],
      recentMessages,
      agentStatus: this.agentStatus.get(roomId)?.status ?? 'idle',
      agentDetail: this.agentStatus.get(roomId)?.detail ?? null,
    };
  }

  // RoomActions.getRoomState
  getRoomState(roomId: RoomId): Promise<RoomState> {
    return this.getState(roomId);
  }

  listMessages(
    roomId: RoomId,
    forUser: UserId,
    opts: { before?: MessageId; limit: number },
  ): Message[] {
    this.requireRoom(roomId);
    return this.storage.messages
      .list(roomId, { before: opts.before, limit: opts.limit, forUser })
      .filter((m) => m.privateTo === null || m.privateTo === forUser);
  }

  async setVotingRule(roomId: RoomId, userId: UserId, rule: VotingRule): Promise<void> {
    const room = this.requireRoom(roomId);
    if (rule !== 'unanimous' && rule !== 'majority')
      throw new RoomError('invalid', 'unknown voting rule');
    if (room.ownerId !== userId)
      throw new RoomError('forbidden', 'only the room owner can change the voting rule');
    if (room.votingRule === rule) return;
    this.storage.rooms.setVotingRule(roomId, rule);
    this.broadcast(roomId, { type: 'room.updated', room: this.requireRoom(roomId) });
    this.systemMessage(roomId, `${this.actorName(userId)} changed the voting rule to ${rule}.`);
    this.evaluateAll(roomId);
  }

  /** Owner-only. Archives the room; connected clients get room.updated with archivedAt set. */
  async archiveRoom(roomId: RoomId, userId: UserId): Promise<void> {
    const room = this.requireRoom(roomId);
    if (room.ownerId !== userId)
      throw new RoomError('forbidden', 'only the room owner can archive the room');
    if (room.archivedAt) return;
    this.storage.rooms.archive(roomId);
    this.systemMessage(roomId, `${this.actorName(userId)} archived the room.`);
    this.broadcast(roomId, { type: 'room.updated', room: this.requireRoom(roomId) });
    // an archived room does no more work: its agent session ends and no window timer fires into it
    this.cancelIdleStop(roomId);
    for (const p of this.storage.proposals.list(roomId, { states: ['open'] }))
      this.clearWindow(p.id);
    this.rt('stopRoom', (r) => r.stopRoom(roomId));
  }

  private actorName(userId: UserId): string {
    return this.storage.users.get(userId)?.displayName ?? userId;
  }

  // ---------------------------------------------------------------- documents

  private pathForTitle(title: string): { title: string; path: string } {
    const clean = title
      .replace(/\.md$/i, '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      // no hidden files, and never a leading dash: a file name must not be able to pass for a command-line option
      .replace(/^[.\-\s]+/, '');
    if (!clean || clean.length > 80)
      throw new RoomError('invalid', 'document title must be 1-80 characters');
    return { title: clean, path: `${clean}.md` };
  }

  async createDocument(
    roomId: RoomId,
    userId: UserId,
    title: string,
  ): Promise<Document & { headSha: Sha | null }> {
    this.requireRoom(roomId);
    this.requireParticipant(roomId, userId);
    const t = this.pathForTitle(title);
    const repo = await this.repo_(roomId);
    // check, commit and record in one step: nothing can take the name between the check and the write
    const { doc, sha } = await this.structural(roomId, () =>
      repo.withMainLock(async () => {
        if (this.storage.documents.getByPath(roomId, t.path))
          throw new RoomError('conflict', `${t.path} already exists`);
        const sha = await repo.commitToMain({ [t.path]: `# ${t.title}\n` }, `Create ${t.path}`, {
          actor: this.actorFor(userId),
          triggerMessageIds: [],
        });
        const doc = this.storage.documents.create({ roomId, path: t.path, title: t.title });
        return { doc, sha };
      }),
    );
    this.systemMessage(roomId, `${this.actorName(userId)} created ${t.path}.`);
    const withHead = { ...doc, headSha: sha };
    this.broadcast(roomId, { type: 'document.created', document: withHead });
    return withHead;
  }

  private hasLiveProposals(roomId: RoomId, documentId: DocumentId): boolean {
    return (
      this.storage.proposals.list(roomId, { documentId, states: ['drafting', 'open', 'merging'] })
        .length > 0
    );
  }

  async renameDocument(
    roomId: RoomId,
    userId: UserId,
    documentId: DocumentId,
    title: string,
  ): Promise<void> {
    this.requireRoom(roomId);
    this.requireParticipant(roomId, userId);
    this.requireDocument(roomId, documentId);
    const t = this.pathForTitle(title);
    const repo = await this.repo_(roomId);
    // every check is made again where it counts: inside the lock, right before the commit and the database write
    const renamed = await this.structural(roomId, () =>
      repo.withMainLock(async () => {
        const doc = this.requireDocument(roomId, documentId);
        if (doc.status === 'archived') throw new RoomError('conflict', 'document is archived');
        if (t.path === doc.path) return null;
        if (this.storage.documents.getByPath(roomId, t.path))
          throw new RoomError('conflict', `${t.path} already exists`);
        if (this.hasLiveProposals(roomId, documentId))
          throw new RoomError(
            'conflict',
            'document has open proposals; resolve them before renaming',
          );
        const content = await repo.readFile(doc.path);
        if (content === null) throw new RoomError('not_found', `${doc.path} is missing on main`);
        const sha = await repo.commitToMain(
          { [t.path]: content, [doc.path]: null },
          `Rename ${doc.path} to ${t.path}`,
          { actor: this.actorFor(userId), triggerMessageIds: [] },
        );
        this.storage.documents.rename(documentId, t.title, t.path);
        return { sha, from: doc.path };
      }),
    );
    if (!renamed) return;
    this.systemMessage(roomId, `${this.actorName(userId)} renamed ${renamed.from} to ${t.path}.`);
    const updated = this.storage.documents.get(documentId);
    // No dedicated rename event exists in the protocol; document.created doubles as an upsert.
    if (updated)
      this.broadcast(roomId, {
        type: 'document.created',
        document: { ...updated, headSha: renamed.sha },
      });
  }

  async archiveDocument(roomId: RoomId, userId: UserId, documentId: DocumentId): Promise<void> {
    this.requireRoom(roomId);
    this.requireParticipant(roomId, userId);
    this.requireDocument(roomId, documentId);
    const repo = await this.repo_(roomId);
    const archived = await this.structural(roomId, () =>
      repo.withMainLock(async () => {
        const doc = this.requireDocument(roomId, documentId);
        if (doc.status === 'archived') return null;
        if (this.hasLiveProposals(roomId, documentId))
          throw new RoomError(
            'conflict',
            'document has open proposals; resolve them before archiving',
          );
        await repo.commitToMain({ [doc.path]: null }, `Archive ${doc.path}`, {
          actor: this.actorFor(userId),
          triggerMessageIds: [],
        });
        this.storage.documents.archive(documentId);
        return doc;
      }),
    );
    if (!archived) return;
    this.systemMessage(roomId, `${this.actorName(userId)} archived ${archived.path}.`);
    this.broadcast(roomId, { type: 'document.archived', documentId });
  }

  async getDocument(roomId: RoomId, documentId: DocumentId): Promise<Document | null> {
    const doc = this.storage.documents.get(documentId);
    return doc && doc.roomId === roomId ? doc : null;
  }

  // ---------------------------------------------------------------- presence / hub

  private connectedUserIds(roomId: RoomId): Set<UserId> {
    const out = new Set<UserId>();
    for (const c of this.conns.get(roomId)?.values() ?? []) out.add(c.userId);
    return out;
  }

  async connect(
    roomId: RoomId,
    userId: UserId,
    send: (ev: ServerEvent) => void,
  ): Promise<() => void> {
    const room = this.requireRoom(roomId);
    if (room.archivedAt) throw new RoomError('conflict', 'this room is archived');
    const user = this.storage.users.get(userId);
    if (!user) throw new RoomError('not_found', 'user not found');
    if (!this.storage.rooms.listParticipants(roomId).some((p) => p.userId === userId)) {
      this.storage.rooms.addParticipant({
        roomId,
        userId,
        displayName: user.displayName,
        role: room.ownerId === userId ? 'owner' : 'member',
      });
    }
    let conns = this.conns.get(roomId);
    if (!conns) {
      conns = new Map();
      this.conns.set(roomId, conns);
    }
    const roomWasEmpty = conns.size === 0;
    const firstForUser = !this.connectedUserIds(roomId).has(userId);
    const lastSeen = this.storage.rooms.getLastSeen(roomId, userId);
    const conn: Connection = { id: this.nextConnId++, userId, send };
    conns.set(conn.id, conn);
    this.cancelIdleStop(roomId);
    if (firstForUser) this.storage.rooms.upsertPresence(roomId, userId, true, this.nowIso());

    let done = false;
    const disconnect = () => {
      if (done) return;
      done = true;
      this.conns.get(roomId)?.delete(conn.id);
      if (!this.connectedUserIds(roomId).has(userId)) {
        this.storage.rooms.upsertPresence(roomId, userId, false, this.nowIso());
        this.broadcastPresence(roomId);
        this.evaluateAll(roomId);
      }
      if ((this.conns.get(roomId)?.size ?? 0) === 0) this.scheduleIdleStop(roomId);
    };

    try {
      const state = await this.getState(roomId, userId);
      this.safeSend(conn, { type: 'hello', state, you: { userId, displayName: user.displayName } });
    } catch (err) {
      // The connection is registered, but nobody will ever hold the disconnect handle: undo it, or the user stays
      // "connected" forever and blocks every unanimous vote.
      disconnect();
      throw err;
    }

    if (firstForUser) {
      this.broadcastPresence(roomId);
      this.evaluateAll(roomId);
      this.track(this.maybeDigest(roomId, userId, lastSeen));
    }
    if (roomWasEmpty) this.rt('startRoom', (r) => r.startRoom(roomId));
    return disconnect;
  }

  /** An empty room keeps its agent session for a while (people drop out and come back), then it is stopped. */
  private scheduleIdleStop(roomId: RoomId): void {
    this.cancelIdleStop(roomId);
    if (this.closed || !this.runtime) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(roomId);
      if (this.closed || (this.conns.get(roomId)?.size ?? 0) > 0) return;
      // a merge in flight is still using the room: look again later
      if (this.storage.proposals.list(roomId, { states: ['merging'] }).length > 0)
        return this.scheduleIdleStop(roomId);
      this.rt('stopRoom', (r) => r.stopRoom(roomId));
    }, this.idleStopMs);
    timer.unref?.();
    this.idleTimers.set(roomId, timer);
  }

  private cancelIdleStop(roomId: RoomId): void {
    const t = this.idleTimers.get(roomId);
    if (t) clearTimeout(t);
    this.idleTimers.delete(roomId);
  }

  private broadcastPresence(roomId: RoomId): void {
    const room = this.storage.rooms.get(roomId);
    if (!room) return;
    const stored = new Map(this.storage.rooms.listPresence(roomId).map((p) => [p.userId, p]));
    const connected = this.connectedUserIds(roomId);
    const presence = this.storage.rooms.listParticipants(roomId).map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      connected: connected.has(p.userId),
      lastSeenAt: stored.get(p.userId)?.lastSeenAt ?? room.createdAt,
    }));
    this.broadcast(roomId, { type: 'presence.update', presence });
  }

  private notableEvents(roomId: RoomId, since: string): string[] {
    const after = (iso: string | null) => iso !== null && Date.parse(iso) > Date.parse(since);
    const events: string[] = [];
    const titleOf = (id: DocumentId) => this.storage.documents.get(id)?.title ?? 'a document';
    for (const doc of this.storage.documents.list(roomId, true)) {
      if (after(doc.createdAt)) events.push(`Document created: ${doc.title}`);
    }
    for (const c of this.storage.changes.list(roomId, { limit: 100 })) {
      if (!after(c.createdAt)) continue;
      const who = c.actor.kind === 'user' ? c.actor.displayName : `agent (${c.actor.role})`;
      events.push(
        `${c.revertsSha ? 'Revert' : 'Change'} on ${titleOf(c.documentId)} by ${who}: ${c.summary}`,
      );
    }
    for (const p of this.storage.proposals.list(roomId)) {
      if (after(p.openedAt)) events.push(`Proposal opened: ${p.title}`);
      if (after(p.closedAt)) events.push(`Proposal ${p.state}: ${p.title}`);
    }
    return events;
  }

  private async maybeDigest(
    roomId: RoomId,
    userId: UserId,
    lastSeen: string | null,
  ): Promise<void> {
    if (!lastSeen || !this.runtime) return;
    if (this.now().getTime() - Date.parse(lastSeen) < this.tunables.digestAbsenceMs) return;
    const events = this.notableEvents(roomId, lastSeen);
    if (events.length === 0) return;
    let sinceMessageId: MessageId | null = null;
    for (const m of this.storage.messages.list(roomId, { limit: 500, forUser: userId })) {
      if (Date.parse(m.createdAt) <= Date.parse(lastSeen)) sinceMessageId = m.id;
    }
    let body: string;
    try {
      body = await this.runtime.writeDigest(roomId, { userId, sinceMessageId, events });
    } catch (err) {
      this.log('error', 'runtime.writeDigest failed', {
        err: String((err as Error)?.message ?? err),
      });
      return;
    }
    if (!body || this.closed) return;
    this.createMessage(roomId, {
      author: { kind: 'agent', role: 'digest' },
      kind: 'card',
      body,
      card: { type: 'digest', sinceMessageId },
      privateTo: userId,
    });
  }

  async handle(roomId: RoomId, userId: UserId, cmd: ClientCommand): Promise<void> {
    const room = this.requireRoom(roomId);
    this.requireParticipant(roomId, userId);
    // an archived room is read-only history (archiving it again is a harmless no-op)
    if (room.archivedAt && cmd.type !== 'room.archive')
      throw new RoomError('conflict', 'this room is archived');
    switch (cmd.type) {
      case 'chat.send':
        return this.sendText(roomId, userId, cmd.body);
      case 'suggestion.create':
        return this.createSuggestion(roomId, userId, cmd.anchor, cmd.replacement, cmd.note);
      case 'ask.create':
        return this.createAsk(roomId, userId, cmd.anchor, cmd.question);
      case 'vote.cast':
        await this.castVote(roomId, userId, cmd.proposalId, cmd.decision, cmd.optionId);
        return;
      case 'revert.request':
        await this.revertChange(roomId, userId, cmd.sha);
        return;
      case 'document.create':
        await this.createDocument(roomId, userId, cmd.title);
        return;
      case 'document.rename':
        return this.renameDocument(roomId, userId, cmd.documentId, cmd.title);
      case 'document.archive':
        return this.archiveDocument(roomId, userId, cmd.documentId);
      case 'room.setRule':
        return this.setVotingRule(roomId, userId, cmd.votingRule);
      case 'room.archive':
        return this.archiveRoom(roomId, userId);
      default: {
        const never: never = cmd;
        throw new RoomError('invalid', `unknown command ${(never as { type?: string })?.type}`);
      }
    }
  }

  // ---------------------------------------------------------------- messages

  private sendText(roomId: RoomId, userId: UserId, body: string): void {
    if (!body || !body.trim()) throw new RoomError('invalid', 'message is empty');
    const message = this.createMessage(roomId, {
      author: this.actorFor(userId),
      kind: 'text',
      body,
    });
    this.rt('onChatMessage', (r) => r.onChatMessage(roomId, message));
  }

  private createSuggestion(
    roomId: RoomId,
    userId: UserId,
    anchor: Anchor,
    replacement: string,
    note?: string,
  ): void {
    this.requireDocument(roomId, anchor.documentId);
    const message = this.createMessage(roomId, {
      author: this.actorFor(userId),
      kind: 'card',
      body: note?.trim() ? note : 'Suggested an edit',
      anchor,
      card: {
        type: 'suggestion',
        anchor,
        replacement,
        status: 'pending',
        resolutionSha: null,
        note: note ?? null,
      },
    });
    this.rt('onSuggestion', (r) => r.onSuggestion(roomId, message));
  }

  private createAsk(roomId: RoomId, userId: UserId, anchor: Anchor, question: string): void {
    this.requireDocument(roomId, anchor.documentId);
    if (!question.trim()) throw new RoomError('invalid', 'question is empty');
    const message = this.createMessage(roomId, {
      author: this.actorFor(userId),
      kind: 'card',
      body: question,
      anchor,
      card: { type: 'ask', anchor, question },
    });
    this.rt('onAsk', (r) => r.onAsk(roomId, message));
  }

  async postChat(
    roomId: RoomId,
    input: { body: string; card?: Card | null; anchor?: Anchor | null; inReplyTo?: MessageId[] },
  ): Promise<Message> {
    this.requireRoom(roomId);
    return this.createMessage(roomId, {
      author: { kind: 'agent', role: 'orchestrator' },
      ...input,
    });
  }

  async updateCard(roomId: RoomId, messageId: MessageId, card: Card): Promise<Message> {
    const existing = this.storage.messages.get(messageId);
    if (!existing || existing.roomId !== roomId)
      throw new RoomError('not_found', 'message not found');
    const updated: Message = { ...existing, card, kind: 'card' };
    this.storage.messages.update(updated);
    this.broadcast(roomId, { type: 'chat.updated', message: updated }, updated.privateTo);
    return updated;
  }

  async sendPrivate(
    roomId: RoomId,
    userId: UserId,
    input: { body: string; card?: Card | null },
  ): Promise<Message> {
    this.requireRoom(roomId);
    return this.createMessage(roomId, {
      author: { kind: 'agent', role: 'orchestrator' },
      privateTo: userId,
      ...input,
    });
  }

  async readTranscript(
    roomId: RoomId,
    opts: { ids?: MessageId[]; sinceMessageId?: MessageId | null; limit?: number },
  ): Promise<Message[]> {
    const limit = opts.limit ?? 200;
    let msgs: Message[];
    if (opts.ids) msgs = this.storage.messages.getMany(opts.ids).filter((m) => m.roomId === roomId);
    else if (opts.sinceMessageId)
      msgs = this.storage.messages.since(roomId, opts.sinceMessageId, limit);
    else msgs = this.storage.messages.list(roomId, { limit });
    return msgs.filter((m) => m.privateTo === null);
  }

  // ---------------------------------------------------------------- agent status / usage

  async setAgentStatus(
    roomId: RoomId,
    status: 'idle' | 'thinking' | 'unavailable',
    detail: string | null = null,
  ): Promise<void> {
    this.agentStatus.set(roomId, { status, detail });
    this.broadcast(roomId, { type: 'agent.status', status, detail });
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.storage.usage.insert(record);
  }

  async repo(roomId: RoomId): Promise<RoomRepository> {
    this.requireRoom(roomId);
    return this.repo_(roomId);
  }

  // ---------------------------------------------------------------- changes

  async recordChange(
    roomId: RoomId,
    input: Omit<Change, 'roomId' | 'createdAt' | 'revertedBySha'>,
  ): Promise<Change> {
    this.requireRoom(roomId);
    const change: Change = { ...input, roomId, createdAt: this.nowIso(), revertedBySha: null };
    this.storage.changes.insert(change);
    this.createMessage(roomId, {
      author: change.actor,
      kind: 'card',
      body: change.summary,
      card: { type: 'change', change },
      inReplyTo: change.triggerMessageIds,
    });
    const repo = await this.repo_(roomId);
    const head = (await repo.headSha()) ?? change.sha;
    this.broadcast(roomId, {
      type: 'document.updated',
      documentId: change.documentId,
      headSha: head,
    });
    return change;
  }

  async revertChange(roomId: RoomId, userId: UserId, sha: Sha): Promise<Change> {
    const change = this.storage.changes.get(sha);
    if (!change || change.roomId !== roomId) throw new RoomError('not_found', 'change not found');
    if (change.revertedBySha || this.reverting.has(sha))
      throw new RoomError('conflict', 'change was already reverted');
    // claimed before the first await: a second request for the same change is refused here, not after a git failure
    this.reverting.add(sha);
    try {
      return await this.performRevert(roomId, userId, change);
    } finally {
      this.reverting.delete(sha);
    }
  }

  private async performRevert(roomId: RoomId, userId: UserId, change: Change): Promise<Change> {
    const sha = change.sha;
    const repo = await this.repo_(roomId);
    const meta: CommitMeta = {
      actor: this.actorFor(userId),
      triggerMessageIds: [],
      revertsSha: sha,
    };
    let revertSha: Sha;
    try {
      revertSha = await repo.withMainLock(async () => {
        // checked again under the lock: it may have been reverted while this request waited for it
        if (this.storage.changes.get(sha)?.revertedBySha)
          throw new RoomError('conflict', 'change was already reverted');
        return repo.revert(sha, meta);
      });
    } catch (err) {
      if (!(err instanceof RevertConflictError)) throw err;
      if (!this.runtime)
        throw new RoomError(
          'internal',
          'revert conflicts and no agent runtime is available to resolve it',
        );
      // Called outside the main lock: the runtime acquires it itself when it commits.
      revertSha = await this.runtime.runSemanticRevert(roomId, { change, byUserId: userId });
    }
    const revertChange: Change = {
      sha: revertSha,
      roomId,
      documentId: change.documentId,
      actor: this.actorFor(userId),
      summary: `Reverted: ${change.summary}`,
      triggerMessageIds: [],
      proposalId: change.proposalId,
      revertsSha: sha,
      revertedBySha: null,
      createdAt: this.nowIso(),
    };
    this.storage.changes.insert(revertChange);
    this.storage.changes.markReverted(sha, revertSha);
    this.markChangeCardReverted(roomId, sha, revertSha);
    if (change.proposalId) {
      const p = this.storage.proposals.get(change.proposalId);
      if (p && p.state === 'merged' && p.mergeSha === sha) {
        this.storage.proposals.setState(p.id, 'reverted');
        this.publishProposal(p.id);
      }
    }
    this.createMessage(roomId, {
      author: revertChange.actor,
      kind: 'card',
      body: revertChange.summary,
      card: { type: 'change', change: revertChange },
    });
    this.broadcast(roomId, {
      type: 'document.updated',
      documentId: change.documentId,
      headSha: revertSha,
    });
    this.rt('onReverted', (r) => r.onReverted(roomId, change, revertSha, userId));
    return revertChange;
  }

  /**
   * The Change card embeds its Change, so a revert has to rewrite the card that announced `sha`; otherwise it keeps
   * offering Revert to everyone, now and after a reload. Quiet when the card is not found (merges post a merge card).
   */
  private markChangeCardReverted(roomId: RoomId, sha: Sha, revertSha: Sha): void {
    const original = this.storage.messages
      .list(roomId, { limit: 1000 })
      .reverse()
      .find((m) => m.card?.type === 'change' && m.card.change.sha === sha);
    if (!original || original.card?.type !== 'change') return;
    const updated: Message = {
      ...original,
      card: { type: 'change', change: { ...original.card.change, revertedBySha: revertSha } },
    };
    this.storage.messages.update(updated);
    this.broadcast(roomId, { type: 'chat.updated', message: updated });
  }

  // ---------------------------------------------------------------- proposals

  async openProposal(
    roomId: RoomId,
    input: {
      documentId: DocumentId;
      kind: ProposalKind;
      title: string;
      branchBase: Sha;
      options: Array<{ label: string; branch: string; summary: string; tradeoffs: string }>;
      triggerMessageIds: MessageId[];
      stale?: boolean;
    },
  ): Promise<Proposal> {
    this.requireRoom(roomId);
    this.requireDocument(roomId, input.documentId);
    if (input.options.length === 0)
      throw new RoomError('invalid', 'a proposal needs at least one option');
    if (input.kind === 'review' && input.options.length !== 1)
      throw new RoomError('invalid', 'a review proposal has exactly one option');
    const repo = await this.repo_(roomId);
    // Validated and registered in one structural step, so a rename or archive of the document cannot slip in between.
    return this.structural(roomId, async () => {
      const doc = this.requireDocument(roomId, input.documentId);
      if (doc.status === 'archived') throw new RoomError('conflict', `${doc.path} is archived`);
      const options: ProposalOption[] = [];
      const proposalId = newId('prop');
      let branchBase: Sha | null = null;
      for (const o of input.options) {
        let head: Sha | null;
        let base: Sha;
        try {
          head = await repo.headSha(o.branch);
          if (!head) throw new RoomError('invalid', `branch ${o.branch} does not exist`);
          // The fork point comes from the repository, never from the caller: a "base" later than the real one would
          // hide earlier commits of the branch (to other documents, say) from the scope check below.
          base = await repo.mergeBase('main', o.branch);
        } catch (err) {
          if (err instanceof RoomError) throw err;
          throw new RoomError('invalid', `option ${o.label}: cannot compare ${o.branch} with main`);
        }
        const files = await repo.changedFiles(base, o.branch);
        if (files.length !== 1 || files[0] !== doc.path) {
          throw new RoomError(
            'invalid',
            `option ${o.label} must change only ${doc.path}, but changes: ${files.join(', ') || '(nothing)'}`,
          );
        }
        branchBase ??= base;
        options.push({
          id: newId('opt'),
          proposalId,
          label: o.label,
          branch: o.branch,
          summary: o.summary,
          tradeoffs: o.tradeoffs,
          headSha: head,
        });
      }
      if (branchBase !== input.branchBase)
        this.log('debug', 'proposal base taken from the repository, not the caller', {
          named: short(input.branchBase),
          used: short(branchBase),
        });
      const now = this.now();
      const proposal: Proposal = {
        id: proposalId,
        roomId,
        documentId: doc.id,
        kind: input.kind,
        state: 'open',
        title: input.title,
        branchBase: branchBase!,
        options,
        votes: [],
        windowClosesAt:
          input.kind === 'review'
            ? new Date(now.getTime() + this.tunables.reviewWindowMs).toISOString()
            : null,
        stale: input.stale ?? false,
        reconciled: false,
        mergedOptionId: null,
        mergeSha: null,
        triggerMessageIds: input.triggerMessageIds,
        cardMessageId: null,
        openedAt: now.toISOString(),
        closedAt: null,
        createdAt: now.toISOString(),
      };
      this.storage.proposals.create(proposal);
      const card = this.createMessage(roomId, {
        author: { kind: 'agent', role: 'orchestrator' },
        kind: 'card',
        body: input.title,
        card: { type: input.kind, proposalId },
        inReplyTo: input.triggerMessageIds,
      });
      this.storage.proposals.setState(proposalId, 'open', { cardMessageId: card.id });
      const stored = this.publishProposal(proposalId) ?? proposal;
      this.armWindow(stored);
      this.evaluate(roomId, proposalId);
      return stored;
    });
  }

  private armWindow(p: Proposal): void {
    this.clearWindow(p.id);
    if (this.closed || p.kind !== 'review' || p.state !== 'open' || !p.windowClosesAt) return;
    const delay = Math.max(0, Date.parse(p.windowClosesAt) - this.now().getTime());
    const t = setTimeout(() => {
      this.windowTimers.delete(p.id);
      this.evaluate(p.roomId, p.id, true);
    }, delay);
    this.windowTimers.set(p.id, t);
  }

  private clearWindow(id: ProposalId): void {
    const t = this.windowTimers.get(id);
    if (t) clearTimeout(t);
    this.windowTimers.delete(id);
  }

  async castVote(
    roomId: RoomId,
    userId: UserId,
    proposalId: ProposalId,
    decision: 'approve' | 'reject',
    optionId?: OptionId,
  ): Promise<Proposal> {
    this.requireRoom(roomId);
    const p = this.storage.proposals.get(proposalId);
    if (!p || p.roomId !== roomId) throw new RoomError('not_found', 'proposal not found');
    if (p.state !== 'open')
      throw new RoomError('conflict', `proposal is ${p.state}; votes are closed`);
    let voteOption: OptionId | null;
    if (p.kind === 'quorum') {
      if (decision !== 'approve')
        throw new RoomError('invalid', 'quorum proposals are voted by choosing an option');
      if (!optionId)
        throw new RoomError('invalid', 'optionId is required to vote on a quorum proposal');
      if (!p.options.some((o) => o.id === optionId))
        throw new RoomError('invalid', 'unknown option');
      voteOption = optionId;
    } else {
      const only = p.options[0]!;
      if (optionId && optionId !== only.id) throw new RoomError('invalid', 'unknown option');
      voteOption = decision === 'approve' ? only.id : null;
    }
    const vote: Vote = {
      proposalId,
      userId,
      optionId: voteOption,
      decision,
      castAt: this.nowIso(),
    };
    this.storage.proposals.clearVote(proposalId, userId);
    this.storage.proposals.castVote(vote);
    const updated = this.publishProposal(proposalId) ?? p;
    this.evaluate(roomId, proposalId);
    return updated;
  }

  private evaluateAll(roomId: RoomId): void {
    for (const p of this.storage.proposals.list(roomId, { states: ['open'] }))
      this.evaluate(roomId, p.id);
  }

  /**
   * The option of an open proposal that currently satisfies the merge rule, or null. The one place the rule lives:
   * evaluation (every vote, presence change and window end) and `requestMerge` both ask it.
   *
   *  - Review (PRD §4.4): the first approval from a connected participant merges it, or the objection window ending
   *    with no rejection; any rejection stops it (evaluate closes the proposal).
   *  - Quorum (PRD §7.2-7.3): the room's voting rule over the connected participants, agent excluded.
   */
  private passingOption(p: Proposal, opts: { windowElapsed?: boolean } = {}): OptionId | null {
    if (p.state !== 'open') return null;
    const eligible = this.connectedUserIds(p.roomId);
    if (p.kind === 'review') {
      if (p.votes.some((v) => v.decision === 'reject')) return null;
      const only = p.options[0]?.id ?? null;
      if (p.votes.some((v) => v.decision === 'approve' && eligible.has(v.userId))) return only;
      const elapsed =
        opts.windowElapsed ||
        (p.windowClosesAt !== null && Date.parse(p.windowClosesAt) <= this.now().getTime());
      return elapsed ? only : null;
    }
    const room = this.storage.rooms.get(p.roomId);
    if (!room) return null;
    const approvals = new Map<OptionId, number>();
    for (const v of p.votes) {
      if (v.decision !== 'approve' || !v.optionId || !eligible.has(v.userId)) continue;
      approvals.set(v.optionId, (approvals.get(v.optionId) ?? 0) + 1);
    }
    for (const [optionId, n] of approvals) {
      if (room.votingRule === 'unanimous' ? n === eligible.size && n > 0 : n > eligible.size / 2)
        return optionId;
    }
    return null;
  }

  /** Identifies the state of the votes, so "the same votes again" can be told from "someone voted since". */
  private voteFingerprint(p: Proposal): string {
    return p.votes
      .map((v) => `${v.userId}:${v.decision}:${v.optionId ?? ''}:${v.castAt}`)
      .sort()
      .join('|');
  }

  /** PRD §7.2-7.3. Synchronous decision; the merge itself runs in the background. */
  private evaluate(roomId: RoomId, proposalId: ProposalId, windowElapsed = false): void {
    if (this.closed || this.stopping) return;
    const p = this.storage.proposals.get(proposalId);
    if (!p || p.roomId !== roomId || p.state !== 'open') return;
    const room = this.storage.rooms.get(roomId);
    if (!room || room.archivedAt) return;

    if (p.kind === 'review') {
      const rejection = p.votes.find((v) => v.decision === 'reject');
      if (rejection) {
        this.finishClose(p, 'rejected', { byUserId: rejection.userId });
        return;
      }
    }
    const winner = this.passingOption(p, { windowElapsed });
    if (!winner) return;
    // A merge that failed is not tried again for the same votes, however often people come and go: it would fail
    // the same way and post the same failure each time. A new vote (or `requestMerge`) is a new attempt.
    if (this.failedMerges.get(p.id) === this.attemptKey(p, winner)) return;
    this.startMerge(p, winner);
  }

  private attemptKey(p: Proposal, optionId: OptionId): string {
    return `${optionId}|${this.voteFingerprint(p)}`;
  }

  /** open -> merging. A new attempt: whatever failed before is forgotten. */
  private enterMerging(p: Proposal): void {
    this.failedMerges.delete(p.id);
    this.storage.proposals.setState(p.id, 'merging');
    this.clearWindow(p.id);
    this.publishProposal(p.id);
  }

  private startMerge(p: Proposal, optionId: OptionId): void {
    this.enterMerging(p);
    this.track(this.runMerge(this.mergeProposal(p.roomId, p.id, optionId)).catch(() => undefined));
  }

  async requestMerge(roomId: RoomId, proposalId: ProposalId, optionId: OptionId): Promise<void> {
    this.requireRoom(roomId);
    const p = this.storage.proposals.get(proposalId);
    if (!p || p.roomId !== roomId) throw new RoomError('not_found', 'proposal not found');
    if (p.state !== 'open') throw new RoomError('conflict', `proposal is ${p.state}`);
    if (!p.options.some((o) => o.id === optionId)) throw new RoomError('invalid', 'unknown option');
    // Only what the vote has passed may be merged: the agent cannot use this to go around the room (PRD §7.2).
    if (this.passingOption(p) !== optionId) {
      throw new RoomError(
        'conflict',
        p.kind === 'review'
          ? p.votes.some((v) => v.decision === 'reject')
            ? 'the review was rejected'
            : 'nobody has approved yet and the objection window is still open'
          : `that option has not passed the room's ${this.storage.rooms.get(roomId)?.votingRule ?? ''} rule`,
      );
    }
    this.enterMerging(p); // an explicit request is a new attempt even if the same votes failed before
    await this.runMerge(this.mergeProposal(roomId, proposalId, optionId));
  }

  /** Everything the vote was about must still hold when the merge happens (and nothing else can write to main). */
  private async verifyOption(
    repo: RoomRepository,
    option: ProposalOption,
    doc: Document,
  ): Promise<void> {
    const head = await repo.headSha(option.branch);
    if (!head) throw new Error(`branch ${option.branch} no longer exists`);
    if (option.headSha && head !== option.headSha)
      throw new Error(
        `branch ${option.branch} changed after it was proposed (${short(option.headSha)} to ${short(head)}); the vote was about the earlier text`,
      );
    const base = await repo.mergeBase('main', option.branch);
    const files = await repo.changedFiles(base, option.branch);
    if (files.length !== 1 || files[0] !== doc.path)
      throw new Error(
        `option ${option.label} must change only ${doc.path}, but changes: ${files.join(', ') || '(nothing)'}`,
      );
  }

  /** Precondition: proposal is in state 'merging'. Rethrows after restoring state 'open' on failure. */
  private async mergeProposal(
    roomId: RoomId,
    proposalId: ProposalId,
    optionId: OptionId,
  ): Promise<void> {
    const p = this.storage.proposals.get(proposalId)!;
    const option = p.options.find((o) => o.id === optionId)!;
    const meta: CommitMeta = {
      actor: { kind: 'agent', role: 'merge' },
      triggerMessageIds: p.triggerMessageIds,
      proposalId: p.id,
    };
    const subject =
      p.kind === 'quorum' ? `Merge option ${option.label}: ${p.title}` : `Merge: ${p.title}`;
    let pendingWorktree = null as string | null;
    let repo: RoomRepository | null = null;
    let result: { sha: Sha; reconciled: boolean; summary: string };
    try {
      repo = await this.repo_(roomId);
      const r = repo;
      result = await r.withMainLock(async () => {
        const doc = this.storage.documents.get(p.documentId);
        if (!doc || doc.status !== 'active') throw new Error('the document is no longer active');
        await this.verifyOption(r, option, doc);
        const out = await r.beginMerge(option.branch);
        if (!out.worktreePath) throw new Error('merge returned no worktree');
        pendingWorktree = out.worktreePath;
        let reconciled = false;
        let summary = '';
        // 'fast-forward' means main has not moved since the branch point: the merge is already the voted text
        if (out.status !== 'fast-forward') {
          if (!this.runtime) throw new Error('no agent runtime available to reconcile the merge');
          const driver = await this.runtime.runMergeDriver(roomId, {
            proposal: p,
            optionId,
            worktreePath: out.worktreePath,
            conflictedFiles: out.conflictedFiles,
            documentPath: doc.path,
          });
          reconciled = driver.reconciled;
          summary = driver.summary;
        }
        const sha = await r.finishMerge(out.worktreePath, subject, meta, { paths: [doc.path] });
        pendingWorktree = null;
        return { sha, reconciled, summary };
      });
    } catch (err) {
      const reason = String((err as Error)?.message ?? err);
      if (repo && pendingWorktree) {
        try {
          await repo.abortMerge(pendingWorktree);
        } catch (abortErr) {
          this.log('warn', 'abortMerge failed', {
            err: String((abortErr as Error)?.message ?? abortErr),
          });
        }
      }
      this.log('warn', 'merge failed', { proposalId, reason });
      const reopened = this.storage.proposals.setState(proposalId, 'open');
      this.failedMerges.set(proposalId, this.attemptKey(reopened, optionId));
      this.publishProposal(proposalId);
      this.systemMessage(
        roomId,
        `Merging "${p.title}" failed: ${reason}. The proposal stays open; vote again to try once more.`,
      );
      this.rt('onProposalEvent', (r) =>
        r.onProposalEvent(roomId, { type: 'merge_failed', proposal: reopened, reason }),
      );
      throw err;
    }

    // The merge is on main from here on: bookkeeping that fails must never reopen the proposal. It is completed by
    // the same recovery that handles a restart, which finds the merge on main and records it (idempotently).
    try {
      await this.recordMerge(p, option, result, repo);
    } catch (err) {
      this.log('error', 'recording a merge failed; completing it through recovery', {
        proposalId,
        err: String((err as Error)?.message ?? err),
      });
      await this.recoverMerging(roomId, proposalId);
    }
  }

  /** Book a merge that is on main: Change row, proposal state, milestone, merge card, events, worktree cleanup. */
  private async recordMerge(
    p: Proposal,
    option: ProposalOption,
    result: { sha: Sha; reconciled: boolean; summary: string },
    repo: RoomRepository | null,
  ): Promise<void> {
    const roomId = p.roomId;
    const closedAt = this.nowIso();
    const change: Change = {
      sha: result.sha,
      roomId,
      documentId: p.documentId,
      actor: { kind: 'agent', role: 'merge' },
      summary: p.kind === 'quorum' ? `${p.title} (option ${option.label})` : p.title,
      triggerMessageIds: p.triggerMessageIds,
      proposalId: p.id,
      revertsSha: null,
      revertedBySha: null,
      createdAt: closedAt,
    };
    let merged!: Proposal;
    this.storage.transaction(() => {
      if (!this.storage.changes.get(result.sha)) this.storage.changes.insert(change);
      merged = this.storage.proposals.setState(p.id, 'merged', {
        closedAt,
        mergedOptionId: option.id,
        mergeSha: result.sha,
        reconciled: result.reconciled,
      });
    });
    this.failedMerges.delete(p.id);
    this.cleanupWorktrees(p);
    if (p.kind === 'quorum' && repo) {
      const n = this.storage.proposals
        .list(roomId, { states: ['merged', 'reverted'] })
        .filter((x) => x.kind === 'quorum').length;
      try {
        await repo.tag(`milestone/${n}`, `Proposal ${p.id}: ${p.title}`, result.sha);
      } catch (err) {
        this.log('warn', 'tagging milestone failed', {
          err: String((err as Error)?.message ?? err),
        });
      }
    }
    const summary =
      result.summary ||
      (result.reconciled
        ? `Merged ${option.label}; the merge was reconciled.`
        : `Merged ${option.label}: ${p.title}`);
    this.createMessage(roomId, {
      author: { kind: 'agent', role: 'merge' },
      kind: 'card',
      body: summary,
      card: {
        type: 'merge',
        proposalId: p.id,
        optionId: option.id,
        sha: result.sha,
        reconciled: result.reconciled,
        summary,
      },
      inReplyTo: p.triggerMessageIds,
    });
    this.broadcast(roomId, {
      type: 'document.updated',
      documentId: p.documentId,
      headSha: result.sha,
    });
    this.publishProposal(p.id);
    this.rt('onProposalEvent', (r) =>
      r.onProposalEvent(roomId, {
        type: 'merged',
        proposal: merged,
        optionId: option.id,
        sha: result.sha,
        reconciled: result.reconciled,
      }),
    );
  }

  /**
   * A proposal found in `merging` (a restart, or bookkeeping that failed) is settled by looking at main: when the head
   * of one of its options is contained in main the merge happened and is recorded now; otherwise nothing was merged
   * and the proposal is reopened with a message. Never throws.
   */
  private async recoverMerging(roomId: RoomId, proposalId: ProposalId): Promise<void> {
    try {
      const p = this.storage.proposals.get(proposalId);
      if (!p || p.roomId !== roomId || p.state !== 'merging') return;
      const repo = await this.repo_(roomId);
      let landed: ProposalOption | null = null;
      for (const o of p.options) {
        if (!o.headSha) continue;
        const base = await repo.mergeBase(o.headSha, 'main').catch(() => null);
        if (base === o.headSha) {
          landed = o;
          break;
        }
      }
      if (landed) {
        // the merge commit carries the proposal in its trailers; a branch that was fast-forwarded by an older version
        // has none, and then its own head is the commit that landed
        const commits = await repo.log(null, 'main', 200);
        const mergeCommit = commits.find(
          (c) => c.trailers.proposalId === p.id && c.trailers.revertsSha === null,
        );
        const sha = mergeCommit?.sha ?? landed.headSha!;
        const parent = await repo.headSha(`${sha}^1`).catch(() => null);
        // main had moved since the branch point exactly when the merge needed the driver
        const reconciled =
          parent !== null &&
          (await repo.mergeBase(parent, landed.headSha!).catch(() => parent)) !== parent;
        this.log('info', 'completing a merge that reached main before the restart', {
          proposalId,
          sha: short(sha),
        });
        await this.recordMerge(
          p,
          landed,
          {
            sha,
            reconciled,
            summary: `Merged ${landed.label}: ${p.title}${reconciled ? ' (reconciled with later edits)' : ''}`,
          },
          repo,
        );
        return;
      }
      const reopened = this.storage.proposals.setState(proposalId, 'open');
      this.publishProposal(proposalId);
      this.systemMessage(
        roomId,
        `Merging "${p.title}" was interrupted before anything reached main. The proposal is open again.`,
      );
      this.armWindow(reopened);
      this.evaluate(roomId, proposalId);
    } catch (err) {
      this.log('error', 'recovering a proposal left in merging failed', {
        proposalId,
        err: String((err as Error)?.message ?? err),
      });
    }
  }

  /** A proposal that reached a terminal state no longer needs its option worktrees; the branches stay (history). */
  private cleanupWorktrees(p: Proposal): void {
    this.track(
      (async () => {
        const repo = await this.repo_(p.roomId);
        for (const o of p.options) {
          await repo.removeWorktree(o.branch).catch((err) =>
            this.log('warn', 'removing an option worktree failed', {
              branch: o.branch,
              err: String((err as Error)?.message ?? err),
            }),
          );
        }
      })(),
    );
  }

  async closeProposal(
    roomId: RoomId,
    proposalId: ProposalId,
    reason: 'expired' | 'rejected' | 'abandoned',
    note?: string,
  ): Promise<Proposal> {
    this.requireRoom(roomId);
    const p = this.storage.proposals.get(proposalId);
    if (!p || p.roomId !== roomId) throw new RoomError('not_found', 'proposal not found');
    if (p.state !== 'open' && p.state !== 'drafting')
      throw new RoomError('conflict', `proposal is ${p.state}`);
    const rejecter = p.votes.find((v) => v.decision === 'reject');
    return this.finishClose(p, reason, { note, byUserId: rejecter?.userId ?? '' });
  }

  private finishClose(
    p: Proposal,
    reason: 'expired' | 'rejected' | 'abandoned',
    opts: { byUserId?: UserId; note?: string },
  ): Proposal {
    const closed = this.storage.proposals.setState(p.id, reason, { closedAt: this.nowIso() });
    this.clearWindow(p.id);
    this.failedMerges.delete(p.id);
    this.cleanupWorktrees(p);
    this.publishProposal(p.id);
    const verb =
      reason === 'rejected' ? 'was rejected' : reason === 'expired' ? 'expired' : 'was abandoned';
    this.systemMessage(
      p.roomId,
      `Proposal "${p.title}" ${verb}${opts.note ? `: ${opts.note}` : '.'} It is archived.`,
    );
    if (reason === 'rejected') {
      this.rt('onProposalEvent', (r) =>
        r.onProposalEvent(p.roomId, {
          type: 'rejected',
          proposal: closed,
          byUserId: opts.byUserId ?? '',
        }),
      );
    } else {
      this.rt('onProposalEvent', (r) =>
        r.onProposalEvent(p.roomId, { type: reason, proposal: closed }),
      );
    }
    return closed;
  }
}
