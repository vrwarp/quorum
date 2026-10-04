import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  ClientCommand,
  Document,
  Message,
  Participant,
  PresenceEntry,
  Proposal,
  Room,
  ServerEvent,
  Sha,
} from '@quorum/shared';
import { getMessages, getRoomState } from './api';
import { CommandTracker } from './commands';
import type { SendOptions } from './commands';
import { RoomSocket } from './ws';
import type { SocketFailure } from './ws';

export type DocWithHead = Document & { headSha: Sha | null };
export type AgentStatusValue = 'idle' | 'thinking' | 'unavailable';

/**
 * Messages missing between what the store held and the newest snapshot: the connection was away for more than the
 * snapshot's window. Refetched backwards from `beforeId`.
 */
export interface TranscriptGap {
  /** newest shared message held before the snapshot; what follows it, up to the snapshot, is missing */
  afterId: string;
  /** oldest message of the snapshot: the missing page ends just before it */
  beforeId: string;
  /** creation time of the oldest shared message held: refetching reaches back this far so cards that changed refresh */
  coverFrom: string;
}

export interface RoomStoreState {
  loaded: boolean;
  connected: boolean;
  /** set when the socket was refused for good (session ended, room unknown) */
  fatal: SocketFailure | null;
  you: { userId: string; displayName: string } | null;
  room: Room | null;
  participants: Participant[];
  presence: PresenceEntry[];
  documents: DocWithHead[];
  proposals: Proposal[];
  messages: Message[];
  agentStatus: AgentStatusValue;
  agentDetail: string | null;
  error: string | null;
  gap: TranscriptGap | null;
  /** proposals a card referenced that neither the snapshot nor a refetch could produce */
  missingProposals: string[];
}

export const initialState: RoomStoreState = {
  loaded: false,
  connected: false,
  fatal: null,
  you: null,
  room: null,
  participants: [],
  presence: [],
  documents: [],
  proposals: [],
  messages: [],
  agentStatus: 'idle',
  agentDetail: null,
  error: null,
  gap: null,
  missingProposals: [],
};

/** Shown when a command is dropped because the socket is down; cleared again once the socket is back. */
export const OFFLINE_MESSAGE = 'Not connected; try again in a moment.';

export type Action =
  | { type: 'event'; ev: ServerEvent }
  | { type: 'connected'; connected: boolean }
  | { type: 'fatal'; reason: SocketFailure; at: string }
  | { type: 'prepend'; messages: Message[] }
  | { type: 'backfill'; gap: TranscriptGap; messages: Message[] }
  | { type: 'proposals'; proposals: Proposal[]; requested: string[] }
  | { type: 'dismissError' };

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/**
 * Merge a hello snapshot into what the store already holds. The snapshot wins for every message it contains; anything
 * else is kept: earlier pages the person loaded, and events that raced ahead of the snapshot (a private digest, or a
 * message newer than the snapshot). Order is by creation time, ties keeping their arrival order.
 */
export function mergeSnapshotMessages(existing: Message[], snapshot: Message[]): Message[] {
  const inSnapshot = new Set(snapshot.map((m) => m.id));
  const kept = existing.filter((m) => !inSnapshot.has(m.id));
  if (kept.length === 0) return snapshot;
  return [...kept, ...snapshot].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

/**
 * Whether a snapshot leaves a hole after what the store already held: the newest shared message held is not in the
 * snapshot and the snapshot starts after it. (A first connection holds nothing, and a short absence overlaps.)
 */
export function findGap(existing: Message[], snapshot: Message[]): TranscriptGap | null {
  const shared = existing.filter((m) => !m.privateTo);
  const newest = shared[shared.length - 1];
  const oldest = shared[0];
  const first = snapshot[0];
  if (!newest || !oldest || !first) return null;
  if (snapshot.some((m) => m.id === newest.id)) return null;
  if (first.createdAt <= newest.createdAt) return null;
  return { afterId: newest.id, beforeId: first.id, coverFrom: oldest.createdAt };
}

/** The server's largest page; a gap is refetched this many messages at a time, newest first, up to a bound. */
export const BACKFILL_PAGE = 200;
export const BACKFILL_MAX_PAGES = 10;

/**
 * Fetches the messages that precede the snapshot, back to the oldest one held (so everything on screen is fresh
 * again), oldest first. Never throws: if a page fails or the bound is reached first, the newest part it got is
 * returned and what lies beyond is left for "Load earlier messages".
 */
export async function backfillTranscript(
  fetchPage: (before: string, limit: number) => Promise<Message[]>,
  gap: TranscriptGap,
  maxPages = BACKFILL_MAX_PAGES,
): Promise<Message[]> {
  let collected: Message[] = [];
  let before = gap.beforeId;
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchPage(before, BACKFILL_PAGE);
      collected = [...page, ...collected];
      const oldest = page[0];
      if (!oldest || page.length < BACKFILL_PAGE) break; // the start of the transcript
      if (oldest.createdAt <= gap.coverFrom) break; // everything that was held is covered
      before = oldest.id;
    }
  } catch {
    /* keep what arrived */
  }
  return collected;
}

export function reducer(state: RoomStoreState, action: Action): RoomStoreState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        connected: action.connected,
        error: action.connected && state.error === OFFLINE_MESSAGE ? null : state.error,
      };
    case 'fatal':
      return {
        ...state,
        fatal: action.reason,
        // refused because the room is archived: if this page did not know yet, it is archived now (read-only)
        room:
          action.reason === 'archived' && state.room && !state.room.archivedAt
            ? { ...state.room, archivedAt: action.at }
            : state.room,
      };
    case 'dismissError':
      return { ...state, error: null };
    case 'prepend': {
      const have = new Set(state.messages.map((m) => m.id));
      const older = action.messages.filter((m) => !have.has(m.id));
      return { ...state, messages: [...older, ...state.messages] };
    }
    case 'backfill': {
      if (state.gap !== action.gap) return state; // a newer snapshot replaced the gap this was for
      // What precedes the snapshot is replaced by the fetched messages: they are in the server's order (timestamps
      // alone cannot order messages sent in the same millisecond), they are fresh, and nothing older than them stays
      // behind to leave a hole that "Load earlier messages" would skip over.
      const at = state.messages.findIndex((m) => m.id === action.gap.beforeId);
      const recent = at >= 0 ? state.messages.slice(at) : state.messages;
      const have = new Set(recent.map((m) => m.id));
      return {
        ...state,
        messages: [...action.messages.filter((m) => !have.has(m.id)), ...recent],
        gap: null,
      };
    }
    case 'proposals': {
      const have = new Set(state.proposals.map((p) => p.id));
      const added = action.proposals.filter((p) => !have.has(p.id));
      const known = new Set([...have, ...added.map((p) => p.id)]);
      const missing = new Set(state.missingProposals);
      for (const id of action.requested) if (!known.has(id)) missing.add(id);
      return {
        ...state,
        proposals: added.length > 0 ? [...state.proposals, ...added] : state.proposals,
        missingProposals: [...missing],
      };
    }
    case 'event':
      return applyEvent(state, action.ev);
  }
}

export function applyEvent(state: RoomStoreState, ev: ServerEvent): RoomStoreState {
  switch (ev.type) {
    case 'hello': {
      const s = ev.state;
      return {
        ...state,
        loaded: true,
        you: ev.you,
        room: s.room,
        participants: s.participants,
        presence: s.presence,
        documents: s.documents,
        proposals: s.proposals,
        messages: mergeSnapshotMessages(state.messages, s.recentMessages),
        agentStatus: s.agentStatus,
        agentDetail: s.agentDetail ?? null,
        gap: findGap(state.messages, s.recentMessages),
        missingProposals: [],
      };
    }
    case 'chat.message':
      return { ...state, messages: upsertById(state.messages, ev.message) };
    case 'chat.updated': {
      // a card changed in place (suggestion applied, change reverted): only messages already on screen matter, and
      // appending an older one here would put it at the end of the transcript
      const i = state.messages.findIndex((m) => m.id === ev.message.id);
      if (i < 0) return state;
      const messages = state.messages.slice();
      messages[i] = ev.message;
      return { ...state, messages };
    }
    case 'presence.update':
      return { ...state, presence: ev.presence };
    case 'room.updated':
      return { ...state, room: ev.room };
    case 'document.updated':
      return {
        ...state,
        documents: state.documents.map((d) =>
          d.id === ev.documentId ? { ...d, headSha: ev.headSha } : d,
        ),
      };
    case 'document.created':
      return { ...state, documents: upsertById(state.documents, ev.document) };
    case 'document.archived':
      return {
        ...state,
        documents: state.documents.map((d) =>
          d.id === ev.documentId ? { ...d, status: 'archived' } : d,
        ),
      };
    case 'proposal.updated':
      return { ...state, proposals: upsertById(state.proposals, ev.proposal) };
    case 'agent.status':
      return { ...state, agentStatus: ev.status, agentDetail: ev.detail };
    case 'error':
      return { ...state, error: ev.message };
    default:
      // An event type this client does not know (a newer server): ignore it rather than lose the room.
      return state;
  }
}

/** How long a card waits for its proposal.updated before the proposal is fetched (the card is posted first). */
export const PROPOSAL_GRACE_MS = 1500;

interface RoomContextValue {
  roomId: string;
  state: RoomStoreState;
  you: { userId: string; displayName: string };
  /**
   * Sends a command with a correlation id. False when the socket is down (the room banner says so). When the server
   * rejects the command, `onError` gets the reason; without it the reason goes to the room banner.
   */
  send: (cmd: ClientCommand, opts?: SendOptions) => boolean;
  /** Puts a message on the room banner (for a rejection whose control is gone). */
  reportError: (message: string) => void;
  loadEarlier: () => Promise<void>;
  dismissError: () => void;
  /** Fetches a proposal a card refers to but the store lacks (after a short grace period). */
  requestProposal: (proposalId: string) => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider(props: {
  roomId: string;
  you: { userId: string; displayName: string };
  children: ReactNode;
}) {
  const { roomId, you, children } = props;
  const [state, dispatch] = useReducer(reducer, initialState);
  const [tracker] = useState(() => new CommandTracker());
  const socketRef = useRef<RoomSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const proposalAsk = useRef({
    asked: new Set<string>(),
    wanted: new Set<string>(),
    timer: null as ReturnType<typeof setTimeout> | null,
  });

  useEffect(() => {
    const socket = new RoomSocket(roomId);
    socketRef.current = socket;
    const ask = proposalAsk.current;
    const offEvent = socket.onEvent((ev) => {
      // a rejection of one of our commands goes to the control that sent it
      if (ev.type === 'error' && tracker.fail(ev)) return;
      dispatch({ type: 'event', ev });
    });
    const offStatus = socket.onStatus((connected) => {
      if (!connected) tracker.clear();
      dispatch({ type: 'connected', connected });
    });
    const offFailure = socket.onFailure((reason) =>
      dispatch({ type: 'fatal', reason, at: new Date().toISOString() }),
    );
    socket.connect();
    return () => {
      offEvent();
      offStatus();
      offFailure();
      socket.close();
      socketRef.current = null;
      tracker.clear();
      if (ask.timer) clearTimeout(ask.timer);
      ask.timer = null;
      ask.wanted.clear();
      ask.asked.clear();
    };
  }, [roomId, tracker]);

  // A snapshot that leaves a hole after what was on screen: fetch the missing messages.
  const gap = state.gap;
  useEffect(() => {
    if (!gap) return;
    let cancelled = false;
    void backfillTranscript((before, limit) => getMessages(roomId, before, limit), gap).then(
      (messages) => {
        if (!cancelled) dispatch({ type: 'backfill', gap, messages });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gap, roomId]);

  const send = useCallback(
    (cmd: ClientCommand, opts?: SendOptions) => {
      const cid = tracker.track(opts?.onError);
      const ok = socketRef.current?.send({ ...cmd, cid }) ?? false;
      if (!ok) {
        tracker.forget(cid);
        dispatch({
          type: 'event',
          ev: { type: 'error', code: 'offline', message: OFFLINE_MESSAGE },
        });
      }
      return ok;
    },
    [tracker],
  );

  const reportError = useCallback(
    (message: string) =>
      dispatch({ type: 'event', ev: { type: 'error', code: 'command', message } }),
    [],
  );

  const loadEarlier = useCallback(async () => {
    const first = stateRef.current.messages.find((m) => !m.privateTo);
    const older = await getMessages(roomId, first?.id);
    dispatch({ type: 'prepend', messages: older });
  }, [roomId]);

  const dismissError = useCallback(() => dispatch({ type: 'dismissError' }), []);

  const requestProposal = useCallback(
    (proposalId: string) => {
      const ask = proposalAsk.current;
      if (ask.asked.has(proposalId)) return;
      ask.asked.add(proposalId);
      ask.wanted.add(proposalId);
      if (ask.timer) return;
      ask.timer = setTimeout(() => {
        ask.timer = null;
        const ids = [...ask.wanted].filter(
          (id) => !stateRef.current.proposals.some((p) => p.id === id),
        );
        ask.wanted.clear();
        if (ids.length === 0) return;
        // No route serves one proposal: the room state carries the same recent set the snapshot did.
        getRoomState(roomId).then(
          (s) => dispatch({ type: 'proposals', proposals: s.proposals, requested: ids }),
          () => ids.forEach((id) => ask.asked.delete(id)), // try again when the card next asks
        );
      }, PROPOSAL_GRACE_MS);
    },
    [roomId],
  );

  const value = useMemo(
    () => ({
      roomId,
      state,
      you,
      send,
      reportError,
      loadEarlier,
      dismissError,
      requestProposal,
    }),
    [roomId, state, you, send, reportError, loadEarlier, dismissError, requestProposal],
  );
  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoom outside RoomProvider');
  return ctx;
}

/** A proposal by id from the store; asks the server for it when a card refers to one the store lacks. */
export function useProposal(proposalId: string): { proposal: Proposal | null; missing: boolean } {
  const { state, requestProposal } = useRoom();
  const proposal = state.proposals.find((p) => p.id === proposalId) ?? null;
  const loaded = state.loaded;
  const connected = state.connected;
  useEffect(() => {
    if (!proposal && loaded) requestProposal(proposalId);
  }, [proposal, loaded, connected, proposalId, requestProposal]);
  return { proposal, missing: !proposal && state.missingProposals.includes(proposalId) };
}

/** Error and send state for one control: a command whose rejection is shown next to the control that sent it. */
export function useCommand(): {
  error: string | null;
  clearError: () => void;
  run: (cmd: ClientCommand, onError?: (message: string) => void) => boolean;
} {
  const { send, reportError } = useRoom();
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const clearError = useCallback(() => setError(null), []);
  const run = useCallback(
    (cmd: ClientCommand, onError?: (message: string) => void) => {
      setError(null);
      return send(cmd, {
        onError: (e) => {
          if (alive.current) setError(e.message);
          else reportError(e.message); // the control is gone: the banner is all that is left
          onError?.(e.message);
        },
      });
    },
    [send, reportError],
  );
  return { error, clearError, run };
}
