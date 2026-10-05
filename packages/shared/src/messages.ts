import type {
  ActorRef,
  Anchor,
  Change,
  DocumentId,
  MessageId,
  OptionId,
  Proposal,
  ProposalId,
  RoomId,
  Sha,
  UserId,
} from './domain.js';

/** Card payloads rendered inside chat. */
export type Card =
  | { type: 'change'; change: Change }
  | {
      type: 'suggestion';
      anchor: Anchor;
      replacement: string; // empty string = delete paragraph
      status: 'pending' | 'applied' | 'superseded' | 'declined';
      resolutionSha: Sha | null;
      note: string | null;
    }
  | { type: 'ask'; anchor: Anchor; question: string }
  | { type: 'review'; proposalId: ProposalId }
  | { type: 'quorum'; proposalId: ProposalId }
  | { type: 'exploration_started'; documentId: DocumentId; title: string; theses: string[] }
  | {
      type: 'merge';
      proposalId: ProposalId;
      optionId: OptionId;
      sha: Sha;
      reconciled: boolean;
      summary: string;
    }
  | { type: 'digest'; sinceMessageId: MessageId | null }
  | { type: 'agent_status'; status: 'thinking' | 'idle' | 'unavailable'; detail: string | null };

export type MessageKind = 'text' | 'system' | 'card';

export interface Message {
  id: MessageId;
  roomId: RoomId;
  /** author for text messages; agent/system actor otherwise */
  author: ActorRef;
  kind: MessageKind;
  body: string; // markdown; for cards, a plain-text fallback / caption
  /**
   * Agent messages: the gist, about 140 characters, shown in chat with `body` (the full text) behind an expander. Absent
   * or null when `body` is short enough to show as it is (and on every message from before summaries existed).
   */
  summary?: string | null;
  card: Card | null;
  /** present when the message is anchored to a passage (suggestion, ask, agent answer) */
  anchor: Anchor | null;
  /** private messages are delivered to one user only (digests) */
  privateTo: UserId | null;
  /** ids this message responds to (agent replies, change triggers) */
  inReplyTo: MessageId[];
  createdAt: string;
}

/** Snapshot of a room for a connecting client. */
export interface RoomState {
  room: import('./domain.js').Room;
  participants: import('./domain.js').Participant[];
  presence: import('./domain.js').PresenceEntry[];
  documents: Array<import('./domain.js').Document & { headSha: Sha | null }>;
  proposals: Proposal[];
  recentMessages: Message[];
  agentStatus: 'idle' | 'thinking' | 'unavailable';
  /** human-readable reason for the current agent status (e.g. "Sign in to Claude in Settings") */
  agentDetail: string | null;
}
