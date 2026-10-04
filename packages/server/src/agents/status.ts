import type { RoomId } from '@quorum/shared';
import type { RoomActions } from '../contracts/index.js';
import { errMessage, noopLogger, type Logger } from './common.js';

export type AgentStatus = 'idle' | 'thinking' | 'unavailable';

/** What the listener, orchestrator and workers report; the board turns it into agent status for the room. */
export interface StatusSink {
  /** work started under `key` (or its detail changed) */
  busy(key: string, detail?: string | null): void;
  /** work under `key` finished */
  done(key: string): void;
  /** something under `key` is broken: the agent shows as unavailable with `detail` */
  fail(key: string, detail: string): void;
  /** the problem under `key` is gone */
  recover(key: string): void;
}

/**
 * Single owner of a room's agent status. Several sources feed it (credentials, listener health, the orchestrator
 * session, merge driver runs), and the effective status is: unavailable while any failure is set, else thinking while
 * any work is running, else idle. Only changes are pushed to RoomActions.setAgentStatus, in order, and a failing push
 * never throws.
 */
export class StatusBoard implements StatusSink {
  private readonly work = new Map<string, string | null>();
  private readonly failures = new Map<string, string>();
  private shown: { status: AgentStatus; detail: string | null } = { status: 'idle', detail: null };
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly roomId: RoomId,
    private readonly actions: RoomActions,
    private readonly log: Logger = noopLogger,
  ) {}

  busy(key: string, detail: string | null = null): void {
    this.work.set(key, detail);
    this.publish();
  }

  done(key: string): void {
    if (this.work.delete(key)) this.publish();
  }

  fail(key: string, detail: string): void {
    this.failures.set(key, detail);
    this.publish();
  }

  recover(key: string): void {
    if (this.failures.delete(key)) this.publish();
  }

  /** Forget everything (sessions were torn down), optionally leaving one failure in place, and publish once. */
  reset(failure?: { key: string; detail: string }): void {
    this.work.clear();
    this.failures.clear();
    if (failure) this.failures.set(failure.key, failure.detail);
    this.publish();
  }

  get current(): { status: AgentStatus; detail: string | null } {
    return this.effective();
  }

  /** Resolves once every status push issued so far has completed (for tests and orderly shutdown). */
  settled(): Promise<void> {
    return this.tail;
  }

  private effective(): { status: AgentStatus; detail: string | null } {
    const failure = this.failures.values().next();
    if (!failure.done) return { status: 'unavailable', detail: failure.value };
    if (this.work.size > 0) {
      const details = [...this.work.values()].filter((d): d is string => d !== null && d !== '');
      return {
        status: 'thinking',
        detail: details.length > 0 ? details[details.length - 1]! : null,
      };
    }
    return { status: 'idle', detail: null };
  }

  private publish(): void {
    const next = this.effective();
    if (next.status === this.shown.status && next.detail === this.shown.detail) return;
    this.shown = next;
    this.tail = this.tail.then(async () => {
      try {
        await this.actions.setAgentStatus(this.roomId, next.status, next.detail);
      } catch (e) {
        this.log('warn', 'setAgentStatus failed', { roomId: this.roomId, error: errMessage(e) });
      }
    });
  }
}
