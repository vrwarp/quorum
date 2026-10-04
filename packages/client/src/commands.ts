/**
 * Commands go out with a correlation id (`cid`); the server echoes it as `inReplyTo` on the `error` event that
 * rejects the command. There is no acknowledgement for success, so an entry simply ages out.
 */

export interface CommandError {
  code: string;
  message: string;
}

export interface SendOptions {
  /** Called when the server rejects this command. Without it the error goes to the room-wide banner. */
  onError?: (error: CommandError) => void;
}

interface Entry {
  onError?: (error: CommandError) => void;
  at: number;
}

export class CommandTracker {
  private readonly entries = new Map<string, Entry>();
  private counter = 0;
  private readonly prefix = Math.random().toString(36).slice(2, 8);

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Registers a command about to be sent and returns the cid to put on it. */
  track(onError?: SendOptions['onError']): string {
    this.sweep();
    const cid = `${this.prefix}-${++this.counter}`;
    this.entries.set(cid, { onError, at: this.clock() });
    return cid;
  }

  /** The command never left (socket not open): nothing will answer it. */
  forget(cid: string): void {
    this.entries.delete(cid);
  }

  /**
   * Hands a rejection to the command it answers. True when the event was consumed by a handler; false when it
   * belongs to no tracked command, or to one without a handler, and so is for the room-wide banner.
   */
  fail(ev: { code: string; message: string; inReplyTo?: string }): boolean {
    const entry = ev.inReplyTo ? this.entries.get(ev.inReplyTo) : undefined;
    if (!entry || !ev.inReplyTo) return false;
    this.entries.delete(ev.inReplyTo);
    if (!entry.onError) return false;
    entry.onError({ code: ev.code, message: ev.message });
    return true;
  }

  /** The socket dropped: whatever was in flight is not coming back. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [cid, e] of this.entries) if (e.at < cutoff) this.entries.delete(cid);
  }
}
