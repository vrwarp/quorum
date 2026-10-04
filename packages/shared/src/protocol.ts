import type {
  Anchor,
  Document,
  DocumentId,
  OptionId,
  PresenceEntry,
  Proposal,
  ProposalId,
  Room,
  RoomId,
  Sha,
  UserId,
  VotingRule,
} from './domain.js';
import type { Message, RoomState } from './messages.js';

/** WebSocket: server -> client */
export type ServerEvent =
  | { type: 'hello'; state: RoomState; you: { userId: UserId; displayName: string } }
  | { type: 'chat.message'; message: Message }
  | { type: 'chat.updated'; message: Message } // card status changes (suggestion applied, etc.)
  | { type: 'presence.update'; presence: PresenceEntry[] }
  | { type: 'room.updated'; room: Room } // the voting rule changed
  | { type: 'document.updated'; documentId: DocumentId; headSha: Sha }
  | { type: 'document.created'; document: Document & { headSha: Sha | null } }
  | { type: 'document.archived'; documentId: DocumentId }
  | { type: 'proposal.updated'; proposal: Proposal }
  | { type: 'agent.status'; status: 'idle' | 'thinking' | 'unavailable'; detail: string | null }
  | { type: 'error'; code: string; message: string; inReplyTo?: string };

/** WebSocket: client -> server. `cid` is a client correlation id echoed in errors. */
export type ClientCommand =
  | { type: 'chat.send'; cid?: string; body: string }
  | { type: 'suggestion.create'; cid?: string; anchor: Anchor; replacement: string; note?: string }
  | { type: 'ask.create'; cid?: string; anchor: Anchor; question: string }
  | {
      type: 'vote.cast';
      cid?: string;
      proposalId: ProposalId;
      decision: 'approve' | 'reject';
      optionId?: OptionId;
    }
  | { type: 'revert.request'; cid?: string; sha: Sha }
  | { type: 'document.create'; cid?: string; title: string }
  | { type: 'document.rename'; cid?: string; documentId: DocumentId; title: string }
  | { type: 'document.archive'; cid?: string; documentId: DocumentId }
  | { type: 'room.setRule'; cid?: string; votingRule: VotingRule }
  | { type: 'room.archive'; cid?: string };

/**
 * HTTP API (JSON). Auth: POST /api/login sets an httpOnly cookie `quorum_session`; the same token is
 * accepted as `?token=` on the WebSocket URL.
 *
 *  POST /api/login                      { password, displayName } -> { userId, displayName }
 *  POST /api/logout
 *  GET  /api/me                         -> { userId, displayName }
 *  GET  /api/rooms                      -> Room[]
 *  POST /api/rooms                      { name } -> Room
 *  GET  /api/rooms/:roomId/state        -> RoomState
 *  GET  /api/rooms/:roomId/documents/:documentId?ref=<branch|sha>   -> { path, ref, sha, content }
 *  GET  /api/rooms/:roomId/proposals/:proposalId/diff?optionId=...   -> DiffResponse
 *  GET  /api/rooms/:roomId/changes/:sha/diff                          -> DiffResponse
 *  GET  /api/rooms/:roomId/messages?before=<messageId>&limit=50       -> Message[]
 *  GET  /api/rooms/:roomId/usage                                      -> { totalCostUsd, byRole }
 *  WS   /ws?roomId=...&token=...
 */
export interface DiffResponse {
  documentId: DocumentId;
  path: string;
  baseSha: Sha;
  headSha: Sha;
  before: string;
  after: string;
  /** unified diff text (git diff) */
  unified: string;
}

export interface LoginRequest {
  password: string;
  displayName: string;
}
export interface LoginResponse {
  userId: UserId;
  displayName: string;
}
export interface CreateRoomRequest {
  name: string;
}
export type { RoomId };
