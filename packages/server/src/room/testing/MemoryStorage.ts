import { newId } from '@quorum/shared';
import type {
  Change,
  Document,
  Message,
  Participant,
  PresenceEntry,
  Proposal,
  Room,
  UsageRecord,
  Vote,
} from '@quorum/shared';
import type { Storage, User } from '../../contracts/index.js';

/** Minimal in-memory Storage for RoomService tests. */
export class MemoryStorage implements Storage {
  private _users = new Map<string, User>();
  private _sessions = new Map<string, string>();
  private _rooms = new Map<string, Room>();
  private _participants: Participant[] = [];
  private _presence = new Map<string, PresenceEntry>();
  private _messages: Message[] = [];
  private _docs = new Map<string, Document>();
  private _proposals = new Map<string, Proposal>();
  private _changes: Change[] = [];
  private _usage: UsageRecord[] = [];
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  users = {
    create: (displayName: string): User => {
      const u = { id: newId('user'), displayName, createdAt: this.clock().toISOString() };
      this._users.set(u.id, u);
      return u;
    },
    get: (id: string) => this._users.get(id) ?? null,
    findByDisplayName: (name: string) => [...this._users.values()].find((u) => u.displayName === name) ?? null,
  };

  sessions = {
    create: (userId: string) => {
      const token = `tok_${++this.seq}_${Math.random().toString(36).slice(2)}`;
      this._sessions.set(token, userId);
      return { token, userId };
    },
    resolve: (token: string) => this._sessions.get(token) ?? null,
    revoke: (token: string) => void this._sessions.delete(token),
  };

  rooms = {
    create: (input: { name: string; ownerId: string; votingRule?: 'unanimous' | 'majority' }): Room => {
      const room: Room = {
        id: newId('room'),
        name: input.name,
        ownerId: input.ownerId,
        votingRule: input.votingRule ?? 'unanimous',
        createdAt: this.clock().toISOString(),
        archivedAt: null,
      };
      this._rooms.set(room.id, room);
      return room;
    },
    get: (id: string) => this._rooms.get(id) ?? null,
    list: () => [...this._rooms.values()],
    setVotingRule: (id: string, rule: 'unanimous' | 'majority') => {
      const r = this._rooms.get(id);
      if (r) r.votingRule = rule;
    },
    archive: (id: string) => {
      const r = this._rooms.get(id);
      if (r) r.archivedAt = this.clock().toISOString();
    },
    addParticipant: (p: Participant) => {
      if (!this._participants.some((x) => x.roomId === p.roomId && x.userId === p.userId)) this._participants.push(p);
    },
    listParticipants: (roomId: string) => this._participants.filter((p) => p.roomId === roomId),
    upsertPresence: (roomId: string, userId: string, connected: boolean, at: string) => {
      const u = this._users.get(userId);
      this._presence.set(`${roomId}:${userId}`, { userId, displayName: u?.displayName ?? userId, connected, lastSeenAt: at });
    },
    listPresence: (roomId: string) => [...this._presence.entries()].filter(([k]) => k.startsWith(`${roomId}:`)).map(([, v]) => v),
    getLastSeen: (roomId: string, userId: string) => this._presence.get(`${roomId}:${userId}`)?.lastSeenAt ?? null,
  };

  messages = {
    insert: (m: Message) => void this._messages.push(m),
    update: (m: Message) => {
      const i = this._messages.findIndex((x) => x.id === m.id);
      if (i >= 0) this._messages[i] = m;
    },
    get: (id: string) => this._messages.find((m) => m.id === id) ?? null,
    getMany: (ids: string[]) => this._messages.filter((m) => ids.includes(m.id)),
    list: (roomId: string, opts: { before?: string; after?: string; limit: number; forUser?: string }) => {
      let ms = this._messages.filter((m) => m.roomId === roomId && (m.privateTo === null || m.privateTo === opts.forUser));
      if (opts.before) {
        const i = ms.findIndex((m) => m.id === opts.before);
        if (i >= 0) ms = ms.slice(0, i);
      }
      if (opts.after) {
        const i = ms.findIndex((m) => m.id === opts.after);
        if (i >= 0) ms = ms.slice(i + 1);
      }
      return ms.slice(-opts.limit);
    },
    since: (roomId: string, sinceId: string | null, limit: number) => {
      const ms = this._messages.filter((m) => m.roomId === roomId);
      const i = sinceId ? ms.findIndex((m) => m.id === sinceId) : -1;
      return ms.slice(i + 1, i + 1 + limit);
    },
    countSince: (roomId: string, sinceId: string | null) => this.messages.since(roomId, sinceId, Infinity).length,
  };

  documents = {
    create: (input: { id?: string; roomId: string; path: string; title: string }): Document => {
      const d: Document = {
        id: input.id ?? newId('doc'),
        roomId: input.roomId,
        path: input.path,
        title: input.title,
        status: 'active',
        createdAt: this.clock().toISOString(),
      };
      this._docs.set(d.id, d);
      return d;
    },
    get: (id: string) => this._docs.get(id) ?? null,
    getByPath: (roomId: string, path: string) => [...this._docs.values()].find((d) => d.roomId === roomId && d.path === path) ?? null,
    list: (roomId: string, includeArchived = false) =>
      [...this._docs.values()].filter((d) => d.roomId === roomId && (includeArchived || d.status === 'active')),
    rename: (id: string, title: string, path: string) => {
      const d = this._docs.get(id);
      if (d) Object.assign(d, { title, path });
    },
    archive: (id: string) => {
      const d = this._docs.get(id);
      if (d) d.status = 'archived';
    },
  };

  proposals = {
    create: (p: Proposal) => void this._proposals.set(p.id, structuredClone(p)),
    get: (id: string): Proposal | null => {
      const p = this._proposals.get(id);
      return p ? structuredClone(p) : null;
    },
    list: (roomId: string, opts?: { states?: string[]; documentId?: string }) =>
      [...this._proposals.values()]
        .filter((p) => p.roomId === roomId)
        .filter((p) => !opts?.states || opts.states.includes(p.state))
        .filter((p) => !opts?.documentId || p.documentId === opts.documentId)
        .map((p) => structuredClone(p)),
    setState: (id: string, state: Proposal['state'], patch?: Partial<Proposal>): Proposal => {
      const p = this._proposals.get(id);
      if (!p) throw new Error('no proposal');
      Object.assign(p, patch ?? {}, { state });
      return structuredClone(p);
    },
    updateOption: (o: Proposal['options'][number]) => {
      const p = this._proposals.get(o.proposalId);
      if (p) p.options = p.options.map((x) => (x.id === o.id ? o : x));
    },
    castVote: (v: Vote) => {
      const p = this._proposals.get(v.proposalId);
      if (!p) return;
      p.votes = p.votes.filter((x) => x.userId !== v.userId).concat(v);
    },
    clearVote: (proposalId: string, userId: string) => {
      const p = this._proposals.get(proposalId);
      if (p) p.votes = p.votes.filter((x) => x.userId !== userId);
    },
    listVotes: (id: string) => this._proposals.get(id)?.votes ?? [],
  };

  changes = {
    insert: (c: Change) => void this._changes.push(structuredClone(c)),
    get: (sha: string) => {
      const c = this._changes.find((x) => x.sha === sha);
      return c ? structuredClone(c) : null;
    },
    list: (roomId: string, opts?: { documentId?: string; limit?: number }) =>
      this._changes
        .filter((c) => c.roomId === roomId && (!opts?.documentId || c.documentId === opts.documentId))
        .slice(-(opts?.limit ?? 1000))
        .reverse()
        .map((c) => structuredClone(c)),
    markReverted: (sha: string, by: string) => {
      const c = this._changes.find((x) => x.sha === sha);
      if (c) c.revertedBySha = by;
    },
  };

  usage = {
    insert: (r: UsageRecord) => void this._usage.push(r),
    summarize: (roomId: string) => {
      const byRole: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }> = {};
      let total = 0;
      for (const r of this._usage.filter((u) => u.roomId === roomId)) {
        const b = (byRole[r.role] ??= { costUsd: 0, inputTokens: 0, outputTokens: 0 });
        b.costUsd += r.costUsd;
        b.inputTokens += r.inputTokens;
        b.outputTokens += r.outputTokens;
        total += r.costUsd;
      }
      return { totalCostUsd: total, byRole };
    },
  };

  transaction<T>(fn: () => T): T {
    return fn();
  }
  close(): void {}
}
