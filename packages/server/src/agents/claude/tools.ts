import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  Anchor,
  Card,
  Change,
  Document,
  OptionId,
  Proposal,
  RoomId,
  RoomState,
} from '@quorum/shared';
import { DEFAULTS } from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import { ORCHESTRATOR_ACTOR, errMessage, type Logger } from '../common.js';
import { compactMessage, compactState } from './events.js';
import { enforceScope, paragraphChange, restoreFiles } from './worktree.js';

export const QUORUM_SERVER_NAME = 'quorum';

/** `mcp__quorum__<tool>` names, as canUseTool sees them */
export function mcpToolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => `mcp__${QUORUM_SERVER_NAME}__${t.name}`);
}

export function createQuorumServer(tools: Array<SdkMcpToolDefinition<any>>) {
  return createSdkMcpServer({ name: QUORUM_SERVER_NAME, tools });
}

export interface ExplorationRequest {
  documentPath: string;
  topic: string;
  theses: string[];
  context?: string;
  triggerMessageIds: string[];
}

export interface ToolContext {
  roomId: RoomId;
  actions: RoomActions;
  repo: RoomRepository;
  logger: Logger;
  /** spawns exploration workers; implemented by the runtime (see workers.ts runExploration) */
  startExploration?: (req: ExplorationRequest) => Promise<unknown>;
  /** size rule: an immediate change may delete or rewrite at most this many existing paragraphs (default: shared DEFAULTS) */
  immediateRewriteLimit?: number;
  /** routes set_status through the room's status board instead of straight to RoomActions */
  setStatus?: (status: 'thinking' | 'idle', detail: string | null) => void;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/** Tool handlers never throw into the SDK: failures come back as tool errors the model can react to. */
function guard<A>(
  ctx: ToolContext,
  name: string,
  fn: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      ctx.logger('warn', `quorum tool ${name} failed`, {
        roomId: ctx.roomId,
        error: errMessage(e),
      });
      return textResult(`${name} failed: ${errMessage(e)}`, true);
    }
  };
}

async function findDocument(ctx: ToolContext, path: string): Promise<Document> {
  const state = await ctx.actions.getRoomState(ctx.roomId);
  const doc = state.documents.find((d) => d.path === path);
  if (!doc)
    throw new Error(
      `no document with path ${path}; known: ${state.documents.map((d) => d.path).join(', ') || '(none)'}`,
    );
  return doc;
}

const AnchorShape = z.object({
  documentId: z.string(),
  baseSha: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  textHash: z.string(),
  text: z.string(),
});

const ExplorationCardShape = z.object({
  type: z.literal('exploration_started'),
  documentId: z.string(),
  title: z.string(),
  theses: z.array(z.string()),
});

/** read_transcript and get_room_state: available to the orchestrator, workers and the digest writer. */
export function readOnlyTools(ctx: ToolContext) {
  const readTranscript = tool(
    'read_transcript',
    'Fetch chat messages from the room transcript, by message id, or everything after a message id. Returns compact JSON.',
    {
      ids: z.array(z.string()).optional().describe('exact message ids to fetch'),
      sinceMessageId: z.string().nullable().optional().describe('return messages after this id'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('max messages (default 50; newest kept)'),
    },
    guard(ctx, 'read_transcript', async (a) => {
      const messages = await ctx.actions.readTranscript(ctx.roomId, {
        ids: a.ids,
        sinceMessageId: a.sinceMessageId ?? null,
        limit: a.limit ?? 50,
      });
      return jsonResult(messages.map(compactMessage));
    }),
    { annotations: { readOnlyHint: true } },
  );
  const getRoomState = tool(
    'get_room_state',
    'Participants, presence, documents with head shas, proposals with votes, voting rule, agent status, and recent messages.',
    {},
    guard(ctx, 'get_room_state', async () =>
      jsonResult(compactState(await ctx.actions.getRoomState(ctx.roomId))),
    ),
    { annotations: { readOnlyHint: true } },
  );
  return [readTranscript, getRoomState];
}

/**
 * Whether `optionId` of an open proposal currently satisfies the room's voting rule (PRD 7.2-7.3). Mirrors what the
 * room server evaluates on every vote and presence change, so request_merge cannot be used to merge something the room
 * has not passed.
 */
export function evaluateVote(
  state: RoomState,
  proposal: Proposal,
  optionId: OptionId,
  now: Date = new Date(),
): { passed: boolean; reason: string } {
  if (proposal.kind === 'review') {
    if (proposal.votes.some((v) => v.decision === 'reject'))
      return { passed: false, reason: 'the review was rejected' };
    if (proposal.votes.some((v) => v.decision === 'approve'))
      return { passed: true, reason: 'approved' };
    if (proposal.windowClosesAt && Date.parse(proposal.windowClosesAt) <= now.getTime())
      return { passed: true, reason: 'the objection window elapsed without a rejection' };
    return { passed: false, reason: 'nobody approved yet and the objection window is still open' };
  }
  const connected = new Set(state.presence.filter((p) => p.connected).map((p) => p.userId));
  const approvals = proposal.votes.filter(
    (v) => v.decision === 'approve' && v.optionId === optionId && connected.has(v.userId),
  ).length;
  const rule = state.room.votingRule;
  const passed =
    rule === 'unanimous'
      ? approvals > 0 && approvals === connected.size
      : approvals > connected.size / 2;
  return {
    passed,
    reason: passed
      ? `${approvals} of ${connected.size} connected participants approved`
      : `${approvals} of ${connected.size} connected participants approved this option and the rule is ${rule}`,
  };
}

export function orchestratorTools(ctx: ToolContext) {
  const [readTranscript, getRoomState] = readOnlyTools(ctx);

  const postChat = tool(
    'post_chat',
    'Post a message to the room chat as the agent. Optionally anchor it to a passage (answers to Ask) or attach an exploration_started card.',
    {
      body: z.string().min(1).describe('markdown message body; keep it short'),
      inReplyTo: z.array(z.string()).optional().describe('ids of the messages this answers'),
      anchor: AnchorShape.optional(),
      card: ExplorationCardShape.optional(),
    },
    guard(ctx, 'post_chat', async (a) => {
      const m = await ctx.actions.postChat(ctx.roomId, {
        body: a.body,
        inReplyTo: a.inReplyTo ?? [],
        anchor: (a.anchor as Anchor | undefined) ?? null,
        card: (a.card as Card | undefined) ?? null,
      });
      return textResult(`posted ${m.id}`);
    }),
  );

  const commitMain = tool(
    'commit_main',
    'Commit the edits you made in the main worktree through the write queue (formatter runs, trailers are added) and announce a Change card. Edit exactly one document before calling. The server checks the result: changes to other files are discarded, and a change that deletes or rewrites more existing paragraphs than the size rule allows is refused (and its edit discarded).',
    {
      documentPath: z
        .string()
        .describe('the one document the change touched, e.g. Architecture.md'),
      subject: z.string().min(1).describe('short imperative commit subject'),
      summary: z.string().min(1).describe('one plain sentence for the Change card'),
      triggerMessageIds: z.array(z.string()).describe('chat messages that caused the change'),
      proposalId: z.string().optional(),
      asUserId: z
        .string()
        .optional()
        .describe('author the commit as this participant (use when applying their suggestion)'),
    },
    guard(ctx, 'commit_main', async (a) => {
      const state = await ctx.actions.getRoomState(ctx.roomId);
      const doc = state.documents.find((d) => d.path === a.documentPath);
      if (!doc) throw new Error(`no document with path ${a.documentPath}`);
      if (doc.status !== 'active') throw new Error(`${doc.path} is archived and cannot be changed`);
      let actor: Change['actor'] = ORCHESTRATOR_ACTOR;
      if (a.asUserId) {
        const p = state.participants.find((x) => x.userId === a.asUserId);
        if (!p) throw new Error(`unknown participant ${a.asUserId}`);
        actor = { kind: 'user', userId: p.userId, displayName: p.displayName };
      }

      // Mechanical checks on the working copy before it is committed (PRD 4.1 scope, 6.3 size rule).
      const dir = ctx.repo.mainWorktree;
      const limit = ctx.immediateRewriteLimit ?? DEFAULTS.immediateRewriteLimit;
      const discarded = await enforceScope(ctx.repo, dir, 'main', [doc.path]);
      const note =
        discarded.length > 0
          ? ` Changes to ${discarded.join(', ')} were discarded: a change touches exactly one document, so handle other documents as their own requests.`
          : '';
      const before = (await ctx.repo.readFile(doc.path, 'main')) ?? '';
      const file = join(dir, doc.path);
      if (!existsSync(file)) {
        await restoreFiles(ctx.repo, dir, 'main', [doc.path]);
        return textResult(
          `${doc.path} was deleted from the worktree; documents are archived from the UI, never deleted. The file was restored.${note}`,
          true,
        );
      }
      const after = readFileSync(file, 'utf8');
      if (after === before)
        return textResult(
          `Nothing to commit: ${doc.path} is unchanged in the main worktree. Make your edits first.${note}`,
          true,
        );
      const { removed } = paragraphChange(before, after);
      if (removed > limit) {
        await restoreFiles(ctx.repo, dir, 'main', [doc.path]);
        return textResult(
          `Refused: this change deletes or rewrites ${removed} existing paragraphs, and an immediate change may touch at most ${limit}. The edit was discarded and main is unchanged. Call start_exploration with one thesis describing the change, then open_proposal with kind "review".${note}`,
          true,
        );
      }

      const sha = await ctx.repo.withMainLock(() =>
        ctx.repo.commitWorktree(ctx.repo.mainWorktree, a.subject, {
          actor,
          triggerMessageIds: a.triggerMessageIds,
          proposalId: a.proposalId ?? null,
        }),
      );
      if (!sha)
        return textResult(
          `Nothing to commit: the main worktree is clean (a merge may have reset it). Make your edits again.${note}`,
          true,
        );
      await ctx.actions.recordChange(ctx.roomId, {
        sha,
        documentId: doc.id,
        actor,
        summary: a.summary,
        triggerMessageIds: a.triggerMessageIds,
        proposalId: a.proposalId ?? null,
        revertsSha: null,
      });
      return textResult(`committed ${sha}.${note}`);
    }),
  );

  const resolveSuggestion = tool(
    'resolve_suggestion',
    'Update a Suggestion card after handling it.',
    {
      messageId: z.string().describe('id of the suggestion message'),
      status: z.enum(['applied', 'declined', 'superseded']),
      resolutionSha: z.string().optional().describe('commit that applied it'),
      note: z.string().optional().describe('why it was declined or superseded'),
    },
    guard(ctx, 'resolve_suggestion', async (a) => {
      const [m] = await ctx.actions.readTranscript(ctx.roomId, { ids: [a.messageId] });
      if (!m || !m.card || m.card.type !== 'suggestion')
        throw new Error(`${a.messageId} is not a suggestion message`);
      await ctx.actions.updateCard(ctx.roomId, m.id, {
        ...m.card,
        status: a.status,
        resolutionSha: a.resolutionSha ?? null,
        note: a.note ?? null,
      });
      return textResult(`suggestion ${a.status}`);
    }),
  );

  const startExploration = tool(
    'start_exploration',
    "Spawn one worker per thesis, each on its own new branch (options a, b, c...) forked from main. Blocks until all finish or time out, then returns each worker's branch, head sha, summary, tradeoffs, assumptions, open questions and sources, plus the base sha to use as branchBase.",
    {
      documentPath: z.string(),
      topic: z.string().describe('short topic used in branch names, e.g. "storage engine"'),
      theses: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe('one thesis per worker; for a divergence, each position plus a synthesis'),
      context: z.string().optional().describe('background the workers need beyond the transcript'),
      triggerMessageIds: z.array(z.string()).default([]),
    },
    guard(ctx, 'start_exploration', async (a) => {
      if (!ctx.startExploration) throw new Error('explorations are not available');
      return jsonResult(await ctx.startExploration(a));
    }),
  );

  const openProposal = tool(
    'open_proposal',
    'Register branches as a proposal and post its card. Review: exactly one option. Quorum: two or more. The server verifies each branch changes only this document.',
    {
      documentPath: z.string(),
      kind: z.enum(['review', 'quorum']),
      title: z.string().min(1),
      branchBase: z
        .string()
        .describe('main sha the branches were forked from (baseSha from start_exploration)'),
      options: z
        .array(
          z.object({
            label: z.string(),
            branch: z.string(),
            summary: z.string(),
            tradeoffs: z.string(),
          }),
        )
        .min(1),
      triggerMessageIds: z.array(z.string()).default([]),
      stale: z
        .boolean()
        .optional()
        .describe('true when the room already resolved the topic while the exploration ran'),
    },
    guard(ctx, 'open_proposal', async (a) => {
      const doc = await findDocument(ctx, a.documentPath);
      if (a.kind === 'review' && a.options.length !== 1)
        throw new Error('a review proposal has exactly one option');
      if (a.kind === 'quorum' && a.options.length < 2)
        throw new Error('a quorum proposal needs at least two options');

      // Scope (PRD 4.1): every option must change exactly this one document. The fork point is read from the
      // repository rather than trusted, so a wrong or abbreviated branchBase cannot make the check pass or fail.
      for (const o of a.options) {
        if (!(await ctx.repo.headSha(o.branch)))
          throw new Error(
            `branch ${o.branch} does not exist; use the branch names start_exploration returned`,
          );
      }
      const forkPoint = await ctx.repo.mergeBase('main', a.options[0]!.branch).catch(() => null);
      const base = forkPoint ?? a.branchBase;
      for (const o of a.options) {
        const files = await ctx.repo.changedFiles(base, o.branch);
        if (files.length === 0)
          throw new Error(
            `option ${o.label} (${o.branch}) has no changes against ${base}; leave it out or ask for it to be drafted again`,
          );
        if (files.length !== 1 || files[0] !== doc.path) {
          throw new Error(
            `option ${o.label} (${o.branch}) must change only ${doc.path}, but changes: ${files.join(', ')}`,
          );
        }
      }
      const mainChangedSince = (
        await ctx.repo.changedFiles(base, 'main').catch(() => [] as string[])
      ).includes(doc.path);

      const p = await ctx.actions.openProposal(ctx.roomId, {
        documentId: doc.id,
        kind: a.kind,
        title: a.title,
        branchBase: base,
        options: a.options,
        triggerMessageIds: a.triggerMessageIds,
        stale: a.stale,
      });
      return jsonResult({
        proposalId: p.id,
        state: p.state,
        stale: p.stale,
        options: p.options.map((o) => ({ id: o.id, label: o.label, branch: o.branch })),
        ...(!base.startsWith(a.branchBase) && !a.branchBase.startsWith(base)
          ? { branchBaseUsed: base, note: "branchBase was corrected to the branches' fork point" }
          : {}),
        ...(mainChangedSince
          ? {
              mainChangedSince: `${doc.path} changed on main after the branches were forked; the merge driver will reconcile`,
            }
          : {}),
      });
    }),
  );

  const closeProposal = tool(
    'close_proposal',
    'Archive a proposal (never deletes): expired, rejected or abandoned. Include a note saying why.',
    {
      proposalId: z.string(),
      reason: z.enum(['expired', 'rejected', 'abandoned']),
      note: z.string().optional(),
    },
    guard(ctx, 'close_proposal', async (a) => {
      const p = await ctx.actions.closeProposal(ctx.roomId, a.proposalId, a.reason, a.note);
      return textResult(`proposal ${p.id} is now ${p.state}`);
    }),
  );

  const requestMerge = tool(
    'request_merge',
    'Hand a proposal that has passed its vote to the merge pipeline. Refused unless the voting rule is satisfied right now: the agent never votes and cannot force a merge.',
    { proposalId: z.string(), optionId: z.string() },
    guard(ctx, 'request_merge', async (a) => {
      const state = await ctx.actions.getRoomState(ctx.roomId);
      const proposal = state.proposals.find((p) => p.id === a.proposalId);
      if (!proposal) throw new Error(`unknown proposal ${a.proposalId}`);
      if (proposal.state !== 'open') throw new Error(`proposal is ${proposal.state}, not open`);
      if (!proposal.options.some((o) => o.id === a.optionId))
        throw new Error(`unknown option ${a.optionId}`);
      const verdict = evaluateVote(state, proposal, a.optionId);
      if (!verdict.passed)
        return textResult(
          `Not merged: ${verdict.reason}. The room decides; the agent never votes and cannot force a merge.`,
          true,
        );
      await ctx.actions.requestMerge(ctx.roomId, a.proposalId, a.optionId);
      return textResult('merge requested');
    }),
  );

  const setStatus = tool(
    'set_status',
    'Show the room what you are doing (for example "Exploring PostgreSQL vs ClickHouse"). Return to idle when done.',
    { status: z.enum(['thinking', 'idle']), detail: z.string().optional() },
    guard(ctx, 'set_status', async (a) => {
      if (ctx.setStatus) ctx.setStatus(a.status, a.detail ?? null);
      else await ctx.actions.setAgentStatus(ctx.roomId, a.status, a.detail ?? null);
      return textResult('ok');
    }),
  );

  return [
    postChat,
    readTranscript,
    getRoomState,
    commitMain,
    resolveSuggestion,
    startExploration,
    openProposal,
    closeProposal,
    requestMerge,
    setStatus,
  ];
}
