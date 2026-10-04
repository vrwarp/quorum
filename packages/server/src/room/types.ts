import type { ClientCommand, RoomId, ServerEvent, UserId } from '@quorum/shared';

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;

export type RoomErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'internal';

/** Domain error with a stable code; api layers map it to HTTP status / WS error events. */
export class RoomError extends Error {
  constructor(
    public readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/** What api/ws.ts needs from the service. */
export interface Hub {
  connect(roomId: RoomId, userId: UserId, send: (ev: ServerEvent) => void): Promise<() => void>;
  handle(roomId: RoomId, userId: UserId, cmd: ClientCommand): Promise<void>;
}
