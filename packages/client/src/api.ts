import type {
  DiffResponse,
  LoginRequest,
  LoginResponse,
  Message,
  Room,
  RoomState,
} from '@quorum/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { credentials: 'include', ...init, headers });
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown; message?: unknown };
      // The server sends a stable code in `error` and a readable sentence in `message`; show the sentence.
      if (typeof j.message === 'string') msg = j.message;
      else if (typeof j.error === 'string') msg = j.error;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new ApiError(res.status, msg);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

const enc = encodeURIComponent;

export interface Me {
  userId: string;
  displayName: string;
  /** true for the first registered user, who alone may sign the agent in; absent on servers that predate the field */
  isAdmin?: boolean;
}
export interface DocumentContent {
  path: string;
  ref: string;
  sha: string;
  content: string;
}
export interface UsageResponse {
  totalCostUsd: number;
  byRole: Record<string, number>;
}

export const login = (req: LoginRequest) => post<LoginResponse>('/api/login', req);
export const logout = () => post<void>('/api/logout');
export const me = () => request<Me>('/api/me');
export const listRooms = () => request<Room[]>('/api/rooms');
export const createRoom = (name: string) => post<Room>('/api/rooms', { name });
export const getRoomState = (roomId: string) =>
  request<RoomState>(`/api/rooms/${enc(roomId)}/state`);
export const getDocument = (roomId: string, documentId: string, ref?: string) =>
  request<DocumentContent>(
    `/api/rooms/${enc(roomId)}/documents/${enc(documentId)}${ref ? `?ref=${enc(ref)}` : ''}`,
  );
export const getProposalDiff = (roomId: string, proposalId: string, optionId?: string) =>
  request<DiffResponse>(
    `/api/rooms/${enc(roomId)}/proposals/${enc(proposalId)}/diff${optionId ? `?optionId=${enc(optionId)}` : ''}`,
  );
export const getChangeDiff = (roomId: string, sha: string) =>
  request<DiffResponse>(`/api/rooms/${enc(roomId)}/changes/${enc(sha)}/diff`);
export const getMessages = (roomId: string, before?: string, limit = 50) =>
  request<Message[]>(
    `/api/rooms/${enc(roomId)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ''}`,
  );
export const getUsage = (roomId: string) =>
  request<UsageResponse>(`/api/rooms/${enc(roomId)}/usage`);

export interface ClaudeStatus {
  signedIn: boolean;
  method: 'oauth_login' | 'oauth_token' | 'api_key' | 'none';
  account: { email?: string; organization?: string; subscriptionType?: string } | null;
  pendingLogins: number;
}
export interface ClaudeLogin {
  loginId: string;
  url: string;
}

export const claudeStatus = () => request<ClaudeStatus>('/api/claude/status');
export const claudeLoginStart = (mode: 'claudeai' | 'console' = 'claudeai') =>
  post<ClaudeLogin>('/api/claude/login/start', { mode });
export const claudeLoginCode = (loginId: string, code: string) =>
  post<ClaudeStatus>('/api/claude/login/code', { loginId, code });
export const claudeLoginCancel = (loginId: string) =>
  post<{ ok: true }>('/api/claude/login/cancel', { loginId });
export const claudeLogout = () => post<ClaudeStatus>('/api/claude/logout');

/** Value of `name` in the query string or fragment of a pasted address, percent-decoded; null when absent or empty. */
function addressParam(text: string, name: string): string | null {
  const m = new RegExp(`[?&#]${name}=([^&\\s#]+)`).exec(text);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // not valid percent-encoding: take it as written
  }
}

/**
 * What gets pasted back is the code the sign-in page shows (`code#state`) or the whole address it redirects to. The
 * CLI wants `code#state`, so an address with both parameters becomes exactly that; an address with only a code gives
 * the bare code; anything else is passed on as typed (trimmed).
 */
export function normalizeCode(pasted: string): string {
  const trimmed = pasted.trim();
  const code = addressParam(trimmed, 'code');
  if (code === null) return trimmed;
  const state = addressParam(trimmed, 'state');
  return state === null ? code : `${code}#${state}`;
}
