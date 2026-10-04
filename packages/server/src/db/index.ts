import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  newId,
  type ActorRef,
  type Anchor,
  type Card,
  type Change,
  type Document,
  type DocumentId,
  type Message,
  type MessageId,
  type Participant,
  type PresenceEntry,
  type Proposal,
  type ProposalId,
  type ProposalOption,
  type ProposalState,
  type Room,
  type RoomId,
  type Sha,
  type UsageRecord,
  type UserId,
  type Vote,
  type VotingRule,
} from '@quorum/shared';
import type {
  ChangeRepo,
  DocumentRepo,
  MessageRepo,
  ProposalRepo,
  RoomRepo,
  SessionRepo,
  Storage,
  UsageRepo,
  User,
  UserRepo,
} from '../contracts/storage.js';
import { migrations } from './schema.js';

type Row = Record<string, any>;

const nowIso = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);

/**
 * Open (creating if needed) the Quorum SQLite database at `filePath` and apply migrations.
 * `':memory:'` gives a private in-memory database (tests).
 */
export function openStorage(filePath: string): Storage {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000;');
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  const cache = new Map<string, StatementSync>();
  const prep = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const get = (sql: string, ...params: SQLInputValue[]): Row | null => (prep(sql).get(...params) as Row | undefined) ?? null;
  const all = (sql: string, ...params: SQLInputValue[]): Row[] => prep(sql).all(...params) as Row[];
  const run = (sql: string, ...params: SQLInputValue[]): void => {
    prep(sql).run(...params);
  };

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    const outer = depth === 0;
    const sp = `sp_${depth}`;
    db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth++;
    try {
      const result = fn();
      depth--;
      db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      depth--;
      try {
        db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch {
        /* the original error matters more */
      }
      throw err;
    }
  }

  // migrations
  const current = (get('PRAGMA user_version') as Row).user_version as number;
  for (let i = current; i < migrations.length; i++) {
    transaction(() => {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }

  // ---- users ----
  const toUser = (r: Row): User => ({ id: r.id, displayName: r.displayName, createdAt: r.createdAt });
  const users: UserRepo = {
    create(displayName) {
      const user: User = { id: newId('user'), displayName, createdAt: nowIso() };
      run('INSERT INTO users (id, displayName, createdAt) VALUES (?, ?, ?)', user.id, user.displayName, user.createdAt);
      return user;
    },
    get(userId) {
      const r = get('SELECT * FROM users WHERE id = ?', userId);
      return r ? toUser(r) : null;
    },
    findByDisplayName(displayName) {
      const r = get('SELECT * FROM users WHERE displayName = ?', displayName);
      return r ? toUser(r) : null;
    },
  };

  // ---- sessions ----
  const sessions: SessionRepo = {
    create(userId) {
      const token = randomBytes(32).toString('hex');
      run('INSERT INTO sessions (token, userId, createdAt) VALUES (?, ?, ?)', token, userId, nowIso());
      return { token, userId };
    },
    resolve(token) {
      const r = get('SELECT userId FROM sessions WHERE token = ?', token);
      return r ? (r.userId as UserId) : null;
    },
    revoke(token) {
      run('DELETE FROM sessions WHERE token = ?', token);
    },
  };

  // ---- rooms ----
  const toRoom = (r: Row): Room => ({
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    votingRule: r.votingRule as VotingRule,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt ?? null,
  });
  const rooms: RoomRepo = {
    create(input) {
      const room: Room = {
        id: newId('room'),
        name: input.name,
        ownerId: input.ownerId,
        votingRule: input.votingRule ?? 'unanimous',
        createdAt: nowIso(),
        archivedAt: null,
      };
      run(
        'INSERT INTO rooms (id, name, ownerId, votingRule, createdAt, archivedAt) VALUES (?, ?, ?, ?, ?, NULL)',
        room.id,
        room.name,
        room.ownerId,
        room.votingRule,
        room.createdAt,
      );
      return room;
    },
    get(roomId) {
      const r = get('SELECT * FROM rooms WHERE id = ?', roomId);
      return r ? toRoom(r) : null;
    },
    list() {
      return all('SELECT * FROM rooms ORDER BY createdAt, rowid').map(toRoom);
    },
    setVotingRule(roomId, rule) {
      run('UPDATE rooms SET votingRule = ? WHERE id = ?', rule, roomId);
    },
    archive(roomId) {
      run('UPDATE rooms SET archivedAt = ? WHERE id = ? AND archivedAt IS NULL', nowIso(), roomId);
    },
    addParticipant(p: Participant) {
      run(
        `INSERT INTO participants (roomId, userId, displayName, role) VALUES (?, ?, ?, ?)
         ON CONFLICT (roomId, userId) DO UPDATE SET displayName = excluded.displayName, role = excluded.role`,
        p.roomId,
        p.userId,
        p.displayName,
        p.role,
      );
    },
    listParticipants(roomId) {
      return all('SELECT * FROM participants WHERE roomId = ? ORDER BY rowid', roomId).map((r) => ({
        roomId: r.roomId,
        userId: r.userId,
        displayName: r.displayName,
        role: r.role,
      }));
    },
    upsertPresence(roomId, userId, connected, at) {
      run(
        `INSERT INTO presence (roomId, userId, connected, lastSeenAt) VALUES (?, ?, ?, ?)
         ON CONFLICT (roomId, userId) DO UPDATE SET connected = excluded.connected, lastSeenAt = excluded.lastSeenAt`,
        roomId,
        userId,
        connected ? 1 : 0,
        at,
      );
    },
    listPresence(roomId): PresenceEntry[] {
      return all(
        `SELECT p.userId AS userId, p.connected AS connected, p.lastSeenAt AS lastSeenAt,
                COALESCE(pa.displayName, u.displayName, p.userId) AS displayName
           FROM presence p
           LEFT JOIN participants pa ON pa.roomId = p.roomId AND pa.userId = p.userId
           LEFT JOIN users u ON u.id = p.userId
          WHERE p.roomId = ?
          ORDER BY p.rowid`,
        roomId,
      ).map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        connected: r.connected === 1,
        lastSeenAt: r.lastSeenAt,
      }));
    },
    getLastSeen(roomId, userId) {
      const r = get('SELECT lastSeenAt FROM presence WHERE roomId = ? AND userId = ?', roomId, userId);
      return r ? (r.lastSeenAt as string) : null;
    },
  };

  // ---- messages ----
  const toMessage = (r: Row): Message => ({
    id: r.id,
    roomId: r.roomId,
    author: JSON.parse(r.author) as ActorRef,
    kind: r.kind,
    body: r.body,
    card: r.card == null ? null : (JSON.parse(r.card) as Card),
    anchor: r.anchor == null ? null : (JSON.parse(r.anchor) as Anchor),
    privateTo: r.privateTo ?? null,
    inReplyTo: JSON.parse(r.inReplyTo) as MessageId[],
    createdAt: r.createdAt,
  });
  const msgSeq = (id: MessageId | null | undefined): number | null => {
    if (!id) return null;
    const r = get('SELECT seq FROM messages WHERE id = ?', id);
    return r ? (r.seq as number) : null;
  };
  /** private messages are visible only to their addressee; with no `forUser` only public ones are returned */
  const VISIBLE = '(privateTo IS NULL OR privateTo = ?)';
  const messages: MessageRepo = {
    insert(m) {
      run(
        `INSERT INTO messages (id, roomId, author, kind, body, card, anchor, privateTo, inReplyTo, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id,
        m.roomId,
        json(m.author),
        m.kind,
        m.body,
        m.card ? json(m.card) : null,
        m.anchor ? json(m.anchor) : null,
        m.privateTo,
        json(m.inReplyTo),
        m.createdAt,
      );
    },
    update(m) {
      run(
        `UPDATE messages SET author = ?, kind = ?, body = ?, card = ?, anchor = ?, privateTo = ?, inReplyTo = ?
          WHERE id = ?`,
        json(m.author),
        m.kind,
        m.body,
        m.card ? json(m.card) : null,
        m.anchor ? json(m.anchor) : null,
        m.privateTo,
        json(m.inReplyTo),
        m.id,
      );
    },
    get(id) {
      const r = get('SELECT * FROM messages WHERE id = ?', id);
      return r ? toMessage(r) : null;
    },
    getMany(ids) {
      const out: Message[] = [];
      for (const id of ids) {
        const m = messages.get(id);
        if (m) out.push(m);
      }
      return out;
    },
    list(roomId, opts) {
      const viewer = opts.forUser ?? '';
      const limit = Math.max(0, Math.floor(opts.limit));
      const afterSeq = msgSeq(opts.after);
      if (afterSeq != null) {
        return all(
          `SELECT * FROM messages WHERE roomId = ? AND seq > ? AND ${VISIBLE} ORDER BY seq ASC LIMIT ?`,
          roomId,
          afterSeq,
          viewer,
          limit,
        ).map(toMessage);
      }
      const beforeSeq = msgSeq(opts.before);
      const rows =
        beforeSeq != null
          ? all(
              `SELECT * FROM messages WHERE roomId = ? AND seq < ? AND ${VISIBLE} ORDER BY seq DESC LIMIT ?`,
              roomId,
              beforeSeq,
              viewer,
              limit,
            )
          : all(`SELECT * FROM messages WHERE roomId = ? AND ${VISIBLE} ORDER BY seq DESC LIMIT ?`, roomId, viewer, limit);
      return rows.reverse().map(toMessage);
    },
    since(roomId, sinceMessageId, limit) {
      const seq = msgSeq(sinceMessageId) ?? 0;
      return all(
        'SELECT * FROM messages WHERE roomId = ? AND seq > ? AND privateTo IS NULL ORDER BY seq ASC LIMIT ?',
        roomId,
        seq,
        Math.max(0, Math.floor(limit)),
      ).map(toMessage);
    },
    countSince(roomId, sinceMessageId) {
      const seq = msgSeq(sinceMessageId) ?? 0;
      const r = get(
        'SELECT COUNT(*) AS n FROM messages WHERE roomId = ? AND seq > ? AND privateTo IS NULL',
        roomId,
        seq,
      ) as Row;
      return r.n as number;
    },
  };

  // ---- documents ----
  const toDocument = (r: Row): Document => ({
    id: r.id,
    roomId: r.roomId,
    path: r.path,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
  });
  const documents: DocumentRepo = {
    create(input) {
      const doc: Document = {
        id: input.id ?? newId('doc'),
        roomId: input.roomId,
        path: input.path,
        title: input.title,
        status: 'active',
        createdAt: nowIso(),
      };
      run(
        'INSERT INTO documents (id, roomId, path, title, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        doc.id,
        doc.roomId,
        doc.path,
        doc.title,
        doc.status,
        doc.createdAt,
      );
      return doc;
    },
    get(id) {
      const r = get('SELECT * FROM documents WHERE id = ?', id);
      return r ? toDocument(r) : null;
    },
    getByPath(roomId, path) {
      // an archived document may share a path with a newer active one; prefer the active one
      const r = get(
        `SELECT * FROM documents WHERE roomId = ? AND path = ?
          ORDER BY (status = 'active') DESC, createdAt DESC, rowid DESC LIMIT 1`,
        roomId,
        path,
      );
      return r ? toDocument(r) : null;
    },
    list(roomId, includeArchived = false) {
      const rows = includeArchived
        ? all('SELECT * FROM documents WHERE roomId = ? ORDER BY createdAt, rowid', roomId)
        : all("SELECT * FROM documents WHERE roomId = ? AND status = 'active' ORDER BY createdAt, rowid", roomId);
      return rows.map(toDocument);
    },
    rename(id, title, path) {
      run('UPDATE documents SET title = ?, path = ? WHERE id = ?', title, path, id);
    },
    archive(id) {
      run("UPDATE documents SET status = 'archived' WHERE id = ?", id);
    },
  };

  // ---- proposals ----
  const toOption = (r: Row): ProposalOption => ({
    id: r.id,
    proposalId: r.proposalId,
    label: r.label,
    branch: r.branch,
    summary: r.summary,
    tradeoffs: r.tradeoffs,
    headSha: r.headSha ?? null,
  });
  const toVote = (r: Row): Vote => ({
    proposalId: r.proposalId,
    userId: r.userId,
    optionId: r.optionId ?? null,
    decision: r.decision,
    castAt: r.castAt,
  });
  const listVotes = (proposalId: ProposalId): Vote[] =>
    all('SELECT * FROM votes WHERE proposalId = ? ORDER BY castAt, rowid', proposalId).map(toVote);
  const listOptions = (proposalId: ProposalId): ProposalOption[] =>
    all('SELECT * FROM options WHERE proposalId = ? ORDER BY position', proposalId).map(toOption);
  const toProposal = (r: Row): Proposal => ({
    id: r.id,
    roomId: r.roomId,
    documentId: r.documentId,
    kind: r.kind,
    state: r.state,
    title: r.title,
    branchBase: r.branchBase,
    options: listOptions(r.id),
    votes: listVotes(r.id),
    windowClosesAt: r.windowClosesAt ?? null,
    stale: r.stale === 1,
    reconciled: r.reconciled === 1,
    mergedOptionId: r.mergedOptionId ?? null,
    mergeSha: r.mergeSha ?? null,
    triggerMessageIds: JSON.parse(r.triggerMessageIds) as MessageId[],
    cardMessageId: r.cardMessageId ?? null,
    openedAt: r.openedAt ?? null,
    closedAt: r.closedAt ?? null,
    createdAt: r.createdAt,
  });
  const insertVote = (v: Vote) =>
    run(
      `INSERT INTO votes (proposalId, userId, optionId, decision, castAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (proposalId, userId) DO UPDATE SET
         optionId = excluded.optionId, decision = excluded.decision, castAt = excluded.castAt`,
      v.proposalId,
      v.userId,
      v.optionId,
      v.decision,
      v.castAt,
    );
  const PATCHABLE = {
    openedAt: 'openedAt',
    closedAt: 'closedAt',
    mergedOptionId: 'mergedOptionId',
    mergeSha: 'mergeSha',
    windowClosesAt: 'windowClosesAt',
    cardMessageId: 'cardMessageId',
    stale: 'stale',
    reconciled: 'reconciled',
    title: 'title',
  } as const;
  const proposals: ProposalRepo = {
    create(p) {
      transaction(() => {
        run(
          `INSERT INTO proposals (id, roomId, documentId, kind, state, title, branchBase, windowClosesAt, stale,
             reconciled, mergedOptionId, mergeSha, triggerMessageIds, cardMessageId, openedAt, closedAt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p.id,
          p.roomId,
          p.documentId,
          p.kind,
          p.state,
          p.title,
          p.branchBase,
          p.windowClosesAt,
          p.stale ? 1 : 0,
          p.reconciled ? 1 : 0,
          p.mergedOptionId,
          p.mergeSha,
          json(p.triggerMessageIds),
          p.cardMessageId,
          p.openedAt,
          p.closedAt,
          p.createdAt,
        );
        p.options.forEach((o, i) =>
          run(
            `INSERT INTO options (id, proposalId, position, label, branch, summary, tradeoffs, headSha)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            o.id,
            p.id,
            i,
            o.label,
            o.branch,
            o.summary,
            o.tradeoffs,
            o.headSha,
          ),
        );
        for (const v of p.votes) insertVote({ ...v, proposalId: p.id });
      });
    },
    get(id) {
      const r = get('SELECT * FROM proposals WHERE id = ?', id);
      return r ? toProposal(r) : null;
    },
    list(roomId, opts) {
      const where = ['roomId = ?'];
      const params: SQLInputValue[] = [roomId];
      if (opts?.states) {
        if (opts.states.length === 0) return [];
        where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
        params.push(...opts.states);
      }
      if (opts?.documentId) {
        where.push('documentId = ?');
        params.push(opts.documentId);
      }
      return all(`SELECT * FROM proposals WHERE ${where.join(' AND ')} ORDER BY createdAt, rowid`, ...params).map(toProposal);
    },
    setState(proposalId: ProposalId, state: ProposalState, patch) {
      const sets = ['state = ?'];
      const params: SQLInputValue[] = [state];
      for (const [key, value] of Object.entries(patch ?? {})) {
        const col = PATCHABLE[key as keyof typeof PATCHABLE];
        if (!col || value === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue));
      }
      params.push(proposalId);
      return transaction(() => {
        const res = prep(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        if (Number(res.changes) === 0) throw new Error(`proposal not found: ${proposalId}`);
        return proposals.get(proposalId)!;
      });
    },
    updateOption(o) {
      run(
        'UPDATE options SET label = ?, branch = ?, summary = ?, tradeoffs = ?, headSha = ? WHERE id = ? AND proposalId = ?',
        o.label,
        o.branch,
        o.summary,
        o.tradeoffs,
        o.headSha,
        o.id,
        o.proposalId,
      );
    },
    castVote: insertVote,
    clearVote(proposalId, userId) {
      run('DELETE FROM votes WHERE proposalId = ? AND userId = ?', proposalId, userId);
    },
    listVotes,
  };

  // ---- changes ----
  const toChange = (r: Row): Change => ({
    sha: r.sha,
    roomId: r.roomId,
    documentId: r.documentId,
    actor: JSON.parse(r.actor) as ActorRef,
    summary: r.summary,
    triggerMessageIds: JSON.parse(r.triggerMessageIds) as MessageId[],
    proposalId: r.proposalId ?? null,
    revertsSha: r.revertsSha ?? null,
    revertedBySha: r.revertedBySha ?? null,
    createdAt: r.createdAt,
  });
  const changes: ChangeRepo = {
    insert(c) {
      run(
        `INSERT INTO changes (sha, roomId, documentId, actor, summary, triggerMessageIds, proposalId, revertsSha,
           revertedBySha, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.sha,
        c.roomId,
        c.documentId,
        json(c.actor),
        c.summary,
        json(c.triggerMessageIds),
        c.proposalId,
        c.revertsSha,
        c.revertedBySha,
        c.createdAt,
      );
    },
    get(sha: Sha) {
      const r = get('SELECT * FROM changes WHERE sha = ?', sha);
      return r ? toChange(r) : null;
    },
    /** newest first */
    list(roomId, opts) {
      const where = ['roomId = ?'];
      const params: SQLInputValue[] = [roomId];
      if (opts?.documentId) {
        where.push('documentId = ?');
        params.push(opts.documentId);
      }
      let sql = `SELECT * FROM changes WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, rowid DESC`;
      if (opts?.limit != null) {
        sql += ' LIMIT ?';
        params.push(Math.max(0, Math.floor(opts.limit)));
      }
      return all(sql, ...params).map(toChange);
    },
    markReverted(sha, revertedBySha) {
      run('UPDATE changes SET revertedBySha = ? WHERE sha = ?', revertedBySha, sha);
    },
  };

  // ---- usage ----
  const usage: UsageRepo = {
    insert(u: UsageRecord) {
      run(
        `INSERT INTO usage (roomId, sessionId, role, model, inputTokens, outputTokens, cacheReadTokens, costUsd, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.roomId,
        u.sessionId,
        u.role,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.costUsd,
        u.at,
      );
    },
    summarize(roomId: RoomId) {
      const byRole: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }> = {};
      let totalCostUsd = 0;
      for (const r of all(
        `SELECT role, SUM(costUsd) AS costUsd, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens
           FROM usage WHERE roomId = ? GROUP BY role ORDER BY role`,
        roomId,
      )) {
        byRole[r.role] = { costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        totalCostUsd += r.costUsd as number;
      }
      return { totalCostUsd, byRole };
    },
  };

  return {
    users,
    rooms,
    messages,
    documents,
    proposals,
    changes,
    usage,
    sessions,
    transaction,
    close() {
      cache.clear();
      db.close();
    },
  };
}

export type { Storage } from '../contracts/storage.js';
