import type { ClientCommand, ServerEvent } from '@quorum/shared';

type EventHandler = (ev: ServerEvent) => void;
type StatusHandler = (connected: boolean) => void;

/** Room WebSocket with automatic reconnect (exponential backoff, capped). */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();

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
    ws.onopen = () => {
      this.attempts = 0;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(e.data)) as ServerEvent;
      } catch {
        return;
      }
      this.handlers.forEach((h) => h(ev));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.statusHandlers.forEach((h) => h(false));
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempts++);
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
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

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
