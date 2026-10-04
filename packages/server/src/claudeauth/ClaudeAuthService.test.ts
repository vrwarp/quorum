import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeAuthService, MAX_PENDING_LOGINS, type ClaudeAuthDeps, type ExecFileFn, type LoginChild } from './index.js';

const URL_LINE = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc123\n";

class FakeChild extends EventEmitter implements LoginChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  env: NodeJS.ProcessEnv = {};
  args: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.written.push(chunk);
      queueMicrotask(() => this.onInput(chunk.trim()));
    },
  };
  onInput: (code: string) => void = () => undefined;
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'));
    return true;
  }
  say(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }
}

let root: string;
let configDir: string;
let children: FakeChild[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'quorum-claudeauth-'));
  configDir = path.join(root, 'claude');
  children = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A CLI that prints the link, then accepts exactly `accept` by writing credentials and exiting 0. */
function cliBehavior(opts: { accept?: string; noUrl?: boolean; exitEarly?: boolean; writeCreds?: boolean } = {}) {
  const accept = opts.accept ?? 'good-code';
  return (_cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }): LoginChild => {
    const child = new FakeChild();
    child.env = o.env;
    child.args = args;
    children.push(child);
    child.onInput = (code) => {
      if (code === accept) {
        if (opts.writeCreds !== false) {
          const dir = o.env.CLAUDE_CONFIG_DIR!;
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'staged' } }));
        }
        child.say('\nLogin successful\n');
        child.emit('exit', 0, null);
      } else {
        child.stderr.emit('data', Buffer.from('Login failed: Request failed with status code 400\n'));
        child.emit('exit', 1, null);
      }
    };
    queueMicrotask(() => {
      if (opts.noUrl) child.say('Something went wrong before any link\n');
      else {
        child.say('Opening browser to sign in...\n');
        child.say(URL_LINE);
        child.say('Paste code here if prompted > ');
      }
      if (opts.exitEarly) child.emit('exit', 1, null);
    });
    return child;
  };
}

function make(overrides: Partial<ClaudeAuthDeps> & { cli?: Parameters<typeof cliBehavior>[0] } = {}) {
  const { cli, ...rest } = overrides;
  const service = new ClaudeAuthService({
    config: { claudeConfigDir: configDir, claudeBinary: 'claude', claudeOauthToken: null, anthropicApiKey: null },
    spawn: cliBehavior(cli),
    execFile: async () => {
      throw Object.assign(new Error('not logged in'), { code: 1 });
    },
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'ambient', CLAUDE_CODE_OAUTH_TOKEN: 'ambient' },
    timeouts: { urlMs: 200, codeMs: 200, loginMs: 5_000 },
    ...rest,
  });
  return service;
}

const credsPath = () => path.join(configDir, '.credentials.json');

describe('startLogin', () => {
  it('parses the https link, even when it arrives split across chunks', async () => {
    const service = make({
      spawn: (_c, _a, o) => {
        const child = new FakeChild();
        child.env = o.env;
        children.push(child);
        queueMicrotask(() => {
          child.say('visit: https://claude.com/cai/oauth/auth');
          child.say('orize?code=true&state=abc123\nPaste code here > ');
        });
        return child;
      },
    });
    const login = await service.startLogin();
    expect(login.url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=abc123');
    expect(login.loginId).toBeTruthy();
    expect(service.pendingCount).toBe(1);
    service.cancelAll();
  });

  it('runs the CLI against a staging dir, without ambient credentials', async () => {
    const service = make();
    await service.startLogin();
    const child = children[0]!;
    expect(child.env.CLAUDE_CONFIG_DIR).not.toBe(configDir);
    expect(child.env.CLAUDE_CONFIG_DIR).toContain(path.join(root, 'claude-login'));
    expect(child.env.BROWSER).toBe('/bin/true');
    expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child.args).toEqual(['auth', 'login', '--claudeai']);
    service.cancelAll();
  });

  it('supports console mode and rejects unknown modes', async () => {
    const service = make();
    await service.startLogin('console');
    expect(children[0]!.args).toEqual(['auth', 'login', '--console']);
    await expect(service.startLogin('nope' as never)).rejects.toThrow(/mode/);
    service.cancelAll();
  });

  it('fails and leaves nothing pending when the CLI exits before offering a link', async () => {
    const service = make({ cli: { noUrl: true, exitEarly: true } });
    await expect(service.startLogin()).rejects.toThrow(/exited/);
    expect(service.pendingCount).toBe(0);
  });

  it('fails when no link appears in time', async () => {
    const service = make({ cli: { noUrl: true }, timeouts: { urlMs: 30, codeMs: 200, loginMs: 5_000 } });
    await expect(service.startLogin()).rejects.toThrow(/did not offer/);
    expect(service.pendingCount).toBe(0);
    expect(children[0]!.killed).toBe(true);
  });

  it('limits pending logins', async () => {
    const service = make();
    for (let i = 0; i < MAX_PENDING_LOGINS; i++) await service.startLogin();
    await expect(service.startLogin()).rejects.toThrow(/Too many/);
    expect(service.pendingCount).toBe(MAX_PENDING_LOGINS);
    service.cancelAll();
    expect(service.pendingCount).toBe(0);
  });
});

describe('submitCode', () => {
  it('promotes credentials, notifies listeners and drops the staging dir on exit 0', async () => {
    const service = make();
    const onChange = vi.fn();
    service.onChange(onChange);
    const login = await service.startLogin();
    const staging = children[0]!.env.CLAUDE_CONFIG_DIR!;
    const before = service.changeCount;

    const result = await service.submitCode(login.loginId, 'good-code');

    expect(result).toEqual({ ok: true });
    expect(children[0]!.written).toEqual(['good-code\n']);
    expect(readFileSync(credsPath(), 'utf8')).toContain('staged');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(service.changeCount).toBe(before + 1);
    expect(service.pendingCount).toBe(0);
    await vi.waitFor(() => expect(existsSync(staging)).toBe(false));
  });

  it('reports a rejected code and promotes nothing', async () => {
    const service = make();
    const onChange = vi.fn();
    service.onChange(onChange);
    const login = await service.startLogin();
    const result = await service.submitCode(login.loginId, 'wrong');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/400/);
    expect(existsSync(credsPath())).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(0);
  });

  it('does not overwrite existing credentials when the attempt fails', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(credsPath(), 'existing');
    const service = make();
    const login = await service.startLogin();
    await service.submitCode(login.loginId, 'wrong');
    expect(readFileSync(credsPath(), 'utf8')).toBe('existing');
  });

  it('fails when the CLI exits 0 without leaving credentials', async () => {
    const service = make({ cli: { writeCreds: false } });
    const login = await service.startLogin();
    const result = await service.submitCode(login.loginId, 'good-code');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no credentials/);
    expect(service.pendingCount).toBe(0);
  });

  it('rejects unknown ids, empty and multi-line codes, and reuse', async () => {
    const service = make();
    expect((await service.submitCode('nope', 'x')).error).toMatch(/expired/);
    const login = await service.startLogin();
    expect((await service.submitCode(login.loginId, '   ')).ok).toBe(false);
    expect((await service.submitCode(login.loginId, 'a\nb')).ok).toBe(false);
    expect(children[0]!.written).toEqual([]);
    expect((await service.submitCode(login.loginId, 'good-code')).ok).toBe(true);
    // consumed: the id is gone
    expect((await service.submitCode(login.loginId, 'good-code')).ok).toBe(false);
  });

  it('gives up when the CLI never answers the code', async () => {
    const service = make({ timeouts: { urlMs: 200, codeMs: 30, loginMs: 5_000 } });
    const login = await service.startLogin();
    children[0]!.onInput = () => undefined; // swallow the code
    const result = await service.submitCode(login.loginId, 'good-code');
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/in time/) });
    expect(children[0]!.killed).toBe(true);
    expect(service.pendingCount).toBe(0);
  });
});

describe('cancel and timeouts', () => {
  it('cancel kills the CLI and forgets the attempt', async () => {
    const service = make();
    const login = await service.startLogin();
    expect(service.cancel(login.loginId)).toBe(true);
    expect(children[0]!.killed).toBe(true);
    expect(service.pendingCount).toBe(0);
    expect(service.cancel(login.loginId)).toBe(false);
    expect((await service.submitCode(login.loginId, 'good-code')).ok).toBe(false);
  });

  it('abandons a login that is never finished', async () => {
    const service = make({ timeouts: { urlMs: 200, codeMs: 200, loginMs: 30 } });
    await service.startLogin();
    await vi.waitFor(() => expect(service.pendingCount).toBe(0));
    expect(children[0]!.killed).toBe(true);
  });

  it('a cancel during submit does not promote', async () => {
    const service = make();
    const login = await service.startLogin();
    children[0]!.onInput = () => undefined;
    const pending = service.submitCode(login.loginId, 'good-code');
    service.cancel(login.loginId);
    expect((await pending).ok).toBe(false);
    expect(existsSync(credsPath())).toBe(false);
  });
});

describe('status', () => {
  it('reports api key and oauth token from config without probing', async () => {
    const execFile = vi.fn();
    const key = make({ config: { claudeConfigDir: configDir, claudeBinary: 'claude', claudeOauthToken: 'tok', anthropicApiKey: 'sk' }, execFile });
    expect(await key.status()).toMatchObject({ signedIn: true, method: 'api_key', account: null });
    const token = make({ config: { claudeConfigDir: configDir, claudeBinary: 'claude', claudeOauthToken: 'tok', anthropicApiKey: null }, execFile });
    expect(await token.status()).toMatchObject({ signedIn: true, method: 'oauth_token' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('uses `claude auth status` with the config dir and reads the account', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({
      stdout: JSON.stringify({ loggedIn: true, email: 'me@example.com', orgName: 'Me Inc', subscriptionType: 'max' }),
      stderr: '',
    }));
    const service = make({ execFile });
    const s = await service.status();
    expect(s).toEqual({
      signedIn: true,
      method: 'oauth_login',
      account: { email: 'me@example.com', organization: 'Me Inc', subscriptionType: 'max' },
      pendingLogins: 0,
    });
    const [file, args, opts] = execFile.mock.calls[0]!;
    expect(file).toBe('claude');
    expect(args).toEqual(['auth', 'status']);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('is signed out when the CLI exits non-zero, even with a stale credentials file', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(credsPath(), '{}');
    const s = await make().status();
    expect(s).toMatchObject({ signedIn: false, method: 'none', account: null });
  });

  it('falls back to the credentials file when the CLI cannot run', async () => {
    const execFile: ExecFileFn = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    const service = make({ execFile });
    expect((await service.status()).signedIn).toBe(false);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(credsPath(), '{}');
    // still cached
    expect((await service.status()).signedIn).toBe(false);
    const fresh = make({ execFile });
    expect(await fresh.status()).toMatchObject({ signedIn: true, method: 'oauth_login' });
  });

  it('caches the probe for 30 seconds and counts live pending logins', async () => {
    let t = 1_000;
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '{"loggedIn":true}', stderr: '' }));
    const service = make({ execFile, now: () => t });
    await service.status();
    await service.status();
    t += 29_000;
    await service.status();
    expect(execFile).toHaveBeenCalledTimes(1);
    await service.startLogin();
    expect((await service.status()).pendingLogins).toBe(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    t += 2_000;
    await service.status();
    expect(execFile).toHaveBeenCalledTimes(2);
    service.cancelAll();
  });

  it('shares one probe between concurrent callers', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '{}', stderr: '' }));
    const service = make({ execFile });
    await Promise.all([service.status(), service.status(), service.status()]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately after a sign-in', async () => {
    let loggedIn = false;
    const execFile = vi.fn<ExecFileFn>(async () => {
      if (!loggedIn) throw Object.assign(new Error('no'), { code: 1 });
      return { stdout: '{"loggedIn":true}', stderr: '' };
    });
    const service = make({ execFile });
    expect((await service.status()).signedIn).toBe(false);
    const login = await service.startLogin();
    loggedIn = true;
    await service.submitCode(login.loginId, 'good-code');
    expect((await service.status()).signedIn).toBe(true);
  });
});

describe('logout and env', () => {
  it('deletes the credentials, bumps the counter, notifies and invalidates the cache', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(credsPath(), '{}');
    const execFile = vi.fn<ExecFileFn>(async () => {
      if (existsSync(credsPath())) return { stdout: '{"loggedIn":true}', stderr: '' };
      throw Object.assign(new Error('no'), { code: 1 });
    });
    const service = make({ execFile });
    const onChange = vi.fn();
    const off = service.onChange(onChange);
    expect((await service.status()).signedIn).toBe(true);
    const before = service.changeCount;

    await service.logout();

    expect(existsSync(credsPath())).toBe(false);
    expect(service.changeCount).toBe(before + 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await service.status()).signedIn).toBe(false);

    off();
    await service.logout(); // nothing to delete; still fine
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break the others', async () => {
    const service = make();
    const ok = vi.fn();
    service.onChange(() => {
      throw new Error('boom');
    });
    service.onChange(ok);
    await service.logout();
    expect(ok).toHaveBeenCalled();
  });

  it('env() gives the SDK the config dir and the token when configured', () => {
    expect(make().env()).toEqual({ CLAUDE_CONFIG_DIR: configDir });
    const withToken = make({ config: { claudeConfigDir: configDir, claudeBinary: 'claude', claudeOauthToken: 'tok', anthropicApiKey: null } });
    expect(withToken.env()).toEqual({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });
});
