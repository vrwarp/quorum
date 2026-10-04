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
  const runtime: 'claude' | 'fake' = rawRuntime ? (rawRuntime as 'claude' | 'fake') : anthropicApiKey ? 'claude' : 'fake';

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
    maxBudgetUsdPerRoom,
    tunables: overrides as TunableOverrides,
    clientDistDir,
  };
}
