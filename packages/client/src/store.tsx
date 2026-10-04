import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
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

export function reducer(state: RoomStoreState, action: Action): RoomStoreState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.connected };
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
      const ids = new Set(s.recentMessages.map((m) => m.id));
      // keep private messages (digests) that arrived before this snapshot
      const keptPrivate = state.messages.filter((m) => m.privateTo && !ids.has(m.id));
      const messages = [...s.recentMessages, ...keptPrivate].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
      return {
        ...state,
        loaded: true,
        you: ev.you,
        room: s.room,
        participants: s.participants,
        presence: s.presence,
        documents: s.documents,
        proposals: s.proposals,
        messages,
        agentStatus: s.agentStatus,
        agentDetail: null,
      };
    }
    case 'chat.message':
    case 'chat.updated':
      return { ...state, messages: upsertById(state.messages, ev.message) };
    case 'presence.update':
      return { ...state, presence: ev.presence };
    case 'document.updated':
      return {
        ...state,
        documents: state.documents.map((d) => (d.id === ev.documentId ? { ...d, headSha: ev.headSha } : d)),
      };
    case 'document.created':
      return { ...state, documents: upsertById(state.documents, ev.document) };
    case 'document.archived':
      return {
        ...state,
        documents: state.documents.map((d) => (d.id === ev.documentId ? { ...d, status: 'archived' } : d)),
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
    if (!ok) dispatch({ type: 'event', ev: { type: 'error', code: 'offline', message: 'Not connected; try again in a moment.' } });
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
