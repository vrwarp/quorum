import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import type * as NodeSqlite from 'node:sqlite';
import { DEFAULTS, MODELS, EFFORT } from '@quorum/shared';
import type { ServerConfig } from '../config.js';
import { TarWriter } from './tar.js';

const run = promisify(execFile);

/** What an export needs from the trace recorder: its files, complete on disk. */
export interface TraceFiles {
  flush(): void;
  files(): Array<{ path: string; bytes: number; mtimeMs: number }>;
}

export interface DebugExportDeps {
  config: Pick<
    ServerConfig,
    | 'dataDir'
    | 'port'
    | 'runtime'
    | 'password'
    | 'anthropicApiKey'
    | 'claudeOauthToken'
    | 'claudeConfigDir'
    | 'claudeBinary'
    | 'maxBudgetUsdPerSession'
    | 'trustProxy'
    | 'allowedOrigins'
    | 'tunables'
  >;
  traces?: TraceFiles | null;
  /** the SQLite file; null (an in-memory database) leaves the tables out */
  databasePath: string | null;
  /** extra facts for the manifest (the Claude sign-in status) */
  status?: () => Promise<Record<string, unknown>>;
}

export interface DebugExportOptions {
  /** only trace files and agent transcripts modified since then (epoch ms); everything when absent */
  sinceMs?: number;
  /** include a `git bundle` of every room's repository (default true) */
  repos?: boolean;
  /** include the Claude Code session transcripts (default true) */
  transcripts?: boolean;
}

/** Tables left out of the export: session tokens are credentials. */
const SKIPPED_TABLES = new Set(['sessions']);

/** How Claude Code names a project directory after its working directory. */
function claudeProjectName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

function serverVersion(): string {
  try {
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function rowJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v: unknown) =>
    v instanceof Uint8Array
      ? { base64: Buffer.from(v).toString('base64') }
      : typeof v === 'bigint'
        ? v.toString()
        : v,
  );
}

/**
 * Writes a gzip-compressed tar of everything useful for analysing the server's behaviour:
 *
 * - `manifest.json`: versions, configuration (secrets reported only as set or unset), tunables, what is inside, and
 *   anything that could not be collected;
 * - `traces/*.jsonl`: the debug trace (logs, HTTP requests, WebSocket commands, room events, every Agent SDK message and
 *   listener request; see debug/tracer.ts);
 * - `database/<table>.jsonl`: every table of the SQLite database except `sessions`;
 * - `repos/<roomId>.bundle` and `repos/<roomId>.log.txt`: each room's git repository (`git clone x.bundle` restores it);
 * - `claude/projects/…`: the Claude Code session transcripts of the agent sessions.
 */
export async function writeDebugExport(
  out: Writable,
  deps: DebugExportDeps,
  opts: DebugExportOptions = {},
): Promise<void> {
  const gzip = createGzip({ level: 6 });
  const done = new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('finish', resolve);
    gzip.once('error', reject);
    // the client went away: stop producing (a pending write fails instead of waiting for a drain that never comes)
    out.once('close', () => {
      if (out.writableFinished) return resolve();
      const aborted = new Error('debug export aborted by the client');
      gzip.destroy(aborted);
      reject(aborted);
    });
  });
  done.catch(() => undefined); // observed below; avoid an unhandled rejection while the archive is still being built
  gzip.pipe(out);
  const tar = new TarWriter(gzip);
  const contents: Array<{ name: string; bytes?: number }> = [];
  const errors: Array<{ step: string; error: string }> = [];
  const since = opts.sinceMs;
  const fresh = (mtimeMs: number) => since === undefined || mtimeMs >= since;
  const { config } = deps;

  const addFile = async (name: string, file: string) => {
    await tar.addFile(name, file);
    contents.push({ name, bytes: (await stat(file).catch(() => null))?.size });
  };
  const addText = async (name: string, text: string) => {
    await tar.addBuffer(name, text);
    contents.push({ name, bytes: Buffer.byteLength(text) });
  };

  // traces
  if (deps.traces) {
    try {
      deps.traces.flush();
      for (const f of deps.traces.files())
        if (fresh(f.mtimeMs)) await addFile(`traces/${path.basename(f.path)}`, f.path);
    } catch (e) {
      errors.push({ step: 'traces', error: String(e) });
    }
  }

  // database
  if (deps.databasePath && existsSync(deps.databasePath)) {
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;
      const db = new DatabaseSync(deps.databasePath, { readOnly: true });
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        for (const { name } of tables) {
          if (SKIPPED_TABLES.has(name)) continue;
          const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as Array<
            Record<string, unknown>
          >;
          await addText(
            `database/${name}.jsonl`,
            rows.map(rowJson).join('\n') + (rows.length ? '\n' : ''),
          );
        }
      } finally {
        db.close();
      }
    } catch (e) {
      errors.push({ step: 'database', error: String(e) });
    }
  }

  // room repositories
  const roomsDir = path.join(config.dataDir, 'rooms');
  if (opts.repos !== false && existsSync(roomsDir)) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'quorum-export-'));
    try {
      for (const roomId of (await readdir(roomsDir)).sort()) {
        const bare = path.join(roomsDir, roomId, 'repo.git');
        if (!existsSync(bare)) continue;
        try {
          const { stdout: log } = await run(
            'git',
            ['log', '--all', '--graph', '--date=iso', '--format=fuller', '--stat'],
            { cwd: bare, maxBuffer: 256 * 1024 * 1024 },
          );
          const { stdout: refs } = await run('git', ['for-each-ref'], { cwd: bare });
          await addText(`repos/${roomId}.log.txt`, `${refs}\n${log}`);
          const bundle = path.join(tmp, `${roomId}.bundle`);
          await run('git', ['bundle', 'create', bundle, '--all'], { cwd: bare });
          await addFile(`repos/${roomId}.bundle`, bundle);
          await rm(bundle, { force: true });
        } catch (e) {
          errors.push({ step: `repo ${roomId}`, error: String(e) });
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // agent transcripts: only the project directories of sessions that ran under the data directory (credentials and
  // everything else in the Claude config directory stay out)
  const projectsDir = path.join(config.claudeConfigDir, 'projects');
  if (opts.transcripts !== false && existsSync(projectsDir)) {
    try {
      const marker = claudeProjectName(path.resolve(config.dataDir));
      for (const project of (await readdir(projectsDir)).sort()) {
        if (!project.includes(marker)) continue;
        for (const file of await walk(path.join(projectsDir, project))) {
          const s = await stat(file).catch(() => null);
          if (!s || !fresh(s.mtimeMs)) continue;
          await addFile(
            `claude/projects/${path.relative(projectsDir, file).split(path.sep).join('/')}`,
            file,
          );
        }
      }
    } catch (e) {
      errors.push({ step: 'transcripts', error: String(e) });
    }
  }

  let status: Record<string, unknown> | null = null;
  try {
    status = (await deps.status?.()) ?? null;
  } catch (e) {
    errors.push({ step: 'status', error: String(e) });
  }
  const gitVersion = await run('git', ['--version']).then(
    (r) => r.stdout.trim(),
    (e) => `unavailable: ${String(e)}`,
  );
  const manifest = {
    format: 'quorum-debug-export/1',
    exportedAt: new Date().toISOString(),
    options: { since: since === undefined ? null : new Date(since).toISOString(), ...opts },
    server: {
      version: serverVersion(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      git: gitVersion,
    },
    config: {
      dataDir: config.dataDir,
      port: config.port,
      runtime: config.runtime,
      password: config.password ? 'set' : 'unset',
      anthropicApiKey: config.anthropicApiKey ? 'set' : 'unset',
      claudeOauthToken: config.claudeOauthToken ? 'set' : 'unset',
      claudeConfigDir: config.claudeConfigDir,
      claudeBinary: config.claudeBinary,
      maxBudgetUsdPerSession: config.maxBudgetUsdPerSession,
      trustProxy: config.trustProxy,
      allowedOrigins: config.allowedOrigins,
      tunableOverrides: config.tunables,
      tunables: { ...DEFAULTS, ...config.tunables },
      models: MODELS,
      effort: EFFORT,
    },
    status,
    contents,
    errors,
  };
  await tar.addBuffer('manifest.json', JSON.stringify(manifest, null, 2));
  await tar.finish();
  gzip.end();
  await done;
}
