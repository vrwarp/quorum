import type Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULTS,
  EFFORT,
  IntentBatchJsonSchema,
  IntentSchema,
  MODELS,
  newId,
  type Intent,
  type Message,
  type RoomId,
  type RoomState,
} from '@quorum/shared';
import type { RoomActions } from '../../contracts/index.js';
import { LISTENER_SYSTEM } from '../prompts.js';
import {
  activeDocs,
  authorName,
  errMessage,
  estimateCostUsd,
  noopLogger,
  type Logger,
  type Tunables,
} from '../common.js';

/** The slice of the Anthropic client the listener uses; tests inject a mock. */
export interface ListenerClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ListenerBatch {
  intents: Intent[];
  /** the messages that were new in this classification */
  messages: Message[];
  /** the whole transcript slice the model saw (already-classified context plus the new messages), so an intent that
   *  references an earlier message, as a divergence does, can be resolved to it */
  context: Message[];
}

export interface ListenerDeps {
  roomId: RoomId;
  actions: RoomActions;
  client: ListenerClient;
  tunables?: Partial<Tunables>;
  logger?: Logger;
  /** called with the intents at or above the confidence threshold (none-type intents are dropped) */
  onIntents: (batch: ListenerBatch) => void;
  /** classification succeeded / failed; the runtime maps these to agent status */
  onHealth?: (ok: boolean, detail?: string) => void;
}

/** Messages of already-classified context kept when the checkpoint is re-anchored. */
const CHECKPOINT_KEEP = 5;
const MAX_TOKENS = 4096;
/** After a failed classification the pending messages are retried on their own: 10 s, doubling, capped at 5 min. */
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;

export function formatTranscriptLine(m: Message): string {
  const flat = m.body.replace(/\s*\n\s*/g, ' ').trim();
  return `[${m.id}] ${authorName(m)}: ${flat}`;
}

/** Headings plus the first lines of a document, compact enough to sit in a cached prefix. */
export function documentOutline(content: string, maxHeadings = 40): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let headings = 0;
  for (const [i, line] of lines.entries()) {
    if (/^#{1,6}\s/.test(line)) {
      if (headings++ >= maxHeadings) break;
      out.push(line);
    } else if (i < 6 && line.trim() !== '') {
      out.push(`  ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`);
    }
  }
  return out.join('\n');
}

/** The model is asked for bare JSON; tolerate a markdown fence around it. */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return (m ? m[1]! : text).trim();
}

export class Listener {
  private readonly log: Logger;
  private readonly t: Tunables;
  private readonly sessionId = newId('sess');
  /** transcript since the checkpoint; append-only between re-anchors so the cached prefix stays valid */
  private window: Message[] = [];
  private classifiedCount = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private lastContext: string | null = null;
  private checkpoints = 0;
  private failures = 0;

  constructor(private readonly deps: ListenerDeps) {
    this.log = deps.logger ?? noopLogger;
    this.t = { ...DEFAULTS, ...(deps.tunables ?? {}) } as Tunables;
  }

  /** Add a human message; schedules classification after the debounce (or the max wait if chat never pauses). */
  push(message: Message): void {
    if (this.stopped) return;
    this.window.push(message);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fire(), this.t.listenerDebounceMs);
    this.debounceTimer.unref?.();
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.fire(), this.t.listenerMaxWaitMs);
      this.maxWaitTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** Classify now (used by timers and tests). Resolves when no classification is running. */
  async flush(): Promise<void> {
    this.clearTimers();
    await this.run();
  }

  get pendingCount(): number {
    return this.window.length - this.classifiedCount;
  }

  /** How many times the transcript checkpoint was re-anchored (old classified messages dropped). */
  get checkpointCount(): number {
    return this.checkpoints;
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;
  }

  private fire(): void {
    this.clearTimers();
    // run() only rejects if a callback throws; never let that become an unhandled rejection
    this.run().catch((e) =>
      this.log('error', 'listener run failed', { roomId: this.deps.roomId, error: errMessage(e) }),
    );
  }

  /** A failed classification leaves its messages pending; without a retry they would wait for the next chat message. */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.pendingCount === 0) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 10));
    this.retryTimer = setTimeout(() => this.fire(), delay);
    this.retryTimer.unref?.();
  }

  private run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let ok = true;
        do {
          this.rerun = false;
          if (!this.stopped && this.pendingCount > 0) ok = await this.classify();
          // a failed pass is not repeated back to back; the retry timer takes over
        } while (this.rerun && ok && !this.stopped);
      } finally {
        this.running = null;
        // messages that arrived mid-flight already armed their own timers via push()
      }
    })();
    return this.running;
  }

  private async buildContext(state: RoomState): Promise<string> {
    const repo = await this.deps.actions.repo(this.deps.roomId);
    const docs = activeDocs(state.documents);
    const docBlocks: string[] = [];
    for (const d of docs) {
      const content = await repo.readFile(d.path).catch(() => null);
      docBlocks.push(
        `### ${d.path} (${d.title})\n${content === null ? '(missing)' : documentOutline(content)}`,
      );
    }
    const open = state.proposals.filter(
      (p) => p.state === 'open' || p.state === 'merging' || p.state === 'drafting',
    );
    return [
      '# Room',
      `Name: ${state.room.name}`,
      `Voting rule: ${state.room.votingRule}`,
      'Participants:',
      ...state.participants.map((p) => `- ${p.userId} = ${p.displayName}`),
      '',
      '# Documents (outline)',
      docBlocks.length > 0 ? docBlocks.join('\n\n') : '(no documents yet)',
      '',
      '# Open proposals',
      open.length > 0
        ? open
            .map(
              (p) =>
                `- ${p.title} [${p.kind}, ${p.state}] on ${p.documentId}: ${p.options.map((o) => o.branch).join(', ')}`,
            )
            .join('\n')
        : '(none)',
    ].join('\n');
  }

  /** Drop old transcript but keep unclassified messages and a little context. Returns how many were dropped. */
  private reanchor(): number {
    const dropped = Math.max(0, this.classifiedCount - CHECKPOINT_KEEP);
    if (dropped === 0) return 0;
    this.window = this.window.slice(dropped);
    this.classifiedCount -= dropped;
    this.checkpoints++;
    return dropped;
  }

  /** Returns false when the classification could not be completed (messages stay pending for a retry). */
  private async classify(): Promise<boolean> {
    const { actions, roomId, client } = this.deps;
    let upTo = this.window.length; // messages arriving during the call stay pending for the next one
    let context: string;
    try {
      const state = await actions.getRoomState(roomId);
      context = await this.buildContext(state);
    } catch (e) {
      this.log('warn', 'listener could not read room context', { roomId, error: errMessage(e) });
      this.failures++;
      this.deps.onHealth?.(false, errMessage(e));
      this.scheduleRetry();
      return false;
    }
    if (this.stopped) return true;
    // The prefix is cached; a changed outline or a full window re-anchors the transcript checkpoint.
    if (
      (this.lastContext !== null && this.lastContext !== context) ||
      this.window.length >= this.t.listenerCheckpointMessages
    ) {
      upTo -= this.reanchor();
    }
    this.lastContext = context;

    const slice = this.window.slice(0, upTo);
    const newMessages = slice.slice(this.classifiedCount);
    if (newMessages.length === 0) return true;

    const lastClassified = this.classifiedCount > 0 ? slice[this.classifiedCount - 1]! : null;
    const content: Anthropic.TextBlockParam[] = slice.map((m) => ({
      type: 'text',
      text: formatTranscriptLine(m),
    }));
    content[content.length - 1] = {
      ...content[content.length - 1]!,
      cache_control: { type: 'ephemeral' },
    };
    content.push({
      type: 'text',
      text: lastClassified
        ? `Messages up to and including [${lastClassified.id}] (${this.classifiedCount} of ${slice.length}) were already classified: context only, do not re-emit them. Classify the ${newMessages.length} message(s) after it (${newMessages.map((m) => m.id).join(', ')}) and return the intents JSON.`
        : `None of these ${slice.length} messages have been classified yet. Classify them and return the intents JSON.`,
    });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODELS.listener,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: EFFORT.listener,
          format: {
            type: 'json_schema',
            schema: IntentBatchJsonSchema as unknown as Record<string, unknown>,
          },
        },
        system: [
          { type: 'text', text: LISTENER_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content }],
      });
    } catch (e) {
      // leave the messages unclassified: a retry (or the next push) classifies them
      this.log('warn', 'listener request failed', { roomId, error: errMessage(e) });
      this.failures++;
      this.deps.onHealth?.(false, errMessage(e));
      this.scheduleRetry();
      return false;
    }

    await this.recordUsage(response);
    this.failures = 0;
    this.deps.onHealth?.(true);
    if (this.stopped) return true;
    this.classifiedCount = slice.length;

    const intents = this.parse(
      response,
      new Set(slice.map((m) => m.id)),
      newMessages.map((m) => m.id),
    );
    const threshold = this.t.listenerConfidenceThreshold;
    const forward = intents.filter((i) => i.type !== 'none' && i.confidence >= threshold);
    this.log('debug', 'listener classified', {
      roomId,
      messages: newMessages.length,
      intents: intents.length,
      forwarded: forward.length,
    });
    if (forward.length > 0) {
      try {
        this.deps.onIntents({ intents: forward, messages: newMessages, context: slice });
      } catch (e) {
        this.log('error', 'listener onIntents threw', { roomId, error: errMessage(e) });
      }
    }
    return true;
  }

  /**
   * Validates intents one by one, so a single malformed entry does not discard the others. Message ids the model made
   * up are dropped (they would end up in commit trailers); an intent left with none refers to the new messages.
   */
  private parse(response: Anthropic.Message, known: Set<string>, fallbackIds: string[]): Intent[] {
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      this.log('warn', 'listener response unusable', {
        roomId: this.deps.roomId,
        stop: response.stop_reason,
      });
      return [];
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let raw: unknown;
    try {
      raw = (JSON.parse(unfence(text)) as { intents?: unknown } | null)?.intents;
    } catch (e) {
      this.log('warn', 'listener output was not JSON', {
        roomId: this.deps.roomId,
        error: errMessage(e),
      });
      return [];
    }
    if (!Array.isArray(raw)) {
      this.log('warn', 'listener output has no intents array', { roomId: this.deps.roomId });
      return [];
    }
    const out: Intent[] = [];
    let invalid = 0;
    for (const item of raw) {
      const parsed = IntentSchema.safeParse(item);
      if (!parsed.success) {
        invalid++;
        continue;
      }
      const ids = parsed.data.messageIds.filter((id) => known.has(id));
      out.push({ ...parsed.data, messageIds: ids.length > 0 ? ids : fallbackIds });
    }
    if (invalid > 0)
      this.log('warn', 'listener dropped intents that failed schema validation', {
        roomId: this.deps.roomId,
        invalid,
      });
    return out;
  }

  private async recordUsage(response: Anthropic.Message): Promise<void> {
    const u = response.usage;
    if (!u) return;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const costUsd = estimateCostUsd(MODELS.listener, {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead,
      cacheWrite,
    });
    await this.deps.actions
      .recordUsage({
        roomId: this.deps.roomId,
        sessionId: this.sessionId,
        role: 'listener',
        model: MODELS.listener,
        inputTokens: u.input_tokens + cacheWrite,
        outputTokens: u.output_tokens,
        cacheReadTokens: cacheRead,
        costUsd,
        at: new Date().toISOString(),
      })
      .catch(() => undefined);
  }
}
