import type {
  Change,
  Document,
  DocumentId,
  Message,
  MessageId,
  Participant,
  PresenceEntry,
  Proposal,
  ProposalId,
  ProposalOption,
  ProposalState,
  Room,
  RoomId,
  Sha,
  UsageRecord,
  UserId,
  Vote,
  VotingRule,
} from '@quorum/shared';

/**
 * Storage contract implemented by packages/server/src/db (node:sqlite).
 * All methods are synchronous (node:sqlite is sync) but typed as returning values directly.
 * Implementations must be safe to call from a single Node process; no cross-process locking.
 */
export interface Storage {
  users: UserRepo;
  rooms: RoomRepo;
  messages: MessageRepo;
  documents: DocumentRepo;
  proposals: ProposalRepo;
  changes: ChangeRepo;
  usage: UsageRepo;
  sessions: SessionRepo;
  /** run fn inside a transaction */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface User {
  id: UserId;
  displayName: string;
  createdAt: string;
}

export interface UserRepo {
  create(displayName: string): User;
  get(userId: UserId): User | null;
  findByDisplayName(displayName: string): User | null;
}

export interface SessionRepo {
  /** auth tokens -> user */
  create(userId: UserId): { token: string; userId: UserId };
  resolve(token: string): UserId | null;
  revoke(token: string): void;
}

export interface RoomRepo {
  create(input: { name: string; ownerId: UserId; votingRule?: VotingRule }): Room;
  get(roomId: RoomId): Room | null;
  list(): Room[];
  setVotingRule(roomId: RoomId, rule: VotingRule): void;
  archive(roomId: RoomId): void;
  addParticipant(p: Participant): void;
  listParticipants(roomId: RoomId): Participant[];
  /** presence is persisted so lastSeenAt survives restarts */
  upsertPresence(roomId: RoomId, userId: UserId, connected: boolean, at: string): void;
  listPresence(roomId: RoomId): PresenceEntry[];
  getLastSeen(roomId: RoomId, userId: UserId): string | null;
}

export interface MessageRepo {
  insert(message: Message): void;
  update(message: Message): void;
  get(messageId: MessageId): Message | null;
  getMany(ids: MessageId[]): Message[];
  /** newest last; `before` is exclusive. privateTo filter: include private messages only for that user */
  list(
    roomId: RoomId,
    opts: { before?: MessageId; after?: MessageId; limit: number; forUser?: UserId },
  ): Message[];
  /** messages created after the given message id (or all when null), in order */
  since(roomId: RoomId, sinceMessageId: MessageId | null, limit: number): Message[];
  countSince(roomId: RoomId, sinceMessageId: MessageId | null): number;
}

export interface DocumentRepo {
  create(input: { id?: DocumentId; roomId: RoomId; path: string; title: string }): Document;
  get(documentId: DocumentId): Document | null;
  getByPath(roomId: RoomId, path: string): Document | null;
  list(roomId: RoomId, includeArchived?: boolean): Document[];
  rename(documentId: DocumentId, title: string, path: string): void;
  archive(documentId: DocumentId): void;
}

export interface ProposalRepo {
  create(p: Proposal): void;
  get(proposalId: ProposalId): Proposal | null;
  list(roomId: RoomId, opts?: { states?: ProposalState[]; documentId?: DocumentId }): Proposal[];
  setState(
    proposalId: ProposalId,
    state: ProposalState,
    patch?: Partial<
      Pick<
        Proposal,
        | 'openedAt'
        | 'closedAt'
        | 'mergedOptionId'
        | 'mergeSha'
        | 'windowClosesAt'
        | 'cardMessageId'
        | 'stale'
        | 'reconciled'
        | 'title'
      >
    >,
  ): Proposal;
  updateOption(option: ProposalOption): void;
  castVote(vote: Vote): void;
  clearVote(proposalId: ProposalId, userId: UserId): void;
  listVotes(proposalId: ProposalId): Vote[];
}

export interface ChangeRepo {
  insert(change: Change): void;
  get(sha: Sha): Change | null;
  list(roomId: RoomId, opts?: { documentId?: DocumentId; limit?: number }): Change[];
  markReverted(sha: Sha, revertedBySha: Sha): void;
}

export interface UsageRepo {
  insert(record: UsageRecord): void;
  summarize(roomId: RoomId): {
    totalCostUsd: number;
    byRole: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }>;
  };
}
