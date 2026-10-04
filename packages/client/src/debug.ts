/**
 * Client-side instrumentation: errors, console warnings, socket lifecycle, failed requests and navigation are buffered
 * and sent to the server's debug trace (`POST /api/debug/client-log`), so a debug export holds what browsers saw too.
 * Nothing here runs until `installClientDebug()` is called (tests import modules that log without a browser).
 */

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ClientLogEntry {
  at: string;
  level: ClientLogLevel;
  msg: string;
  data?: unknown;
  /** one id per page load, so entries of a tab can be told apart */
  pageId: string;
  path: string;
}

const ENDPOINT = '/api/debug/client-log';
const MAX_BUFFER = 200;
const FLUSH_MS = 5000;
const MAX_STRING = 8000;

let installed = false;
let enabled = true;
let buffer: ClientLogEntry[] = [];
let sending = false;
const pageId = Math.random().toString(36).slice(2, 10);

/** Makes console arguments and error objects JSON-safe and of bounded size. */
export function describe(value: unknown, depth = 0): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack?.slice(0, MAX_STRING) };
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => describe(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = describe(v, depth + 1);
  return out;
}

/** Records an entry; a no-op until installClientDebug() ran. */
export function clientLog(level: ClientLogLevel, msg: string, data?: unknown): void {
  if (!installed || !enabled) return;
  buffer.push({
    at: new Date().toISOString(),
    level,
    msg,
    ...(data === undefined ? {} : { data: describe(data) }),
    pageId,
    path: location.pathname,
  });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  if (level === 'error') void flush();
}

async function flush(): Promise<void> {
  if (sending || buffer.length === 0 || !enabled) return;
  const entries = buffer;
  buffer = [];
  sending = true;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      keepalive: true,
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { enabled?: boolean };
      if (body.enabled === false) enabled = false; // the server keeps no trace: stop collecting
    } else if (res.status !== 401 && res.status !== 404) {
      buffer = [...entries, ...buffer].slice(-MAX_BUFFER); // try again later; 401 (logged out) and 404 drop them
    }
  } catch {
    buffer = [...entries, ...buffer].slice(-MAX_BUFFER);
  } finally {
    sending = false;
  }
}

/** Last chance when the tab goes away: a beacon survives the page being unloaded. */
function flushOnExit(): void {
  if (buffer.length === 0 || !enabled || typeof navigator.sendBeacon !== 'function') return;
  const body = new Blob([JSON.stringify({ entries: buffer })], { type: 'application/json' });
  if (navigator.sendBeacon(ENDPOINT, body)) buffer = [];
}

export function installClientDebug(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  clientLog('info', 'page loaded', {
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    referrer: document.referrer || undefined,
  });
  window.addEventListener('error', (e) =>
    clientLog('error', 'uncaught error', {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      error: e.error,
    }),
  );
  window.addEventListener('unhandledrejection', (e) =>
    clientLog('error', 'unhandled rejection', { reason: e.reason }),
  );
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      clientLog(level, `console.${level}`, args);
    };
  }
  let lastPath = location.pathname;
  const onNav = () => {
    if (location.pathname === lastPath) return;
    clientLog('info', 'navigate', { from: lastPath, to: location.pathname });
    lastPath = location.pathname;
  };
  window.addEventListener('popstate', onNav);
  window.addEventListener('quorum:navigate', onNav);
  document.addEventListener('visibilitychange', () => {
    clientLog('debug', `page ${document.visibilityState}`);
    if (document.visibilityState === 'hidden') flushOnExit();
  });
  window.addEventListener('pagehide', flushOnExit);
  setInterval(() => void flush(), FLUSH_MS);
}
