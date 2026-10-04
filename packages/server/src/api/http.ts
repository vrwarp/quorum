import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResponse, Proposal } from '@quorum/shared';
import type { Storage, User } from '../contracts/index.js';
import type { ServerConfig } from '../config.js';
import type { RoomService } from '../room/RoomService.js';
import { RoomError, type Logger, type RoomErrorCode } from '../room/types.js';
import { AuthError, createAuth } from './auth.js';

export interface HttpOptions {
  service: Pick<
    RoomService,
    'createRoom' | 'listRooms' | 'getState' | 'getRoom' | 'repo' | 'listMessages'
  >;
  storage: Pick<Storage, 'users' | 'sessions' | 'rooms' | 'documents' | 'proposals' | 'changes' | 'usage' | 'messages'>;
  config: Pick<ServerConfig, 'password' | 'clientDistDir'>;
  logger?: Logger;
}

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ROOM_STATUS: Record<RoomErrorCode, number> = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409, internal: 500 };

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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
}

/** git ref/sha as accepted from the query string: no leading dash, no odd characters. */
function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9._/~^-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) throw new HttpError(400, 'bad_ref', 'invalid ref');
  return ref;
}

export function createHttpServer(opts: HttpOptions): Server {
  const { service, storage, config } = opts;
  const log: Logger = opts.logger ?? (() => undefined);
  const auth = createAuth({ storage, config });
  const distRoot = path.resolve(config.clientDistDir);

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const secure = req.headers['x-forwarded-proto'] === 'https';

    if (method === 'GET' && p === '/api/health') {
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && p === '/api/login') {
      const body = await readJson(req);
      try {
        const { token, user } = auth.login(body.password, body.displayName);
        sendJson(res, 200, { userId: user.id, displayName: user.displayName }, { 'set-cookie': auth.sessionCookie(token, secure) });
      } catch (err) {
        if (err instanceof AuthError) throw new HttpError(err.status, err.code, err.message);
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

    if (method === 'GET' && p === '/api/me') {
      const u = requireUser();
      sendJson(res, 200, { userId: u.id, displayName: u.displayName });
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
      if (typeof body.name !== 'string') throw new HttpError(400, 'bad_request', 'name is required');
      sendJson(res, 201, await service.createRoom(u.id, body.name));
      return true;
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
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
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
        if (!doc || doc.roomId !== roomId) throw new HttpError(404, 'not_found', 'document not found');
        const ref = safeRef(url.searchParams.get('ref') ?? 'main');
        const repo = await service.repo(roomId);
        const [content, sha] = await Promise.all([repo.readFile(doc.path, ref), repo.headSha(ref)]);
        if (content === null || sha === null) throw new HttpError(404, 'not_found', 'document not found at ref');
        sendJson(res, 200, { path: doc.path, ref, sha, content });
        return true;
      }
      if (rest.length === 3 && rest[0] === 'proposals' && rest[2] === 'diff') {
        const proposal: Proposal | null = storage.proposals.get(rest[1]!);
        if (!proposal || proposal.roomId !== roomId) throw new HttpError(404, 'not_found', 'proposal not found');
        const optionId = url.searchParams.get('optionId');
        const option = optionId ? proposal.options.find((o) => o.id === optionId) : proposal.options[0];
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
        if (!change || change.roomId !== roomId) throw new HttpError(404, 'not_found', 'change not found');
        const doc = storage.documents.get(change.documentId);
        if (!doc) throw new HttpError(404, 'not_found', 'document not found');
        const repo = await service.repo(roomId);
        const parent = `${sha}~1`;
        const [before, after, unified] = await Promise.all([
          repo.readFile(doc.path, parent),
          repo.readFile(doc.path, sha),
          repo.diff(doc.path, parent, sha),
        ]);
        const out: DiffResponse = { documentId: doc.id, path: doc.path, baseSha: parent, headSha: sha, before: before ?? '', after: after ?? '', unified };
        sendJson(res, 200, out);
        return true;
      }
    }
    return false;
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
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
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (await route(req, res, url)) return;
          throw new HttpError(404, 'not_found', 'unknown API route');
        }
        if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) throw new HttpError(404, 'not_found', 'not found');
        await serveStatic(req, res, url.pathname);
      } catch (err) {
        let status = 500;
        let code = 'internal';
        let message = 'internal error';
        if (err instanceof HttpError) ({ status, code, message } = { status: err.status, code: err.code, message: err.message });
        else if (err instanceof RoomError) ({ status, code, message } = { status: ROOM_STATUS[err.code], code: err.code, message: err.message });
        else log('error', 'request failed', { url: req.url, err: String((err as Error)?.stack ?? err) });
        if (res.headersSent) return void res.destroy();
        sendJson(res, status, { error: code, message });
      }
    })();
  });
}
