import type { ClientCommand, ServerEvent } from '@quorum/shared';

type EventHandler = (ev: ServerEvent) => void;
type StatusHandler = (connected: boolean) => void;

/** Why the socket gave up for good: retrying cannot help. */
export type SocketFailure = 'unauthorized' | 'not_found' | 'archived';
type FailureHandler = (reason: SocketFailure) => void;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/**
 * Wait before reconnect attempt number `attempts` (0 for the first): exponential, capped, and jittered into the upper
 * half of the step so a server restart does not bring every tab back in the same instant.
 */
export function reconnectDelay(attempts: number, random: () => number = Math.random): number {
  const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts);
  return Math.round(step / 2 + (step / 2) * random());
}

/** Anything the server sends is an object with a string `type`; everything else is dropped. */
function isEvent(value: unknown): value is ServerEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Room WebSocket with automatic reconnect. The backoff only resets once the server has greeted us (`hello`), so a
 * server that accepts and immediately drops does not get a retry every half second. A socket that never opens may
 * have been refused (session revoked, room unknown); the browser does not say, so a cheap request finds out, and
 * those two cases are reported instead of retried forever. An archived room is accepted and then refused with a
 * `room_archived` error, which also ends the retrying.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private failureHandlers = new Set<FailureHandler>();

  constructor(private roomId: string) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws?roomId=${encodeURIComponent(this.roomId)}`;
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (e) => {
      let ev: unknown;
      try {
        ev = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!isEvent(ev)) return;
      if (ev.type === 'error' && ev.code === 'room_archived') {
        this.giveUp('archived');
        return;
      }
      if (ev.type === 'hello') this.attempts = 0;
      this.handlers.forEach((h) => h(ev));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.statusHandlers.forEach((h) => h(false));
      if (this.closed) return;
      if (opened) this.scheduleReconnect();
      else void this.probe().then((failure) => this.afterRefusal(failure));
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.open(), reconnectDelay(this.attempts++));
  }

  private afterRefusal(failure: SocketFailure | null): void {
    if (this.closed) return;
    if (failure) this.giveUp(failure);
    else this.scheduleReconnect();
  }

  /** Stop for good; a new RoomSocket is made when the person acts on the notice. */
  private giveUp(failure: SocketFailure): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.failureHandlers.forEach((h) => h(failure));
  }

  /** The room's usage route needs a session and an existing room and costs nothing: 401 and 404 say which. */
  private async probe(): Promise<SocketFailure | null> {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/usage`, {
        credentials: 'include',
      });
      if (res.status === 401) return 'unauthorized';
      if (res.status === 404) return 'not_found';
    } catch {
      /* the server is unreachable: an ordinary retry */
    }
    return null;
  }

  /** Returns false when the socket is not open (the command is dropped). */
  send(cmd: ClientCommand): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onFailure(handler: FailureHandler): () => void {
    this.failureHandlers.add(handler);
    return () => this.failureHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
