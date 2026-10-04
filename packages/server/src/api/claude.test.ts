import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { RoomService } from '../room/RoomService.js';
import { FakeGit, MemoryStorage, StubRuntime } from '../room/testing/index.js';
import { LoginLimitError, type ClaudeAuthStatus } from '../claudeauth/index.js';
import { createHttpServer, type HttpOptions } from './index.js';

const signedOut: ClaudeAuthStatus = { signedIn: false, method: 'none', account: null, pendingLogins: 0 };
const signedIn: ClaudeAuthStatus = { signedIn: true, method: 'oauth_login', account: { email: 'me@example.com' }, pendingLogins: 0 };

function fakeClaude() {
  return {
    status: vi.fn(async () => signedOut),
    startLogin: vi.fn(async () => ({ loginId: 'L1', url: 'https://claude.com/cai/oauth/authorize?x=1' })),
    submitCode: vi.fn(async (_id: string, code: string) => (code === 'good' ? { ok: true } : { ok: false, error: 'bad code' })),
    cancel: vi.fn(() => true),
    logout: vi.fn(async () => undefined),
  };
}

describe('/api/claude', () => {
  let dist: string;
  let server: Server;
  let service: RoomService;
  let base: string;

  async function start(claudeAuth?: HttpOptions['claudeAuth']) {
    dist = mkdtempSync(path.join(tmpdir(), 'quorum-dist-'));
    const storage = new MemoryStorage();
    service = new RoomService({ storage, git: new FakeGit() });
    service.setRuntime(new StubRuntime());
    server = createHttpServer({ service, storage, config: { password: 'pw', clientDistDir: dist }, claudeAuth });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function login(): Promise<string> {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw', displayName: 'Ann' }),
    });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  const call = (cookie: string | null, method: string, p: string, body?: unknown) =>
    fetch(`${base}/api/claude/${p}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  afterEach(async () => {
    await service.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    rmSync(dist, { recursive: true, force: true });
  });

  describe('with the service', () => {
    let claude: ReturnType<typeof fakeClaude>;
    beforeEach(async () => {
      claude = fakeClaude();
      await start(claude);
    });

    it('requires a Quorum session on every route', async () => {
      for (const [method, p] of [
        ['GET', 'status'],
        ['POST', 'login/start'],
        ['POST', 'login/code'],
        ['POST', 'login/cancel'],
        ['POST', 'logout'],
      ] as const) {
        const res = await call(null, method, p, method === 'POST' ? {} : undefined);
        expect(res.status, `${method} ${p}`).toBe(401);
      }
      expect(claude.startLogin).not.toHaveBeenCalled();
      expect(claude.logout).not.toHaveBeenCalled();
    });

    it('returns status', async () => {
      const cookie = await login();
      const res = await call(cookie, 'GET', 'status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(signedOut);
    });

    it('starts a login and returns the link', async () => {
      const cookie = await login();
      const res = await call(cookie, 'POST', 'login/start', { mode: 'console' });
      expect(await res.json()).toEqual({ loginId: 'L1', url: 'https://claude.com/cai/oauth/authorize?x=1' });
      expect(claude.startLogin).toHaveBeenCalledWith('console');
      await call(cookie, 'POST', 'login/start', {});
      expect(claude.startLogin).toHaveBeenLastCalledWith('claudeai');
      expect((await call(cookie, 'POST', 'login/start', { mode: 'bogus' })).status).toBe(400);
    });

    it('maps the pending limit to 429 and other failures to 502', async () => {
      const cookie = await login();
      claude.startLogin.mockRejectedValueOnce(new LoginLimitError());
      expect((await call(cookie, 'POST', 'login/start', {})).status).toBe(429);
      claude.startLogin.mockRejectedValueOnce(new Error('Claude Code did not offer a sign-in link.'));
      const res = await call(cookie, 'POST', 'login/start', {});
      expect(res.status).toBe(502);
      expect((await res.json()).message).toMatch(/did not offer/);
    });

    it('throttles login starts per address', async () => {
      const cookie = await login();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await call(cookie, 'POST', 'login/start', {})).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    });

    it('accepts a code and answers with the new status; rejects a bad one', async () => {
      const cookie = await login();
      claude.status.mockResolvedValue(signedIn);
      const ok = await call(cookie, 'POST', 'login/code', { loginId: 'L1', code: 'good' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual(signedIn);
      const bad = await call(cookie, 'POST', 'login/code', { loginId: 'L1', code: 'nope' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).message).toBe('bad code');
      expect((await call(cookie, 'POST', 'login/code', { loginId: 'L1' })).status).toBe(400);
    });

    it('cancels and logs out', async () => {
      const cookie = await login();
      expect((await call(cookie, 'POST', 'login/cancel', { loginId: 'L1' })).status).toBe(200);
      expect(claude.cancel).toHaveBeenCalledWith('L1');
      expect((await call(cookie, 'POST', 'login/cancel', {})).status).toBe(400);
      const res = await call(cookie, 'POST', 'logout');
      expect(res.status).toBe(200);
      expect(claude.logout).toHaveBeenCalled();
    });

    it('404s unknown claude routes', async () => {
      const cookie = await login();
      expect((await call(cookie, 'GET', 'nope')).status).toBe(404);
    });
  });

  it('answers 503 when the service is not configured (after checking the session)', async () => {
    await start(undefined);
    expect((await call(null, 'GET', 'status')).status).toBe(401);
    const cookie = await login();
    expect((await call(cookie, 'GET', 'status')).status).toBe(503);
    expect((await call(cookie, 'POST', 'login/start', {})).status).toBe(503);
  });
});
