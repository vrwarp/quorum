import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResponse, Proposal } from '@quorum/shared';
import type { Storage, User } from '../contracts/index.js';
import type { ServerConfig } from '../config.js';
import type { RoomService } from '../room/RoomService.js';
import { RoomError, type Logger, type RoomErrorCode } from '../room/types.js';
import { LoginLimitError, type ClaudeAuthService } from '../claudeauth/index.js';
import { AuthError, createAuth } from './auth.js';
import { clientAddress, originAllowed } from './net.js';
import { noopTracer, writeDebugExport, type Tracer, type TraceFiles } from '../debug/index.js';

export interface HttpOptions {
  service: Pick<
    RoomService,
    'createRoom' | 'listRooms' | 'getState' | 'getRoom' | 'repo' | 'listMessages'
  >;
  storage: Pick<
    Storage,
    'users' | 'sessions' | 'rooms' | 'documents' | 'proposals' | 'changes' | 'usage' | 'messages'
  >;
  config: Pick<ServerConfig, 'password' | 'clientDistDir'> &
    Partial<Pick<ServerConfig, 'trustProxy' | 'allowedOrigins'>>;
  logger?: Logger;
  /** The server's Claude credential (web sign-in). When absent, `/api/claude/*` answers 503. */
  claudeAuth?: Pick<
    ClaudeAuthService,
    'status' | 'startLogin' | 'submitCode' | 'cancel' | 'logout'
  >;
  /**
   * Debug instrumentation: `trace` records API requests and client reports; `debugExport` makes
   * `GET /api/debug/export` (admin only) answer with a .tar.gz of traces, database, repositories and transcripts.
   */
  trace?: Tracer;
  debugExport?: {
    config: Parameters<typeof writeDebugExport>[1]['config'];
    traces: TraceFiles | null;
    databasePath: string | null;
  };
}

const MAX_BODY_BYTES = 256 * 1024;
/** the hash of the empty tree: what a root commit is compared against */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LOGIN_FAILURES_PER_WINDOW = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
/** most entries one client report may carry */
const CLIENT_LOG_MAX_ENTRIES = 100;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const ROOM_STATUS: Record<RoomErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  internal: 500,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  // A form or text/plain post can be sent by any page in the browser; JSON cannot without a CORS preflight we never grant.
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
}

/** Sliding-window per-key limiter for the endpoints that cost something (a login attempt is a live subprocess). */
class Throttle {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  private recent(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    return recent;
  }
  /** Counts the attempt when it is allowed. */
  allow(key: string, now = Date.now()): boolean {
    const recent = this.recent(key, now);
    const ok = recent.length < this.limit;
    if (ok) {
      recent.push(now);
      this.hits.set(key, recent);
    }
    return ok;
  }
  /** Whether the key is over its limit; counts nothing. */
  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }
  /** Counts one hit (a failure) against the key. */
  record(key: string, now = Date.now()): void {
    // keys come from the network: forget the expired ones before the table can grow without bound
    if (this.hits.size > 10_000) for (const k of [...this.hits.keys()]) this.recent(k, now);
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
  /** Seconds until the oldest hit leaves the window (what Retry-After says). */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const oldest = this.recent(key, now)[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }
}

/** git ref/sha as accepted from the query string: no leading dash, no odd characters. */
function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9._/~^-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..'))
    throw new HttpError(400, 'bad_ref', 'invalid ref');
  return ref;
}

export function createHttpServer(opts: HttpOptions): Server {
  const { service, storage, config } = opts;
  const log: Logger = opts.logger ?? (() => undefined);
  const trace = opts.trace ?? noopTracer;
  /** who made each request, for the trace */
  const requestUsers = new WeakMap<ServerResponse, string>();
  const auth = createAuth({ storage, config });
  const distRoot = path.resolve(config.clientDistDir);
  const loginStartThrottle = new Throttle(5, 10 * 60_000);
  const loginCodeThrottle = new Throttle(20, 10 * 60_000);
  /** wrong passwords per client address: without a limit the shared password can be guessed at network speed */
  const loginFailures = new Throttle(LOGIN_FAILURES_PER_WINDOW, LOGIN_FAILURE_WINDOW_MS);
  const trustProxy = config.trustProxy ?? false;
  const allowedOrigins = config.allowedOrigins ?? [];

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const ip = clientAddress(req, trustProxy);

    // A state-changing request made by a page of another origin carries the visitor's cookie when the site is the same
    // (another port on the host, a sibling subdomain). Browsers say where the page came from; believe them.
    if (
      method !== 'GET' &&
      method !== 'HEAD' &&
      !originAllowed(req.headers.origin, req.headers.host, allowedOrigins)
    )
      throw new HttpError(403, 'forbidden_origin', 'cross-origin requests are not accepted');

    if (method === 'GET' && p === '/api/health') {
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && p === '/api/login') {
      if (loginFailures.blocked(ip))
        throw new HttpError(
          429,
          'rate_limited',
          'Too many failed logins. Wait a few minutes and try again.',
          { 'retry-after': String(loginFailures.retryAfterSeconds(ip)) },
        );
      const body = await readJson(req);
      try {
        const { token, user } = auth.login(body.password, body.displayName);
        loginFailures.reset(ip);
        sendJson(
          res,
          200,
          { userId: user.id, displayName: user.displayName },
          { 'set-cookie': auth.sessionCookie(token, secure) },
        );
      } catch (err) {
        if (err instanceof AuthError) {
          if (err.code === 'invalid_password') loginFailures.record(ip);
          throw new HttpError(err.status, err.code, err.message);
        }
        throw err;
      }
      return true;
    }
    if (method === 'POST' && p === '/api/logout') {
      const session = auth.userFromRequest(req);
      if (session) auth.logout(session.token);
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(secure) });
      return true;
    }

    const session = auth.userFromRequest(req);
    const user: User | null = session?.user ?? null;
    const requireUser = (): User => {
      if (!user) throw new HttpError(401, 'unauthorized', 'login required');
      return user;
    };
    /** Quorum has no global owner; the first person who signed in is the admin of the server itself. */
    const requireAdmin = (what = 'manage the Claude sign-in'): User => {
      const u = requireUser();
      if (!u.admin)
        throw new HttpError(
          403,
          'forbidden',
          `only the server's admin (the first person who signed in) can ${what}`,
        );
      return u;
    };
    if (user) requestUsers.set(res, user.id);

    if (method === 'GET' && p === '/api/me') {
      const u = requireUser();
      sendJson(res, 200, { userId: u.id, displayName: u.displayName, isAdmin: u.admin });
      return true;
    }
    if (method === 'GET' && p === '/api/rooms') {
      requireUser();
      sendJson(res, 200, service.listRooms());
      return true;
    }
    if (method === 'POST' && p === '/api/rooms') {
      const u = requireUser();
      const body = await readJson(req);
      if (typeof body.name !== 'string')
        throw new HttpError(400, 'bad_request', 'name is required');
      sendJson(res, 201, await service.createRoom(u.id, body.name));
      return true;
    }

    if (method === 'POST' && p === '/api/debug/client-log') {
      const u = requireUser();
      const body = await readJson(req);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      for (const entry of entries.slice(0, CLIENT_LOG_MAX_ENTRIES))
        trace.record('client.log', { userId: u.id, userAgent: req.headers['user-agent'], entry });
      if (entries.length > CLIENT_LOG_MAX_ENTRIES)
        trace.record('client.log.dropped', {
          userId: u.id,
          count: entries.length - CLIENT_LOG_MAX_ENTRIES,
        });
      sendJson(res, 200, { ok: true, enabled: trace.enabled });
      return true;
    }
    if (method === 'GET' && p === '/api/debug/status') {
      requireAdmin('read the debug status');
      const files = opts.debugExport?.traces?.files() ?? [];
      sendJson(res, 200, {
        tracing: trace.enabled,
        exportAvailable: Boolean(opts.debugExport),
        traceFiles: files.length,
        traceBytes: files.reduce((n, f) => n + f.bytes, 0),
        oldestTrace: files[0] ? new Date(files[0].mtimeMs).toISOString() : null,
      });
      return true;
    }
    if (method === 'GET' && p === '/api/debug/export') {
      const u = requireAdmin('download a debug export');
      const exp = opts.debugExport;
      if (!exp)
        throw new HttpError(503, 'debug_export_unavailable', 'debug export is not available');
      const hoursRaw = url.searchParams.get('sinceHours');
      const hours = hoursRaw ? Number(hoursRaw) : NaN;
      if (hoursRaw && (!Number.isFinite(hours) || hours <= 0))
        throw new HttpError(400, 'bad_request', 'sinceHours must be a positive number');
      const flag = (name: string) =>
        !['0', 'false', 'no'].includes(url.searchParams.get(name) ?? '');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      trace.record('debug.export', { userId: u.id, sinceHours: hoursRaw ? hours : null });
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="quorum-debug-${stamp}.tar.gz"`,
        'cache-control': 'no-store',
      });
      await writeDebugExport(
        res,
        {
          ...exp,
          status: async () => ({
            claude: opts.claudeAuth ? await opts.claudeAuth.status() : null,
            rooms: service.listRooms().length,
          }),
        },
        {
          sinceMs: hoursRaw ? Date.now() - hours * 3_600_000 : undefined,
          repos: flag('repos'),
          transcripts: flag('transcripts'),
        },
      );
      return true;
    }

    if (p.startsWith('/api/claude/')) {
      requireAdmin(); // signing the server in or out of Claude affects every room and every participant
      const claude = opts.claudeAuth;
      if (!claude)
        throw new HttpError(
          503,
          'claude_auth_unavailable',
          'Claude sign-in is not available on this server',
        );

      if (method === 'GET' && p === '/api/claude/status') {
        sendJson(res, 200, await claude.status());
        return true;
      }
      if (method === 'POST' && p === '/api/claude/login/start') {
        const body = await readJson(req);
        const mode = body.mode ?? 'claudeai';
        if (mode !== 'claudeai' && mode !== 'console')
          throw new HttpError(400, 'bad_request', 'mode must be "claudeai" or "console"');
        if (!loginStartThrottle.allow(ip))
          throw new HttpError(
            429,
            'rate_limited',
            'Too many sign-in attempts. Wait a few minutes.',
          );
        try {
          const login = await claude.startLogin(mode);
          sendJson(res, 200, { loginId: login.loginId, url: login.url });
        } catch (err) {
          if (err instanceof LoginLimitError)
            throw new HttpError(429, 'too_many_logins', err.message);
          log('warn', 'could not start a claude sign-in', { err: String(err) });
          throw new HttpError(
            502,
            'claude_login_failed',
            err instanceof Error ? err.message : 'Could not start the sign-in.',
          );
        }
        return true;
      }
      if (method === 'POST' && p === '/api/claude/login/code') {
        const body = await readJson(req);
        if (
          typeof body.loginId !== 'string' ||
          !body.loginId ||
          typeof body.code !== 'string' ||
          !body.code.trim()
        ) {
          throw new HttpError(400, 'bad_request', 'loginId and code are required');
        }
        if (!loginCodeThrottle.allow(ip))
          throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
        const result = await claude.submitCode(body.loginId, body.code);
        if (!result.ok)
          throw new HttpError(
            400,
            'claude_login_failed',
            result.error ?? 'The code was not accepted.',
          );
        sendJson(res, 200, await claude.status());
        return true;
      }
      if (method === 'POST' && p === '/api/claude/login/cancel') {
        const body = await readJson(req);
        if (typeof body.loginId !== 'string' || !body.loginId)
          throw new HttpError(400, 'bad_request', 'loginId is required');
        claude.cancel(body.loginId);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (method === 'POST' && p === '/api/claude/logout') {
        await claude.logout();
        sendJson(res, 200, await claude.status());
        return true;
      }
      return false;
    }

    const m = /^\/api\/rooms\/([^/]+)\/(.+)$/.exec(p);
    if (m && method === 'GET') {
      const u = requireUser();
      const roomId = decodeURIComponent(m[1]!);
      const rest = m[2]!.split('/').map(decodeURIComponent);
      if (!service.getRoom(roomId)) throw new HttpError(404, 'not_found', 'room not found');

      if (rest.length === 1 && rest[0] === 'state') {
        sendJson(res, 200, await service.getState(roomId, u.id));
        return true;
      }
      if (rest.length === 1 && rest[0] === 'messages') {
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
          200,
        );
        const before = url.searchParams.get('before') ?? undefined;
        sendJson(res, 200, service.listMessages(roomId, u.id, { before, limit }));
        return true;
      }
      if (rest.length === 1 && rest[0] === 'usage') {
        sendJson(res, 200, storage.usage.summarize(roomId));
        return true;
      }
      if (rest.length === 2 && rest[0] === 'documents') {
        const doc = storage.documents.get(rest[1]!);
        if (!doc || doc.roomId !== roomId)
          throw new HttpError(404, 'not_found', 'document not found');
        const ref = safeRef(url.searchParams.get('ref') ?? 'main');
        const repo = await service.repo(roomId);
        const [content, sha] = await Promise.all([repo.readFile(doc.path, ref), repo.headSha(ref)]);
        if (content === null || sha === null)
          throw new HttpError(404, 'not_found', 'document not found at ref');
        sendJson(res, 200, { path: doc.path, ref, sha, content });
        return true;
      }
      if (rest.length === 3 && rest[0] === 'proposals' && rest[2] === 'diff') {
        const proposal: Proposal | null = storage.proposals.get(rest[1]!);
        if (!proposal || proposal.roomId !== roomId)
          throw new HttpError(404, 'not_found', 'proposal not found');
        const optionId = url.searchParams.get('optionId');
        const option = optionId
          ? proposal.options.find((o) => o.id === optionId)
          : proposal.options[0];
        if (!option) throw new HttpError(404, 'not_found', 'option not found');
        const doc = storage.documents.get(proposal.documentId);
        if (!doc) throw new HttpError(404, 'not_found', 'document not found');
        const repo = await service.repo(roomId);
        const [before, after, unified, headSha] = await Promise.all([
          repo.readFile(doc.path, proposal.branchBase),
          repo.readFile(doc.path, option.branch),
          repo.diff(doc.path, proposal.branchBase, option.branch),
          option.headSha ? Promise.resolve(option.headSha) : repo.headSha(option.branch),
        ]);
        const out: DiffResponse = {
          documentId: doc.id,
          path: doc.path,
          baseSha: proposal.branchBase,
          headSha: headSha ?? option.branch,
          before: before ?? '',
          after: after ?? '',
          unified,
        };
        sendJson(res, 200, out);
        return true;
      }
      if (rest.length === 3 && rest[0] === 'changes' && rest[2] === 'diff') {
        const sha = safeRef(rest[1]!);
        const change = storage.changes.get(sha);
        if (!change || change.roomId !== roomId)
          throw new HttpError(404, 'not_found', 'change not found');
        const doc = storage.documents.get(change.documentId);
        if (!doc) throw new HttpError(404, 'not_found', 'document not found');
        const repo = await service.repo(roomId);
        // The document may have been renamed since: its path is the one this commit touched, not today's.
        const touched = await repo.show(sha).then(
          (c) => c.files,
          () => [] as string[], // a commit git does not know: the diff comes back empty, as it always did
        );
        const docPath = touched.includes(doc.path)
          ? doc.path
          : ((touched.length === 1 ? touched[0] : touched.find((f) => f.endsWith('.md'))) ??
            doc.path);
        // the real parent (the first one for a merge), resolved here; a root commit is compared with nothing
        const parent = await repo.headSha(`${sha}^1`).catch(() => null);
        const [before, after, unified] = await Promise.all([
          parent ? repo.readFile(docPath, parent) : Promise.resolve(null),
          repo.readFile(docPath, sha),
          repo.diff(docPath, parent ?? EMPTY_TREE, sha),
        ]);
        const out: DiffResponse = {
          documentId: doc.id,
          path: docPath,
          baseSha: parent ?? sha,
          headSha: sha,
          before: before ?? '',
          after: after ?? '',
          unified,
        };
        sendJson(res, 200, out);
        return true;
      }
    }
    return false;
  }

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'bad_request', 'bad path');
    }
    const candidate = path.resolve(distRoot, '.' + path.posix.normalize('/' + rel));
    let file: string | null = null;
    if (candidate === distRoot || candidate.startsWith(distRoot + path.sep)) {
      const s = await stat(candidate).catch(() => null);
      if (s?.isFile()) file = candidate;
    }
    if (!file) {
      if (rel.startsWith('/assets/')) throw new HttpError(404, 'not_found', 'not found');
      file = path.join(distRoot, 'index.html'); // SPA fallback
    }
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) throw new HttpError(404, 'not_found', 'client build not found');
    const ext = path.extname(file).toLowerCase();
    const isIndex = path.basename(file) === 'index.html';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': s.size,
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return void res.end();
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file!);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    if (trace.enabled && req.url?.startsWith('/api')) {
      res.once('close', () => {
        const path = req.url?.split('?')[0];
        if (path === '/api/debug/client-log' || path === '/api/health') return; // reports are recorded as themselves
        trace.record('http', {
          method: req.method,
          path,
          // no API route takes a secret in the query string (the WebSocket's ?token= never reaches this handler)
          query: req.url?.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : undefined,
          status: res.statusCode,
          ms: Date.now() - started,
          userId: requestUsers.get(res),
          aborted: !res.writableFinished,
        });
      });
    }
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (await route(req, res, url)) return;
          throw new HttpError(404, 'not_found', 'unknown API route');
        }
        if (url.pathname === '/ws' || url.pathname.startsWith('/ws/'))
          throw new HttpError(404, 'not_found', 'not found');
        await serveStatic(req, res, url.pathname);
      } catch (err) {
        let status = 500;
        let code = 'internal';
        let message = 'internal error';
        let headers: Record<string, string> = {};
        if (err instanceof HttpError)
          ({ status, code, message, headers } = {
            status: err.status,
            code: err.code,
            message: err.message,
            headers: err.headers,
          });
        else if (err instanceof RoomError)
          ({ status, code, message } = {
            status: ROOM_STATUS[err.code],
            code: err.code,
            message: err.message,
          });
        else
          log('error', 'request failed', {
            // the path only: a token or other secret in the query string must not reach the log
            path: req.url?.split('?')[0],
            err: String((err as Error)?.stack ?? err),
          });
        if (res.headersSent) return void res.destroy();
        sendJson(res, status, { error: code, message }, headers);
      }
    })();
  });
}
