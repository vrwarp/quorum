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
  maxBudgetUsdPerRoom: number;
  tunables: TunableOverrides;
  clientDistDir: string;
}

/** digestAbsenceMs -> QUORUM_DIGEST_ABSENCE_MS */
export function tunableEnvName(key: string): string {
  return 'QUORUM_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function parseNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/** Platform packages that could hold a runnable Claude Code binary on this machine, best first. */
export function claudePlatformCandidates(
  proc: { platform: string; arch: string } = process,
  glibc: boolean = Boolean((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime),
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
      return path.join(path.dirname(manifest), platform.startsWith('win32') ? 'claude.exe' : 'claude');
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
    throw new Error('QUORUM_PASSWORD is required (set QUORUM_ALLOW_NO_PASSWORD=1 to run without one)');
  }

  const anthropicApiKey = env.ANTHROPIC_API_KEY ? env.ANTHROPIC_API_KEY : null;
  const rawRuntime = env.QUORUM_RUNTIME;
  if (rawRuntime !== undefined && rawRuntime !== '' && rawRuntime !== 'claude' && rawRuntime !== 'fake') {
    throw new Error(`QUORUM_RUNTIME must be "claude" or "fake", got "${rawRuntime}"`);
  }
  // Credentials may arrive later through the web sign-in (see docs/CLAUDE-SIGNIN.md), so the real runtime is the
  // default even with none configured; the fake runtime is for tests and an explicit QUORUM_RUNTIME=fake.
  const runtime: 'claude' | 'fake' = rawRuntime ? (rawRuntime as 'claude' | 'fake') : 'claude';
  const claudeOauthToken = env.CLAUDE_CODE_OAUTH_TOKEN ? env.CLAUDE_CODE_OAUTH_TOKEN : null;
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(dataDir, 'claude');
  const claudeBinary = findClaudeBinary();

  const maxBudgetUsdPerRoom = env.QUORUM_MAX_BUDGET_USD_PER_ROOM
    ? parseNumber('QUORUM_MAX_BUDGET_USD_PER_ROOM', env.QUORUM_MAX_BUDGET_USD_PER_ROOM)
    : 20;

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
    maxBudgetUsdPerRoom,
    tunables: overrides as TunableOverrides,
    clientDistDir,
  };
}
