import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { startServer } from '../main.js';
import { TarWriter, TraceRecorder, traceJson, MAX_STRING } from './index.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix = 'quorum-debug-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function readTrace(dir: string): Array<Record<string, any>> {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((n) =>
      readFileSync(path.join(dir, n), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
}
/** Unpacks a .tar.gz with the system tar (an independent check of the archive format). */
function untar(gz: Buffer): string {
  const dir = tempDir('quorum-untar-');
  const file = path.join(dir, 'x.tar.gz');
  writeFileSync(file, gz);
  mkdirSync(path.join(dir, 'out'));
  execFileSync('tar', ['-xzf', file, '-C', path.join(dir, 'out')]);
  return path.join(dir, 'out');
}

describe('traceJson', () => {
  it('redacts credentials, cuts long strings and survives errors, cycles and bigints', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = JSON.parse(
      traceJson({
        password: 'pw',
        nested: { ANTHROPIC_API_KEY: 'sk', authorization: 'Bearer x', input_tokens: 5 },
        long: 'x'.repeat(MAX_STRING + 10),
        err: new Error('boom'),
        big: 10n,
        cyclic,
      }),
    );
    expect(out.password).toBe('[redacted]');
    expect(out.nested).toEqual({
      ANTHROPIC_API_KEY: '[redacted]',
      authorization: '[redacted]',
      input_tokens: 5,
    });
    expect(out.long).toMatch(/…\[truncated 10 chars\]$/);
    expect(out.err.message).toBe('boom');
    expect(out.big).toBe('10');
    expect(out.cyclic.self).toBe('[circular]');
  });
});

describe('TraceRecorder', () => {
  it('buffers lines, writes them on flush, rotates past the file size and prunes the oldest files', () => {
    const dir = tempDir();
    let tick = 0;
    const rec = new TraceRecorder({
      dir,
      maxFileBytes: 200,
      maxTotalBytes: 1000,
      flushMs: 60_000,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    rec.record('hello', { n: 1 });
    expect(rec.files()).toHaveLength(0); // still buffered
    rec.flush();
    expect(readTrace(dir)).toEqual([expect.objectContaining({ kind: 'hello', n: 1 })]);
    for (let i = 0; i < 60; i++) {
      rec.record('filler', { i, pad: 'p'.repeat(50) });
      rec.flush();
    }
    const files = rec.files();
    expect(files.length).toBeGreaterThan(1);
    expect(files.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(1500);
    // the newest entries survive pruning
    expect(readTrace(dir).at(-1)).toMatchObject({ kind: 'filler', i: 59 });
    rec.close();
    rec.record('after close');
    expect(readTrace(dir).some((l) => l.kind === 'after close')).toBe(false);
  });
});

describe('TarWriter', () => {
  it('writes an archive tar can read, long names included', async () => {
    const dir = tempDir();
    const src = path.join(dir, 'f.txt');
    writeFileSync(src, 'file body');
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const tar = new TarWriter(sink);
    const long = `deep/${'d'.repeat(120)}/name-${'n'.repeat(50)}.jsonl`;
    await tar.addBuffer('a.txt', 'hello');
    await tar.addBuffer(long, 'long one');
    await tar.addFile('dir/f.txt', src);
    await tar.finish();
    sink.end();
    const out = tempDir();
    const file = path.join(out, 'x.tar');
    writeFileSync(file, Buffer.concat(chunks));
    execFileSync('tar', ['-xf', file, '-C', out]);
    expect(readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(path.join(out, long), 'utf8')).toBe('long one');
    expect(readFileSync(path.join(out, 'dir/f.txt'), 'utf8')).toBe('file body');
  });
});

describe('debug export over HTTP', () => {
  async function boot(env: Record<string, string> = {}) {
    const dataDir = tempDir('quorum-debug-data-');
    const client = tempDir('quorum-debug-client-');
    writeFileSync(path.join(client, 'index.html'), '<!doctype html><title>Quorum</title>');
    const app = await startServer({
      PORT: '0',
      QUORUM_RUNTIME: 'fake',
      QUORUM_PASSWORD: 'pw',
      QUORUM_DATA_DIR: dataDir,
      QUORUM_CLIENT_DIST: client,
      QUORUM_FAKE_EXPLORE_MS: '10',
      ...env,
    });
    closers.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const login = async (displayName: string) => {
      const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'pw', displayName }),
      });
      const cookie = /quorum_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
      return { cookie: `quorum_session=${cookie}`, token: cookie };
    };
    return { app, base, dataDir, login };
  }

  it('records requests, commands, room events and client reports, and exports them with the database and repositories', async () => {
    const { base, dataDir, login, app } = await boot();
    const admin = await login('Ann');
    const other = await login('Bob');
    const room = (await (
      await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Plans' }),
      })
    ).json()) as { id: string };

    // one WebSocket command, so the trace has a command and the events it caused
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?roomId=${room.id}`, {
      headers: { cookie: admin.cookie, origin: base },
    });
    closers.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        if (JSON.parse(String(d)).type === 'hello') resolve();
      });
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'document.create', title: 'Notes', cid: 'c1' }));
    await new Promise<void>((resolve) =>
      ws.on('message', (d) => {
        if (JSON.parse(String(d)).type === 'document.created') resolve();
      }),
    );

    const report = await fetch(`${base}/api/debug/client-log`, {
      method: 'POST',
      headers: { cookie: other.cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ entries: [{ level: 'error', msg: 'it broke', data: { x: 1 } }] }),
    });
    expect(await report.json()).toEqual({ ok: true, enabled: true });

    // admin only
    expect(
      (await fetch(`${base}/api/debug/export`, { headers: { cookie: other.cookie } })).status,
    ).toBe(403);
    expect((await fetch(`${base}/api/debug/export`)).status).toBe(401);
    const status = await (
      await fetch(`${base}/api/debug/status`, { headers: { cookie: admin.cookie } })
    ).json();
    expect(status).toMatchObject({ tracing: true, exportAvailable: true });

    const res = await fetch(`${base}/api/debug/export`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toMatch(/quorum-debug-.*\.tar\.gz/);
    const gz = Buffer.from(await res.arrayBuffer());
    expect(gunzipSync(gz).length).toBeGreaterThan(gz.length); // really compressed
    const out = untar(gz);

    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('quorum-debug-export/1');
    expect(manifest.errors).toEqual([]);
    expect(manifest.config.password).toBe('set');
    expect(JSON.stringify(manifest)).not.toContain('"pw"');

    const trace = readdirSync(path.join(out, 'traces')).flatMap((n) =>
      readFileSync(path.join(out, 'traces', n), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
    const kinds = new Set(trace.map((l) => l.kind));
    for (const k of [
      'server.start',
      'log',
      'http',
      'ws.connect',
      'ws.command',
      'room.event',
      'client.log',
    ])
      expect(kinds, k).toContain(k);
    expect(trace.find((l) => l.kind === 'ws.command')).toMatchObject({
      roomId: room.id,
      cmd: { type: 'document.create', title: 'Notes' },
    });
    expect(trace.find((l) => l.kind === 'client.log')).toMatchObject({
      entry: { msg: 'it broke', data: { x: 1 } },
    });
    expect(trace.find((l) => l.kind === 'http' && l.path === '/api/rooms')).toMatchObject({
      method: 'POST',
      status: 201,
    });
    const allText = readdirSync(path.join(out, 'traces'))
      .map((n) => readFileSync(path.join(out, 'traces', n), 'utf8'))
      .join('');
    expect(allText).not.toContain(admin.token); // session tokens never reach the trace

    // database: every table but sessions
    const tables = readdirSync(path.join(out, 'database'));
    expect(tables).toContain('rooms.jsonl');
    expect(tables).toContain('users.jsonl');
    expect(tables).not.toContain('sessions.jsonl');
    expect(readFileSync(path.join(out, 'database', 'documents.jsonl'), 'utf8')).toContain('Notes');

    // the room's repository comes back from its bundle
    const clone = path.join(tempDir(), 'clone');
    execFileSync('git', ['clone', '-q', path.join(out, 'repos', `${room.id}.bundle`), clone]);
    expect(readdirSync(clone)).toContain('Notes.md');
    expect(readFileSync(path.join(out, 'repos', `${room.id}.log.txt`), 'utf8')).toContain(
      'refs/heads/main',
    );

    // repos=0 leaves the repositories out
    const slim = untar(
      Buffer.from(
        await (
          await fetch(`${base}/api/debug/export?repos=0&sinceHours=1`, {
            headers: { cookie: admin.cookie },
          })
        ).arrayBuffer(),
      ),
    );
    expect(readdirSync(slim)).not.toContain('repos');
    expect(readdirSync(slim)).toContain('traces');

    expect(app.config.dataDir).toBe(dataDir);
  });

  it('includes only the Claude transcripts of sessions under the data directory, never the credentials', async () => {
    const { base, dataDir, login } = await boot();
    const admin = await login('Ann');
    const projects = path.join(dataDir, 'claude', 'projects');
    const mine = path.join(
      projects,
      path.join(dataDir, 'rooms', 'r1').replace(/[^a-zA-Z0-9]/g, '-'),
    );
    mkdirSync(mine, { recursive: true });
    writeFileSync(path.join(mine, 'session.jsonl'), '{"type":"user"}\n');
    mkdirSync(path.join(projects, '-somewhere-else'), { recursive: true });
    writeFileSync(path.join(projects, '-somewhere-else', 'other.jsonl'), '{}\n');
    writeFileSync(path.join(dataDir, 'claude', '.credentials.json'), '{"secret":true}');

    const out = untar(
      Buffer.from(
        await (
          await fetch(`${base}/api/debug/export`, { headers: { cookie: admin.cookie } })
        ).arrayBuffer(),
      ),
    );
    const claudeDir = path.join(out, 'claude', 'projects');
    expect(readdirSync(claudeDir)).toEqual([path.basename(mine)]);
    expect(readFileSync(path.join(claudeDir, path.basename(mine), 'session.jsonl'), 'utf8')).toBe(
      '{"type":"user"}\n',
    );
    expect(readdirSync(path.join(out, 'claude'))).toEqual(['projects']);
  });

  it('keeps no trace with QUORUM_TRACE=0, and still exports', async () => {
    const { base, dataDir, login } = await boot({ QUORUM_TRACE: '0' });
    const admin = await login('Ann');
    expect(readdirSync(dataDir)).not.toContain('debug');
    const status = await (
      await fetch(`${base}/api/debug/status`, { headers: { cookie: admin.cookie } })
    ).json();
    expect(status).toMatchObject({ tracing: false, traceFiles: 0 });
    const out = untar(
      Buffer.from(
        await (
          await fetch(`${base}/api/debug/export`, { headers: { cookie: admin.cookie } })
        ).arrayBuffer(),
      ),
    );
    expect(readdirSync(out)).toContain('manifest.json');
    expect(readdirSync(out)).not.toContain('traces');
  });
});
