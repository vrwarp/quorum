import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { ServerEvent } from '@quorum/shared';
import { RoomService } from '../room/RoomService.js';
import { FakeGit, MemoryStorage, StubRuntime } from '../room/testing/index.js';
import { createAuth, parseClientCommand, tokenFromRequest, verifyPassword, attachWebSocket, createHttpServer, type WsHandle } from './index.js';

describe('verifyPassword / auth', () => {
  it('compares passwords exactly', () => {
    expect(verifyPassword('secret', 'secret')).toBe(true);
    expect(verifyPassword('secret', 'secreT')).toBe(false);
    expect(verifyPassword('', 'secret')).toBe(false);
    expect(verifyPassword('a'.repeat(1000), 'secret')).toBe(false);
  });

  it('logs in, find-or-creates the user by display name and resolves tokens', () => {
    const storage = new MemoryStorage();
    const auth = createAuth({ storage, config: { password: 'pw' } });
    expect(() => auth.login('nope', 'Ann')).toThrow(/wrong password/);
    expect(() => auth.login('pw', '   ')).toThrow(/displayName/);
    const a = auth.login('pw', ' Ann ');
    const b = auth.login('pw', 'Ann');
    expect(a.user.id).toBe(b.user.id);
    expect(a.user.displayName).toBe('Ann');
    const req = { headers: { authorization: `Bearer ${a.token}` }, url: '/' } as never;
    expect(auth.userFromRequest(req)?.user.id).toBe(a.user.id);
    auth.logout(a.token);
    expect(auth.userFromRequest(req)).toBeNull();
  });

  it('accepts the token from bearer, query or cookie', () => {
    const mk = (headers: Record<string, string>, url = '/') => tokenFromRequest({ headers, url } as never);
    expect(mk({ authorization: 'Bearer abc' })).toBe('abc');
    expect(mk({}, '/ws?roomId=r&token=qq')).toBe('qq');
    expect(mk({ cookie: 'x=1; quorum_session=ck; y=2' })).toBe('ck');
    expect(mk({})).toBeNull();
  });

  it('allows login without a password only when none is configured', () => {
    const auth = createAuth({ storage: new MemoryStorage(), config: { password: null } });
    expect(auth.login(undefined, 'Zed').user.displayName).toBe('Zed');
  });

  it('sets an httpOnly SameSite=Lax cookie', () => {
    const auth = createAuth({ storage: new MemoryStorage(), config: { password: 'pw' } });
    const c = auth.sessionCookie('tok', false);
    expect(c).toContain('quorum_session=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(auth.sessionCookie('tok', true)).toContain('Secure');
  });
});

describe('command validation', () => {
  const anchor = { documentId: 'doc_1', baseSha: 'abc', startLine: 1, endLine: 2, textHash: 'h', text: 't' };
  it('accepts every command type', () => {
    const cmds = [
      { type: 'chat.send', body: 'hi' },
      { type: 'suggestion.create', anchor, replacement: '' },
      { type: 'ask.create', anchor, question: 'q?' },
      { type: 'vote.cast', proposalId: 'p', decision: 'approve', optionId: 'o' },
      { type: 'revert.request', sha: 'abcd1234' },
      { type: 'document.create', title: 'T' },
      { type: 'document.rename', documentId: 'd', title: 'T' },
      { type: 'document.archive', documentId: 'd' },
      { type: 'room.setRule', votingRule: 'majority' },
    ];
    for (const c of cmds) expect(parseClientCommand(JSON.stringify({ ...c, cid: 'c1' })).ok, c.type).toBe(true);
  });

  it('rejects malformed commands and keeps the cid', () => {
    expect(parseClientCommand('not json')).toMatchObject({ ok: false });
    expect(parseClientCommand(JSON.stringify({ type: 'nope', cid: 'x' }))).toMatchObject({ ok: false, cid: 'x' });
    expect(parseClientCommand(JSON.stringify({ type: 'chat.send', body: '', cid: 'x' }))).toMatchObject({ ok: false, cid: 'x' });
    expect(parseClientCommand(JSON.stringify({ type: 'vote.cast', proposalId: 'p', decision: 'maybe' })).ok).toBe(false);
    expect(parseClientCommand(JSON.stringify({ type: 'suggestion.create', anchor: { ...anchor, startLine: 0 }, replacement: 'x' })).ok).toBe(false);
    expect(parseClientCommand(JSON.stringify({ type: 'room.setRule', votingRule: 'dictator' })).ok).toBe(false);
  });
});

describe('http + websocket', () => {
  let server: Server;
  let ws: WsHandle;
  let service: RoomService;
  let storage: MemoryStorage;
  let base: string;
  let dist: string;

  beforeEach(async () => {
    dist = mkdtempSync(path.join(tmpdir(), 'quorum-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<html>spa</html>');
    writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    storage = new MemoryStorage();
    service = new RoomService({ storage, git: new FakeGit() });
    service.setRuntime(new StubRuntime());
    const config = { password: 'pw', clientDistDir: dist };
    server = createHttpServer({ service, storage, config });
    ws = attachWebSocket(server, { service, storage });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    ws.close();
    await service.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    rmSync(dist, { recursive: true, force: true });
  });

  async function login(name = 'Ann') {
    const res = await fetch(`http://${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw', displayName: name }),
    });
    const cookie = res.headers.get('set-cookie')!;
    return { res, cookie: cookie.split(';')[0]!, token: decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!) };
  }

  it('serves health, login, me, and gates API routes', async () => {
    expect(await (await fetch(`http://${base}/api/health`)).json()).toEqual({ ok: true });
    const bad = await fetch(`http://${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'x', displayName: 'A' }) });
    expect(bad.status).toBe(401);
    expect((await fetch(`http://${base}/api/me`)).status).toBe(401);
    const { res, cookie, token } = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(await (await fetch(`http://${base}/api/me`, { headers: { cookie } })).json()).toMatchObject({ displayName: 'Ann' });
    expect((await fetch(`http://${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    const unknown = await fetch(`http://${base}/api/nope`, { headers: { cookie } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('not_found');
  });

  it('creates rooms and returns state', async () => {
    const { cookie } = await login();
    const created = await fetch(`http://${base}/api/rooms`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'R1' }) });
    expect(created.status).toBe(201);
    const room = await created.json();
    const list = await (await fetch(`http://${base}/api/rooms`, { headers: { cookie } })).json();
    expect(list).toHaveLength(1);
    const state = await (await fetch(`http://${base}/api/rooms/${room.id}/state`, { headers: { cookie } })).json();
    expect(state.room.name).toBe('R1');
    expect((await fetch(`http://${base}/api/rooms/room_missing/state`, { headers: { cookie } })).status).toBe(404);
    const huge = await fetch(`http://${base}/api/rooms`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'x'.repeat(400_000) }) });
    expect(huge.status).toBe(413);
  });

  it('serves static files with an SPA fallback', async () => {
    expect(await (await fetch(`http://${base}/`)).text()).toBe('<html>spa</html>');
    expect(await (await fetch(`http://${base}/rooms/room_abc`)).text()).toBe('<html>spa</html>');
    expect(await (await fetch(`http://${base}/assets/app.js`)).text()).toBe('console.log(1)');
    expect((await fetch(`http://${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`http://${base}/../../etc/passwd`)).status).toBe(200); // normalized; falls back to index
  });

  function open(url: string): Promise<{ sock: WebSocket; events: ServerEvent[] }> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      const events: ServerEvent[] = [];
      sock.on('message', (d) => events.push(JSON.parse(d.toString())));
      sock.on('open', () => resolve({ sock, events }));
      sock.on('error', reject);
      sock.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });
  }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fn()).toBe(true);
  };

  it('rejects unauthenticated sockets, then handles commands and errors', async () => {
    const { cookie, token } = await login();
    const room = await (await fetch(`http://${base}/api/rooms`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'R' }) })).json();
    await expect(open(`ws://${base}/ws?roomId=${room.id}`)).rejects.toThrow(/401/);
    await expect(open(`ws://${base}/ws?roomId=${room.id}&token=bad`)).rejects.toThrow(/401/);
    await expect(open(`ws://${base}/ws?roomId=room_nope&token=${token}`)).rejects.toThrow(/404/);

    const { sock, events } = await open(`ws://${base}/ws?roomId=${room.id}&token=${token}`);
    await until(() => events.some((e) => e.type === 'hello'));
    sock.send(JSON.stringify({ type: 'chat.send', cid: 'c1', body: 'hello room' }));
    await until(() => events.some((e) => e.type === 'chat.message' && e.message.body === 'hello room'));
    sock.send(JSON.stringify({ type: 'chat.send', cid: 'c2', body: '' }));
    await until(() => events.some((e) => e.type === 'error' && e.inReplyTo === 'c2' && e.code === 'bad_request'));
    sock.send(JSON.stringify({ type: 'vote.cast', cid: 'c3', proposalId: 'prop_x', decision: 'approve' }));
    await until(() => events.some((e) => e.type === 'error' && e.inReplyTo === 'c3' && e.code === 'not_found'));
    sock.close();
    await until(() => storage.rooms.listPresence(room.id).every((p) => !p.connected));
  });
});
