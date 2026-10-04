import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.js';
import { openStorage } from './db/index.js';
import { createGitProvider } from './git/index.js';
import { RoomService } from './room/index.js';
import { createAgentRuntime } from './agents/index.js';
import { createHttpServer, attachWebSocket } from './api/index.js';

// node:sqlite still prints an ExperimentalWarning on Node 22; silence just that one.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : (warning as Error)?.message ?? '';
  if (text.includes('SQLite is an experimental feature')) return;
  return (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export function logger(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  if (level === 'debug' && !process.env.QUORUM_DEBUG) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  mkdirSync(config.dataDir, { recursive: true });
  const storage = openStorage(path.join(config.dataDir, 'quorum.sqlite'));
  const git = createGitProvider(config.dataDir);
  const service = new RoomService({ storage, git, tunables: config.tunables, logger });
  const runtime = createAgentRuntime(config.runtime, service, {
    dataDir: config.dataDir,
    tunables: config.tunables,
    logger,
    anthropicApiKey: config.anthropicApiKey,
    maxBudgetUsd: config.maxBudgetUsdPerRoom,
  });
  service.setRuntime(runtime);

  const server = createHttpServer({ service, storage, config, logger });
  attachWebSocket(server, { service, storage, logger });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger('info', `quorum listening on http://localhost:${config.port} (runtime=${config.runtime})`);

  const shutdown = async () => {
    logger('info', 'shutting down');
    await runtime.stopAll().catch(() => undefined);
    await service.close?.();
    server.close();
    storage.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, service, runtime, storage, config };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  startServer().catch((err) => {
    logger('error', 'failed to start', { err: String(err?.stack ?? err) });
    process.exit(1);
  });
}
