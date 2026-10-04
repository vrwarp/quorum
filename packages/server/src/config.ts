import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULTS } from '@quorum/shared';

export type TunableOverrides = Partial<typeof DEFAULTS>;

export interface ServerConfig {
  port: number;
  dataDir: string;
  /** null only when QUORUM_ALLOW_NO_PASSWORD=1 */
  password: string | null;
  runtime: 'claude' | 'fake';
  anthropicApiKey: string | null;
  /** Long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), or null. */
  claudeOauthToken: string | null;
  /** CLAUDE_CONFIG_DIR for the sign-in flow, auth probes and the Agent SDK: `<dataDir>/claude` unless overridden. */
  claudeConfigDir: string;
  /** The Claude Code executable the sign-in runs, so it is the same program the Agent SDK uses. */
  claudeBinary: string;
  /**
   * Spend cap handed to the Agent SDK as `maxBudgetUsd`. It applies to each SDK session separately (the orchestrator,
   * every worker, every merge-driver run, every digest), not to a room as a whole: a room can spend several times it.
   */
  maxBudgetUsdPerSession: number;
  /** `QUORUM_TRUST_PROXY=1`: take the client address from X-Forwarded-For (behind a reverse proxy that sets it) */
  trustProxy: boolean;
  /** `QUORUM_ALLOWED_ORIGINS`: origins besides the server's own host that may open a WebSocket */
  allowedOrigins: string[];
  tunables: TunableOverrides;
  clientDistDir: string;
  /** Things worth telling the operator at startup (deprecated settings in use); main.ts logs each as a warning. */
  warnings: string[];
}

/** digestAbsenceMs -> QUORUM_DIGEST_ABSENCE_MS */
export function tunableEnvName(key: string): string {
  return 'QUORUM_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function parseNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n))
    throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/** Platform packages that could hold a runnable Claude Code binary on this machine, best first. */
export function claudePlatformCandidates(
  proc: { platform: string; arch: string } = process,
  glibc: boolean = Boolean(
    (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime,
  ),
): string[] {
  const arch = proc.arch === 'arm64' ? 'arm64' : 'x64';
  if (proc.platform === 'darwin') return [`darwin-${arch}`];
  if (proc.platform === 'win32') return [`win32-${arch}`];
  const native = glibc ? `linux-${arch}` : `linux-${arch}-musl`;
  const other = glibc ? `linux-${arch}-musl` : `linux-${arch}`;
  return [native, other];
}

/** The binary shipped with the Agent SDK's platform package; falls back to `claude` on PATH. */
export function findClaudeBinary(candidates: string[] = claudePlatformCandidates()): string {
  const require = createRequire(import.meta.url);
  for (const platform of candidates) {
    try {
      const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
      return path.join(
        path.dirname(manifest),
        platform.startsWith('win32') ? 'claude.exe' : 'claude',
      );
    } catch {
      continue;
    }
  }
  return 'claude';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = env.PORT ? parseNumber('PORT', env.PORT) : 8787;
  const dataDir = path.resolve(env.QUORUM_DATA_DIR || './data');

  const allowNoPassword = env.QUORUM_ALLOW_NO_PASSWORD === '1';
  let password: string | null = env.QUORUM_PASSWORD ? env.QUORUM_PASSWORD : null;
  if (password === null && !allowNoPassword) {
    throw new Error(
      'QUORUM_PASSWORD is required (set QUORUM_ALLOW_NO_PASSWORD=1 to run without one)',
    );
  }

  const anthropicApiKey = env.ANTHROPIC_API_KEY ? env.ANTHROPIC_API_KEY : null;
  const rawRuntime = env.QUORUM_RUNTIME;
  if (
    rawRuntime !== undefined &&
    rawRuntime !== '' &&
    rawRuntime !== 'claude' &&
    rawRuntime !== 'fake'
  ) {
    throw new Error(`QUORUM_RUNTIME must be "claude" or "fake", got "${rawRuntime}"`);
  }
  // Credentials may arrive later through the web sign-in (see docs/CLAUDE-SIGNIN.md), so the real runtime is the
  // default even with none configured; the fake runtime is for tests and an explicit QUORUM_RUNTIME=fake.
  const runtime: 'claude' | 'fake' = rawRuntime ? (rawRuntime as 'claude' | 'fake') : 'claude';
  const claudeOauthToken = env.CLAUDE_CODE_OAUTH_TOKEN ? env.CLAUDE_CODE_OAUTH_TOKEN : null;
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(dataDir, 'claude');
  // QUORUM_CLAUDE_BINARY points at another Claude Code executable (a system install, or a stub in tests); a bare
  // command name such as "claude" is looked up on PATH.
  const claudeOverride = env.QUORUM_CLAUDE_BINARY;
  const claudeBinary = claudeOverride
    ? /[\\/]/.test(claudeOverride)
      ? path.resolve(claudeOverride)
      : claudeOverride
    : findClaudeBinary();

  // The cap is per Agent SDK session (see ServerConfig); the old name suggested a per-room cap and is still read.
  const warnings: string[] = [];
  const oldBudget = env.QUORUM_MAX_BUDGET_USD_PER_ROOM;
  const newBudget = env.QUORUM_MAX_BUDGET_USD_PER_SESSION;
  if (oldBudget) {
    warnings.push(
      newBudget
        ? 'QUORUM_MAX_BUDGET_USD_PER_ROOM is deprecated and ignored because QUORUM_MAX_BUDGET_USD_PER_SESSION is set'
        : 'QUORUM_MAX_BUDGET_USD_PER_ROOM is deprecated: the cap applies to each agent session, not to a room; rename it to QUORUM_MAX_BUDGET_USD_PER_SESSION',
    );
  }
  const maxBudgetUsdPerSession = newBudget
    ? parseNumber('QUORUM_MAX_BUDGET_USD_PER_SESSION', newBudget)
    : oldBudget
      ? parseNumber('QUORUM_MAX_BUDGET_USD_PER_ROOM', oldBudget)
      : 20;

  const trustProxy = env.QUORUM_TRUST_PROXY === '1' || env.QUORUM_TRUST_PROXY === 'true';
  const allowedOrigins = (env.QUORUM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const overrides: Record<string, number> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const name = tunableEnvName(key);
    const raw = env[name];
    if (raw !== undefined && raw !== '') overrides[key] = parseNumber(name, raw);
  }

  const clientDistDir = env.QUORUM_CLIENT_DIST
    ? path.resolve(env.QUORUM_CLIENT_DIST)
    : fileURLToPath(new URL('../../client/dist', import.meta.url));

  return {
    port,
    dataDir,
    password,
    runtime,
    anthropicApiKey,
    claudeOauthToken,
    claudeConfigDir,
    claudeBinary,
    maxBudgetUsdPerSession,
    trustProxy,
    allowedOrigins,
    tunables: overrides as TunableOverrides,
    clientDistDir,
    warnings,
  };
}
