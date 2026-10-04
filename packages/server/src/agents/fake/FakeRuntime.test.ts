import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textHash, type Anchor, type Message, type Proposal } from '@quorum/shared';
import { createStubActions, type StubActions } from '../testing/stubActions.js';
import { MemoryRepo } from '../testing/memoryRepo.js';
import { makeChange, makeProposal, tunables } from '../testing/fixtures.js';
import { createAgentRuntime } from '../index.js';
import {
  FakeRuntime,
  cleanSenseTerm,
  cleanUseTerm,
  isQuestion,
  pickDocument,
  reverseChange,
  takeTheirs,
  titleCase,
} from './FakeRuntime.js';

const ALICE = { id: 'user_alice', name: 'Alice' };
const BOB = { id: 'user_bob', name: 'Bob' };
const CAROL = { id: 'user_carol', name: 'Carol' };
type User = typeof ALICE;

const DOC =
  '# Architecture\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.\n\nFifth paragraph.\n';

interface Rig {
  repo: MemoryRepo;
  stub: StubActions;
  runtime: FakeRuntime;
  logs: string[];
  say(user: User, text: string): Message;
  /** chat messages the agent posted */
  agentChat(): string[];
  statuses(): string[];
}

function rig(
  opts: {
    files?: Record<string, string>;
    docs?: Array<{ path: string; title: string }>;
    tunables?: Record<string, number>;
    exploreMs?: number;
  } = {},
): Rig {
  const files = opts.files ?? { 'Architecture.md': DOC, 'PRD.md': '# PRD\n\nGoals.\n' };
  const repo = new MemoryRepo('room_test', files);
  const docs = opts.docs ?? [
    { path: 'Architecture.md', title: 'Architecture' },
    { path: 'PRD.md', title: 'PRD' },
  ];
  const stub = createStubActions({
    repo,
    documents: docs,
    participants: [
      { userId: ALICE.id, displayName: ALICE.name },
      { userId: BOB.id, displayName: BOB.name },
      { userId: CAROL.id, displayName: CAROL.name },
    ],
  });
  const logs: string[] = [];
  const runtime = new FakeRuntime(
    stub.actions,
    {
      dataDir: '/tmp/quorum-fake-test',
      tunables: tunables({ listenerDebounceMs: 5, ...(opts.tunables ?? {}) }),
      logger: (level, msg, meta) =>
        logs.push(`${level}:${msg}${meta?.error ? ` (${String(meta.error)})` : ''}`),
    },
    { delays: { exploreMs: opts.exploreMs ?? 5 } },
  );
  return {
    repo,
    stub,
    runtime,
    logs,
    say(user, text) {
      const m = stub.human(user.id, user.name, text);
      runtime.onChatMessage(stub.roomId, m);
      return m;
    },
    agentChat: () =>
      stub.messages
        .filter((m) => m.author.kind === 'agent' && m.kind === 'text')
        .map((m) => m.body),
    statuses: () => stub.statuses.map((s) => s.status),
  };
}

const anchorFor = (doc: string, startLine: number, endLine = startLine): Anchor => ({
  documentId: 'doc_1',
  baseSha: 'b'.repeat(40),
  startLine,
  endLine,
  textHash: textHash(
    doc
      .split('\n')
      .slice(startLine - 1, endLine)
      .join('\n'),
  ),
  text: doc
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n'),
});

function suggestion(r: Rig, user: User, anchor: Anchor, replacement: string): Message {
  return r.stub.human(user.id, user.name, 'Suggested an edit', {
    kind: 'card',
    anchor,
    card: {
      type: 'suggestion',
      anchor,
      replacement,
      status: 'pending',
      resolutionSha: null,
      note: null,
    },
  });
}

const cardOf = (m: Message) =>
  m.card as Extract<NonNullable<Message['card']>, { type: 'suggestion' }>;

afterEach(() => vi.useRealTimers());

describe('direct request: "add a section on X" is an immediate change', () => {
  it('commits a new section to main with trailers and records a Change', async () => {
    const r = rig();
    const m = r.say(ALICE, 'We should add a section on latency requirements');
    await r.runtime.flush();

    expect(r.stub.changes).toHaveLength(1);
    const change = r.stub.changes[0]!;
    expect(change).toMatchObject({
      documentId: 'doc_1',
      actor: { kind: 'agent', role: 'orchestrator' },
      summary: 'Added a "Latency Requirements" section to Architecture',
      triggerMessageIds: [m.id],
      proposalId: null,
      revertsSha: null,
    });
    expect(await r.repo.headSha('main')).toBe(change.sha);
    const content = (await r.repo.readFile('Architecture.md'))!;
    expect(content.startsWith(DOC)).toBe(true);
    expect(content).toContain(
      '\n## Latency Requirements\n\nPlaceholder text about Latency Requirements:',
    );
    const info = await r.repo.show(change.sha);
    expect(info.subject).toBe('Add Latency Requirements section');
    expect(info.trailers).toMatchObject({ actor: 'agent:orchestrator', triggerMessageIds: [m.id] });
    expect(await r.repo.readFile('PRD.md')).toBe('# PRD\n\nGoals.\n');
  });

  it.each([
    ['add a section on deployment', 'Deployment'],
    ['Please add a section about error handling.', 'Error Handling'],
    ['add a section on latency, please', 'Latency'],
    ['we need to ADD A SECTION ON caching strategy!', 'Caching Strategy'],
    ['add section on goals', 'Goals'], // the "a" is optional
    ['we should not add sections on anything', null], // "sections on", not the phrase
    ['add a section on observability to the Architecture doc', 'Observability'],
  ])('%s', async (text, title) => {
    const r = rig();
    r.say(ALICE, text);
    await r.runtime.flush();
    if (title === null) {
      expect(r.stub.changes).toHaveLength(0);
      return;
    }
    expect(r.stub.changes).toHaveLength(1);
    expect(await r.repo.readFile('Architecture.md')).toContain(`## ${title}\n`);
  });

  it('picks the document the message names, else the first active one', async () => {
    const r = rig();
    r.say(ALICE, 'add a section on goals to PRD');
    await r.runtime.flush();
    expect(r.stub.changes[0]!.documentId).toBe('doc_2');
    expect(await r.repo.readFile('PRD.md')).toContain('## Goals');
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC);
  });

  it('says so instead of duplicating a section that exists', async () => {
    const r = rig();
    r.say(ALICE, 'add a section on latency');
    await r.runtime.flush();
    r.say(BOB, 'add a section on Latency');
    await r.runtime.flush();
    expect(r.stub.changes).toHaveLength(1);
    expect(r.agentChat()).toEqual(['Architecture already has a "Latency" section.']);
  });

  it('asks for a document when there is none, and ignores archived ones', async () => {
    const r = rig({ docs: [] });
    r.say(ALICE, 'add a section on latency');
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['There is no active document yet. Create one and ask again.']);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('reports a document it cannot read', async () => {
    const r = rig({ files: {}, docs: [{ path: 'Architecture.md', title: 'Architecture' }] });
    r.say(ALICE, 'add a section on latency');
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['I could not read Architecture.md.']);
  });

  it('handles several requests in one debounce batch in order', async () => {
    const r = rig();
    r.say(ALICE, 'add a section on first topic');
    r.say(BOB, 'add a section on second topic');
    await r.runtime.flush();
    expect(r.stub.changes.map((c) => c.summary)).toEqual([
      'Added a "First Topic" section to Architecture',
      'Added a "Second Topic" section to Architecture',
    ]);
    const content = (await r.repo.readFile('Architecture.md'))!;
    expect(content.indexOf('First Topic')).toBeLessThan(content.indexOf('Second Topic'));
  });

  it('shows thinking while it works and idle after', async () => {
    const r = rig();
    r.say(ALICE, 'add a section on latency');
    await r.runtime.flush();
    expect(r.statuses()).toEqual(['thinking', 'idle']);
  });

  it('does not react to its own or to system messages, or to chit-chat', async () => {
    const r = rig();
    const agent = {
      ...r.stub.human(ALICE.id, ALICE.name, 'add a section on latency'),
      author: { kind: 'agent', role: 'orchestrator' },
    } as Message;
    r.runtime.onChatMessage(r.stub.roomId, agent);
    r.say(ALICE, 'sounds good, thanks everyone');
    await r.runtime.flush();
    expect(r.stub.changes).toHaveLength(0);
    expect(r.agentChat()).toEqual([]);
    expect(r.stub.statuses).toEqual([]);
  });
});

describe('direct request: "rewrite the whole document" opens a Review proposal', () => {
  it.each([
    'Please rewrite the whole document from scratch',
    'rewrite the entire document please',
    'REWRITE THE WHOLE DOCUMENT',
  ])('%s', async (text) => {
    const r = rig();
    const m = r.say(CAROL, text);
    await r.runtime.flush();

    expect(r.stub.proposals).toHaveLength(1);
    const p = r.stub.proposals[0]!;
    expect(p).toMatchObject({
      kind: 'review',
      state: 'open',
      title: 'Rewrite Architecture',
      documentId: 'doc_1',
      triggerMessageIds: [m.id],
      stale: false,
    });
    expect(p.options).toHaveLength(1);
    expect(p.options[0]).toMatchObject({ label: 'A', branch: 'architecture/rewrite/a' });
    expect(p.options[0]!.summary).toMatch(/Rewrites Architecture from the top/);
    // main is untouched; the branch carries the rewrite of exactly one document
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC);
    expect(await r.repo.changedFiles(p.branchBase, 'architecture/rewrite/a')).toEqual([
      'Architecture.md',
    ]);
    const rewritten = (await r.repo.readFile('Architecture.md', 'architecture/rewrite/a'))!;
    expect(rewritten.startsWith('# Architecture\n')).toBe(true);
    expect(rewritten).toContain('rewritten end to end');
    expect(
      (await r.repo.log('Architecture.md', 'architecture/rewrite/a'))[0]!.trailers,
    ).toMatchObject({ actor: 'agent:worker', triggerMessageIds: [m.id] });
    expect(r.stub.changes).toHaveLength(0);
  });

  it('uses a fresh branch name for a second rewrite', async () => {
    const r = rig();
    r.say(CAROL, 'rewrite the whole document');
    await r.runtime.flush();
    r.say(CAROL, 'rewrite the whole document again');
    await r.runtime.flush();
    expect(r.stub.proposals.map((p) => p.options[0]!.branch)).toEqual([
      'architecture/rewrite/a',
      'architecture/rewrite-2/a',
    ]);
  });

  it('keeps the document title line of the original', async () => {
    const r = rig({
      files: { 'PRD.md': '# Product Requirements\n\nGoals.\n' },
      docs: [{ path: 'PRD.md', title: 'PRD' }],
    });
    r.say(CAROL, 'rewrite the whole document');
    await r.runtime.flush();
    expect(
      (await r.repo.readFile('PRD.md', 'prd/rewrite/a'))!.startsWith('# Product Requirements\n'),
    ).toBe(true);
  });
});

describe('divergence: two people disagree -> exploration card -> Quorum proposal with 3 options', () => {
  it('explores "let\'s use X" against "Y makes more sense" and opens a three-option Quorum proposal', async () => {
    const r = rig();
    const a = r.say(ALICE, "Let's use PostgreSQL for the storage layer");
    const b = r.say(BOB, 'ClickHouse makes more sense for this write volume');
    await r.runtime.flush();

    const announce = r.stub.messages.find((m) => m.card?.type === 'exploration_started')!;
    expect(announce.body).toBe('Exploring PostgreSQL vs ClickHouse for Architecture');
    expect(announce.card).toEqual({
      type: 'exploration_started',
      documentId: 'doc_1',
      title: 'Exploring PostgreSQL vs ClickHouse for Architecture',
      theses: ['PostgreSQL', 'ClickHouse', 'PostgreSQL with ClickHouse fallback'],
    });
    expect(announce.inReplyTo).toEqual([a.id, b.id]);

    expect(r.stub.proposals).toHaveLength(1);
    const p = r.stub.proposals[0]!;
    expect(p).toMatchObject({
      kind: 'quorum',
      state: 'open',
      title: 'PostgreSQL vs ClickHouse for Architecture',
      documentId: 'doc_1',
      triggerMessageIds: [a.id, b.id],
      stale: false,
    });
    expect(p.options.map((o) => [o.label, o.branch, o.summary])).toEqual([
      ['A', 'architecture/postgresql-vs-clickhouse/a', 'Commit to PostgreSQL everywhere.'],
      ['B', 'architecture/postgresql-vs-clickhouse/b', 'Commit to ClickHouse everywhere.'],
      [
        'C',
        'architecture/postgresql-vs-clickhouse/c',
        'Start with PostgreSQL, keep ClickHouse as a fallback.',
      ],
    ]);
    expect(p.options.every((o) => o.tradeoffs.length > 0)).toBe(true);
    // the card comes before the proposal; the branches differ from main in this one document only
    expect(r.stub.messages.indexOf(announce)).toBeLessThan(r.stub.messages.length);
    for (const o of p.options)
      expect(await r.repo.changedFiles(p.branchBase, o.branch)).toEqual(['Architecture.md']);
    expect(
      await r.repo.readFile('Architecture.md', 'architecture/postgresql-vs-clickhouse/a'),
    ).toContain('## Decision: PostgreSQL\n');
    expect(
      await r.repo.readFile('Architecture.md', 'architecture/postgresql-vs-clickhouse/b'),
    ).toContain('## Decision: ClickHouse\n');
    expect(
      await r.repo.readFile('Architecture.md', 'architecture/postgresql-vs-clickhouse/c'),
    ).toContain('## Decision: PostgreSQL with ClickHouse fallback\n');
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC);
    expect(p.branchBase).toBe(await r.repo.headSha('main'));
    expect(
      (await r.repo.show((await r.repo.headSha('architecture/postgresql-vs-clickhouse/a'))!))
        .trailers,
    ).toMatchObject({ actor: 'agent:worker', triggerMessageIds: [a.id, b.id] });
  });

  it('is "thinking" for the whole exploration, then idle', async () => {
    const r = rig({ exploreMs: 300 });
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await vi.waitFor(
      () => expect(r.stub.messages.some((m) => m.card?.type === 'exploration_started')).toBe(true),
      { interval: 5 },
    );
    expect(r.stub.proposals).toHaveLength(0);
    expect(r.statuses().at(-1)).toBe('thinking');
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(1);
    expect(r.statuses().at(-1)).toBe('idle');
    expect(r.statuses().filter((s) => s === 'idle')).toHaveLength(1);
  });

  it('keeps chat, asks and suggestions flowing while an exploration runs', async () => {
    const r = rig({ exploreMs: 400 });
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await vi.waitFor(
      () => expect(r.stub.messages.some((m) => m.card?.type === 'exploration_started')).toBe(true),
      { interval: 5 },
    );
    r.say(CAROL, 'add a section on caching');
    await vi.waitFor(() => expect(r.stub.changes).toHaveLength(1), { interval: 5 }); // handled before the exploration finished
    expect(r.stub.proposals).toHaveLength(0);
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(1);
  });

  it('finds the pair in either order, and in the "use / use" form', async () => {
    const reversed = rig();
    reversed.say(BOB, 'honestly ClickHouse makes more sense');
    reversed.say(ALICE, "let's use PostgreSQL");
    await reversed.runtime.flush();
    expect(reversed.stub.proposals[0]!.title).toBe('PostgreSQL vs ClickHouse for Architecture'); // X is the "use" side, Y the "makes more sense" side

    const useUse = rig();
    useUse.say(ALICE, "let's use PostgreSQL");
    useUse.say(BOB, 'we should use ClickHouse instead');
    await useUse.runtime.flush();
    expect(useUse.stub.proposals[0]!.title).toBe('PostgreSQL vs ClickHouse for Architecture');
  });

  it('needs two different people', async () => {
    const r = rig();
    r.say(ALICE, "let's use PostgreSQL");
    r.say(ALICE, 'MySQL makes more sense');
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(0);
    expect(r.stub.messages.some((m) => m.card?.type === 'exploration_started')).toBe(false);
  });

  it('only looks at the most recent messages', async () => {
    const r = rig();
    r.say(ALICE, "let's use PostgreSQL");
    for (let i = 0; i < 6; i++) r.say(i % 2 ? BOB : CAROL, `unrelated chatter ${i}`);
    r.say(BOB, 'ClickHouse makes more sense');
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(0);
  });

  it('does not explore the same pair twice', async () => {
    const r = rig();
    r.say(ALICE, "let's use PostgreSQL");
    r.say(BOB, 'ClickHouse makes more sense');
    await r.runtime.flush();
    r.say(CAROL, "let's use PostgreSQL");
    r.say(BOB, 'ClickHouse makes more sense');
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(1);
  });

  it('uses fresh branch names when the topic comes back', async () => {
    const r = rig();
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await r.runtime.flush();
    r.say(CAROL, "let's use Memcached");
    r.say(ALICE, 'Redis makes more sense'); // the same pair, but already explored: nothing
    await r.runtime.flush();
    r.say(CAROL, "let's use Redis");
    r.say(BOB, 'Valkey makes more sense'); // a new pair
    await r.runtime.flush();
    expect(r.stub.proposals.map((p) => p.title)).toEqual([
      'Redis vs Memcached for Architecture',
      'Redis vs Valkey for Architecture',
    ]);
  });

  it('names the document the discussion mentions', async () => {
    const r = rig();
    r.say(ALICE, "let's use OAuth for the PRD");
    r.say(BOB, 'API keys make more sense'); // not matched: "make more sense"
    r.say(BOB, 'API keys makes more sense for the PRD');
    await r.runtime.flush();
    expect(r.stub.proposals[0]!.documentId).toBe('doc_2');
    expect(r.stub.proposals[0]!.title).toBe('OAuth vs API keys for PRD');
  });

  it('opens the proposal as stale when the room says "never mind" while it explores', async () => {
    const r = rig({ exploreMs: 300 });
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await vi.waitFor(
      () => expect(r.stub.messages.some((m) => m.card?.type === 'exploration_started')).toBe(true),
      { interval: 5 },
    );
    r.say(CAROL, 'never mind, we can skip the cache entirely');
    await r.runtime.flush();
    expect(r.stub.proposals).toHaveLength(1);
    expect(r.stub.proposals[0]!.stale).toBe(true);
    // a later exploration is not affected
    r.say(ALICE, "let's use Postgres");
    r.say(BOB, 'MySQL makes more sense');
    await r.runtime.flush();
    expect(r.stub.proposals[1]!.stale).toBe(false);
  });

  it('says so when there is no document to explore against', async () => {
    const r = rig({ docs: [] });
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['There is no active document to explore against.']);
    expect(r.stub.proposals).toHaveLength(0);
  });

  it('reports a failed exploration in chat and goes back to idle', async () => {
    const r = rig();
    r.stub.actions.openProposal = async () => {
      throw new Error('scope check failed');
    };
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await r.runtime.flush();
    expect(r.agentChat()).toEqual([
      'The exploration of Redis vs Memcached failed: scope check failed',
    ]);
    expect(r.statuses().at(-1)).toBe('idle');
  });
});

describe('questions: why / what / how / explain', () => {
  it.each([
    'Why does the storage layer use PostgreSQL?',
    'what is the latency target',
    'How do deployments work',
    'Explain the storage choice',
    'explain: the storage choice',
    'Can someone explain the storage choice?',
    'is anyone clear on why we picked this?',
  ])('answers: %s', async (text) => {
    const r = rig();
    const m = r.say(BOB, text);
    await r.runtime.flush();
    expect(r.agentChat()).toEqual([
      'Short answer: the documents answer that on a first read; ask me about a specific passage if you want the history behind it.',
    ]);
    expect(r.stub.messages.at(-1)!.inReplyTo).toEqual([m.id]);
  });

  it.each([
    "that's what I said",
    'I wonder how it works',
    'somehow this works',
    'whatever',
    'thanks, that helps',
    'the whyte paper',
  ])('stays quiet: %s', async (text) => {
    const r = rig();
    r.say(BOB, text);
    await r.runtime.flush();
    expect(r.agentChat()).toEqual([]);
  });

  it('exports the matcher', () => {
    expect(isQuestion('Why?')).toBe(true);
    expect(isQuestion('add a section on how things work')).toBe(false);
  });
});

describe('closing a proposal by asking', () => {
  it.each([
    'drop the proposal',
    'Abandon that proposal',
    'close the latest proposal',
    'close last proposal',
  ])('%s', async (text) => {
    const r = rig();
    r.stub.proposals.push(
      makeProposal({ id: 'prop_old', state: 'merged' }),
      makeProposal({ id: 'prop_a' }),
      makeProposal({ id: 'prop_b' }),
    );
    r.say(ALICE, text);
    await r.runtime.flush();
    expect(r.stub.proposals.find((p) => p.id === 'prop_b')!.state).toBe('abandoned'); // the latest open one
    expect(r.stub.proposals.find((p) => p.id === 'prop_a')!.state).toBe('open');
    expect(r.stub.proposals.find((p) => p.id === 'prop_old')!.state).toBe('merged');
  });

  it('says so when nothing is open', async () => {
    const r = rig();
    r.say(ALICE, 'drop the proposal');
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['There is no open proposal to close.']);
  });
});

describe('suggestions: applied, or declined when stale', () => {
  it('applies the replacement as given, authored as the participant, and resolves the card', async () => {
    const r = rig();
    const m = suggestion(r, ALICE, anchorFor(DOC, 5), 'Second paragraph, improved.');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await r.runtime.flush();

    expect(r.stub.changes).toHaveLength(1);
    const change = r.stub.changes[0]!;
    expect(change).toMatchObject({
      actor: { kind: 'user', userId: 'user_alice', displayName: 'Alice' },
      summary: 'Updated a paragraph in Architecture from Alice suggestion',
      triggerMessageIds: [m.id],
    });
    expect(await r.repo.readFile('Architecture.md')).toBe(
      DOC.replace('Second paragraph.', 'Second paragraph, improved.'),
    );
    expect((await r.repo.show(change.sha)).trailers).toMatchObject({
      actor: 'user:user_alice',
      triggerMessageIds: [m.id],
    });
    expect(cardOf(m)).toMatchObject({ status: 'applied', resolutionSha: change.sha, note: null });
    expect(r.agentChat()).toEqual([]);
  });

  it('deletes the paragraph and its blank separator for an empty replacement', async () => {
    const r = rig();
    const m = suggestion(r, BOB, anchorFor(DOC, 5), '');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await r.runtime.flush();
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC.replace('Second paragraph.\n\n', ''));
    expect(r.stub.changes[0]!.summary).toBe(
      'Deleted a paragraph in Architecture from Bob suggestion',
    );
    expect((await r.repo.show(r.stub.changes[0]!.sha)).subject).toBe(
      'Delete paragraph in Architecture (suggestion)',
    );
    expect(cardOf(m).status).toBe('applied');
  });

  it('can replace one paragraph by several', async () => {
    const r = rig();
    const m = suggestion(r, ALICE, anchorFor(DOC, 5), 'Part one.\n\nPart two.\n');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await r.runtime.flush();
    expect(await r.repo.readFile('Architecture.md')).toContain(
      'Part one.\n\nPart two.\n\nThird paragraph.',
    );
    expect(cardOf(m).status).toBe('applied');
  });

  it('declines when the paragraph changed since the suggestion was made, and says why', async () => {
    const r = rig();
    const m = suggestion(r, ALICE, anchorFor(DOC, 5), 'My edit.');
    // the paragraph is edited on main before the suggestion is handled
    await r.repo.commitToMain(
      {
        'Architecture.md': DOC.replace(
          'Second paragraph.',
          'Second paragraph, edited by someone else.',
        ),
      },
      'Edit',
      { actor: { kind: 'agent', role: 'orchestrator' }, triggerMessageIds: [] },
    );
    const head = await r.repo.headSha('main');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await r.runtime.flush();

    expect(await r.repo.headSha('main')).toBe(head); // nothing applied
    expect(r.stub.changes).toHaveLength(0);
    expect(cardOf(m)).toMatchObject({
      status: 'declined',
      note: 'The paragraph changed since this suggestion was made',
    });
    expect(r.agentChat()).toEqual([
      'That paragraph changed since the suggestion was made, so I did not apply it. Please suggest again on the current text.',
    ]);
    expect(r.stub.messages.at(-1)).toMatchObject({ anchor: m.anchor, inReplyTo: [m.id] });
  });

  it('declines an anchor that is out of range or inconsistent', async () => {
    const r = rig();
    const outOfRange = suggestion(
      r,
      ALICE,
      { ...anchorFor(DOC, 5), startLine: 50, endLine: 50 },
      'x',
    );
    const backwards = suggestion(r, ALICE, { ...anchorFor(DOC, 5), startLine: 5, endLine: 4 }, 'x');
    r.runtime.onSuggestion(r.stub.roomId, outOfRange);
    r.runtime.onSuggestion(r.stub.roomId, backwards);
    await r.runtime.flush();
    expect([cardOf(outOfRange).status, cardOf(backwards).status]).toEqual(['declined', 'declined']);
    expect(r.stub.changes).toHaveLength(0);
  });

  it('declines when the document or its file is gone', async () => {
    const r = rig({ files: { 'Other.md': '# Other\n' } });
    const noDoc = suggestion(r, ALICE, { ...anchorFor(DOC, 5), documentId: 'doc_missing' }, 'x');
    r.runtime.onSuggestion(r.stub.roomId, noDoc);
    const noFile = suggestion(r, ALICE, anchorFor(DOC, 5), 'x'); // doc_1 exists in the room, but Architecture.md is not in the repo
    r.runtime.onSuggestion(r.stub.roomId, noFile);
    await r.runtime.flush();
    expect(cardOf(noDoc)).toMatchObject({ status: 'declined', note: 'Document not found' });
    expect(cardOf(noFile)).toMatchObject({ status: 'declined', note: 'Document not found' });
    expect(r.agentChat()).toEqual([
      'I could not find the document this suggestion refers to.',
      'I could not read Architecture.md.',
    ]);
  });

  it('turns a suggestion that rewrites more than the limit into a Review proposal (size rule)', async () => {
    const r = rig();
    const big = anchorFor(DOC, 3, 9); // four paragraphs
    const m = suggestion(r, CAROL, big, 'Condensed.');
    r.runtime.onSuggestion(r.stub.roomId, m);
    await r.runtime.flush();

    expect(r.stub.changes).toHaveLength(0);
    expect(r.stub.proposals).toHaveLength(1);
    const p = r.stub.proposals[0]!;
    expect(p).toMatchObject({
      kind: 'review',
      title: 'Suggestion on Architecture',
      triggerMessageIds: [m.id],
    });
    expect(p.options[0]!.summary).toBe(
      'Rewrites 4 paragraphs of Architecture as suggested by Carol.',
    );
    expect(await r.repo.readFile('Architecture.md')).toBe(DOC);
    expect(await r.repo.readFile('Architecture.md', p.options[0]!.branch)).toBe(
      '# Architecture\n\nCondensed.\n\nFifth paragraph.\n',
    );
    expect((await r.repo.log('Architecture.md', p.options[0]!.branch))[0]!.trailers.actor).toBe(
      'user:user_carol',
    );
    expect(cardOf(m)).toMatchObject({
      status: 'superseded',
      note: 'Too large to apply directly; opened a review proposal',
    });
  });

  it('allows exactly the limit directly, and honors a tunable limit', async () => {
    const three = rig();
    const m3 = suggestion(three, ALICE, anchorFor(DOC, 3, 7), 'Three become one.'); // 3 paragraphs
    three.runtime.onSuggestion(three.stub.roomId, m3);
    await three.runtime.flush();
    expect(cardOf(m3).status).toBe('applied');
    expect(three.stub.proposals).toHaveLength(0);

    const strict = rig({ tunables: { immediateRewriteLimit: 1 } });
    const m2 = suggestion(strict, ALICE, anchorFor(DOC, 3, 5), 'Two become one.');
    strict.runtime.onSuggestion(strict.stub.roomId, m2);
    await strict.runtime.flush();
    expect(cardOf(m2).status).toBe('superseded');
    expect(strict.stub.proposals).toHaveLength(1);
  });

  it('ignores a suggestion message without a suggestion card', async () => {
    const r = rig();
    r.runtime.onSuggestion(r.stub.roomId, r.stub.human(ALICE.id, ALICE.name, 'plain'));
    await r.runtime.flush();
    expect(r.logs.some((l) => l.startsWith('warn:onSuggestion without a suggestion card'))).toBe(
      true,
    );
    expect(r.stub.changes).toHaveLength(0);
  });
});

describe('ask: answered from the passage history', () => {
  async function history(r: Rig) {
    const trigger = r.say(ALICE, 'add a section on latency requirements');
    await r.runtime.flush();
    const sha = r.stub.changes[0]!.sha;
    const content = (await r.repo.readFile('Architecture.md'))!;
    const line =
      content.split('\n').findIndex((l) => l.startsWith('Placeholder text about Latency')) + 1;
    return { trigger, sha, content, line };
  }

  it('quotes the commits and the chat messages that produced the passage', async () => {
    const r = rig();
    const { trigger, sha, content, line } = await history(r);
    const anchor = { ...anchorFor(content, line), documentId: 'doc_1' };
    const ask = r.stub.human(BOB.id, BOB.name, 'Why does this say that?', {
      kind: 'card',
      anchor,
      card: { type: 'ask', anchor, question: 'Why does this say that?' },
    });
    r.runtime.onAsk(r.stub.roomId, ask);
    await r.runtime.flush();

    const answer = r.stub.messages.at(-1)!;
    expect(answer.anchor).toEqual(anchor);
    expect(answer.inReplyTo).toEqual([ask.id]);
    expect(answer.body).toContain(`Here is the history of line ${line} of Architecture:`);
    expect(answer.body).toContain(
      `- \`${sha.slice(0, 7)}\` Add Latency Requirements section (agent:orchestrator)`,
    );
    expect(answer.body).toContain(`> Alice: ${trigger.body}`); // the discussion that produced it
    expect(answer.body).toContain(`Last changed in \`${sha.slice(0, 7)}\`.`);
    expect(answer.body).toMatch(/commit|history/i);
  });

  it('describes a range of lines and a passage with no history', async () => {
    const r = rig();
    const anchor = anchorFor(DOC, 3, 5);
    const ask = r.stub.human(BOB.id, BOB.name, 'what is this?', {
      kind: 'card',
      anchor,
      card: { type: 'ask', anchor, question: 'what is this?' },
    });
    r.runtime.onAsk(r.stub.roomId, ask);
    await r.runtime.flush();
    expect(r.stub.messages.at(-1)!.body).toMatch(
      /^Here is the history of lines 3-5 of Architecture:/,
    );
  });

  it('still answers when git cannot trace the passage', async () => {
    const r = rig();
    r.repo.logLines = async () => {
      throw new Error('fatal: file has only 3 lines');
    };
    const anchor = anchorFor(DOC, 5);
    const ask = r.stub.human(BOB.id, BOB.name, 'why?', {
      kind: 'card',
      anchor,
      card: { type: 'ask', anchor, question: 'why?' },
    });
    r.runtime.onAsk(r.stub.roomId, ask);
    await r.runtime.flush();
    expect(r.stub.messages.at(-1)!.body).toBe(
      'I could not trace the history of line 5 of Architecture: the passage may have moved since you selected it.',
    );
    expect(r.stub.messages.at(-1)!.anchor).toEqual(anchor);
  });

  it('reports a missing document, and ignores an ask without an anchor', async () => {
    const r = rig();
    const anchor = { ...anchorFor(DOC, 5), documentId: 'doc_missing' };
    r.runtime.onAsk(
      r.stub.roomId,
      r.stub.human(BOB.id, BOB.name, 'why?', {
        kind: 'card',
        anchor,
        card: { type: 'ask', anchor, question: 'why?' },
      }),
    );
    r.runtime.onAsk(r.stub.roomId, r.stub.human(BOB.id, BOB.name, 'no anchor'));
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['I could not find the document that question refers to.']);
    expect(r.logs.some((l) => l.startsWith('warn:onAsk without an anchor'))).toBe(true);
  });
});

describe('proposal lifecycle messages', () => {
  const event = (
    type: 'merged' | 'rejected' | 'expired' | 'superseded' | 'abandoned' | 'merge_failed',
    p: Proposal,
  ) =>
    ({
      merged: {
        type: 'merged',
        proposal: p,
        optionId: 'opt_b',
        sha: 'abcdef1234567890'.padEnd(40, '0'),
        reconciled: false,
      },
      rejected: { type: 'rejected', proposal: p, byUserId: 'user_bob' },
      expired: { type: 'expired', proposal: p },
      superseded: { type: 'superseded', proposal: p },
      abandoned: { type: 'abandoned', proposal: p },
      merge_failed: { type: 'merge_failed', proposal: p, reason: 'boom' },
    })[type] as Parameters<FakeRuntime['onProposalEvent']>[1];

  it('announces a merge with the option label and short sha, noting a reconciliation', async () => {
    const r = rig();
    const p = makeProposal();
    r.runtime.onProposalEvent(r.stub.roomId, event('merged', p));
    r.runtime.onProposalEvent(r.stub.roomId, { ...event('merged', p), reconciled: true } as never);
    await r.runtime.flush();
    expect(r.agentChat()).toEqual([
      'Merged "PostgreSQL vs ClickHouse" (option B) as abcdef1.',
      'Merged "PostgreSQL vs ClickHouse" (option B) as abcdef1 after reconciling it with newer edits.',
    ]);
  });

  it('asks what should change after a rejection', async () => {
    const r = rig();
    r.runtime.onProposalEvent(
      r.stub.roomId,
      event('rejected', makeProposal({ title: 'Rewrite Architecture' })),
    );
    await r.runtime.flush();
    expect(r.agentChat()).toEqual(['"Rewrite Architecture" was rejected. What should change?']);
  });

  it.each(['expired', 'superseded', 'abandoned', 'merge_failed'] as const)(
    'says nothing for %s (the room already posted a system message)',
    async (type) => {
      const r = rig();
      r.runtime.onProposalEvent(r.stub.roomId, event(type, makeProposal()));
      await r.runtime.flush();
      expect(r.agentChat()).toEqual([]);
    },
  );

  it('never throws into the room server, even for a malformed event', () => {
    const r = rig();
    expect(() =>
      r.runtime.onProposalEvent(r.stub.roomId, { type: 'merged' } as never),
    ).not.toThrow();
    expect(() => r.runtime.onReverted(r.stub.roomId, undefined as never, 'x', 'y')).not.toThrow();
    expect(r.logs.some((l) => l.startsWith('error:fake runtime onProposalEvent failed'))).toBe(
      true,
    );
  });

  it('only logs a revert', async () => {
    const r = rig();
    expect(() =>
      r.runtime.onReverted(r.stub.roomId, makeChange(), 'e'.repeat(40), 'user_bob'),
    ).not.toThrow();
    await r.runtime.flush();
    expect(r.stub.messages).toHaveLength(0);
  });
});

describe('merge driver', () => {
  const MARKERS =
    '# Architecture\n\nShared.\n\n<<<<<<< HEAD\nMain side.\n=======\nProposal side.\n>>>>>>> architecture/storage/a\n\nTail.\n';

  function worktreeWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-fake-merge-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }
  const input = (worktreePath: string, conflictedFiles: string[]) => ({
    proposal: makeProposal(),
    optionId: 'opt_a',
    worktreePath,
    conflictedFiles,
    documentPath: 'Architecture.md',
  });

  it("strips conflict markers keeping the proposal's side", async () => {
    const r = rig();
    const dir = worktreeWith({ 'Architecture.md': MARKERS });
    const out = await r.runtime.runMergeDriver(r.stub.roomId, input(dir, ['Architecture.md']));
    expect(out).toEqual({
      reconciled: true,
      summary: "Resolved 1 conflicted file by keeping the proposal's side of each conflict.",
    });
    const text = readFileSync(join(dir, 'Architecture.md'), 'utf8');
    expect(text).toBe('# Architecture\n\nShared.\n\nProposal side.\n\nTail.\n');
    expect(text).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
  });

  it('handles diff3-style markers and several conflicts and files', async () => {
    const r = rig();
    const diff3 =
      '# A\n<<<<<<< HEAD\nours 1\n||||||| base\nbase 1\n=======\ntheirs 1\n>>>>>>> branch\nmiddle\n<<<<<<< HEAD\nours 2\n=======\ntheirs 2\n>>>>>>> branch\n';
    const dir = worktreeWith({ 'Architecture.md': diff3, 'PRD.md': MARKERS });
    const out = await r.runtime.runMergeDriver(
      r.stub.roomId,
      input(dir, ['Architecture.md', 'PRD.md']),
    );
    expect(out.summary).toBe(
      "Resolved 2 conflicted files by keeping the proposal's side of each conflict.",
    );
    expect(readFileSync(join(dir, 'Architecture.md'), 'utf8')).toBe(
      '# A\ntheirs 1\nmiddle\ntheirs 2\n',
    );
    expect(readFileSync(join(dir, 'PRD.md'), 'utf8')).toContain('Proposal side.');
  });

  it('leaves a clean merge alone', async () => {
    const r = rig();
    const dir = worktreeWith({ 'Architecture.md': DOC });
    expect(await r.runtime.runMergeDriver(r.stub.roomId, input(dir, []))).toEqual({
      reconciled: false,
      summary: 'Clean merge; nothing to reconcile.',
    });
    expect(readFileSync(join(dir, 'Architecture.md'), 'utf8')).toBe(DOC);
  });

  it('takeTheirs keeps everything outside conflicts, byte for byte', () => {
    expect(takeTheirs('a\nb\n')).toBe('a\nb\n');
    expect(takeTheirs('a\n<<<<<<< x\nb\n=======\nc\n>>>>>>> y\nd')).toBe('a\nc\nd');
    // a markdown setext underline of seven "=" outside a conflict is content, not a marker
    expect(takeTheirs('Title\n=======\ntext\n')).toBe('Title\n=======\ntext\n');
  });
});

describe('semantic revert', () => {
  const AGENT = { kind: 'agent', role: 'orchestrator' } as const;
  const BASE = '# Architecture\n\nIntro.\n\nOutro.\n';

  async function setup(extra: Record<string, string> = {}) {
    const r = rig({
      files: { 'Architecture.md': BASE, ...extra },
      docs: [{ path: 'Architecture.md', title: 'Architecture' }],
    });
    return r;
  }
  const commit = (r: Rig, text: string, subject: string, ids: string[] = []) =>
    r.repo.commitToMain({ 'Architecture.md': text }, subject, {
      actor: AGENT,
      triggerMessageIds: ids,
    });
  const changeFor = (sha: string, ids: string[] = []) =>
    makeChange({ sha, documentId: 'doc_1', triggerMessageIds: ids });

  it('removes what the change added and keeps later edits, committing as a revert by the participant', async () => {
    const r = await setup();
    const added = await commit(
      r,
      `${BASE}\n## Latency\n\np99 under 200 ms.\n`,
      'Add latency section',
      ['msg_9'],
    );
    await commit(
      r,
      `${BASE.replace('Intro.', 'Intro, edited.')}\n## Latency\n\np99 under 200 ms.\n`,
      'Edit intro',
    );
    const sha = await r.runtime.runSemanticRevert(r.stub.roomId, {
      change: changeFor(added, ['msg_9']),
      byUserId: BOB.id,
    });
    expect(await r.repo.readFile('Architecture.md')).toBe(
      '# Architecture\n\nIntro, edited.\n\nOutro.\n',
    );
    expect(await r.repo.headSha('main')).toBe(sha);
    const info = await r.repo.show(sha);
    expect(info.subject).toBe(`Revert ${added.slice(0, 7)}: Add latency section`);
    expect(info.trailers).toMatchObject({
      actor: 'user:user_bob',
      revertsSha: added,
      triggerMessageIds: ['msg_9'],
    });
  });

  it('restores a paragraph the change replaced, even when a neighbor was edited afterwards', async () => {
    const r = await setup();
    const replaced = await commit(
      r,
      BASE.replace('Intro.', 'Intro, rewritten by a suggestion.'),
      'Update paragraph',
    );
    await commit(
      r,
      `${BASE.replace('Intro.', 'Intro, rewritten by a suggestion.')}\nA new closing remark.\n`,
      'Add closing remark',
    );
    await r.runtime.runSemanticRevert(r.stub.roomId, {
      change: changeFor(replaced),
      byUserId: ALICE.id,
    });
    expect(await r.repo.readFile('Architecture.md')).toBe(`${BASE}\nA new closing remark.\n`);
  });

  it('refuses to undo half a change when later edits rewrote what it added', async () => {
    const r = await setup();
    const added = await commit(
      r,
      `${BASE}\n## Latency\n\np99 under 200 ms.\n`,
      'Add latency section',
    );
    await commit(
      r,
      `${BASE}\n## Latency\n\np99 under 150 ms, measured at the edge.\n`,
      'Tighten latency',
    );
    const head = await r.repo.headSha('main');
    await expect(
      r.runtime.runSemanticRevert(r.stub.roomId, { change: changeFor(added), byUserId: BOB.id }),
    ).rejects.toThrow(/cannot be undone automatically/);
    expect(await r.repo.headSha('main')).toBe(head);
  });

  it('reverseChange is a pure function of before, after and current', () => {
    expect(reverseChange('a\n\nb\n', 'a\n\nb\n\nc\n', 'a\n\nb\n\nc\n')).toBe('a\n\nb\n');
    expect(() => reverseChange('a\n', 'a\n', 'a\n')).toThrow(/cannot be undone automatically/);
  });
});

describe('digest', () => {
  it('lists the events and the recent chat of the absence', async () => {
    const r = rig();
    const before = r.stub.human(ALICE.id, ALICE.name, 'seen already');
    r.stub.human(
      ALICE.id,
      ALICE.name,
      'We decided to use PostgreSQL for the storage layer, with a ClickHouse fallback behind a narrow interface, as written down in the architecture document today',
    );
    r.stub.human(BOB.id, BOB.name, 'looks good');
    r.stub.human(BOB.id, BOB.name, 'card message', { kind: 'card' }); // cards are not part of "In chat"
    const text = await r.runtime.writeDigest(r.stub.roomId, {
      userId: 'user_dave',
      sinceMessageId: before.id,
      events: [
        'Change on Architecture by Alice: Added latency',
        'Proposal opened: PostgreSQL vs ClickHouse',
      ],
    });
    expect(text.split('\n')).toEqual([
      'While you were away:',
      '- Change on Architecture by Alice: Added latency',
      '- Proposal opened: PostgreSQL vs ClickHouse',
      '',
      'In chat:',
      `- Alice: ${'We decided to use PostgreSQL for the storage layer, with a ClickHouse fallback behind a narrow interf'.slice(0, 99)}…`,
      '- Bob: looks good',
    ]);
  });

  it('copes with no events and no chat', async () => {
    const r = rig();
    expect(
      await r.runtime.writeDigest(r.stub.roomId, { userId: 'u', sinceMessageId: null, events: [] }),
    ).toBe('While you were away:\n- Nothing notable happened.');
  });

  it('keeps only the last 8 chat lines', async () => {
    const r = rig();
    for (let i = 0; i < 12; i++) r.stub.human(ALICE.id, ALICE.name, `line ${i}`);
    const text = await r.runtime.writeDigest(r.stub.roomId, {
      userId: 'u',
      sinceMessageId: null,
      events: ['x'],
    });
    const chat = text.split('\n').filter((l) => l.startsWith('- Alice'));
    expect(chat).toHaveLength(8);
    expect(chat[0]).toBe('- Alice: line 4');
    expect(chat.at(-1)).toBe('- Alice: line 11');
  });
});

describe('timing, lifecycle and robustness', () => {
  it('debounces chat: the batch is handled once the room has been quiet for the debounce', async () => {
    vi.useFakeTimers();
    const r = rig({ tunables: { listenerDebounceMs: 1000, listenerMaxWaitMs: 20_000 } });
    r.say(ALICE, 'add a section on first');
    await vi.advanceTimersByTimeAsync(900);
    r.say(ALICE, 'add a section on second'); // restarts the debounce
    await vi.advanceTimersByTimeAsync(900);
    expect(r.stub.changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.stub.changes).toHaveLength(2);
  });

  it('handles the batch after the max wait when chat never pauses', async () => {
    vi.useFakeTimers();
    const r = rig({ tunables: { listenerDebounceMs: 1000, listenerMaxWaitMs: 3000 } });
    for (let i = 0; i < 6; i++) {
      r.say(ALICE, i === 0 ? 'add a section on early topic' : `chatter ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    // 3 s after the first message the batch is handled although the debounce kept being restarted
    expect(r.stub.changes).toHaveLength(1);
  });

  it('stopRoom cancels a pending batch and a running exploration', async () => {
    const r = rig({ exploreMs: 300 });
    r.say(ALICE, "let's use Redis");
    r.say(BOB, 'Memcached makes more sense');
    await vi.waitFor(
      () => expect(r.stub.messages.some((m) => m.card?.type === 'exploration_started')).toBe(true),
      { interval: 5 },
    );
    r.say(ALICE, 'add a section on never handled'); // still in the debounce
    await r.runtime.stopRoom(r.stub.roomId);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(r.stub.proposals).toHaveLength(0);
    expect(r.stub.changes).toHaveLength(0);
    expect(r.statuses().at(-1)).toBe('idle');
  });

  it('stopAll stops every room and a stopped room can be used again', async () => {
    const r = rig();
    await r.runtime.startRoom(r.stub.roomId);
    await r.runtime.startRoom(r.stub.roomId); // idempotent
    await r.runtime.stopAll();
    r.say(ALICE, 'add a section on revived');
    await r.runtime.flush();
    expect(r.stub.changes).toHaveLength(1);
  });

  it('one failing message does not stop the next ones, and failures are logged, not thrown', async () => {
    const r = rig();
    const postChat = r.stub.actions.postChat;
    let failed = false;
    r.stub.actions.postChat = async (room, input) => {
      if (!failed) {
        failed = true;
        throw new Error('chat store down');
      }
      return postChat(room, input);
    };
    r.say(ALICE, 'Why is this so?'); // its answer fails
    r.say(BOB, 'add a section on latency'); // still handled
    await r.runtime.flush();
    expect(
      r.logs.some((l) => l.startsWith('error:fake runtime chat failed (chat store down)')),
    ).toBe(true);
    expect(r.stub.changes).toHaveLength(1);
  });

  it('survives setAgentStatus failing', async () => {
    const r = rig();
    r.stub.actions.setAgentStatus = async () => {
      throw new Error('socket closed');
    };
    r.say(ALICE, 'add a section on latency');
    await r.runtime.flush();
    expect(r.stub.changes).toHaveLength(1);
  });

  it('survives a malformed message', () => {
    const r = rig();
    expect(() => r.runtime.onChatMessage(r.stub.roomId, null as unknown as Message)).not.toThrow();
    expect(r.logs.some((l) => l.startsWith('error:fake runtime onChatMessage failed'))).toBe(true);
  });

  it('flush and idle on a runtime that never saw a room return at once', async () => {
    const r = rig();
    await r.runtime.flush();
    await r.runtime.idle();
  });
});

describe('helpers', () => {
  it('titleCase capitalizes every word', () => {
    expect(titleCase('latency requirements')).toBe('Latency Requirements');
    expect(titleCase('  api   design ')).toBe('Api Design');
    expect(titleCase('')).toBe('');
  });

  it('cleanUseTerm cuts the term at the first connector or punctuation', () => {
    expect(cleanUseTerm('PostgreSQL for the storage layer')).toBe('PostgreSQL');
    expect(cleanUseTerm('Redis, because it is fast')).toBe('Redis');
    expect(cleanUseTerm('API keys instead of OAuth')).toBe('API keys');
    expect(cleanUseTerm('Postgres')).toBe('Postgres');
  });

  it('cleanSenseTerm keeps the last few words without hedges', () => {
    expect(cleanSenseTerm('ClickHouse')).toBe('ClickHouse');
    expect(cleanSenseTerm('I think ClickHouse')).toBe('ClickHouse');
    expect(cleanSenseTerm('honestly the ClickHouse')).toBe('ClickHouse');
    expect(cleanSenseTerm('well, actually using Valkey')).toBe('Valkey');
    expect(cleanSenseTerm('one two three four five')).toBe('three four five');
  });

  it('pickDocument prefers the longest named document, else the first', () => {
    const docs = [
      { id: 'a', roomId: 'r', path: 'API.md', title: 'API', status: 'active', createdAt: '' },
      {
        id: 'b',
        roomId: 'r',
        path: 'API-Spec.md',
        title: 'API Spec',
        status: 'active',
        createdAt: '',
      },
    ] as const;
    expect(pickDocument([...docs], 'update the API Spec please')!.id).toBe('b');
    expect(pickDocument([...docs], 'update the api')!.id).toBe('a');
    expect(pickDocument([...docs], 'nothing named')!.id).toBe('a');
    expect(pickDocument([], 'x')).toBeNull();
  });
});

describe('createAgentRuntime("fake")', () => {
  it('ignores the Claude options and builds a FakeRuntime', async () => {
    const stub = createStubActions({
      repo: new MemoryRepo('room_test', { 'Architecture.md': '# Architecture\n' }),
      documents: [{ path: 'Architecture.md', title: 'Architecture' }],
    });
    const called: string[] = [];
    const runtime = createAgentRuntime('fake', stub.actions, {
      dataDir: '/tmp/x',
      tunables: tunables({ listenerDebounceMs: 5 }),
      claudeBinary: '/opt/claude',
      claudeEnv: () => {
        called.push('env');
        return {};
      },
      claudeAvailable: async () => {
        called.push('available');
        return false;
      },
      onCredentialsChanged: () => {
        called.push('subscribe');
      },
    });
    expect(runtime).toBeInstanceOf(FakeRuntime);
    await runtime.startRoom(stub.roomId);
    runtime.onChatMessage(stub.roomId, stub.human('user_a', 'A', 'add a section on latency'));
    await (runtime as FakeRuntime).flush();
    expect(stub.changes).toHaveLength(1); // works although "claudeAvailable" says false
    expect(called).toEqual([]);
    await runtime.stopAll();
  });

  it('reads QUORUM_FAKE_EXPLORE_MS for the exploration delay', async () => {
    const saved = process.env.QUORUM_FAKE_EXPLORE_MS;
    process.env.QUORUM_FAKE_EXPLORE_MS = '0';
    try {
      const stub = createStubActions({
        repo: new MemoryRepo('room_test', { 'Architecture.md': '# Architecture\n' }),
        documents: [{ path: 'Architecture.md', title: 'Architecture' }],
      });
      const runtime = createAgentRuntime('fake', stub.actions, {
        dataDir: '/tmp/x',
        tunables: tunables({ listenerDebounceMs: 5 }),
      }) as FakeRuntime;
      runtime.onChatMessage(stub.roomId, stub.human('user_a', 'A', "let's use Redis"));
      runtime.onChatMessage(stub.roomId, stub.human('user_b', 'B', 'Memcached makes more sense'));
      await runtime.flush();
      expect(stub.proposals).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.QUORUM_FAKE_EXPLORE_MS;
      else process.env.QUORUM_FAKE_EXPLORE_MS = saved;
    }
  });
});
