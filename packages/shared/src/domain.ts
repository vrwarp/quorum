/** Core domain types shared by server and client. Ids are strings with a type prefix. */

export type RoomId = string; // room_...
export type UserId = string; // user_...
export type MessageId = string; // msg_...
export type DocumentId = string; // doc_...
export type ProposalId = string; // prop_...
export type OptionId = string; // opt_...
export type Sha = string;

export type VotingRule = 'unanimous' | 'majority';

export interface Room {
  id: RoomId;
  name: string;
  ownerId: UserId;
  votingRule: VotingRule;
  createdAt: string; // ISO
  archivedAt: string | null;
}

export interface Participant {
  roomId: RoomId;
  userId: UserId;
  displayName: string;
  role: 'owner' | 'member';
}

export interface PresenceEntry {
  userId: UserId;
  displayName: string;
  connected: boolean;
  lastSeenAt: string;
}

export interface Document {
  id: DocumentId;
  roomId: RoomId;
  /** File name at the repository root, e.g. "Architecture.md". Unique per room. */
  path: string;
  title: string;
  status: 'active' | 'archived';
  createdAt: string;
}

/** A location inside a document on main (or a branch) at a known revision. */
export interface Anchor {
  documentId: DocumentId;
  baseSha: Sha;
  /** 1-based inclusive line numbers; a paragraph is one line. */
  startLine: number;
  endLine: number;
  /** sha256 hex of the anchored text, used to detect staleness. */
  textHash: string;
  /** The anchored text itself, for display and reconciliation. */
  text: string;
}

export type ActorRef =
  | { kind: 'user'; userId: UserId; displayName: string }
  | { kind: 'agent'; role: 'orchestrator' | 'worker' | 'merge' | 'digest' | 'system' };

export type ProposalKind = 'review' | 'quorum';

export type ProposalState =
  | 'drafting'
  | 'open'
  | 'merging'
  | 'merged'
  | 'reverted'
  | 'rejected'
  | 'superseded'
  | 'expired'
  | 'abandoned';

export interface ProposalOption {
  id: OptionId;
  proposalId: ProposalId;
  label: string; // "A", "B", "C" or a short name
  branch: string; // git branch name
  summary: string;
  tradeoffs: string;
  headSha: Sha | null;
}

export interface Proposal {
  id: ProposalId;
  roomId: RoomId;
  documentId: DocumentId;
  kind: ProposalKind;
  state: ProposalState;
  title: string;
  /** main sha the branches were forked from */
  branchBase: Sha;
  options: ProposalOption[];
  votes: Vote[];
  /** Review proposals only: when the objection window closes (ISO). */
  windowClosesAt: string | null;
  stale: boolean;
  reconciled: boolean;
  /** option that merged, when state is merged/reverted */
  mergedOptionId: OptionId | null;
  mergeSha: Sha | null;
  triggerMessageIds: MessageId[];
  cardMessageId: MessageId | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface Vote {
  proposalId: ProposalId;
  userId: UserId;
  /** null = reject (Review) ; for Quorum, the chosen option */
  optionId: OptionId | null;
  decision: 'approve' | 'reject';
  castAt: string;
}

/** A commit on main that the UI shows as a Change card. */
export interface Change {
  sha: Sha;
  roomId: RoomId;
  documentId: DocumentId;
  actor: ActorRef;
  summary: string;
  triggerMessageIds: MessageId[];
  proposalId: ProposalId | null;
  revertsSha: Sha | null;
  revertedBySha: Sha | null;
  createdAt: string;
}

export interface UsageRecord {
  roomId: RoomId;
  sessionId: string;
  role: 'listener' | 'orchestrator' | 'worker' | 'merge' | 'digest';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  at: string;
}
