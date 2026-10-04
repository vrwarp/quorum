import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  textHash,
  type Anchor,
  type Message,
  type Proposal,
  type RoomState,
  type ServerEvent,
} from '@quorum/shared';
import { startServer } from '../main.js';

/**
 * The composition root, for real: startServer() with SQLite, real git repositories, the HTTP + WebSocket API and the
 * fake agent runtime, driven by plain HTTP and `ws` clients. e2e/ does the same through a browser; this is the fast,
 * precise version (events, privacy, git history) and also covers restarts.
 */

const PASSWORD = 'pw';
const FAST = {
  QUORUM_LISTENER_DEBOUNCE_MS: '30',
  QUORUM_REVIEW_WINDOW_MS: '700',
  QUORUM_DIGEST_ABSENCE_MS: '300',
};

type App = Awaited<ReturnType<typeof startServer>> & { base: string; dataDir: string };
interface User {
  name: string;
  id: string;
  cookie: string;
}
type Pred = (e: ServerEvent) => boolean;

const apps: App[] = [];
const dirs: string[] = [];
const sockets: Client[] = [];
let previousExploreMs: string | undefined;

beforeAll(() => {
  previousExploreMs = process.env.QUORUM_FAKE_EXPLORE_MS;
  process.env.QUORUM_FAKE_EXPLORE_MS = '30';
});

afterAll(() => {
  if (previousExploreMs === undefined) delete process.env.QUORUM_FAKE_EXPLORE_MS;
  else process.env.QUORUM_FAKE_EXPLORE_MS = previousExploreMs;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const app of apps.splice(0)) await app.close();
});

async function boot(dataDir?: string, extraEnv: Record<string, string> = {}): Promise<App> {
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), 'quorum-int-'));
  if (!dataDir) dirs.push(dir);
  const app = await startServer({
    PORT: '0',
    QUORUM_RUNTIME: 'fake',
    QUORUM_PASSWORD: PASSWORD,
    QUORUM_DATA_DIR: dir,
    ...FAST,
    ...extraEnv,
  });
  const full: App = Object.assign(app, {
    base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    dataDir: dir,
  });
  apps.push(full);
  return full;
}

async function login(app: App, name: string, password = PASSWORD): Promise<User> {
  const res = await fetch(`${app.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, displayName: name }),
  });
  expect(res.status).toBe(200);
  const cookie = /quorum_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  expect(cookie).toBeTruthy();
  const body = (await res.json()) as { userId: string };
  return { name, id: body.userId, cookie: cookie! };
}

async function api<T = unknown>(
  app: App,
  user: User | null,
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${app.base}${route}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(user ? { cookie: `quorum_session=${user.cookie}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON (static files) */
  }
  return { status: res.status, body: body as T };
}

/** Events carry a process-wide sequence number, so a mark taken from any client orders events on every client. */
let tick = 0;
const mark = () => tick;

class Client {
  private readonly log: Array<{ seq: number; ev: ServerEvent }> = [];
  private readonly ws: WebSocket;
  private readonly waiters: Array<{ pred: Pred; from: number; resolve: (e: ServerEvent) => void }> =
    [];

  constructor(
    app: App,
    readonly user: User,
    roomId: string,
  ) {
    this.ws = new WebSocket(`${app.base.replace('http', 'ws')}/ws?roomId=${roomId}`, {
      headers: { cookie: `quorum_session=${user.cookie}` },
    });
    this.ws.on('message', (data) => {
      const ev = JSON.parse(data.toString()) as ServerEvent;
      const seq = ++tick;
      this.log.push({ seq, ev });
      for (const w of [...this.waiters]) {
        if (seq > w.from && w.pred(ev)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    });
    sockets.push(this);
  }

  get events(): ServerEvent[] {
    return this.log.map((l) => l.ev);
  }

  send(cmd: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(cmd));
  }

  waitFor<T extends ServerEvent = ServerEvent>(
    pred: (e: ServerEvent) => e is T,
    label: string,
    from?: number,
  ): Promise<T>;
  waitFor(pred: Pred, label: string, from?: number): Promise<ServerEvent>;
  waitFor(pred: Pred, label: string, from = 0): Promise<ServerEvent> {
    const seen = this.log.find((l) => l.seq > from && pred(l.ev));
    if (seen) return Promise.resolve(seen.ev);
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(
            new Error(
              `${this.user.name}: timed out waiting for ${label}; saw ${
                this.log
                  .filter((l) => l.seq > from)
                  .map((l) => l.ev.type)
                  .join(', ') || 'nothing'
              }`,
            ),
          );
        }
      }, 8_000).unref();
    });
  }

  /** Resolves with the first chat message (or card update) matching `pred`. */
  message(
    pred: (m: Message) => boolean,
    label: string,
    from?: number,
    type: 'chat.message' | 'chat.updated' = 'chat.message',
  ): Promise<Message> {
    return this.waitFor((e) => e.type === type && pred(e.message), label, from).then(
      (e) => (e as Extract<ServerEvent, { message: Message }>).message,
    );
  }

  proposal(pred: (p: Proposal) => boolean, label: string, from?: number): Promise<Proposal> {
    return this.waitFor((e) => e.type === 'proposal.updated' && pred(e.proposal), label, from).then(
      (e) => (e as Extract<ServerEvent, { type: 'proposal.updated' }>).proposal,
    );
  }

  async hello(): Promise<Extract<ServerEvent, { type: 'hello' }>> {
    return (await this.waitFor((e) => e.type === 'hello', 'hello')) as Extract<
      ServerEvent,
      { type: 'hello' }
    >;
  }

  errors(): Array<Extract<ServerEvent, { type: 'error' }>> {
    return this.events.filter(
      (e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error',
    );
  }

  /** Close the socket and wait for the server to notice. */
  async leave(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  terminate(): void {
    this.ws.terminate();
  }
}

async function join(app: App, user: User, roomId: string): Promise<Client> {
  const c = new Client(app, user, roomId);
  await c.hello();
  return c;
}

async function createRoom(app: App, owner: User, name = 'Design review'): Promise<string> {
  const res = await api<{ id: string }>(app, owner, '/api/rooms', {
    method: 'POST',
    body: { name },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createDoc(c: Client, title: string): Promise<{ id: string; path: string }> {
  const from = mark();
  c.send({ type: 'document.create', title });
  const ev = await c.waitFor(
    (e): e is Extract<ServerEvent, { type: 'document.created' }> =>
      e.type === 'document.created' && e.document.title === title,
    `document.created ${title}`,
    from,
  );
  return ev.document;
}

const docContent = async (app: App, user: User, roomId: string, docId: string, ref = 'main') =>
  (
    await api<{ content: string }>(
      app,
      user,
      `/api/rooms/${roomId}/documents/${docId}?ref=${encodeURIComponent(ref)}`,
    )
  ).body.content;

const git = (app: App, roomId: string, ...args: string[]) =>
  execFileSync('git', ['-C', path.join(app.dataDir, 'rooms', roomId, 'repo.git'), ...args], {
    encoding: 'utf8',
  }).trim();

const isChange = (m: Message) => m.card?.type === 'change';
const optionLabeled = (p: Proposal, label: string) => p.options.find((o) => o.label === label)!;

/** Alice proposes PostgreSQL, Bob answers ClickHouse; resolves with the open Quorum proposal. */
async function diverge(
  alice: Client,
  bob: Client,
  x = 'PostgreSQL',
  y = 'ClickHouse',
): Promise<Proposal> {
  const from = mark();
  alice.send({ type: 'chat.send', body: `Let's use ${x} for the storage layer` });
  await bob.message((m) => m.body.includes(`use ${x}`), 'alice message reaches bob');
  bob.send({ type: 'chat.send', body: `${y} makes more sense for this write volume` });
  return alice.proposal(
    (p) => p.kind === 'quorum' && p.state === 'open' && p.title.includes(x),
    `quorum proposal ${x} vs ${y}`,
    from,
  );
}

const vote = (c: Client, p: Proposal, label: string) =>
  c.send({
    type: 'vote.cast',
    proposalId: p.id,
    decision: 'approve',
    optionId: optionLabeled(p, label).id,
  });

describe('the canonical scenario against the real composition root', () => {
  it('direct request, divergence vote, suggestion, ask, revert, rejoin digest', async () => {
    const app = await boot();
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const a = await join(app, alice, roomId);
    const doc = await createDoc(a, 'Architecture');
    const b = await join(app, bob, roomId);
    await a.waitFor(
      (e) =>
        e.type === 'presence.update' && e.presence.some((p) => p.userId === bob.id && p.connected),
      'bob present',
    );
    const bobHello = b.events.find((e) => e.type === 'hello') as Extract<
      ServerEvent,
      { type: 'hello' }
    >;
    expect(bobHello.you).toEqual({ userId: bob.id, displayName: 'Bob' });
    expect(bobHello.state.documents.map((d) => d.path)).toEqual(['Architecture.md']);
    expect(
      bobHello.state.presence
        .filter((p) => p.connected)
        .map((p) => p.displayName)
        .sort(),
    ).toEqual(['Alice', 'Bob']);

    // 1. a direct request becomes a Change card and a commit on main, announced to everyone
    const fromDirect = mark();
    a.send({ type: 'chat.send', body: 'We should add a section on latency requirements' });
    const changeMsg = await b.message(isChange, 'change card', fromDirect);
    await b.waitFor(
      (e) => e.type === 'document.updated' && e.documentId === doc.id,
      'document.updated',
      fromDirect,
    );
    expect(changeMsg.card).toMatchObject({
      type: 'change',
      change: {
        actor: { kind: 'agent', role: 'orchestrator' },
        proposalId: null,
        revertsSha: null,
      },
    });
    expect(changeMsg.body).toContain('Latency Requirements');
    expect(await docContent(app, bob, roomId, doc.id)).toContain('## Latency Requirements');
    const head = git(app, roomId, 'log', '-1', '--format=%H%n%B', 'main');
    expect(head).toContain(`Quorum-Actor: agent:orchestrator`);
    expect(head).toMatch(/Quorum-Trigger: msg_/);

    // 2. a disagreement is explored on three branches and comes back as a Quorum proposal
    const fromExplore = mark();
    const open = await diverge(a, b);
    expect(open.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(open.options.map((o) => o.branch)).toEqual([
      'architecture/postgresql-vs-clickhouse/a',
      'architecture/postgresql-vs-clickhouse/b',
      'architecture/postgresql-vs-clickhouse/c',
    ]);
    expect(
      await a.message(
        (m) => m.card?.type === 'exploration_started',
        'exploration card',
        fromExplore,
      ),
    ).toMatchObject({
      card: { theses: ['PostgreSQL', 'ClickHouse', 'PostgreSQL with ClickHouse fallback'] },
    });
    await a.message((m) => m.card?.type === 'quorum', 'quorum card', fromExplore);
    // every option is viewable by branch, and main is untouched until the vote passes
    expect(await docContent(app, alice, roomId, doc.id, optionLabeled(open, 'B').branch)).toContain(
      'Decision: ClickHouse',
    );
    expect(await docContent(app, alice, roomId, doc.id)).not.toContain('Decision:');
    const diff = await api<{ unified: string; after: string }>(
      app,
      alice,
      `/api/rooms/${roomId}/proposals/${open.id}/diff?optionId=${optionLabeled(open, 'C').id}`,
    );
    expect(diff.body.unified).toContain('+## Decision: PostgreSQL with ClickHouse fallback');

    const fromVote = mark();
    vote(a, open, 'C');
    const afterFirst = await b.proposal(
      (p) => p.id === open.id && p.votes.length === 1,
      'first vote',
      fromVote,
    );
    expect(afterFirst.state).toBe('open');
    vote(b, open, 'C');
    const merged = await a.proposal(
      (p) => p.id === open.id && p.state === 'merged',
      'merged',
      fromVote,
    );
    expect(merged).toMatchObject({
      mergedOptionId: optionLabeled(open, 'C').id,
      reconciled: false,
      votes: expect.arrayContaining([
        expect.objectContaining({ userId: alice.id }),
        expect.objectContaining({ userId: bob.id }),
      ]),
    });
    const mergeCard = await b.message((m) => m.card?.type === 'merge', 'merge card', fromVote);
    expect(mergeCard.card).toMatchObject({
      type: 'merge',
      proposalId: open.id,
      sha: merged.mergeSha,
      reconciled: false,
    });
    const main = await docContent(app, bob, roomId, doc.id);
    expect(main).toContain('## Decision: PostgreSQL with ClickHouse fallback');
    expect(main).not.toContain('Decision: ClickHouse');
    expect(git(app, roomId, 'tag', '-l')).toBe('milestone/1');
    expect(git(app, roomId, 'tag', '-n1', 'milestone/1')).toContain(open.id);

    // 3. a suggestion is applied as given and its card resolves in place; a stale one is declined
    const lines = main.split('\n');
    const line = lines.findIndex((l) => l.startsWith('Placeholder text')) + 1;
    const text = lines[line - 1]!;
    const anchor: Anchor = {
      documentId: doc.id,
      baseSha: merged.mergeSha!,
      startLine: line,
      endLine: line,
      textHash: textHash(text),
      text,
    };
    const fromSuggest = mark();
    a.send({
      type: 'suggestion.create',
      anchor,
      replacement: text.replace('Placeholder', 'Draft'),
    });
    const pending = await b.message(
      (m) => m.card?.type === 'suggestion',
      'suggestion card',
      fromSuggest,
    );
    expect(pending.card).toMatchObject({ status: 'pending' });
    const applied = await b.message(
      (m) => m.id === pending.id && m.card?.type === 'suggestion' && m.card.status === 'applied',
      'suggestion applied',
      fromSuggest,
      'chat.updated',
    );
    expect(applied.card).toMatchObject({
      status: 'applied',
      resolutionSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const suggestionChange = await b.message(
      (m) => isChange(m) && m.body.includes('Alice'),
      'change card for the suggestion',
      fromSuggest,
    );
    expect(suggestionChange.card).toMatchObject({
      change: {
        actor: { kind: 'user', userId: alice.id },
        sha: (applied.card as { resolutionSha: string }).resolutionSha,
      },
    });
    expect(await docContent(app, bob, roomId, doc.id)).toContain(
      'Draft text about Latency Requirements',
    );

    const fromStale = mark();
    a.send({
      type: 'suggestion.create',
      anchor: { ...anchor, textHash: 'deadbeefdeadbeef' },
      replacement: 'never applied',
    });
    const stale = await a.message(
      (m) => m.card?.type === 'suggestion' && m.card.status === 'declined',
      'stale suggestion declined',
      fromStale,
      'chat.updated',
    );
    expect(stale.card).toMatchObject({
      status: 'declined',
      note: expect.stringMatching(/changed/i),
    });
    expect(await docContent(app, bob, roomId, doc.id)).not.toContain('never applied');

    // 4. an ask is answered from the passage's history, quoting the chat that caused it
    const fromAsk = mark();
    const draftLine = {
      ...anchor,
      text: text.replace('Placeholder', 'Draft'),
      textHash: textHash(text.replace('Placeholder', 'Draft')),
    };
    b.send({ type: 'ask.create', anchor: draftLine, question: 'Why does this say that?' });
    const answer = await a.message(
      (m) => m.author.kind === 'agent' && m.body.includes('Here is the history of line'),
      'ask answer',
      fromAsk,
    );
    expect(answer.anchor).toMatchObject({ documentId: doc.id, startLine: line });
    expect(answer.body).toContain('We should add a section on latency requirements');

    // 5. a participant reverts the suggestion; the card that announced it is flagged for everyone
    const changeCard = suggestionChange.card;
    const sha = changeCard?.type === 'change' ? changeCard.change.sha : '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const fromRevert = mark();
    b.send({ type: 'revert.request', cid: 'r1', sha });
    const flagged = await a.message(
      (m) =>
        m.id === suggestionChange.id &&
        m.card?.type === 'change' &&
        m.card.change.revertedBySha !== null,
      'change card flagged reverted',
      fromRevert,
      'chat.updated',
    );
    const revertCard = await a.message(
      (m) => isChange(m) && m.card?.type === 'change' && m.card.change.revertsSha === sha,
      'revert card',
      fromRevert,
    );
    expect(flagged.card).toMatchObject({
      change: { revertedBySha: (revertCard.card as { change: { sha: string } }).change.sha },
    });
    expect(revertCard.card).toMatchObject({ change: { actor: { kind: 'user', userId: bob.id } } });
    expect(await docContent(app, alice, roomId, doc.id)).toContain(
      'Placeholder text about Latency Requirements',
    );
    b.send({ type: 'revert.request', cid: 'r2', sha });
    await b.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'r2' && e.code === 'conflict',
      'second revert refused',
    );

    // 6. Bob leaves; things happen; on return only he receives a digest
    await b.leave();
    await a.waitFor(
      (e) =>
        e.type === 'presence.update' && e.presence.some((p) => p.userId === bob.id && !p.connected),
      'bob gone',
    );
    await new Promise((r) => setTimeout(r, 400)); // QUORUM_DIGEST_ABSENCE_MS is 300
    const fromDeploy = mark();
    a.send({ type: 'chat.send', body: 'add a section on deployment' });
    await a.message(isChange, 'change while bob is away', fromDeploy);
    const b2 = new Client(app, bob, roomId);
    const digest = await b2.message((m) => m.card?.type === 'digest', 'digest for bob');
    expect(digest).toMatchObject({ privateTo: bob.id, author: { kind: 'agent', role: 'digest' } });
    expect(digest.body).toContain('While you were away');
    expect(digest.body).toContain('Deployment');
    await new Promise((r) => setTimeout(r, 100));
    expect(
      a.events.some((e) => e.type === 'chat.message' && e.message.card?.type === 'digest'),
    ).toBe(false);
    const aliceMessages = await api<Message[]>(
      app,
      alice,
      `/api/rooms/${roomId}/messages?limit=200`,
    );
    expect(aliceMessages.body.some((m) => m.card?.type === 'digest')).toBe(false);
    const bobMessages = await api<Message[]>(app, bob, `/api/rooms/${roomId}/messages?limit=200`);
    expect(bobMessages.body.filter((m) => m.card?.type === 'digest')).toHaveLength(1);
    expect(a.errors()).toEqual([]);
  });

  it('survives a restart: sessions, rooms, history and proposals persist and the repo keeps working', async () => {
    const first = await boot();
    const alice = await login(first, 'Alice');
    const roomId = await createRoom(first, alice, 'Durable room');
    const a = await join(first, alice, roomId);
    const doc = await createDoc(a, 'Plan');
    const from = mark();
    a.send({ type: 'chat.send', body: 'Please rewrite the whole document' });
    const review = await a.proposal(
      (p) => p.kind === 'review' && p.state === 'open',
      'review proposal',
      from,
    );
    const before = (await api<RoomState>(first, alice, `/api/rooms/${roomId}/state`)).body;
    await first.close();
    apps.length = 0;

    const second = await boot(first.dataDir);
    expect((await api(second, alice, '/api/me')).body).toMatchObject({
      userId: alice.id,
      displayName: 'Alice',
    }); // old cookie still valid
    const after = (await api<RoomState>(second, alice, `/api/rooms/${roomId}/state`)).body;
    expect(after.documents.map((d) => d.id)).toEqual(before.documents.map((d) => d.id));
    expect(after.recentMessages.map((m) => m.id)).toEqual(before.recentMessages.map((m) => m.id));
    expect(after.proposals.find((p) => p.id === review.id)?.state).toBe('open');
    // the review window was re-armed on start: with no objection the proposal still merges
    const a2 = await join(second, alice, roomId);
    await a2.proposal(
      (p) => p.id === review.id && p.state === 'merged',
      'review merged after restart',
    );
    expect(await docContent(second, alice, roomId, doc.id)).toContain('rewritten end to end');
    // and the reopened repository still accepts changes
    const fromMore = mark();
    a2.send({ type: 'chat.send', body: 'add a section on goals' });
    await a2.message(isChange, 'change after restart', fromMore);
    expect(await docContent(second, alice, roomId, doc.id)).toContain('## Goals');
  });
});

describe('merging', () => {
  it('uses the merge driver when main moved while the proposal was open, and leaves main healthy', async () => {
    const app = await boot();
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
    const doc = await createDoc(a, 'Architecture');
    const open = await diverge(a, b);

    // main moves on while the vote is open: both sides append to the end of the file, which conflicts
    const fromMove = mark();
    a.send({ type: 'chat.send', body: 'add a section on deployment' });
    await a.message(isChange, 'change on main', fromMove);

    const fromVote = mark();
    vote(a, open, 'C');
    vote(b, open, 'C');
    const merged = await a.proposal(
      (p) => p.id === open.id && p.state === 'merged',
      'merged with the driver',
      fromVote,
    );
    expect(merged.reconciled).toBe(true);
    const card = await a.message((m) => m.card?.type === 'merge', 'merge card', fromVote);
    expect(card.card).toMatchObject({ type: 'merge', reconciled: true });
    expect(card.body).toMatch(/conflict/i);

    // a real merge commit with the merge actor and the proposal in its trailers
    const parents = git(app, roomId, 'rev-list', '--parents', '-n', '1', 'main').split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[0]).toBe(merged.mergeSha);
    const message = git(app, roomId, 'log', '-1', '--format=%B', 'main');
    expect(message).toContain('Quorum-Actor: agent:merge');
    expect(message).toContain(`Quorum-Proposal: ${open.id}`);
    expect(await docContent(app, alice, roomId, doc.id)).toContain(
      '## Decision: PostgreSQL with ClickHouse fallback',
    );
    // no leftover merge worktree, no conflict markers, main checkout matches main
    const worktrees = git(app, roomId, 'worktree', 'list', '--porcelain');
    expect(worktrees).not.toMatch(/worktrees\/merge-/);
    expect(await docContent(app, alice, roomId, doc.id)).not.toMatch(/^(<{7}|>{7})/m);
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: path.join(app.dataDir, 'rooms', roomId, 'worktrees', 'main'),
        encoding: 'utf8',
      }),
    ).toBe('');

    // reverting the merge commit (against its first parent) restores main as it was and marks the proposal
    const fromRevert = mark();
    a.send({ type: 'revert.request', sha: merged.mergeSha });
    await a.proposal(
      (p) => p.id === open.id && p.state === 'reverted',
      'proposal reverted',
      fromRevert,
    );
    const restored = await docContent(app, alice, roomId, doc.id);
    expect(restored).toContain('## Deployment');
    expect(restored).not.toContain('Decision:');

    // the next change goes through the same lock and worktree without trouble
    const fromNext = mark();
    a.send({ type: 'chat.send', body: 'add a section on monitoring' });
    await a.message(
      (m) => isChange(m) && m.body.includes('Monitoring'),
      'change after the merge',
      fromNext,
    );
    expect(await docContent(app, alice, roomId, doc.id)).toContain('## Monitoring');
  });

  it('a departure can complete a unanimous vote; the owner can switch to majority', async () => {
    const app = await boot();
    const [alice, bob, carol] = [
      await login(app, 'Alice'),
      await login(app, 'Bob'),
      await login(app, 'Carol'),
    ];
    const roomId = await createRoom(app, alice);
    const [a, b, c] = [
      await join(app, alice, roomId),
      await join(app, bob, roomId),
      await join(app, carol, roomId),
    ];
    const doc = await createDoc(a, 'Architecture');

    const open = await diverge(a, b);
    vote(a, open, 'C');
    vote(b, open, 'C');
    await a.proposal((p) => p.id === open.id && p.votes.length === 2, 'two votes');
    await new Promise((r) => setTimeout(r, 150));
    expect(
      (await api<RoomState>(app, alice, `/api/rooms/${roomId}/state`)).body.proposals.find(
        (p) => p.id === open.id,
      )?.state,
    ).toBe('open'); // Carol has not voted

    const fromLeave = mark();
    await c.leave();
    await a.proposal(
      (p) => p.id === open.id && p.state === 'merged',
      'merged once Carol left',
      fromLeave,
    );
    expect(await docContent(app, alice, roomId, doc.id)).toContain(
      'Decision: PostgreSQL with ClickHouse fallback',
    );

    // only the owner changes the rule; with majority two of three connected approvals are enough
    const c2 = await join(app, carol, roomId);
    const fromRule = mark();
    b.send({ type: 'room.setRule', cid: 'rule1', votingRule: 'majority' });
    await b.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'rule1' && e.code === 'forbidden',
      'non-owner refused',
    );
    a.send({ type: 'room.setRule', votingRule: 'majority' });
    await b.message(
      (m) => m.kind === 'system' && m.body.includes('majority'),
      'rule change announced',
      fromRule,
    );
    for (const c of [a, b, c2])
      await c.waitFor(
        (e) => e.type === 'room.updated' && e.room.votingRule === 'majority',
        `${c.user.name} hears the new rule`,
        fromRule,
      );
    const second = await diverge(a, b, 'Redis', 'Memcached');
    vote(a, second, 'A');
    vote(b, second, 'A');
    const merged = await a.proposal(
      (p) => p.id === second.id && p.state === 'merged',
      'merged on a majority',
    );
    expect(merged.mergedOptionId).toBe(optionLabeled(second, 'A').id);
    await c2.proposal(
      (p) => p.id === second.id && p.state === 'merged',
      'Carol hears about the merge',
    );
    expect(await docContent(app, alice, roomId, doc.id)).toContain('## Decision: Redis');
    expect(git(app, roomId, 'tag', '-l').split('\n')).toEqual(['milestone/1', 'milestone/2']);
  });

  it.each([['first'], ['last']])(
    'shutting down records last-seen times but does not let the disconnects pass a vote (Carol connects %s)',
    async (when) => {
      const app = await boot();
      const [alice, bob, carol] = [
        await login(app, 'Alice'),
        await login(app, 'Bob'),
        await login(app, 'Carol'),
      ];
      const roomId = await createRoom(app, alice);
      // The server closes sockets in an order that follows connection order one way or the other. Carol has not voted,
      // so when hers closes first Alice and Bob alone are unanimous: a vote that must not be counted at shutdown.
      if (when === 'first') await join(app, carol, roomId);
      const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
      if (when === 'last') await join(app, carol, roomId);
      const doc = await createDoc(a, 'Architecture');
      const open = await diverge(a, b);
      vote(a, open, 'C');
      vote(b, open, 'C');
      await a.proposal((p) => p.id === open.id && p.votes.length === 2, 'both votes are in');

      const closing = Date.now();
      await app.close();
      apps.length = 0;
      const second = await boot(app.dataDir);
      const state = (await api<RoomState>(second, alice, `/api/rooms/${roomId}/state`)).body;
      expect(state.proposals.find((p) => p.id === open.id)?.state).toBe('open');
      expect(await docContent(second, alice, roomId, doc.id)).not.toContain('Decision:');
      expect(state.presence.map((p) => p.connected)).toEqual([false, false, false]);
      for (const p of state.presence) {
        expect(Date.parse(p.lastSeenAt)).toBeGreaterThanOrEqual(closing);
      }
    },
  );

  it('a Review proposal: rejection archives it, silence lets it merge when the window closes', async () => {
    const app = await boot();
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
    const doc = await createDoc(a, 'Plan');

    const from = mark();
    a.send({ type: 'chat.send', body: 'Please rewrite the entire document' });
    const review = await b.proposal(
      (p) => p.kind === 'review' && p.state === 'open',
      'review opened',
    );
    expect(review.windowClosesAt).not.toBeNull();
    expect(await a.message((m) => m.card?.type === 'review', 'review card', from)).toMatchObject({
      card: { proposalId: review.id },
    });
    b.send({ type: 'vote.cast', proposalId: review.id, decision: 'reject' });
    const rejected = await a.proposal(
      (p) => p.id === review.id && p.state === 'rejected',
      'rejected',
    );
    expect(rejected.closedAt).not.toBeNull();
    await a.message(
      (m) => m.kind === 'system' && m.body.includes('was rejected'),
      'rejection announced',
    );
    expect(await docContent(app, alice, roomId, doc.id)).not.toContain('rewritten');
    b.send({ type: 'vote.cast', cid: 'late', proposalId: review.id, decision: 'approve' });
    await b.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'late' && e.code === 'conflict',
      'votes on a closed proposal refused',
    );

    // the rejected branch stays readable; a second request nobody objects to merges by itself
    expect(await docContent(app, alice, roomId, doc.id, review.options[0]!.branch)).toContain(
      'rewritten end to end',
    );
    const fromSecond = mark();
    a.send({ type: 'chat.send', body: 'rewrite the whole document again' });
    const second = await a.proposal(
      (p) => p.kind === 'review' && p.state === 'open' && p.id !== review.id,
      'second review',
      fromSecond,
    );
    const closes = Date.parse(second.windowClosesAt!);
    await a.proposal(
      (p) => p.id === second.id && p.state === 'merged',
      'merged after the window',
      fromSecond,
    );
    expect(Date.now()).toBeGreaterThanOrEqual(closes - 50);
    expect(await docContent(app, alice, roomId, doc.id)).toContain('rewritten end to end');
    expect(git(app, roomId, 'tag', '-l')).toBe(''); // only Quorum proposals tag milestones
  });
});

describe('documents and the API surface', () => {
  it('pages through history: hello carries the latest messages, ?before= the earlier ones, oldest first', async () => {
    const app = await boot(undefined, { QUORUM_RECENT_MESSAGES_IN_HELLO: '4' });
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const a = await join(app, alice, roomId);
    for (let i = 1; i <= 9; i++) {
      const from = mark();
      a.send({ type: 'chat.send', body: `message ${i}` });
      await a.message((m) => m.body === `message ${i}`, `message ${i} echoed`, from);
    }

    const hello = (await (await join(app, bob, roomId)).hello()).state.recentMessages;
    expect(hello.map((m) => m.body)).toEqual(['message 6', 'message 7', 'message 8', 'message 9']);

    const collected: string[] = hello.map((m) => m.body);
    let cursor = hello[0]!.id;
    for (let page = 0; page < 10; page++) {
      const older = (
        await api<Message[]>(app, bob, `/api/rooms/${roomId}/messages?limit=3&before=${cursor}`)
      ).body;
      if (older.length === 0) break;
      expect(older.length).toBeLessThanOrEqual(3);
      collected.unshift(...older.map((m) => m.body));
      cursor = older[0]!.id;
    }
    expect(collected.filter((b) => b.startsWith('message '))).toEqual(
      Array.from({ length: 9 }, (_, i) => `message ${i + 1}`),
    );
    expect(new Set(collected).size).toBe(collected.length);
    expect((await api(app, bob, `/api/rooms/${roomId}/messages?limit=0`)).status).toBe(200);
  });

  it('renames and archives documents, refusing while a proposal is open', async () => {
    const app = await boot();
    const alice = await login(app, 'Alice');
    const roomId = await createRoom(app, alice);
    const a = await join(app, alice, roomId);
    const doc = await createDoc(a, 'Architecture');
    await createDoc(a, 'API Spec');

    const fromRename = mark();
    a.send({ type: 'document.rename', documentId: doc.id, title: 'Design' });
    const renamed = await a.waitFor(
      (e): e is Extract<ServerEvent, { type: 'document.created' }> =>
        e.type === 'document.created' && e.document.id === doc.id,
      'rename as upsert',
      fromRename,
    );
    expect(renamed.document).toMatchObject({
      id: doc.id,
      path: 'Design.md',
      title: 'Design',
      status: 'active',
    });
    expect(await docContent(app, alice, roomId, doc.id)).toBe('# Architecture\n');
    expect(git(app, roomId, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual([
      'API Spec.md',
      'Design.md',
    ]);

    a.send({ type: 'document.rename', cid: 'dup', documentId: doc.id, title: 'API Spec' });
    await a.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'dup' && e.code === 'conflict',
      'duplicate name refused',
    );

    const from = mark();
    a.send({ type: 'chat.send', body: 'rewrite the whole document' });
    const review = await a.proposal((p) => p.state === 'open', 'review open', from);
    a.send({ type: 'document.archive', cid: 'busy', documentId: review.documentId });
    await a.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'busy' && e.code === 'conflict',
      'archive refused while a proposal is open',
    );
    a.send({ type: 'vote.cast', proposalId: review.id, decision: 'reject' });
    await a.proposal((p) => p.id === review.id && p.state === 'rejected', 'rejected');

    const fromArchive = mark();
    a.send({ type: 'document.archive', documentId: doc.id });
    await a.waitFor(
      (e) => e.type === 'document.archived' && e.documentId === doc.id,
      'archived',
      fromArchive,
    );
    const state = (await api<RoomState>(app, alice, `/api/rooms/${roomId}/state`)).body;
    expect(state.documents.map((d) => d.path)).toEqual(['API Spec.md']);
  });

  it('rejects what it should: bad passwords, anonymous sockets, bad commands, unsafe refs, unknown routes', async () => {
    const app = await boot();
    const bad = await fetch(`${app.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong', displayName: 'Mallory' }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const alice = await login(app, 'Alice');
    expect((await api(app, null, '/api/rooms')).status).toBe(401);
    expect((await api(app, null, '/api/me')).status).toBe(401);
    expect((await api(app, alice, '/api/rooms/room_missing/state')).status).toBe(404);
    expect((await api(app, alice, '/api/nope')).status).toBe(404);
    expect(
      (await api(app, alice, '/api/rooms', { method: 'POST', body: { name: '   ' } })).status,
    ).toBe(400);

    const roomId = await createRoom(app, alice);
    const doc = await createDoc(await join(app, alice, roomId), 'Notes');
    const ref = await api(app, alice, `/api/rooms/${roomId}/documents/${doc.id}?ref=--upload-pack`);
    expect(ref.status).toBe(400);
    expect(
      (await api(app, alice, `/api/rooms/${roomId}/documents/${doc.id}?ref=no-such-branch`)).status,
    ).toBe(404);

    // an anonymous or unknown-room socket never opens
    const rejected = (url: string, headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => undefined);
      });
    expect(await rejected(`${app.base.replace('http', 'ws')}/ws?roomId=${roomId}`, {})).toBe(401);
    expect(
      await rejected(`${app.base.replace('http', 'ws')}/ws?roomId=room_missing`, {
        cookie: `quorum_session=${alice.cookie}`,
      }),
    ).toBe(404);

    // bad commands come back as error events carrying the correlation id; the socket stays usable
    const c = await join(app, alice, roomId);
    c.send({ type: 'chat.send', cid: 'empty', body: '' });
    c.send({ type: 'vote.cast', cid: 'ghost', proposalId: 'prop_missing', decision: 'approve' });
    c.send({ type: 'room.setRule', cid: 'rule', votingRule: 'dictator' });
    await c.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'empty' && e.code === 'bad_request',
      'empty message refused',
    );
    await c.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'ghost' && e.code === 'not_found',
      'unknown proposal refused',
    );
    await c.waitFor(
      (e) => e.type === 'error' && e.inReplyTo === 'rule' && e.code === 'bad_request',
      'unknown rule refused',
    );
    const from = mark();
    c.send({ type: 'chat.send', body: 'still here' });
    await c.message((m) => m.body === 'still here', 'the socket still works', from);

    // the client build is served, with the SPA fallback for client-side routes and a 404 for missing assets
    const index = await api<string>(app, null, '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('<div id="root">');
    expect(await api<string>(app, null, `/rooms/${roomId}`)).toMatchObject({ status: 200 });
    expect((await api(app, null, '/settings')).status).toBe(200);
    expect((await api(app, null, '/assets/missing.js')).status).toBe(404);
    // a traversal attempt gets the client's index page (the SPA fallback), never a file from outside the client build
    const traversal = await api<string>(app, null, '/%2e%2e/%2e%2e/etc/passwd');
    expect(traversal.status).toBe(200);
    expect(traversal.body).toContain('<div id="root">');
    expect(traversal.body).not.toMatch(/root:.*:0:0:/);
    const encoded = await api<string>(app, null, '/assets/..%2f..%2f..%2f..%2fetc%2fpasswd');
    expect([400, 404]).toContain(encoded.status);
    expect(String(encoded.body)).not.toMatch(/root:.*:0:0:/);
  });
});

/**
 * The write path to main, found wanting by the server core review and fixed: real git, real SQLite, real HTTP and
 * WebSocket, the fake agent runtime. Each test is the scenario from the review, end to end.
 */
describe('the write path to main', () => {
  const worker = { actor: { kind: 'agent', role: 'worker' } as const, triggerMessageIds: [] };
  const repoOf = (app: App, roomId: string) => app.service.repo(roomId);

  /** an open Quorum proposal for `doc` with one option: a branch of two commits, step one and step two */
  async function twoStepProposal(app: App, roomId: string, docId: string) {
    const repo = await repoOf(app, roomId);
    const { worktreePath, baseSha } = await repo.createBranch('plan/two-steps/a');
    writeFileSync(path.join(worktreePath, 'Plan.md'), '# Plan\n\nstep one\n');
    await repo.commitWorktree(worktreePath, 'step 1', worker);
    writeFileSync(path.join(worktreePath, 'Plan.md'), '# Plan\n\nstep one\n\nstep two\n');
    await repo.commitWorktree(worktreePath, 'step 2', worker);
    return app.service.openProposal(roomId, {
      documentId: docId,
      kind: 'quorum',
      title: 'Two steps',
      branchBase: baseSha,
      options: [
        { label: 'A', branch: 'plan/two-steps/a', summary: 'one, then two', tradeoffs: '' },
      ],
      triggerMessageIds: [],
    });
  }

  it('F1: a proposal of several commits merges as one merge commit, and Revert takes all of it back', async () => {
    const app = await boot();
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
    const doc = await createDoc(a, 'Plan');
    const proposal = await twoStepProposal(app, roomId, doc.id);

    const fromVote = mark();
    vote(a, proposal, 'A');
    vote(b, proposal, 'A');
    const merged = await a.proposal(
      (p) => p.id === proposal.id && p.state === 'merged',
      'merged',
      fromVote,
    );
    expect(merged.reconciled).toBe(false); // main had not moved: no merge driver, the voted text exactly
    const parents = git(app, roomId, 'rev-list', '--parents', '-n1', merged.mergeSha!).split(' ');
    expect(parents).toHaveLength(3); // a merge commit, not the branch tip
    expect(git(app, roomId, 'log', '-1', '--format=%B', merged.mergeSha!)).toContain(
      `Quorum-Proposal: ${proposal.id}`,
    );
    expect(await docContent(app, alice, roomId, doc.id)).toBe('# Plan\n\nstep one\n\nstep two\n');
    // the merged proposal no longer needs its option worktree; the branch stays as history (review F17)
    await app.service.idle();
    expect(
      existsSync(path.join(app.dataDir, 'rooms', roomId, 'worktrees', 'plan__two-steps__a')),
    ).toBe(false);
    expect(git(app, roomId, 'branch', '--list', 'plan/two-steps/a')).toContain('plan/two-steps/a');
    // the change's diff covers the whole proposal, against the real first parent
    const diff = await api<{ unified: string; baseSha: string; before: string; after: string }>(
      app,
      alice,
      `/api/rooms/${roomId}/changes/${merged.mergeSha}/diff`,
    );
    expect(diff.status).toBe(200);
    expect(diff.body.baseSha).toBe(parents[1]);
    expect(diff.body.unified).toContain('+step one');
    expect(diff.body.unified).toContain('+step two');

    const fromRevert = mark();
    b.send({ type: 'revert.request', cid: 'rv', sha: merged.mergeSha });
    await a.proposal((p) => p.id === proposal.id && p.state === 'reverted', 'reverted', fromRevert);
    expect(await docContent(app, alice, roomId, doc.id)).toBe('# Plan\n'); // not "step one"
    expect(b.errors()).toEqual([]);
  });

  it('F2: a merge that cannot update the main checkout fails whole, and later commits do not undo it', async () => {
    const app = await boot();
    const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
    const roomId = await createRoom(app, alice);
    const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
    const doc = await createDoc(a, 'Architecture');
    const open = await diverge(a, b);
    const mainBefore = git(app, roomId, 'rev-parse', 'main');
    const textBefore = await docContent(app, alice, roomId, doc.id);

    // the orchestrator's `git status` holds the main worktree's index lock for longer than the merge is willing to wait
    const lock = path.join(
      app.dataDir,
      'rooms',
      roomId,
      'repo.git',
      'worktrees',
      'main',
      'index.lock',
    );
    writeFileSync(lock, '');
    try {
      const fromFail = mark();
      vote(a, open, 'C');
      vote(b, open, 'C');
      const reopened = await a.message(
        (m) => m.kind === 'system' && m.body.includes('failed'),
        'merge failure announced',
        fromFail,
      );
      expect(reopened.body).toMatch(/could not advance main/);
      await a.proposal((p) => p.id === open.id && p.state === 'open', 'reopened', fromFail);
      // main did not move, its checkout agrees with it, and the half-made merge was cleaned away
      expect(git(app, roomId, 'rev-parse', 'main')).toBe(mainBefore);
      expect(git(app, roomId, 'worktree', 'list', '--porcelain')).not.toMatch(/worktrees\/merge-/);
      expect(await docContent(app, alice, roomId, doc.id)).toBe(textBefore);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: path.join(app.dataDir, 'rooms', roomId, 'worktrees', 'main'),
        encoding: 'utf8',
      }),
    ).toBe('');

    // an unrelated change goes through; it must not bring back or take away anything
    await createDoc(a, 'Other');
    expect(await docContent(app, alice, roomId, doc.id)).toBe(textBefore);

    // a fresh vote tries again, and now it works; the next unrelated change keeps the merged text
    const fromRetry = mark();
    vote(b, open, 'C');
    await a.proposal(
      (p) => p.id === open.id && p.state === 'merged',
      'merged on the second try',
      fromRetry,
    );
    const merged = await docContent(app, alice, roomId, doc.id);
    expect(merged).toContain('## Decision: PostgreSQL with ClickHouse fallback');
    await createDoc(a, 'More');
    expect(await docContent(app, alice, roomId, doc.id)).toBe(merged);
  }, 20_000);

  describe('F4: a proposal a restart found in merging', () => {
    it('is reopened when nothing reached main, and can then be voted through', async () => {
      const first = await boot();
      const [alice, bob] = [await login(first, 'Alice'), await login(first, 'Bob')];
      const roomId = await createRoom(first, alice);
      const [a, b] = [await join(first, alice, roomId), await join(first, bob, roomId)];
      await createDoc(a, 'Architecture');
      const open = await diverge(a, b);
      // the process died while the merge was starting: the state says merging, main has nothing
      first.storage.proposals.setState(open.id, 'merging');
      await first.close();
      apps.length = 0;

      const second = await boot(first.dataDir);
      const state = (await api<RoomState>(second, alice, `/api/rooms/${roomId}/state`)).body;
      expect(state.proposals.find((p) => p.id === open.id)?.state).toBe('open');
      expect(
        state.recentMessages.some((m) => m.kind === 'system' && m.body.includes('interrupted')),
      ).toBe(true);
      const [a2, b2] = [await join(second, alice, roomId), await join(second, bob, roomId)];
      const fromVote = mark();
      vote(a2, open, 'C');
      vote(b2, open, 'C');
      await a2.proposal(
        (p) => p.id === open.id && p.state === 'merged',
        'merged after the restart',
        fromVote,
      );
    });

    it('is finished when its merge had reached main: the card, the Change and the milestone appear', async () => {
      const first = await boot();
      const [alice, bob] = [await login(first, 'Alice'), await login(first, 'Bob')];
      const roomId = await createRoom(first, alice);
      const [a, b] = [await join(first, alice, roomId), await join(first, bob, roomId)];
      const doc = await createDoc(a, 'Architecture');
      const open = await diverge(a, b);
      const option = optionLabeled(open, 'B');
      // the merge commit is on main (as finishMerge leaves it), but nothing was recorded: the process died right there
      const repo = await repoOf(first, roomId);
      const mergeSha = await repo.withMainLock(async () => {
        const out = await repo.beginMerge(option.branch);
        return repo.finishMerge(out.worktreePath!, 'Merge option B', {
          actor: { kind: 'agent', role: 'merge' },
          triggerMessageIds: [],
          proposalId: open.id,
        });
      });
      first.storage.proposals.setState(open.id, 'merging');
      await first.close();
      apps.length = 0;

      const second = await boot(first.dataDir);
      const after = (await api<RoomState>(second, alice, `/api/rooms/${roomId}/state`)).body;
      expect(after.proposals.find((p) => p.id === open.id)).toMatchObject({
        state: 'merged',
        mergedOptionId: option.id,
        mergeSha,
      });
      const messages = (
        await api<Message[]>(second, alice, `/api/rooms/${roomId}/messages?limit=200`)
      ).body;
      expect(messages.some((m) => m.card?.type === 'merge' && m.card.sha === mergeSha)).toBe(true);
      expect(git(second, roomId, 'tag', '-l')).toBe('milestone/1');
      expect(await docContent(second, alice, roomId, doc.id)).toContain('Decision: ClickHouse');
      // and it can be reverted like any other merge
      const a2 = await join(second, alice, roomId);
      const fromRevert = mark();
      a2.send({ type: 'revert.request', cid: 'rv', sha: mergeSha });
      await a2.proposal((p) => p.id === open.id && p.state === 'reverted', 'reverted', fromRevert);
      expect(await docContent(second, alice, roomId, doc.id)).not.toContain('Decision:');
    });

    it('a merge in flight is given time when the server stops: the agents are stopped after it, not before', async () => {
      const app = await boot();
      const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
      const roomId = await createRoom(app, alice);
      const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
      await createDoc(a, 'Architecture');
      const open = await diverge(a, b);
      const fromMove = mark();
      a.send({ type: 'chat.send', body: 'add a section on deployment' }); // main moves: the merge needs the driver
      await a.message(isChange, 'change on main', fromMove);

      // a slow merge driver, and a record of what the proposal looked like when the agents were stopped
      const drive = app.runtime.runMergeDriver.bind(app.runtime);
      let entered!: () => void;
      const inDriver = new Promise<void>((r) => (entered = r));
      app.runtime.runMergeDriver = async (...args) => {
        entered();
        await new Promise((r) => setTimeout(r, 700));
        return drive(...args);
      };
      const stopAll = app.runtime.stopAll.bind(app.runtime);
      let stateWhenAgentsStopped = '';
      app.runtime.stopAll = async () => {
        stateWhenAgentsStopped = app.storage.proposals.get(open.id)!.state;
        return stopAll();
      };
      vote(a, open, 'C');
      vote(b, open, 'C');
      await inDriver;
      await app.close();
      apps.length = 0;
      expect(stateWhenAgentsStopped).toBe('merged');
      const second = await boot(app.dataDir);
      expect(
        (await api<RoomState>(second, alice, `/api/rooms/${roomId}/state`)).body.proposals.find(
          (p) => p.id === open.id,
        )?.state,
      ).toBe('merged');
    });
  });

  it("F3: the orchestrator's unsaved edit in the main worktree is not swept into someone else's change", async () => {
    const app = await boot();
    const alice = await login(app, 'Alice');
    const roomId = await createRoom(app, alice);
    const a = await join(app, alice, roomId);
    const plan = await createDoc(a, 'Plan');
    const mainWorktree = path.join(app.dataDir, 'rooms', roomId, 'worktrees', 'main');
    writeFileSync(path.join(mainWorktree, 'Plan.md'), '# Plan\n\nhalf-typed by the orchestrator\n');

    await createDoc(a, 'Other');
    expect(git(app, roomId, 'show', '--name-only', '--format=%s', 'main')).toBe(
      'Create Other.md\n\nOther.md',
    );
    // the edit is still there for the orchestrator to finish, and main has not got it
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: mainWorktree, encoding: 'utf8' }),
    ).toBe(' M Plan.md\n');
    expect(await docContent(app, alice, roomId, plan.id)).toBe('# Plan\n');
  });

  it.each([['create first'], ['rename first']])(
    'F9: creating a document while another is renamed to the same name leaves git and the database agreeing (%s)',
    async (order) => {
      const app = await boot();
      const [alice, bob] = [await login(app, 'Alice'), await login(app, 'Bob')];
      const roomId = await createRoom(app, alice);
      const [a, b] = [await join(app, alice, roomId), await join(app, bob, roomId)];
      const plan = await createDoc(a, 'Plan');
      const create = () => a.send({ type: 'document.create', cid: 'create', title: 'Spec' });
      const rename = () =>
        b.send({ type: 'document.rename', cid: 'rename', documentId: plan.id, title: 'Spec' });
      if (order === 'create first') {
        create();
        rename();
      } else {
        rename();
        create();
      }
      await Promise.all([
        a.waitFor(
          (e) => e.type === 'document.created' && e.document.title === 'Spec',
          'a hears Spec',
        ),
        b.waitFor(
          (e) => e.type === 'document.created' && e.document.title === 'Spec',
          'b hears Spec',
        ),
      ]);
      const failed = await Promise.race([
        a.waitFor((e) => e.type === 'error' && e.inReplyTo === 'create', 'create refused'),
        b.waitFor((e) => e.type === 'error' && e.inReplyTo === 'rename', 'rename refused'),
      ]);
      expect(failed).toMatchObject({ type: 'error', code: 'conflict' });
      await new Promise((r) => setTimeout(r, 50));

      const state = (await api<RoomState>(app, alice, `/api/rooms/${roomId}/state`)).body;
      const paths = state.documents.map((d) => d.path).sort();
      expect(paths).toHaveLength(new Set(paths).size);
      expect(git(app, roomId, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual(paths);
      for (const d of state.documents) {
        const content = await docContent(app, alice, roomId, d.id);
        expect(content, d.path).toMatch(/^# (Plan|Spec)\n$/);
      }
      expect(
        app.storage.documents.list(roomId, true).filter((d) => d.status === 'active'),
      ).toHaveLength(state.documents.length);
    },
  );

  it('a Change keeps its diff after the document is renamed: the path is the one the commit touched', async () => {
    const app = await boot();
    const alice = await login(app, 'Alice');
    const roomId = await createRoom(app, alice);
    const a = await join(app, alice, roomId);
    const doc = await createDoc(a, 'Architecture');
    const from = mark();
    a.send({ type: 'chat.send', body: 'We should add a section on latency requirements' });
    const change = await a.message(isChange, 'change card', from);
    const sha = change.card?.type === 'change' ? change.card.change.sha : '';

    const fromRename = mark();
    a.send({ type: 'document.rename', documentId: doc.id, title: 'Design' });
    await a.waitFor(
      (e) => e.type === 'document.created' && e.document.path === 'Design.md',
      'renamed',
      fromRename,
    );

    const diff = await api<{
      path: string;
      baseSha: string;
      headSha: string;
      before: string;
      after: string;
      unified: string;
    }>(app, alice, `/api/rooms/${roomId}/changes/${sha}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.path).toBe('Architecture.md'); // as of that commit, not today's Design.md
    expect(diff.body.headSha).toBe(sha);
    expect(diff.body.baseSha).toBe(git(app, roomId, 'rev-parse', `${sha}^1`)); // a sha, never "<sha>~1"
    expect(diff.body.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.body.before).not.toContain('Latency Requirements');
    expect(diff.body.after).toContain('## Latency Requirements');
    expect(diff.body.unified).toContain('+## Latency Requirements');
    expect(
      existsSync(path.join(app.dataDir, 'rooms', roomId, 'worktrees', 'main', 'Design.md')),
    ).toBe(true);
  });
});
