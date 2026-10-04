import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerEvent } from '@quorum/shared';
import type { Storage } from '../contracts/index.js';
import type { Hub, Logger } from '../room/types.js';
import { RoomError } from '../room/types.js';
import { createAuth } from './auth.js';
import { parseClientCommand } from './schemas.js';

export interface WsOptions {
  service: Hub;
  storage: Pick<Storage, 'users' | 'sessions' | 'rooms'>;
  logger?: Logger;
  pingIntervalMs?: number;
}

export interface WsHandle {
  wss: WebSocketServer;
  close(): void;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocket(server: Server, opts: WsOptions): WsHandle {
  const { service, storage } = opts;
  const log: Logger = opts.logger ?? (() => undefined);
  // only token resolution is needed here; password is irrelevant
  const auth = createAuth({ storage, config: { password: null } });
  const alive = new WeakMap<WebSocket, boolean>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    const session = auth.userFromRequest(req);
    if (!session) return reject(socket, 401, 'Unauthorized');
    const roomId = url.searchParams.get('roomId');
    if (!roomId || !storage.rooms.get(roomId)) return reject(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, roomId, session.user.id));
  });

  function sendEvent(ws: WebSocket, ev: ServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  }

  function errorEvent(err: unknown, cid?: string): ServerEvent {
    const code = err instanceof RoomError ? err.code : 'internal';
    const message = err instanceof RoomError ? err.message : 'internal error';
    return { type: 'error', code, message, ...(cid ? { inReplyTo: cid } : {}) };
  }

  function onConnection(ws: WebSocket, roomId: string, userId: string): void {
    alive.set(ws, true);
    let disconnect: (() => void) | null = null;
    let closed = false;
    ws.on('pong', () => alive.set(ws, true));

    const ready = service
      .connect(roomId, userId, (ev) => sendEvent(ws, ev))
      .then((d) => {
        if (closed) d();
        else disconnect = d;
      })
      .catch((err) => {
        log('warn', 'ws connect failed', { err: String((err as Error)?.message ?? err) });
        sendEvent(ws, errorEvent(err));
        ws.close(1011, 'connect failed');
      });

    // commands are processed in order per socket
    let queue: Promise<void> = ready;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return sendEvent(ws, { type: 'error', code: 'bad_request', message: 'binary frames are not supported' });
      const parsed = parseClientCommand(data.toString());
      if (!parsed.ok) {
        return sendEvent(ws, { type: 'error', code: 'bad_request', message: parsed.message, ...(parsed.cid ? { inReplyTo: parsed.cid } : {}) });
      }
      queue = queue.then(async () => {
        if (closed) return;
        try {
          await service.handle(roomId, userId, parsed.cmd);
        } catch (err) {
          if (!(err instanceof RoomError)) log('error', 'command failed', { type: parsed.cmd.type, err: String((err as Error)?.stack ?? err) });
          sendEvent(ws, errorEvent(err, parsed.cid));
        }
      });
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      void ready.then(() => disconnect?.());
    };
    ws.on('close', cleanup);
    ws.on('error', (err) => {
      log('warn', 'ws error', { err: String(err?.message ?? err) });
      cleanup();
    });
  }

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, opts.pingIntervalMs ?? 30_000);
  interval.unref();
  server.on('close', () => clearInterval(interval));

  return {
    wss,
    close() {
      clearInterval(interval);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
