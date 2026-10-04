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
      if (typeof j.error === 'string') msg = j.error;
      else if (typeof j.message === 'string') msg = j.message;
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
export const getRoomState = (roomId: string) => request<RoomState>(`/api/rooms/${enc(roomId)}/state`);
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
export const getUsage = (roomId: string) => request<UsageResponse>(`/api/rooms/${enc(roomId)}/usage`);
