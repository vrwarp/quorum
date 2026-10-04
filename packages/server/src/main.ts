import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openStorage } from './db/index.js';
import { createGitProvider } from './git/index.js';
import { RoomService } from './room/index.js';
import { createAgentRuntime } from './agents/index.js';
import { ClaudeAuthService } from './claudeauth/index.js';
import { createHttpServer, attachWebSocket } from './api/index.js';

export function logger(
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
) {
  if (level === 'debug' && !process.env.QUORUM_DEBUG) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** How long a merge in flight may keep running when the server is asked to stop (the merge driver takes minutes). */
export const MERGE_DRAIN_MS = 25_000;
/**
 * A stop that has not finished by then exits anyway, a little inside the 30 s `stop_grace_period` compose gives the
 * container: the drain above plus stopping the agents and closing sockets and database.
 */
const SHUTDOWN_LIMIT_MS = 28_000;

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  for (const warning of config.warnings) logger('warn', warning);
  mkdirSync(config.dataDir, { recursive: true });
  const storage = openStorage(path.join(config.dataDir, 'quorum.sqlite'));
  const git = createGitProvider(config.dataDir, { logger });
  const claudeAuth = new ClaudeAuthService({ config, logger });
  const service = new RoomService({ storage, git, tunables: config.tunables, logger });
  const runtime = createAgentRuntime(config.runtime, service, {
    dataDir: config.dataDir,
    tunables: config.tunables,
    logger,
    anthropicApiKey: config.anthropicApiKey ?? undefined,
    // the runtime's option keeps its name (maxBudgetUsd, the SDK's own); it caps each SDK session, not a room
    maxBudgetUsd: config.maxBudgetUsdPerSession,
    // Claude credentials (used by the claude runtime; the fake runtime ignores them): the Agent SDK launches
    // config.claudeBinary with the sign-in service's environment (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN); the agent
    // is "unavailable" until a credential exists; a web sign-in or sign-out restarts or stops the room sessions.
    claudeBinary: config.claudeBinary,
    claudeEnv: () => claudeAuth.env(),
    claudeAvailable: async () => (await claudeAuth.status()).signedIn,
    onCredentialsChanged: (listener) => claudeAuth.onChange(listener),
  });
  service.setRuntime(runtime);
  await service.start();

  const server = createHttpServer({ service, storage, config, logger, claudeAuth });
  const sockets = attachWebSocket(server, {
    service,
    storage,
    logger,
    allowedOrigins: config.allowedOrigins,
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger('info', `quorum listening on http://localhost:${config.port} (runtime=${config.runtime})`);

  let closing: Promise<void> | null = null;
  /** Stops agents, the room service, sockets and the listener, then the database. Safe to call twice. */
  const close = () =>
    (closing ??= (async () => {
      claudeAuth.cancelAll();
      // A merge in flight gets its time first: stopping the agents aborts the merge driver mid-merge, which would leave
      // the proposal to be reopened by the next start. No new merge begins from here on.
      if (!(await service.drain(MERGE_DRAIN_MS)))
        logger('warn', 'a merge was still running after the drain period; stopping the agents');
      await runtime.stopAll().catch(() => undefined);
      // The service first: once closed it ignores presence changes, so sockets that close one by one cannot "complete"
      // a vote among whoever happens to be left. Then the sockets, which record last-seen times while storage is open.
      await service.close();
      await sockets.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      storage.close();
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    })());

  const shutdown = async () => {
    logger('info', 'shutting down');
    setTimeout(() => {
      logger('warn', 'shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_LIMIT_MS).unref();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, service, runtime, storage, config, close };
}

/** True when this file is the process entry point (also when started through a symlink or from a path with spaces). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  startServer().catch((err) => {
    logger('error', 'failed to start', { err: String(err?.stack ?? err) });
    process.exit(1);
  });
}
