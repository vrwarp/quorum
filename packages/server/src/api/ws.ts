import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent } from '@quorum/shared';
import type { Storage } from '../contracts/index.js';
import type { Hub, Logger } from '../room/types.js';
import { RoomError } from '../room/types.js';
import { createAuth } from './auth.js';
import { originAllowed } from './net.js';
import { parseClientCommand } from './schemas.js';

export interface WsOptions {
  service: Hub;
  storage: Pick<Storage, 'users' | 'sessions' | 'rooms'>;
  logger?: Logger;
  pingIntervalMs?: number;
  /** Origins (beyond the server's own host) whose pages may open a socket: `QUORUM_ALLOWED_ORIGINS` */
  allowedOrigins?: readonly string[];
}

export interface WsHandle {
  wss: WebSocketServer;
  /**
   * Closes every socket and resolves once their disconnect handlers ran (so presence and last-seen are recorded
   * while storage is still open). Sockets that ignore the closing handshake are terminated after `graceMs`.
   */
  close(graceMs?: number): Promise<void>;
}

/**
 * Commands that wait for the main write lock, which a merge holds for as long as the merge driver runs (minutes). They
 * run outside the socket's command queue, so the sender's chat, votes and suggestions are not frozen behind them.
 */
const LOCK_TAKING: ReadonlySet<ClientCommand['type']> = new Set([
  'revert.request',
  'document.create',
  'document.rename',
  'document.archive',
]);

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
  /** lock-taking commands still running: shutdown waits a moment for them before the database closes */
  const inflight = new Set<Promise<void>>();

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    // A page on another origin must not be able to open a socket with the visitor's cookie.
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins))
      return reject(socket, 403, 'Forbidden');
    // the token may also come in the query string here: a browser cannot set headers on a WebSocket
    const session = auth.userFromRequest(req, { allowQueryToken: true });
    if (!session) return reject(socket, 401, 'Unauthorized');
    const roomId = url.searchParams.get('roomId');
    const room = roomId ? storage.rooms.get(roomId) : null;
    if (!roomId || !room) return reject(socket, 404, 'Not Found');
    if (room.archivedAt) {
      // Accepted and then told why: a browser cannot read the status of a refused upgrade, only that it failed.
      return wss.handleUpgrade(req, socket, head, (ws) => {
        sendEvent(ws, {
          type: 'error',
          code: 'room_archived',
          message: 'This room is archived and can no longer be joined.',
        });
        ws.close(1008, 'room archived');
      });
    }
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

    /** Run one command; whatever goes wrong is reported to the sender under the command's `cid`. */
    const run = async (cmd: ClientCommand, cid: string | undefined): Promise<void> => {
      try {
        await service.handle(roomId, userId, cmd);
      } catch (err) {
        if (!(err instanceof RoomError))
          log('error', 'command failed', {
            type: cmd.type,
            err: String((err as Error)?.stack ?? err),
          });
        sendEvent(ws, errorEvent(err, cid));
      }
    };

    // commands are processed in order per socket, except the ones that may wait for the main write lock
    let queue: Promise<void> = ready;
    ws.on('message', (data, isBinary) => {
      if (isBinary)
        return sendEvent(ws, {
          type: 'error',
          code: 'bad_request',
          message: 'binary frames are not supported',
        });
      const parsed = parseClientCommand(data.toString());
      if (!parsed.ok) {
        return sendEvent(ws, {
          type: 'error',
          code: 'bad_request',
          message: parsed.message,
          ...(parsed.cid ? { inReplyTo: parsed.cid } : {}),
        });
      }
      if (LOCK_TAKING.has(parsed.cmd.type)) {
        const job: Promise<void> = ready
          .then(() => (closed ? undefined : run(parsed.cmd, parsed.cid)))
          .finally(() => inflight.delete(job));
        inflight.add(job);
        return;
      }
      queue = queue.then(async () => {
        if (closed) return;
        await run(parsed.cmd, parsed.cid);
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
    async close(graceMs = 500) {
      clearInterval(interval);
      const sockets = [...wss.clients];
      const closed = sockets.map(
        (ws) =>
          new Promise<void>((resolve) =>
            ws.readyState === ws.CLOSED ? resolve() : ws.once('close', () => resolve()),
          ),
      );
      for (const ws of sockets) ws.close(1001, 'server shutting down');
      const force = setTimeout(() => sockets.forEach((ws) => ws.terminate()), graceMs);
      await Promise.all(closed);
      clearTimeout(force);
      // a revert or document change still waiting for the main lock gets a moment to finish before storage closes
      if (inflight.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise((resolve) => (timer = setTimeout(resolve, 5_000))),
        ]);
        clearTimeout(timer);
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
