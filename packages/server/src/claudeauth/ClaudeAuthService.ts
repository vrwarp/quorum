/**
 * Signing the server's Claude Code CLI in to a Claude account from the web UI.
 *
 * `claude auth login --claudeai` drives cleanly over pipes: it prints an https URL, waits at a paste prompt, and
 * exits 0 once the code is accepted. Each attempt runs against a throw-away staging CLAUDE_CONFIG_DIR; only an
 * accepted code promotes the resulting `.credentials.json` into the real config dir (the one the Agent SDK reads).
 * See docs/CLAUDE-SIGNIN.md.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../room/types.js';

/** The CLI must not see the server's own configuration (QUORUM_PASSWORD, QUORUM_DATA_DIR, ...). */
function withoutQuorumSettings(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith('QUORUM_')) env[key] = value;
  }
  return env;
}

export type ClaudeAuthMethod = 'oauth_login' | 'oauth_token' | 'api_key' | 'none';
export type LoginMode = 'claudeai' | 'console';

export interface ClaudeAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

export interface ClaudeAuthStatus {
  signedIn: boolean;
  method: ClaudeAuthMethod;
  account: ClaudeAccount | null;
  pendingLogins: number;
}

export interface LoginHandle {
  loginId: string;
  url: string;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/** The slice of a child process the login flow uses; `child_process.spawn` results satisfy it. */
export interface LoginChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stdin: { write(chunk: string): unknown } | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => LoginChild;
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ClaudeAuthDeps {
  config: Pick<
    ServerConfig,
    'claudeConfigDir' | 'claudeBinary' | 'claudeOauthToken' | 'anthropicApiKey'
  >;
  logger?: Logger;
  /** Injected in tests; defaults to `child_process.spawn` with piped stdio. */
  spawn?: SpawnFn;
  /** Injected in tests; defaults to a promisified `child_process.execFile`. */
  execFile?: ExecFileFn;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Overrides for the timing constants, for tests. */
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
}

export const DEFAULT_TIMEOUTS = {
  /** How long a half-finished login may occupy a process. */
  loginMs: 10 * 60_000,
  /** How long to wait for the CLI to print its link. */
  urlMs: 60_000,
  /** How long to wait for the CLI to judge a submitted code. */
  codeMs: 60_000,
  /** How long a status probe is cached. */
  statusCacheMs: 30_000,
  /** Timeout for `claude auth status`. */
  probeMs: 15_000,
};

/** One pending login is one live subprocess. */
export const MAX_PENDING_LOGINS = 3;
const MAX_CODE_LENGTH = 4096;

/** Thrown by startLogin when MAX_PENDING_LOGINS attempts are already running. */
export class LoginLimitError extends Error {
  constructor() {
    super('Too many sign-ins are already in progress. Try again in a few minutes.');
    this.name = 'LoginLimitError';
  }
}

interface Pending {
  id: string;
  child: LoginChild;
  stagingDir: string;
  stderr: string;
  timer: NodeJS.Timeout;
  codeSubmitted: boolean;
  /** Resolves when the child exits (or the attempt is cancelled), with what the CLI made of the code. */
  settle: (r: LoginResult) => void;
  done: Promise<LoginResult>;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function defaultExecFile(
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    nodeExecFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as LoginChild;

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

function parseAccount(stdout: string): { loggedIn: boolean | null; account: ClaudeAccount | null } {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const account: ClaudeAccount = {};
    const email = str(j.email);
    const organization = str(j.orgName) ?? str(j.organization);
    const subscriptionType = str(j.subscriptionType);
    if (email) account.email = email;
    if (organization) account.organization = organization;
    if (subscriptionType) account.subscriptionType = subscriptionType;
    return {
      loggedIn: typeof j.loggedIn === 'boolean' ? j.loggedIn : null,
      account: Object.keys(account).length > 0 ? account : null,
    };
  } catch {
    return { loggedIn: null, account: null };
  }
}

export class ClaudeAuthService {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private cache: { at: number; value: Promise<Omit<ClaudeAuthStatus, 'pendingLogins'>> } | null =
    null;
  private changes = 0;
  private readonly configDir: string;
  private readonly stagingRoot: string;
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  private readonly log: Logger;

  constructor(private readonly deps: ClaudeAuthDeps) {
    this.configDir = deps.config.claudeConfigDir;
    // A sibling of the config dir, so a staged attempt never sits inside the directory the SDK reads.
    this.stagingRoot = path.join(
      path.dirname(this.configDir),
      `${path.basename(this.configDir)}-login`,
    );
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.log = deps.logger ?? (() => undefined);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get credentialsPath(): string {
    return path.join(this.configDir, '.credentials.json');
  }

  /** Bumped on every sign-in and sign-out; lets callers tell that credentials changed. */
  get changeCount(): number {
    return this.changes;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Environment additions the Agent SDK should receive. */
  env(): Record<string, string> {
    const out: Record<string, string> = { CLAUDE_CONFIG_DIR: this.configDir };
    if (this.deps.config.claudeOauthToken)
      out.CLAUDE_CODE_OAUTH_TOKEN = this.deps.config.claudeOauthToken;
    return out;
  }

  /** Called after a successful sign-in or a sign-out. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.changes += 1;
    this.cache = null;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        this.log('warn', 'claude auth listener failed', { err: String(err) });
      }
    }
  }

  async status(): Promise<ClaudeAuthStatus> {
    const t = this.now();
    if (!this.cache || t - this.cache.at >= this.timeouts.statusCacheMs) {
      this.cache = { at: t, value: this.probe() };
    }
    const probed = await this.cache.value;
    return { ...probed, pendingLogins: this.pending.size };
  }

  private async probe(): Promise<Omit<ClaudeAuthStatus, 'pendingLogins'>> {
    const { config } = this.deps;
    if (config.anthropicApiKey) return { signedIn: true, method: 'api_key', account: null };
    if (config.claudeOauthToken) return { signedIn: true, method: 'oauth_token', account: null };

    const env: NodeJS.ProcessEnv = {
      ...withoutQuorumSettings(this.deps.env ?? process.env),
      CLAUDE_CONFIG_DIR: this.configDir,
    };
    // Judge the config dir alone; ambient credentials are reported through the config fields above.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    try {
      const { stdout } = await (this.deps.execFile ?? defaultExecFile)(
        config.claudeBinary,
        ['auth', 'status'],
        {
          timeout: this.timeouts.probeMs,
          env,
        },
      );
      const { loggedIn, account } = parseAccount(stdout);
      if (loggedIn === false) return { signedIn: false, method: 'none', account: null };
      return { signedIn: true, method: 'oauth_login', account };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // A numeric code is an exit status: the CLI ran and said no. Anything else (ENOENT, a timeout) means it did
      // not answer, so fall back to the credentials file rather than reporting a guess as a verdict.
      if (typeof code === 'number') return { signedIn: false, method: 'none', account: null };
      this.log('warn', 'claude auth status did not answer; checking for credentials file', {
        code: String(code),
      });
      const has = await exists(this.credentialsPath);
      return has
        ? { signedIn: true, method: 'oauth_login', account: null }
        : { signedIn: false, method: 'none', account: null };
    }
  }

  /** Start a sign-in and return the link the person should open. The CLI keeps running until the code comes back. */
  async startLogin(mode: LoginMode = 'claudeai'): Promise<LoginHandle> {
    if (mode !== 'claudeai' && mode !== 'console') throw new Error('Unknown sign-in mode.');
    if (this.pending.size >= MAX_PENDING_LOGINS) {
      throw new LoginLimitError();
    }
    const id = randomUUID();
    const stagingDir = path.join(this.stagingRoot, id);
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const env: NodeJS.ProcessEnv = {
      ...withoutQuorumSettings(this.deps.env ?? process.env),
      CLAUDE_CONFIG_DIR: stagingDir,
      // Nothing to open in a server; the CLI then prints the URL, which is what we need.
      BROWSER: '/bin/true',
    };
    // An ambient credential would make the CLI skip the flow.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    const args = ['auth', 'login', mode === 'console' ? '--console' : '--claudeai'];
    let child: LoginChild;
    try {
      child = (this.deps.spawn ?? defaultSpawn)(this.deps.config.claudeBinary, args, { env });
    } catch (err) {
      void rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err instanceof Error ? err : new Error(String(err));
    }

    let settle!: (r: LoginResult) => void;
    const done = new Promise<LoginResult>((resolve) => {
      settle = resolve;
    });
    const entry: Pending = {
      id,
      child,
      stagingDir,
      stderr: '',
      codeSubmitted: false,
      settle,
      done,
      timer: setTimeout(() => this.end(id, 'The sign-in timed out.'), this.timeouts.loginMs),
    };
    this.pending.set(id, entry);

    child.once('exit', ((code: number | null) => {
      const failure = /Login failed:?\s*(.*)/i.exec(entry.stderr);
      entry.settle(
        code === 0
          ? { ok: true }
          : {
              ok: false,
              error: failure?.[1]?.trim() || entry.stderr.trim() || 'The code was not accepted.',
            },
      );
    }) as (...args: never[]) => void);

    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const deadline = setTimeout(
        () => reject(new Error('Claude Code did not offer a sign-in link.')),
        this.timeouts.urlMs,
      );
      const fail = (e: Error) => {
        clearTimeout(deadline);
        reject(e);
      };
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
        // Require a terminator so a chunk boundary inside the URL cannot truncate it.
        const m = /https:\/\/\S+(?=\s)/.exec(out.replace(ANSI, ''));
        if (!m) return;
        const candidate = m[0].replace(/[.,)]+$/, '');
        try {
          if (new URL(candidate).protocol !== 'https:') return;
        } catch {
          return;
        }
        clearTimeout(deadline);
        resolve(candidate);
      });
      child.stderr?.on('data', (chunk) => {
        entry.stderr += String(chunk);
      });
      child.on('error', ((e: Error) => fail(e)) as (...args: never[]) => void);
      child.on('exit', ((code: number | null) =>
        fail(
          new Error(
            entry.stderr.trim() ||
              `Claude Code exited (${code ?? 'signal'}) before offering a sign-in link.`,
          ),
        )) as (...args: never[]) => void);
    }).catch((err: unknown) => {
      this.end(id, 'start failed');
      throw err instanceof Error ? err : new Error(String(err));
    });

    this.log('info', 'claude sign-in started', { loginId: id, mode });
    return { loginId: id, url };
  }

  /** Hand the pasted code to the waiting CLI. Exit 0 means it was accepted; credentials are then promoted. */
  async submitCode(id: string, code: string): Promise<LoginResult> {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, error: 'That sign-in has expired. Start again.' };
    if (entry.codeSubmitted) return { ok: false, error: 'That code was already used.' };
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (!trimmed || trimmed.length > MAX_CODE_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      // Not counted as an attempt: the CLI never saw it.
      return { ok: false, error: 'Paste the code Claude showed you.' };
    }
    entry.codeSubmitted = true;

    try {
      entry.child.stdin?.write(`${trimmed}\n`);
    } catch (err) {
      this.end(id, 'stdin closed');
      return { ok: false, error: `Could not hand the code to Claude Code: ${String(err)}` };
    }

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      entry.done,
      new Promise<LoginResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: 'Claude did not answer in time.' }),
          this.timeouts.codeMs,
        );
      }),
    ]);
    clearTimeout(timer);

    if (!this.pending.has(id)) {
      // Cancelled or timed out while we waited.
      return outcome.ok ? { ok: false, error: 'That sign-in was cancelled.' } : outcome;
    }
    if (!outcome.ok) {
      this.end(id, 'code rejected');
      return outcome;
    }

    try {
      await this.promote(entry.stagingDir);
    } catch (err) {
      this.end(id, 'promote failed');
      this.log('error', 'claude sign-in succeeded but credentials could not be saved', {
        err: String(err),
      });
      return {
        ok: false,
        error: 'Claude accepted the code but no credentials were saved. Try again.',
      };
    }
    this.end(id, 'signed in');
    this.log('info', 'claude sign-in completed', { loginId: id });
    this.changed();
    return { ok: true };
  }

  /** Move the credentials the sign-in produced into the dir the Agent SDK reads (write-then-rename). */
  private async promote(stagingDir: string): Promise<void> {
    const from = path.join(stagingDir, '.credentials.json');
    const to = this.credentialsPath;
    const credentials = await readFile(from, 'utf8');
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const tmp = `${to}.${randomUUID()}`;
    await writeFile(tmp, credentials, { mode: 0o600 });
    await rename(tmp, to);
  }

  /** Abandon a pending sign-in. Returns whether there was one. */
  cancel(id: string): boolean {
    return this.end(id, 'The sign-in was cancelled.');
  }

  private end(id: string, reason: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.settle({ ok: false, error: reason });
    try {
      entry.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    void rm(entry.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** Delete the stored login. Credentials from the environment (token, API key) are not ours to remove. */
  async logout(): Promise<void> {
    await rm(this.credentialsPath, { force: true });
    this.log('info', 'claude credentials removed');
    this.changed();
  }

  /** Abandon every pending sign-in; used on shutdown. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.end(id, 'The server is stopping.');
  }
}
