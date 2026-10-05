import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { ServerEvent } from '@quorum/shared';
import { RoomService } from '../room/RoomService.js';
import { FakeGit, FakeRepository, MemoryStorage, StubRuntime } from '../room/testing/index.js';
import { SESSION_TTL_MS } from '../contracts/index.js';
import { attachWebSocket, createHttpServer, type HttpOptions, type WsHandle } from './index.js';

/**
 * What the review of the server core asked of the HTTP and WebSocket layer: login throttling (F12), origin and
 * content-type checks (F13), command queues that do not freeze behind the write lock (F16), the admin-only Claude routes,
 * session expiry and token handling (F18), archived rooms.
 */

interface App {
  server: Server;
  ws: WsHandle;
  service: RoomService;
  storage: MemoryStorage;
  git: FakeGit;
  base: string;
  host: string;
  clock: { t: number };
  logs: Array<{ msg: string; meta?: Record<string, unknown> }>;
}

const apps: App[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.ws.close();
    await app.service.close();
    await new Promise<void>((r) => {
      app.server.close(() => r());
      app.server.closeAllConnections();
    });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(
  extra: Partial<HttpOptions['config']> = {},
  wsExtra: { allowedOrigins?: string[] } = {},
  claudeAuth?: HttpOptions['claudeAuth'],
): Promise<App> {
  const dist = mkdtempSync(path.join(tmpdir(), 'quorum-dist-'));
  dirs.push(dist);
  writeFileSync(path.join(dist, 'index.html'), '<html>spa</html>');
  const clock = { t: Date.parse('2026-03-01T00:00:00.000Z') };
  const storage = new MemoryStorage(() => new Date(clock.t));
  const git = new FakeGit();
  const logs: App['logs'] = [];
  const service = new RoomService({ storage, git, now: () => new Date(clock.t) });
  service.setRuntime(new StubRuntime());
  const logger = (_l: string, msg: string, meta?: Record<string, unknown>) =>
    logs.push({ msg, meta });
  const server = createHttpServer({
    service,
    storage,
    config: { password: 'pw', clientDistDir: dist, ...extra },
    claudeAuth,
    logger: logger as never,
  });
  const ws = attachWebSocket(server, { service, storage, ...wsExtra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app: App = { server, ws, service, storage, git, base: `http://${host}`, host, clock, logs };
  apps.push(app);
  return app;
}

/** A raw request, so headers a browser would send (Origin, Host) and bodies of any type can be set. */
function raw(
  app: App,
  method: string,
  route: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${app.base}${route}`,
      {
        method,
        headers: {
          ...(opts.body !== undefined
            ? { 'content-length': String(Buffer.byteLength(opts.body)) }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const json = { 'content-type': 'application/json' };
const login = async (
  app: App,
  name: string,
  password = 'pw',
  headers: Record<string, string> = {},
) => {
  const res = await raw(app, 'POST', '/api/login', {
    headers: { ...json, ...headers },
    body: JSON.stringify({ password, displayName: name }),
  });
  const cookie = /quorum_session=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''))?.[1];
  return {
    res,
    cookie: cookie ? `quorum_session=${cookie}` : '',
    token: cookie ? decodeURIComponent(cookie) : '',
  };
};

describe('login throttling (review F12)', () => {
  it('stops guessing after 10 wrong passwords from one address, even for the right one, and says when to come back', async () => {
    const app = await start();
    for (let i = 1; i <= 10; i++)
      expect((await login(app, 'Mallory', `guess${i}`)).res.status, `attempt ${i}`).toBe(401);
    const blocked = await login(app, 'Mallory', 'pw');
    expect(blocked.res.status).toBe(429);
    expect(JSON.parse(blocked.res.body)).toMatchObject({ error: 'rate_limited' });
    expect(Number(blocked.res.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.res.headers['set-cookie']).toBeUndefined();
    expect(app.storage.users.findByDisplayName('Mallory')).toBeNull();
  });

  it('counts failures only: ten logins that work never block anyone, and a success starts the count over', async () => {
    const app = await start();
    for (let i = 0; i < 12; i++) expect((await login(app, `User${i}`)).res.status).toBe(200);
    for (let i = 0; i < 9; i++) await login(app, 'Ann', 'wrong');
    expect((await login(app, 'Ann')).res.status).toBe(200); // the ninth failure did not block; success resets
    for (let i = 0; i < 9; i++) expect((await login(app, 'Ann', 'wrong')).res.status).toBe(401);
    expect((await login(app, 'Ann')).res.status).toBe(200);
  });

  it('the wrong-password window is 15 minutes', async () => {
    const app = await start();
    // the limiter reads the real clock; 15 minutes is the contract, so check the number rather than wait for it
    for (let i = 0; i < 10; i++) await login(app, 'Mallory', 'nope');
    const blocked = await login(app, 'Mallory', 'pw');
    expect(Number(blocked.res.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
    expect(Number(blocked.res.headers['retry-after'])).toBeGreaterThan(14 * 60);
  });

  it('is keyed by the socket address, and X-Forwarded-For is ignored unless the proxy is trusted', async () => {
    const app = await start();
    // an attacker who sets the header does not get a fresh allowance per value
    for (let i = 0; i < 10; i++)
      await login(app, 'Mallory', 'nope', { 'x-forwarded-for': `203.0.113.${i}` });
    expect(
      (await login(app, 'Mallory', 'pw', { 'x-forwarded-for': '203.0.113.99' })).res.status,
    ).toBe(429);
  });

  it('with QUORUM_TRUST_PROXY the first hop of X-Forwarded-For is the client: clients behind one proxy are throttled separately', async () => {
    const app = await start({ trustProxy: true });
    const via = (ip: string) => ({ 'x-forwarded-for': `${ip}, 10.0.0.1` });
    for (let i = 0; i < 10; i++) await login(app, 'Mallory', 'nope', via('203.0.113.7'));
    expect((await login(app, 'Mallory', 'pw', via('203.0.113.7'))).res.status).toBe(429);
    expect((await login(app, 'Ann', 'pw', via('198.51.100.2'))).res.status).toBe(200); // someone else behind the proxy
    expect((await login(app, 'Ann', 'pw')).res.status).toBe(200); // no header: the socket address
  });

  it('the Claude sign-in limits use the same client address', async () => {
    const claude = {
      status: async () => ({
        signedIn: false,
        method: 'none' as const,
        account: null,
        pendingLogins: 0,
      }),
      startLogin: async () => ({ loginId: 'L', url: 'https://claude.com/x' }),
      submitCode: async () => ({ ok: true }),
      cancel: () => true,
      logout: async () => undefined,
    };
    const app = await start({ trustProxy: true }, {}, claude);
    const { cookie } = await login(app, 'Admin');
    const startLogin = (ip: string) =>
      raw(app, 'POST', '/api/claude/login/start', {
        headers: { ...json, cookie, 'x-forwarded-for': ip },
        body: '{}',
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await startLogin('203.0.113.7')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await startLogin('198.51.100.2')).status).toBe(200); // another client behind the same proxy
  });
});

describe('origins and content types (review F13)', () => {
  it('a WebSocket from a page of another origin is refused, however valid the cookie', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const room = JSON.parse(
      (await raw(app, 'POST', '/api/rooms', { headers: { ...json, cookie }, body: '{"name":"R"}' }))
        .body,
    );
    const attempt = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const sock = new WebSocket(`ws://${app.host}/ws?roomId=${room.id}`, {
          headers: { cookie, ...headers },
        });
        sock.on('open', () => {
          sock.close();
          resolve(101);
        });
        sock.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        sock.on('error', () => undefined);
      });
    expect(await attempt({ origin: 'https://evil.example' })).toBe(403);
    expect(await attempt({ origin: `http://localhost:${app.host.split(':')[1]}` })).toBe(403); // same site, other host
    expect(await attempt({ origin: 'http://127.0.0.1:1' })).toBe(403); // same host, other port
    expect(await attempt({ origin: 'null' })).toBe(403);
    expect(await attempt({ origin: `http://${app.host}` })).toBe(101); // the page this server served
    expect(await attempt({})).toBe(101); // no Origin: not a browser page (a script, the tests)
  });

  it('QUORUM_ALLOWED_ORIGINS names the other origins that may open a socket', async () => {
    const app = await start(
      {},
      { allowedOrigins: ['https://quorum.example.com', 'app.example.com:8443'] },
    );
    const { cookie } = await login(app, 'Ann');
    const room = JSON.parse(
      (await raw(app, 'POST', '/api/rooms', { headers: { ...json, cookie }, body: '{"name":"R"}' }))
        .body,
    );
    const attempt = (origin: string) =>
      new Promise<number>((resolve) => {
        const sock = new WebSocket(`ws://${app.host}/ws?roomId=${room.id}`, {
          headers: { cookie, origin },
        });
        sock.on('open', () => {
          sock.close();
          resolve(101);
        });
        sock.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        sock.on('error', () => undefined);
      });
    expect(await attempt('https://quorum.example.com')).toBe(101);
    expect(await attempt('https://Quorum.Example.com/')).toBe(101);
    expect(await attempt('https://app.example.com:8443')).toBe(101); // listed as a bare host
    expect(await attempt('https://quorum.example.com.evil.example')).toBe(403);
    expect(await attempt('http://quorum.example.com')).toBe(403); // another scheme is another origin
  });

  it('a state-changing request from another origin is refused; reads and same-origin requests are not', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const cross = { origin: 'https://evil.example', cookie };
    expect(
      (
        await raw(app, 'POST', '/api/rooms', {
          headers: { ...json, ...cross },
          body: '{"name":"R"}',
        })
      ).status,
    ).toBe(403);
    expect((await raw(app, 'POST', '/api/logout', { headers: cross })).status).toBe(403); // no body: a "simple" request
    expect(app.service.listRooms()).toEqual([]);
    expect((await raw(app, 'GET', '/api/me', { headers: cross })).status).toBe(200);
    const same = { origin: app.base, cookie };
    expect(
      (
        await raw(app, 'POST', '/api/rooms', {
          headers: { ...json, ...same },
          body: '{"name":"R"}',
        })
      ).status,
    ).toBe(201);
  });

  it('a request body must be JSON: a form or text post is refused, an empty one is fine', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const post = (type: string | null, body: string) =>
      raw(app, 'POST', '/api/rooms', {
        headers: { cookie, ...(type ? { 'content-type': type } : {}) },
        body,
      });
    expect((await post('text/plain', '{"name":"R"}')).status).toBe(415);
    expect((await post('application/x-www-form-urlencoded', 'name=R')).status).toBe(415);
    expect((await post(null, '{"name":"R"}')).status).toBe(415);
    expect(JSON.parse((await post('text/plain', '{"name":"R"}')).body)).toMatchObject({
      error: 'unsupported_media_type',
    });
    expect((await post('application/json; charset=utf-8', '{"name":"R"}')).status).toBe(201);
    expect((await post('application/json', '[]')).status).toBe(400);
    expect(app.service.listRooms()).toHaveLength(1);
    // the login form is held to the same rule
    const badLogin = await raw(app, 'POST', '/api/login', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ password: 'pw', displayName: 'Eve' }),
    });
    expect(badLogin.status).toBe(415);
    expect(badLogin.headers['set-cookie']).toBeUndefined();
    // no body at all needs no content type
    expect((await raw(app, 'POST', '/api/logout', { headers: { cookie } })).status).toBe(200);
  });
});

describe('who may do what (review F18)', () => {
  const claude = () => {
    const calls: string[] = [];
    return {
      calls,
      status: async () => (
        calls.push('status'),
        { signedIn: false, method: 'none' as const, account: null, pendingLogins: 0 }
      ),
      startLogin: async () => (
        calls.push('startLogin'),
        { loginId: 'L', url: 'https://claude.com/x' }
      ),
      submitCode: async () => (calls.push('submitCode'), { ok: true }),
      cancel: () => (calls.push('cancel'), true),
      logout: async () => void calls.push('logout'),
    };
  };

  it('only the first person who logged in can sign the server in or out of Claude', async () => {
    const c = claude();
    const app = await start({}, {}, c);
    const admin = await login(app, 'Admin');
    const guest = await login(app, 'Guest');
    expect(
      JSON.parse((await raw(app, 'GET', '/api/me', { headers: { cookie: admin.cookie } })).body),
    ).toMatchObject({ displayName: 'Admin', isAdmin: true });
    expect(
      JSON.parse((await raw(app, 'GET', '/api/me', { headers: { cookie: guest.cookie } })).body),
    ).toMatchObject({ displayName: 'Guest', isAdmin: false });

    for (const [method, p] of [
      ['GET', 'status'],
      ['POST', 'login/start'],
      ['POST', 'login/code'],
      ['POST', 'login/cancel'],
      ['POST', 'logout'],
    ] as const) {
      const res = await raw(app, method, `/api/claude/${p}`, {
        headers: { ...json, cookie: guest.cookie },
        body: method === 'POST' ? JSON.stringify({ loginId: 'L', code: 'x' }) : undefined,
      });
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'forbidden' });
    }
    expect(c.calls).toEqual([]); // nothing reached the sign-in service
    expect(
      (await raw(app, 'GET', '/api/claude/status', { headers: { cookie: admin.cookie } })).status,
    ).toBe(200);
    expect(
      (await raw(app, 'POST', '/api/claude/logout', { headers: { cookie: admin.cookie } })).status,
    ).toBe(200);
    expect(c.calls).toEqual(['status', 'logout', 'status']);
  });

  it('a logged-in session lasts 30 days', async () => {
    const app = await start();
    const { cookie, token } = await login(app, 'Ann');
    expect((await raw(app, 'GET', '/api/me', { headers: { cookie } })).status).toBe(200);
    app.clock.t += SESSION_TTL_MS - 1000;
    expect((await raw(app, 'GET', '/api/me', { headers: { cookie } })).status).toBe(200);
    app.clock.t += 1000;
    expect((await raw(app, 'GET', '/api/me', { headers: { cookie } })).status).toBe(401);
    expect(
      (await raw(app, 'GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    expect((await login(app, 'Ann')).res.status).toBe(200); // logging in again works
  });

  it('?token= is read on the WebSocket and nowhere else', async () => {
    const app = await start();
    const { cookie, token } = await login(app, 'Ann');
    expect((await raw(app, 'GET', `/api/me?token=${token}`)).status).toBe(401);
    expect((await raw(app, 'GET', '/api/me', { headers: { cookie } })).status).toBe(200);
    expect(
      (await raw(app, 'GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    const room = JSON.parse(
      (await raw(app, 'POST', '/api/rooms', { headers: { ...json, cookie }, body: '{"name":"R"}' }))
        .body,
    );
    const sock = new WebSocket(`ws://${app.host}/ws?roomId=${room.id}&token=${token}`);
    const hello = await new Promise<ServerEvent>((resolve, reject) => {
      sock.on('message', (d) => resolve(JSON.parse(d.toString())));
      sock.on('error', reject);
    });
    expect(hello.type).toBe('hello');
    sock.close();
  });

  it('an internal error logs the path, never the query string that may hold a token', async () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'quorum-dist-'));
    dirs.push(dist);
    const storage = new MemoryStorage();
    const logs: Array<Record<string, unknown> | undefined> = [];
    const service = {
      createRoom: async () => {
        throw new Error('x');
      },
      listRooms: () => [],
      getRoom: () => ({ id: 'room_1' }),
      getState: async () => {
        throw new Error('boom');
      },
      repo: async () => {
        throw new Error('x');
      },
      listMessages: () => [],
    };
    const server = createHttpServer({
      service: service as never,
      storage,
      config: { password: 'pw', clientDistDir: dist },
      logger: (_l, _m, meta) => logs.push(meta),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const u = storage.users.create('Ann');
    const { token } = storage.sessions.create(u.id);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/rooms/room_1/state?token=${token}&secret=hunter2`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(logs)).toContain('/api/rooms/room_1/state');
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  });
});

describe('commands that wait for the write lock do not freeze the socket (review F16)', () => {
  function connect(app: App, cookie: string, roomId: string) {
    const events: ServerEvent[] = [];
    const sock = new WebSocket(`ws://${app.host}/ws?roomId=${roomId}`, { headers: { cookie } });
    sock.on('message', (d) => events.push(JSON.parse(d.toString())));
    const until = async (fn: (e: ServerEvent[]) => boolean, label: string) => {
      for (let i = 0; i < 300 && !fn(events); i++) await new Promise((r) => setTimeout(r, 10));
      expect(fn(events), label).toBe(true);
    };
    return { sock, events, until, send: (c: unknown) => sock.send(JSON.stringify(c)) };
  }

  it('chat, votes and errors by cid keep flowing while a document change waits behind a merge', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const room = JSON.parse(
      (await raw(app, 'POST', '/api/rooms', { headers: { ...json, cookie }, body: '{"name":"R"}' }))
        .body,
    );
    const c = connect(app, cookie, room.id);
    await c.until((e) => e.some((x) => x.type === 'hello'), 'hello');
    const repo = app.git.repos.get(room.id) as FakeRepository;

    // a merge holds the write lock for as long as the merge driver runs
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const merge = repo.withMainLock(() => gate);
    c.send({ type: 'document.create', cid: 'doc1', title: 'Spec' });
    c.send({ type: 'chat.send', cid: 'chat1', body: 'still talking' });
    await c.until(
      (e) => e.some((x) => x.type === 'chat.message' && x.message.body === 'still talking'),
      'chat flows while document.create waits for the lock',
    );
    expect(c.events.some((e) => e.type === 'document.created')).toBe(false);
    // an invalid lock-taking command is answered at once, by cid
    c.send({ type: 'document.archive', cid: 'bad', documentId: 'doc_missing' });
    await c.until(
      (e) => e.some((x) => x.type === 'error' && x.inReplyTo === 'bad' && x.code === 'not_found'),
      'error by cid',
    );

    release();
    await merge;
    await c.until(
      (e) => e.some((x) => x.type === 'document.created' && x.document.title === 'Spec'),
      'the document appears once the lock is free',
    );
    expect(c.events.filter((e) => e.type === 'error' && e.inReplyTo === 'doc1')).toEqual([]);
    c.sock.close();
  });

  it('a lock-taking command that fails after the wait reports its error under its own cid', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const room = JSON.parse(
      (await raw(app, 'POST', '/api/rooms', { headers: { ...json, cookie }, body: '{"name":"R"}' }))
        .body,
    );
    const c = connect(app, cookie, room.id);
    await c.until((e) => e.some((x) => x.type === 'hello'), 'hello');
    const repo = app.git.repos.get(room.id) as FakeRepository;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const merge = repo.withMainLock(() => gate);
    c.send({ type: 'document.create', cid: 'first', title: 'Spec' });
    c.send({ type: 'document.create', cid: 'second', title: 'Spec' });
    release();
    await merge;
    await c.until(
      (e) => e.some((x) => x.type === 'error' && x.inReplyTo === 'second' && x.code === 'conflict'),
      'duplicate refused by cid',
    );
    expect(app.storage.documents.list(room.id)).toHaveLength(1);
    c.sock.close();
  });
});

describe('archived rooms', () => {
  it('leave the room list, and a new connection is told why and closed', async () => {
    const app = await start();
    const { cookie } = await login(app, 'Ann');
    const make = async (name: string) =>
      JSON.parse(
        (
          await raw(app, 'POST', '/api/rooms', {
            headers: { ...json, cookie },
            body: JSON.stringify({ name }),
          })
        ).body,
      );
    const keep = await make('Keep');
    const gone = await make('Gone');
    expect(
      JSON.parse((await raw(app, 'GET', '/api/rooms', { headers: { cookie } })).body).map(
        (r: { name: string }) => r.name,
      ),
    ).toEqual(['Keep', 'Gone']);

    // archived over the socket, by the owner
    const owner = new WebSocket(`ws://${app.host}/ws?roomId=${gone.id}`, { headers: { cookie } });
    const seen: ServerEvent[] = [];
    owner.on('message', (d) => seen.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => owner.on('open', () => r()));
    for (let i = 0; i < 100 && !seen.some((e) => e.type === 'hello'); i++)
      await new Promise((r) => setTimeout(r, 10));
    owner.send(JSON.stringify({ type: 'room.archive', cid: 'arch' }));
    for (let i = 0; i < 100 && !seen.some((e) => e.type === 'room.updated'); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(seen.find((e) => e.type === 'room.updated')).toMatchObject({
      room: { id: gone.id, archivedAt: expect.any(String) },
    });
    expect(seen.some((e) => e.type === 'error')).toBe(false);
    owner.close();

    expect(
      JSON.parse((await raw(app, 'GET', '/api/rooms', { headers: { cookie } })).body).map(
        (r: { name: string }) => r.name,
      ),
    ).toEqual(['Keep']);
    // history is still readable
    expect(
      (await raw(app, 'GET', `/api/rooms/${gone.id}/state`, { headers: { cookie } })).status,
    ).toBe(200);

    const refused = await new Promise<{ events: ServerEvent[]; code: number; reason: string }>(
      (resolve, reject) => {
        const sock = new WebSocket(`ws://${app.host}/ws?roomId=${gone.id}`, {
          headers: { cookie },
        });
        const events: ServerEvent[] = [];
        sock.on('message', (d) => events.push(JSON.parse(d.toString())));
        sock.on('close', (code, reason) => resolve({ events, code, reason: reason.toString() }));
        sock.on('error', reject);
      },
    );
    expect(refused.events).toEqual([
      { type: 'error', code: 'room_archived', message: expect.stringContaining('archived') },
    ]);
    expect(refused.code).toBe(1008);
    expect(refused.reason).toBe('room archived');
    expect(app.storage.rooms.listPresence(gone.id).filter((p) => p.connected)).toEqual([]);

    // other rooms are unaffected
    const ok = new WebSocket(`ws://${app.host}/ws?roomId=${keep.id}`, { headers: { cookie } });
    const hello = await new Promise<ServerEvent>((resolve, reject) => {
      ok.on('message', (d) => resolve(JSON.parse(d.toString())));
      ok.on('error', reject);
    });
    expect(hello.type).toBe('hello');
    ok.close();
  });

  it('only the owner can archive it: anyone else gets forbidden under their cid', async () => {
    const app = await start();
    const owner = await login(app, 'Owner');
    const other = await login(app, 'Other');
    const room = JSON.parse(
      (
        await raw(app, 'POST', '/api/rooms', {
          headers: { ...json, cookie: owner.cookie },
          body: '{"name":"R"}',
        })
      ).body,
    );
    const sock = new WebSocket(`ws://${app.host}/ws?roomId=${room.id}`, {
      headers: { cookie: other.cookie },
    });
    const events: ServerEvent[] = [];
    sock.on('message', (d) => events.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => sock.on('open', () => r()));
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'hello'); i++)
      await new Promise((r) => setTimeout(r, 10));
    sock.send(JSON.stringify({ type: 'room.archive', cid: 'no' }));
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'error'); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'forbidden',
      inReplyTo: 'no',
    });
    expect(app.storage.rooms.get(room.id)!.archivedAt).toBeNull();
    sock.close();
  });
});

describe('a client that hangs up mid-request', () => {
  it('is not logged as a server error', async () => {
    const app = await start();
    const u = app.storage.users.create('Ann');
    const { token } = app.storage.sessions.create(u.id);
    // a POST whose body never fully arrives: the socket is destroyed after half of it
    await new Promise<void>((resolve) => {
      const req = http.request(`${app.base}/api/debug/client-log`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': '1000',
        },
      });
      req.on('error', () => resolve());
      req.write('{"entries":[');
      setTimeout(() => req.destroy(), 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(app.logs.filter((l) => l.msg === 'request failed')).toEqual([]);
  });
});
