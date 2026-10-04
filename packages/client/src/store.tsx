import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
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
import { getMessages } from './api';
import { RoomSocket } from './ws';

export type DocWithHead = Document & { headSha: Sha | null };
export type AgentStatusValue = 'idle' | 'thinking' | 'unavailable';

export interface RoomStoreState {
  loaded: boolean;
  connected: boolean;
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
}

export const initialState: RoomStoreState = {
  loaded: false,
  connected: false,
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
};

/** Shown when a command is dropped because the socket is down; cleared again once the socket is back. */
export const OFFLINE_MESSAGE = 'Not connected; try again in a moment.';

export type Action =
  | { type: 'event'; ev: ServerEvent }
  | { type: 'connected'; connected: boolean }
  | { type: 'prepend'; messages: Message[] }
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

export function reducer(state: RoomStoreState, action: Action): RoomStoreState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        connected: action.connected,
        error: action.connected && state.error === OFFLINE_MESSAGE ? null : state.error,
      };
    case 'dismissError':
      return { ...state, error: null };
    case 'prepend': {
      const have = new Set(state.messages.map((m) => m.id));
      const older = action.messages.filter((m) => !have.has(m.id));
      return { ...state, messages: [...older, ...state.messages] };
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
        agentDetail: null,
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
  }
}

interface RoomContextValue {
  roomId: string;
  state: RoomStoreState;
  you: { userId: string; displayName: string };
  send: (cmd: ClientCommand) => boolean;
  loadEarlier: () => Promise<void>;
  dismissError: () => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider(props: {
  roomId: string;
  you: { userId: string; displayName: string };
  children: ReactNode;
}) {
  const { roomId, you, children } = props;
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<RoomSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const socket = new RoomSocket(roomId);
    socketRef.current = socket;
    const offEvent = socket.onEvent((ev) => dispatch({ type: 'event', ev }));
    const offStatus = socket.onStatus((connected) => dispatch({ type: 'connected', connected }));
    socket.connect();
    return () => {
      offEvent();
      offStatus();
      socket.close();
      socketRef.current = null;
    };
  }, [roomId]);

  const send = useCallback((cmd: ClientCommand) => {
    const ok = socketRef.current?.send(cmd) ?? false;
    if (!ok)
      dispatch({ type: 'event', ev: { type: 'error', code: 'offline', message: OFFLINE_MESSAGE } });
    return ok;
  }, []);

  const loadEarlier = useCallback(async () => {
    const first = stateRef.current.messages.find((m) => !m.privateTo);
    const older = await getMessages(roomId, first?.id);
    dispatch({ type: 'prepend', messages: older });
  }, [roomId]);

  const dismissError = useCallback(() => dispatch({ type: 'dismissError' }), []);

  const value = useMemo(
    () => ({ roomId, state, you, send, loadEarlier, dismissError }),
    [roomId, state, you, send, loadEarlier, dismissError],
  );
  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoom outside RoomProvider');
  return ctx;
}
