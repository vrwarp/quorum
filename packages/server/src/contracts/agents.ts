import type {
  Anchor,
  Card,
  Change,
  Document,
  DocumentId,
  Message,
  MessageId,
  OptionId,
  Proposal,
  ProposalId,
  ProposalKind,
  RoomId,
  RoomState,
  Sha,
  UsageRecord,
  UserId,
} from '@quorum/shared';
import type { RoomRepository } from './git.js';

/**
 * What agents may do to a room. Implemented by RoomService (packages/server/src/room) and handed to
 * the agent runtime. Every mutation here goes through the normal room pipeline (persist, broadcast).
 */
export interface RoomActions {
  /**
   * `summary` (optional): the gist, about 140 characters, shown in chat with `body` behind an expander. It is cut at
   * 280 characters, and dropped when `body` says no more than it does (see summarizedMessage in @quorum/shared).
   */
  postChat(
    roomId: RoomId,
    input: {
      body: string;
      summary?: string | null;
      card?: Card | null;
      anchor?: Anchor | null;
      inReplyTo?: MessageId[];
    },
  ): Promise<Message>;
  updateCard(roomId: RoomId, messageId: MessageId, card: Card): Promise<Message>;
  sendPrivate(
    roomId: RoomId,
    userId: UserId,
    input: { body: string; card?: Card | null },
  ): Promise<Message>;
  readTranscript(
    roomId: RoomId,
    opts: { ids?: MessageId[]; sinceMessageId?: MessageId | null; limit?: number },
  ): Promise<Message[]>;
  getRoomState(roomId: RoomId): Promise<RoomState>;
  getDocument(roomId: RoomId, documentId: DocumentId): Promise<Document | null>;
  /** Record a commit the agent made to main and broadcast document.updated + a Change card. */
  recordChange(
    roomId: RoomId,
    change: Omit<Change, 'roomId' | 'createdAt' | 'revertedBySha'>,
  ): Promise<Change>;
  /** Create a proposal (state drafting -> open with card). Validates single-document scope. */
  openProposal(
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
  ): Promise<Proposal>;
  closeProposal(
    roomId: RoomId,
    proposalId: ProposalId,
    reason: 'expired' | 'rejected' | 'abandoned',
    note?: string,
  ): Promise<Proposal>;
  /** Ask the room to merge a passed proposal (RoomService runs the merge pipeline). */
  requestMerge(roomId: RoomId, proposalId: ProposalId, optionId: OptionId): Promise<void>;
  setAgentStatus(
    roomId: RoomId,
    status: 'idle' | 'thinking' | 'unavailable',
    detail?: string | null,
  ): Promise<void>;
  recordUsage(record: UsageRecord): Promise<void>;
  /** git access for a room (the orchestrator's main worktree, branches, blame) */
  repo(roomId: RoomId): Promise<RoomRepository>;
}

/** Events RoomService pushes into the runtime. All are fire-and-forget; the runtime must not throw. */
export interface AgentRuntime {
  /** Called when a room becomes active (first connection or startup). Idempotent. */
  startRoom(roomId: RoomId): Promise<void>;
  stopRoom(roomId: RoomId): Promise<void>;
  stopAll(): Promise<void>;

  /** Every human text message; feeds the listener debounce. */
  onChatMessage(roomId: RoomId, message: Message): void;
  /** Explicit intents that bypass the listener. */
  onSuggestion(roomId: RoomId, message: Message): void;
  onAsk(roomId: RoomId, message: Message): void;
  /** Lifecycle notifications the orchestrator reacts to (announce, follow-ups, revise). */
  onProposalEvent(
    roomId: RoomId,
    event:
      | { type: 'merged'; proposal: Proposal; optionId: OptionId; sha: Sha; reconciled: boolean }
      | { type: 'rejected'; proposal: Proposal; byUserId: UserId }
      | { type: 'expired' | 'superseded' | 'abandoned'; proposal: Proposal }
      | { type: 'merge_failed'; proposal: Proposal; reason: string },
  ): void;
  onReverted(roomId: RoomId, change: Change, revertSha: Sha, byUserId: UserId): void;

  /**
   * Merge driver: RoomService has already run `beginMerge` and got a 'clean' or 'conflict' outcome (main moved since
   * the branch point). A 'fast-forward' outcome means no reconciliation is needed and never reaches the driver.
   * The runtime must leave the worktree with a clean, marker-free result (or throw); RoomService then commits it with
   * `finishMerge`, restricted to the document's path, so edits to other files fail the merge.
   * Returns a summary of any semantic reconciliation performed.
   */
  runMergeDriver(
    roomId: RoomId,
    input: {
      proposal: Proposal;
      optionId: OptionId;
      worktreePath: string;
      conflictedFiles: string[];
      documentPath: string;
    },
  ): Promise<{ reconciled: boolean; summary: string }>;

  /** Semantic revert when `git revert` conflicts. Must leave main reverted (committed) or throw. */
  runSemanticRevert(roomId: RoomId, input: { change: Change; byUserId: UserId }): Promise<Sha>;

  /** Digest for a returning participant. */
  writeDigest(
    roomId: RoomId,
    input: { userId: UserId; sinceMessageId: MessageId | null; events: string[] },
  ): Promise<string>;
}

/** Factory signature both runtimes export. */
export type AgentRuntimeFactory = (
  actions: RoomActions,
  options: AgentRuntimeOptions,
) => AgentRuntime;

export interface AgentRuntimeOptions {
  dataDir: string;
  /** overrides of @quorum/shared DEFAULTS */
  tunables?: Partial<typeof import('@quorum/shared').DEFAULTS>;
  logger?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ) => void;
}
