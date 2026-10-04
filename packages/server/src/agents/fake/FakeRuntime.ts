import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, textHash, proposalBranchName, type Anchor, type Card, type Change, type Document, type Message, type MessageId, type OptionId, type Proposal, type RoomId, type Sha, type UserId } from '@quorum/shared';
import type { AgentRuntime, AgentRuntimeOptions, RoomActions, RoomRepository } from '../../contracts/index.js';
import { ORCHESTRATOR_ACTOR, WORKER_ACTOR, activeDocs, authorName, errMessage, noopLogger, shortSha, sleep, type Logger } from '../common.js';

export interface FakeScript {
  delays?: {
    /** how long an exploration takes before its branches appear (default 500 ms) */
    exploreMs?: number;
  };
}

interface WindowEntry {
  id: MessageId;
  userId: UserId;
  displayName: string;
  body: string;
}

interface RoomCtx {
  pending: Message[];
  timer: NodeJS.Timeout | null;
  window: WindowEntry[];
  explored: Set<string>;
  chain: Promise<void>;
  busy: number;
  abort: AbortController;
}

const ADD_SECTION = /add (?:a )?section (?:on|about) (.+)/i;
const REWRITE_ALL = /rewrite the (?:whole|entire) document/i;
const USE_PATTERN = /(?:let'?s use|we should use|go with) (\w[\w\- ]*)/i;
const MORE_SENSE_PATTERN = /(\w[\w\- ]*) makes more sense/i;
const QUESTION = /^(?:why|what|how|explain)/i;
const CLOSE_PROPOSAL = /^(?:drop|abandon|close) (?:the |that )?(?:last |latest )?proposal/i;
const DEFAULT_DEBOUNCE_MS = 300;
const WINDOW_SIZE = 6;

/**
 * Deterministic, keyword-driven AgentRuntime with no network access. Used by e2e tests. See README.md in this
 * directory for the exact phrases it reacts to.
 */
export class FakeRuntime implements AgentRuntime {
  private readonly rooms = new Map<RoomId, RoomCtx>();
  private readonly log: Logger;
  private readonly debounceMs: number;
  private readonly exploreMs: number;

  constructor(
    private readonly actions: RoomActions,
    options: AgentRuntimeOptions,
    script: FakeScript = {},
  ) {
    this.log = options.logger ?? noopLogger;
    this.debounceMs = options.tunables?.listenerDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.exploreMs = script.delays?.exploreMs ?? 500;
  }

  // --- lifecycle --------------------------------------------------------------------------

  async startRoom(roomId: RoomId): Promise<void> {
    this.ctx(roomId);
  }

  async stopRoom(roomId: RoomId): Promise<void> {
    const c = this.rooms.get(roomId);
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.pending = [];
    c.abort.abort();
    await c.chain;
    this.rooms.delete(roomId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((id) => this.stopRoom(id)));
  }

  private ctx(roomId: RoomId): RoomCtx {
    let c = this.rooms.get(roomId);
    if (!c) {
      c = { pending: [], timer: null, window: [], explored: new Set(), chain: Promise.resolve(), busy: 0, abort: new AbortController() };
      this.rooms.set(roomId, c);
    }
    return c;
  }

  // --- serialization and status -----------------------------------------------------------

  private async begin(roomId: RoomId, c: RoomCtx): Promise<void> {
    c.busy += 1;
    if (c.busy === 1) await this.actions.setAgentStatus(roomId, 'thinking', null).catch(() => undefined);
  }

  private async end(roomId: RoomId, c: RoomCtx): Promise<void> {
    c.busy -= 1;
    if (c.busy === 0) await this.actions.setAgentStatus(roomId, 'idle', null).catch(() => undefined);
  }

  /** Run `fn` after earlier work for this room, with thinking/idle around it. Never rejects. */
  private enqueue(roomId: RoomId, label: string, fn: () => Promise<void>): void {
    const c = this.ctx(roomId);
    c.chain = c.chain.then(async () => {
      if (c.abort.signal.aborted) return;
      await this.begin(roomId, c);
      try {
        await fn();
      } catch (e) {
        this.log('error', `fake runtime ${label} failed`, { roomId, error: errMessage(e) });
      } finally {
        await this.end(roomId, c);
      }
    });
  }

  // --- AgentRuntime: chat -----------------------------------------------------------------

  onChatMessage(roomId: RoomId, message: Message): void {
    if (message.author.kind !== 'user') return;
    const c = this.ctx(roomId);
    c.pending.push(message);
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      c.timer = null;
      const batch = c.pending.splice(0);
      if (batch.length === 0) return;
      this.enqueue(roomId, 'chat', async () => {
        for (const m of batch) await this.handleChat(roomId, c, m);
      });
    }, this.debounceMs);
    c.timer.unref?.();
  }

  private async handleChat(roomId: RoomId, c: RoomCtx, m: Message): Promise<void> {
    if (m.author.kind !== 'user') return;
    c.window.push({ id: m.id, userId: m.author.userId, displayName: m.author.displayName, body: m.body });
    if (c.window.length > WINDOW_SIZE) c.window.splice(0, c.window.length - WINDOW_SIZE);
    const body = m.body.trim();

    const add = ADD_SECTION.exec(body);
    if (add) return this.addSection(roomId, m, add[1]!);
    if (REWRITE_ALL.test(body)) return this.rewriteDocument(roomId, m);
    if (await this.detectDivergence(roomId, c, m)) return;
    if (CLOSE_PROPOSAL.test(body)) return this.closeLatestProposal(roomId, m);
    if (QUESTION.test(body)) {
      await this.actions.postChat(roomId, {
        body: `Short answer: the documents answer that on a first read; ask me about a specific passage if you want the history behind it.`,
        inReplyTo: [m.id],
      });
    }
  }

  private async documents(roomId: RoomId): Promise<Document[]> {
    const state = await this.actions.getRoomState(roomId);
    return activeDocs(state.documents);
  }

  private async noDocument(roomId: RoomId, m: Message): Promise<void> {
    await this.actions.postChat(roomId, { body: 'There is no active document yet. Create one and ask again.', inReplyTo: [m.id] });
  }

  // --- direct request: immediate change ---------------------------------------------------

  private async addSection(roomId: RoomId, m: Message, rawTopic: string): Promise<void> {
    const docs = await this.documents(roomId);
    const doc = pickDocument(docs, m.body);
    if (!doc) return this.noDocument(roomId, m);
    const repo = await this.actions.repo(roomId);
    const title = titleCase(stripDocSuffix(rawTopic.trim().replace(/[.!?]+$/, ''), doc));
    const content = await repo.readFile(doc.path);
    if (content === null) {
      await this.actions.postChat(roomId, { body: `I could not read ${doc.path}.`, inReplyTo: [m.id] });
      return;
    }
    if (new RegExp(`^## ${escapeRegExp(title)}\\s*$`, 'mi').test(content)) {
      await this.actions.postChat(roomId, { body: `${doc.title} already has a "${title}" section.`, inReplyTo: [m.id] });
      return;
    }
    const base = content.endsWith('\n') ? content : `${content}\n`;
    const next = `${base}\n## ${title}\n\nPlaceholder text about ${title}: this section will be expanded as the discussion continues.\n`;
    const summary = `Added a "${title}" section to ${doc.title}`;
    await this.commitMain(roomId, repo, doc, { [doc.path]: next }, `Add ${title} section`, summary, m.id);
  }

  private async commitMain(
    roomId: RoomId,
    repo: RoomRepository,
    doc: Document,
    files: Record<string, string | null>,
    subject: string,
    summary: string,
    triggerId: MessageId,
    actor: Change['actor'] = ORCHESTRATOR_ACTOR,
    revertsSha: Sha | null = null,
  ): Promise<Sha> {
    const sha = await repo.withMainLock(() => repo.commitToMain(files, subject, { actor, triggerMessageIds: [triggerId], revertsSha }));
    await this.actions.recordChange(roomId, {
      sha,
      documentId: doc.id,
      actor,
      summary,
      triggerMessageIds: [triggerId],
      proposalId: null,
      revertsSha,
    });
    return sha;
  }

  // --- direct request: Review proposal ----------------------------------------------------

  private async rewriteDocument(roomId: RoomId, m: Message): Promise<void> {
    const docs = await this.documents(roomId);
    const doc = pickDocument(docs, m.body);
    if (!doc) return this.noDocument(roomId, m);
    const repo = await this.actions.repo(roomId);
    const branch = await uniqueBranch(repo, slugify(doc.path), 'rewrite', 'a');
    const { worktreePath, baseSha } = await repo.createBranch(branch);
    const original = readFileSync(join(worktreePath, doc.path), 'utf8');
    const h1 = original.split('\n').find((l) => /^# /.test(l)) ?? `# ${doc.title}`;
    const rewritten = `${h1}\n\nThis document was rewritten end to end for clarity and consistency.\n\n## Overview\n\nA tighter overview replaces the previous draft.\n\n## Details\n\nThe details were consolidated and reordered to follow the overview.\n`;
    writeFileSync(join(worktreePath, doc.path), rewritten);
    const sha = await repo.commitWorktree(worktreePath, `Rewrite ${doc.title}`, { actor: WORKER_ACTOR, triggerMessageIds: [m.id] });
    if (!sha) {
      await this.actions.postChat(roomId, { body: `The rewrite of ${doc.title} produced no changes.`, inReplyTo: [m.id] });
      return;
    }
    await this.actions.openProposal(roomId, {
      documentId: doc.id,
      kind: 'review',
      title: `Rewrite ${doc.title}`,
      branchBase: baseSha,
      options: [
        {
          label: 'A',
          branch,
          summary: `Rewrites ${doc.title} from the top, keeping the title.`,
          tradeoffs: 'Reads more consistently, but replaces most of the existing wording.',
        },
      ],
      triggerMessageIds: [m.id],
    });
  }

  // --- divergence -> exploration -> Quorum proposal ---------------------------------------

  private async detectDivergence(roomId: RoomId, c: RoomCtx, current: Message): Promise<boolean> {
    const w = c.window;
    const cur = w[w.length - 1];
    if (!cur || cur.id !== current.id) return false;
    const curUse = USE_PATTERN.exec(cur.body);
    const curSense = MORE_SENSE_PATTERN.exec(cur.body);
    if (!curUse && !curSense) return false;

    for (let i = w.length - 2; i >= 0; i--) {
      const prev = w[i]!;
      if (prev.userId === cur.userId) continue;
      const prevUse = USE_PATTERN.exec(prev.body);
      const prevSense = MORE_SENSE_PATTERN.exec(prev.body);
      let x: string | null = null;
      let y: string | null = null;
      if (prevUse && curSense) {
        x = cleanUseTerm(prevUse[1]!);
        y = cleanSenseTerm(curSense[1]!);
      } else if (prevSense && curUse) {
        x = cleanUseTerm(curUse[1]!);
        y = cleanSenseTerm(prevSense[1]!);
      } else if (prevUse && curUse) {
        x = cleanUseTerm(prevUse[1]!);
        y = cleanUseTerm(curUse[1]!);
      }
      if (!x || !y || x.toLowerCase() === y.toLowerCase()) continue;
      const key = [x.toLowerCase(), y.toLowerCase()].sort().join('|');
      if (c.explored.has(key)) continue;
      c.explored.add(key);
      w.splice(w.length - 1, 1);
      w.splice(i, 1);
      await this.startExploration(roomId, c, x, y, [prev, cur]);
      return true;
    }
    return false;
  }

  private async startExploration(roomId: RoomId, c: RoomCtx, x: string, y: string, source: WindowEntry[]): Promise<void> {
    const docs = await this.documents(roomId);
    const doc = pickDocument(docs, ...source.map((s) => s.body));
    const triggerIds = source.map((s) => s.id);
    if (!doc) {
      await this.actions.postChat(roomId, { body: 'There is no active document to explore against.', inReplyTo: triggerIds });
      return;
    }
    const theses = [x, y, `${x} with ${y} fallback`];
    const title = `Exploring ${x} vs ${y} for ${doc.title}`;
    await this.actions.postChat(roomId, {
      body: title,
      card: { type: 'exploration_started', documentId: doc.id, title, theses } satisfies Card,
      inReplyTo: triggerIds,
    });

    // The exploration runs detached so chat, suggestions and asks keep flowing while it "works".
    await this.begin(roomId, c);
    void (async () => {
      try {
        await sleep(this.exploreMs, c.abort.signal);
        if (c.abort.signal.aborted) return;
        await this.finishExploration(roomId, doc, x, y, triggerIds);
      } catch (e) {
        this.log('error', 'fake exploration failed', { roomId, error: errMessage(e) });
        await this.actions.postChat(roomId, { body: `The exploration of ${x} vs ${y} failed: ${errMessage(e)}`, inReplyTo: triggerIds }).catch(() => undefined);
      } finally {
        await this.end(roomId, c);
      }
    })();
  }

  private async finishExploration(roomId: RoomId, doc: Document, x: string, y: string, triggerIds: MessageId[]): Promise<void> {
    const repo = await this.actions.repo(roomId);
    const topic = slugify(`${x}-vs-${y}`);
    const docSlug = slugify(doc.path);
    let topicSlug = topic;
    for (let n = 2; (await repo.listBranches()).includes(proposalBranchName(docSlug, topicSlug, 'a')); n++) topicSlug = `${topic}-${n}`;

    const variants = [
      {
        label: 'A',
        heading: `Decision: ${x}`,
        text: `We will use ${x} as the primary choice. It is the simpler path and keeps the surface area small.`,
        summary: `Commit to ${x} everywhere.`,
        tradeoffs: `Simplest to operate and explain; gives up what ${y} offers.`,
      },
      {
        label: 'B',
        heading: `Decision: ${y}`,
        text: `We will use ${y} as the primary choice. It fits the access patterns we expect best.`,
        summary: `Commit to ${y} everywhere.`,
        tradeoffs: `Best fit for the expected workload; gives up what ${x} offers.`,
      },
      {
        label: 'C',
        heading: `Decision: ${x} with ${y} fallback`,
        text: `We will start with ${x} and keep ${y} available as a fallback behind a narrow interface.`,
        summary: `Start with ${x}, keep ${y} as a fallback.`,
        tradeoffs: `Hedges the risk of either choice; costs an extra abstraction to maintain.`,
      },
    ];

    const options: Array<{ label: string; branch: string; summary: string; tradeoffs: string }> = [];
    let branchBase: Sha | null = null;
    for (const v of variants) {
      const branch = proposalBranchName(docSlug, topicSlug, v.label.toLowerCase());
      const { worktreePath, baseSha } = await repo.createBranch(branch);
      branchBase ??= baseSha;
      const file = join(worktreePath, doc.path);
      mkdirSync(worktreePath, { recursive: true });
      const original = readFileSync(file, 'utf8');
      const base = original.endsWith('\n') ? original : `${original}\n`;
      writeFileSync(file, `${base}\n## ${v.heading}\n\n${v.text}\n`);
      await repo.commitWorktree(worktreePath, `Explore: ${v.heading}`, { actor: WORKER_ACTOR, triggerMessageIds: triggerIds });
      options.push({ label: v.label, branch, summary: v.summary, tradeoffs: v.tradeoffs });
    }
    await this.actions.openProposal(roomId, {
      documentId: doc.id,
      kind: 'quorum',
      title: `${x} vs ${y} for ${doc.title}`,
      branchBase: branchBase!,
      options,
      triggerMessageIds: triggerIds,
    });
  }

  private async closeLatestProposal(roomId: RoomId, m: Message): Promise<void> {
    const state = await this.actions.getRoomState(roomId);
    const open = [...state.proposals].reverse().find((p) => p.state === 'open');
    if (!open) {
      await this.actions.postChat(roomId, { body: 'There is no open proposal to close.', inReplyTo: [m.id] });
      return;
    }
    await this.actions.closeProposal(roomId, open.id, 'abandoned', 'Closed on request');
  }

  // --- suggestions ------------------------------------------------------------------------

  onSuggestion(roomId: RoomId, message: Message): void {
    this.enqueue(roomId, 'suggestion', () => this.applySuggestion(roomId, message));
  }

  private async applySuggestion(roomId: RoomId, m: Message): Promise<void> {
    const card = m.card;
    if (!card || card.type !== 'suggestion') {
      this.log('warn', 'onSuggestion without a suggestion card', { roomId, messageId: m.id });
      return;
    }
    const decline = async (note: string, chat: string) => {
      await this.actions.postChat(roomId, { body: chat, inReplyTo: [m.id], anchor: card.anchor });
      await this.actions.updateCard(roomId, m.id, { ...card, status: 'declined', note });
    };
    const doc = await this.actions.getDocument(roomId, card.anchor.documentId);
    if (!doc) return decline('Document not found', 'I could not find the document this suggestion refers to.');
    const repo = await this.actions.repo(roomId);
    const content = await repo.readFile(doc.path);
    if (content === null) return decline('Document not found', `I could not read ${doc.path}.`);

    const lines = content.split('\n');
    const { startLine, endLine } = card.anchor;
    const current = lines.slice(startLine - 1, endLine).join('\n');
    if (startLine < 1 || endLine < startLine || textHash(current) !== card.anchor.textHash) {
      return decline('The paragraph changed since this suggestion was made', 'That paragraph changed since the suggestion was made, so I did not apply it. Please suggest again on the current text.');
    }

    const replacement = card.replacement === '' ? [] : card.replacement.replace(/\n$/, '').split('\n');
    const at = startLine - 1;
    lines.splice(at, endLine - startLine + 1, ...replacement);
    if (replacement.length === 0 && lines[at] === '' && (at === 0 || lines[at - 1] === '')) lines.splice(at, 1);
    const author = m.author.kind === 'user' ? m.author : null;
    const actor: Change['actor'] = author ? { kind: 'user', userId: author.userId, displayName: author.displayName } : ORCHESTRATOR_ACTOR;
    const verb = card.replacement === '' ? 'Delete' : 'Update';
    const sha = await this.commitMain(
      roomId,
      repo,
      doc,
      { [doc.path]: lines.join('\n') },
      `${verb} paragraph in ${doc.title} (suggestion)`,
      `${verb === 'Delete' ? 'Deleted' : 'Updated'} a paragraph in ${doc.title} from ${author?.displayName ?? 'a'} suggestion`,
      m.id,
      actor,
    );
    await this.actions.updateCard(roomId, m.id, { ...card, status: 'applied', resolutionSha: sha, note: null });
  }

  // --- ask --------------------------------------------------------------------------------

  onAsk(roomId: RoomId, message: Message): void {
    this.enqueue(roomId, 'ask', () => this.answerAsk(roomId, message));
  }

  private async answerAsk(roomId: RoomId, m: Message): Promise<void> {
    const anchor: Anchor | null = m.card && m.card.type === 'ask' ? m.card.anchor : m.anchor;
    if (!anchor) {
      this.log('warn', 'onAsk without an anchor', { roomId, messageId: m.id });
      return;
    }
    const doc = await this.actions.getDocument(roomId, anchor.documentId);
    if (!doc) {
      await this.actions.postChat(roomId, { body: 'I could not find the document that question refers to.', inReplyTo: [m.id] });
      return;
    }
    const repo = await this.actions.repo(roomId);
    const [commits, blame] = await Promise.all([repo.logLines(doc.path, anchor.startLine, anchor.endLine), repo.blame(doc.path)]);
    const range = blame.filter((b) => b.line >= anchor.startLine && b.line <= anchor.endLine);
    const lastTouched = range.length > 0 ? range[range.length - 1]!.sha : null;
    const triggerIds = [...new Set(commits.flatMap((c) => c.trailers.triggerMessageIds))].slice(0, 6);
    const transcript = triggerIds.length > 0 ? await this.actions.readTranscript(roomId, { ids: triggerIds }) : [];

    const where = anchor.startLine === anchor.endLine ? `line ${anchor.startLine}` : `lines ${anchor.startLine}-${anchor.endLine}`;
    const out: string[] = [`Here is the history of ${where} of ${doc.title}:`];
    if (commits.length === 0) out.push('', 'There is no recorded history beyond the initial draft.');
    for (const c of commits.slice(0, 5)) {
      out.push('', `- \`${shortSha(c.sha)}\` ${c.subject}${c.trailers.actor ? ` (${c.trailers.actor})` : ''}`);
      for (const id of c.trailers.triggerMessageIds) {
        const t = transcript.find((x) => x.id === id);
        if (t) out.push(`  > ${authorName(t)}: ${t.body.split('\n')[0]}`);
      }
    }
    if (lastTouched) out.push('', `Last changed in \`${shortSha(lastTouched)}\`.`);
    await this.actions.postChat(roomId, { body: out.join('\n'), anchor, inReplyTo: [m.id] });
  }

  // --- proposal lifecycle -----------------------------------------------------------------

  onProposalEvent(
    roomId: RoomId,
    event: Parameters<AgentRuntime['onProposalEvent']>[1],
  ): void {
    if (event.type === 'merged') {
      const label = event.proposal.options.find((o) => o.id === event.optionId)?.label ?? '?';
      const tail = event.reconciled ? ' after reconciling it with newer edits' : '';
      this.enqueue(roomId, 'merged', async () => {
        await this.actions.postChat(roomId, { body: `Merged "${event.proposal.title}" (option ${label}) as ${shortSha(event.sha)}${tail}.` });
      });
    } else if (event.type === 'rejected') {
      this.enqueue(roomId, 'rejected', async () => {
        await this.actions.postChat(roomId, { body: `"${event.proposal.title}" was rejected. What should change?` });
      });
    }
  }

  onReverted(roomId: RoomId, change: Change, revertSha: Sha, _byUserId: UserId): void {
    this.log('debug', 'fake runtime saw a revert', { roomId, sha: change.sha, revertSha });
  }

  async runMergeDriver(
    _roomId: RoomId,
    input: { proposal: Proposal; optionId: OptionId; worktreePath: string; conflictedFiles: string[]; documentPath: string },
  ): Promise<{ reconciled: boolean; summary: string }> {
    for (const file of input.conflictedFiles) {
      const path = join(input.worktreePath, file);
      writeFileSync(path, takeTheirs(readFileSync(path, 'utf8')));
    }
    const n = input.conflictedFiles.length;
    return n === 0
      ? { reconciled: false, summary: 'Clean merge; nothing to reconcile.' }
      : { reconciled: true, summary: `Resolved ${n} conflicted file${n === 1 ? '' : 's'} by keeping the proposal's side of each conflict.` };
  }

  async runSemanticRevert(roomId: RoomId, input: { change: Change; byUserId: UserId }): Promise<Sha> {
    const repo = await this.actions.repo(roomId);
    const info = await repo.show(input.change.sha);
    const doc = await this.actions.getDocument(roomId, input.change.documentId);
    const path = doc?.path ?? info.files[0];
    if (!path) throw new Error('semantic revert: the change touched no file');
    const patch = await repo.diff(path, `${input.change.sha}^`, input.change.sha);
    const added = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    const current = (await repo.readFile(path)) ?? '';
    const remaining = [...added];
    const kept: string[] = [];
    for (const line of current.split('\n')) {
      const idx = line.trim() === '' ? -1 : remaining.indexOf(line);
      if (idx >= 0) remaining.splice(idx, 1);
      else kept.push(line);
    }
    // collapse the blank lines the removal leaves behind
    const cleaned = kept.filter((l, i) => !(l === '' && kept[i - 1] === '')).join('\n');
    const state = await this.actions.getRoomState(roomId);
    const displayName = state.participants.find((p) => p.userId === input.byUserId)?.displayName ?? input.byUserId;
    const actor: Change['actor'] = { kind: 'user', userId: input.byUserId, displayName };
    return repo.withMainLock(() =>
      repo.commitToMain({ [path]: cleaned }, `Revert ${shortSha(input.change.sha)}: ${info.subject}`, {
        actor,
        triggerMessageIds: input.change.triggerMessageIds,
        revertsSha: input.change.sha,
      }),
    );
  }

  async writeDigest(roomId: RoomId, input: { userId: UserId; sinceMessageId: MessageId | null; events: string[] }): Promise<string> {
    const transcript = await this.actions.readTranscript(roomId, { sinceMessageId: input.sinceMessageId, limit: 20 });
    const out = ['While you were away:'];
    for (const e of input.events) out.push(`- ${e}`);
    if (input.events.length === 0) out.push('- Nothing notable happened.');
    const chat = transcript.filter((t) => t.kind === 'text');
    if (chat.length > 0) {
      out.push('', 'In chat:');
      for (const t of chat.slice(-8)) out.push(`- ${authorName(t)}: ${truncate(t.body.split('\n')[0] ?? '', 100)}`);
    }
    return out.join('\n');
  }
}

// --- helpers --------------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

function docNames(doc: Document): string[] {
  const bare = doc.path.replace(/\.md$/i, '');
  return [...new Set([doc.title, doc.path, bare].map((n) => n.toLowerCase()).filter(Boolean))];
}

/** The document named in the texts (longest name wins), else the first active document. */
export function pickDocument(docs: Document[], ...texts: string[]): Document | null {
  const hay = texts.join('\n').toLowerCase();
  let best: { doc: Document; len: number } | null = null;
  for (const doc of docs) {
    for (const name of docNames(doc)) {
      if (hay.includes(name) && (!best || name.length > best.len)) best = { doc, len: name.length };
    }
  }
  return best?.doc ?? docs[0] ?? null;
}

function stripDocSuffix(topic: string, doc: Document): string {
  for (const name of docNames(doc)) {
    const re = new RegExp(`\\s+(?:to|in|into)\\s+(?:the\\s+)?${escapeRegExp(name)}(?:\\s+doc(?:ument)?)?$`, 'i');
    if (re.test(topic)) return topic.replace(re, '');
  }
  return topic;
}

const USE_STOP = /\s+(?:for|because|since|as|so|to|in|on|over|instead|rather|and|but|with|due)\b.*$|[,.;:!?].*$/i;

export function cleanUseTerm(raw: string): string {
  return raw.replace(USE_STOP, '').trim();
}

export function cleanSenseTerm(raw: string): string {
  let t = raw.split(/[,;.!?]|\s(?:but|and)\s/i).pop()!.trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^(?:i|we)\s+(?:think|feel|believe|guess|say)\s+/i, '')
      .replace(/^(?:honestly|actually|well|but|and|hmm|imo|maybe|probably|then|still|just|really)\s+/i, '')
      .replace(/^(?:that|using|the)\s+/i, '');
  }
  const words = t.split(/\s+/);
  return words.slice(-3).join(' ').trim();
}

async function uniqueBranch(repo: RoomRepository, docSlug: string, topic: string, option: string): Promise<string> {
  const existing = new Set(await repo.listBranches());
  let candidate = proposalBranchName(docSlug, topic, option);
  for (let n = 2; existing.has(candidate); n++) candidate = proposalBranchName(docSlug, `${topic}-${n}`, option);
  return candidate;
}

/** Resolve git conflict markers (merge or diff3 style) by keeping the "theirs" block. */
export function takeTheirs(text: string): string {
  const out: string[] = [];
  let state: 'normal' | 'ours' | 'base' | 'theirs' = 'normal';
  for (const line of text.split('\n')) {
    if (state === 'normal' && /^<{7}(?:\s|$)/.test(line)) state = 'ours';
    else if (state === 'ours' && /^\|{7}(?:\s|$)/.test(line)) state = 'base';
    else if ((state === 'ours' || state === 'base') && /^={7}$/.test(line)) state = 'theirs';
    else if (state === 'theirs' && /^>{7}(?:\s|$)/.test(line)) state = 'normal';
    else if (state === 'normal' || state === 'theirs') out.push(line);
  }
  return out.join('\n');
}
