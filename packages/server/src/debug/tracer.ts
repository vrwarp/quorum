import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Structured debug trace: one JSON object per line (`{"t":"<iso>","kind":"…",…}`), written under
 * `<dataDir>/debug/traces/` so an operator can export it (GET /api/debug/export) and hand it over for analysis. It is
 * not anonymized: chat text, prompts and model output are recorded as they are. Credentials are not (see SECRET_KEYS).
 */
export interface Tracer {
  readonly enabled: boolean;
  record(kind: string, data?: Record<string, unknown>): void;
}

export const noopTracer: Tracer = { enabled: false, record: () => undefined };

/** Keys whose values are credentials: replaced in every record, wherever they appear. */
const SECRET_KEYS = new Set([
  'password',
  'token',
  'apikey',
  'anthropicapikey',
  'anthropic_api_key',
  'claude_code_oauth_token',
  'claudeoauthtoken',
  'authorization',
  'cookie',
  'set-cookie',
]);

/** Longest string kept in a record; tool results that read whole files would otherwise dominate the trace. */
export const MAX_STRING = 64 * 1024;

/** JSON for a trace line: secrets redacted, long strings cut, errors expanded, cycles and bigints survivable. */
export function traceJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, v: unknown) => {
    if (key && SECRET_KEYS.has(key.toLowerCase()) && v !== null && v !== undefined && v !== '')
      return '[redacted]';
    if (typeof v === 'string' && v.length > MAX_STRING)
      return `${v.slice(0, MAX_STRING)}…[truncated ${v.length - MAX_STRING} chars]`;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

export interface TraceRecorderOptions {
  dir: string;
  /** a file is closed and a new one started past this size (default 20 MB) */
  maxFileBytes?: number;
  /** the oldest files are deleted once all of them together pass this (default 500 MB) */
  maxTotalBytes?: number;
  /** buffered lines are written at least this often (default 1 s) */
  flushMs?: number;
  now?: () => Date;
}

const FLUSH_BYTES = 256 * 1024;

/** Appends trace lines to rotating JSONL files. Writes are buffered and flushed on a timer, on size, and by `flush()`. */
export class TraceRecorder implements Tracer {
  readonly enabled = true;
  readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private file: string | null = null;
  private fileBytes = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null;
  private closed = false;
  private failed = false;

  constructor(opts: TraceRecorderOptions) {
    this.dir = opts.dir;
    this.maxFileBytes = opts.maxFileBytes ?? 20 * 1024 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 500 * 1024 * 1024;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.flush(), opts.flushMs ?? 1000);
    this.timer.unref();
  }

  record(kind: string, data: Record<string, unknown> = {}): void {
    if (this.closed || this.failed) return;
    let line: string;
    try {
      line = traceJson({ t: this.now().toISOString(), kind, ...data });
    } catch (e) {
      line = traceJson({ t: this.now().toISOString(), kind, unserializable: String(e) });
    }
    this.buffer.push(line + '\n');
    this.bufferBytes += line.length + 1;
    if (this.bufferBytes >= FLUSH_BYTES) this.flush();
  }

  /** Writes what is buffered. Called before an export so the files on disk are complete. */
  flush(): void {
    if (this.buffer.length === 0 || this.failed) return;
    const text = this.buffer.join('');
    this.buffer = [];
    this.bufferBytes = 0;
    try {
      if (!this.file || this.fileBytes >= this.maxFileBytes) this.rotate();
      appendFileSync(this.file!, text);
      this.fileBytes += Buffer.byteLength(text);
    } catch (e) {
      // a full disk or a removed directory must not take the server down; tracing just stops
      this.failed = true;
      console.error(`debug trace disabled: ${String(e)}`);
    }
  }

  private rotate(): void {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    this.file = path.join(this.dir, `trace-${stamp}-${process.pid}-${++this.seq}.jsonl`);
    this.fileBytes = 0;
    this.prune();
  }

  /** Trace files, oldest first. */
  files(): Array<{ path: string; bytes: number; mtimeMs: number }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith('trace-') && n.endsWith('.jsonl'))
      .map((n) => {
        const p = path.join(this.dir, n);
        try {
          const s = statSync(p);
          return { path: p, bytes: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; bytes: number; mtimeMs: number } => f !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  }

  private prune(): void {
    const files = this.files();
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const f of files) {
      if (total <= this.maxTotalBytes) break;
      if (f.path === this.file) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
      } catch {
        /* already gone */
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
