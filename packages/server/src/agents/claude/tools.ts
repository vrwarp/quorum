import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Anchor, Card, Change, Document, RoomId } from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import { ORCHESTRATOR_ACTOR, errMessage, type Logger } from '../common.js';
import { compactMessage, compactState } from './events.js';

export const QUORUM_SERVER_NAME = 'quorum';

/** `mcp__quorum__<tool>` names for allowedTools / canUseTool */
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
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/** Tool handlers never throw into the SDK: failures come back as tool errors the model can react to. */
function guard<A>(ctx: ToolContext, name: string, fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      ctx.logger('warn', `quorum tool ${name} failed`, { roomId: ctx.roomId, error: errMessage(e) });
      return textResult(`${name} failed: ${errMessage(e)}`, true);
    }
  };
}

async function findDocument(ctx: ToolContext, path: string): Promise<Document> {
  const state = await ctx.actions.getRoomState(ctx.roomId);
  const doc = state.documents.find((d) => d.path === path);
  if (!doc) throw new Error(`no document with path ${path}; known: ${state.documents.map((d) => d.path).join(', ') || '(none)'}`);
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
      limit: z.number().int().min(1).max(200).optional().describe('max messages (default 50; newest kept)'),
    },
    guard(ctx, 'read_transcript', async (a) => {
      const messages = await ctx.actions.readTranscript(ctx.roomId, { ids: a.ids, sinceMessageId: a.sinceMessageId ?? null, limit: a.limit ?? 50 });
      return jsonResult(messages.map(compactMessage));
    }),
    { annotations: { readOnlyHint: true } },
  );
  const getRoomState = tool(
    'get_room_state',
    'Participants, presence, documents with head shas, proposals with votes, voting rule, agent status, and recent messages.',
    {},
    guard(ctx, 'get_room_state', async () => jsonResult(compactState(await ctx.actions.getRoomState(ctx.roomId)))),
    { annotations: { readOnlyHint: true } },
  );
  return [readTranscript, getRoomState];
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
    'Commit the edits you made in the main worktree through the write queue (formatter runs, trailers are added) and announce a Change card. Edit exactly one document before calling.',
    {
      documentPath: z.string().describe('the one document the change touched, e.g. Architecture.md'),
      subject: z.string().min(1).describe('short imperative commit subject'),
      summary: z.string().min(1).describe('one plain sentence for the Change card'),
      triggerMessageIds: z.array(z.string()).describe('chat messages that caused the change'),
      proposalId: z.string().optional(),
      asUserId: z.string().optional().describe('author the commit as this participant (use when applying their suggestion)'),
    },
    guard(ctx, 'commit_main', async (a) => {
      const state = await ctx.actions.getRoomState(ctx.roomId);
      const doc = state.documents.find((d) => d.path === a.documentPath);
      if (!doc) throw new Error(`no document with path ${a.documentPath}`);
      let actor: Change['actor'] = ORCHESTRATOR_ACTOR;
      if (a.asUserId) {
        const p = state.participants.find((x) => x.userId === a.asUserId);
        if (!p) throw new Error(`unknown participant ${a.asUserId}`);
        actor = { kind: 'user', userId: p.userId, displayName: p.displayName };
      }
      const sha = await ctx.repo.withMainLock(() =>
        ctx.repo.commitWorktree(ctx.repo.mainWorktree, a.subject, { actor, triggerMessageIds: a.triggerMessageIds, proposalId: a.proposalId ?? null }),
      );
      if (!sha) return textResult('Nothing to commit: the main worktree is clean. Make your edits first.', true);
      await ctx.actions.recordChange(ctx.roomId, {
        sha,
        documentId: doc.id,
        actor,
        summary: a.summary,
        triggerMessageIds: a.triggerMessageIds,
        proposalId: a.proposalId ?? null,
        revertsSha: null,
      });
      return textResult(`committed ${sha}`);
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
      if (!m || !m.card || m.card.type !== 'suggestion') throw new Error(`${a.messageId} is not a suggestion message`);
      await ctx.actions.updateCard(ctx.roomId, m.id, { ...m.card, status: a.status, resolutionSha: a.resolutionSha ?? null, note: a.note ?? null });
      return textResult(`suggestion ${a.status}`);
    }),
  );

  const startExploration = tool(
    'start_exploration',
    'Spawn one worker per thesis, each on its own new branch (options a, b, c...) forked from main. Blocks until all finish or time out, then returns each worker\'s branch, head sha, summary, tradeoffs, assumptions, open questions and sources, plus the base sha to use as branchBase.',
    {
      documentPath: z.string(),
      topic: z.string().describe('short topic used in branch names, e.g. "storage engine"'),
      theses: z.array(z.string()).min(1).max(5).describe('one thesis per worker; for a divergence, each position plus a synthesis'),
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
      branchBase: z.string().describe('main sha the branches were forked from (baseSha from start_exploration)'),
      options: z
        .array(z.object({ label: z.string(), branch: z.string(), summary: z.string(), tradeoffs: z.string() }))
        .min(1),
      triggerMessageIds: z.array(z.string()).default([]),
      stale: z.boolean().optional().describe('true when the room already resolved the topic while the exploration ran'),
    },
    guard(ctx, 'open_proposal', async (a) => {
      const doc = await findDocument(ctx, a.documentPath);
      if (a.kind === 'review' && a.options.length !== 1) throw new Error('a review proposal has exactly one option');
      if (a.kind === 'quorum' && a.options.length < 2) throw new Error('a quorum proposal needs at least two options');
      const p = await ctx.actions.openProposal(ctx.roomId, {
        documentId: doc.id,
        kind: a.kind,
        title: a.title,
        branchBase: a.branchBase,
        options: a.options,
        triggerMessageIds: a.triggerMessageIds,
        stale: a.stale,
      });
      return jsonResult({ proposalId: p.id, state: p.state, options: p.options.map((o) => ({ id: o.id, label: o.label, branch: o.branch })) });
    }),
  );

  const closeProposal = tool(
    'close_proposal',
    'Archive a proposal (never deletes): expired, rejected or abandoned. Include a note saying why.',
    { proposalId: z.string(), reason: z.enum(['expired', 'rejected', 'abandoned']), note: z.string().optional() },
    guard(ctx, 'close_proposal', async (a) => {
      const p = await ctx.actions.closeProposal(ctx.roomId, a.proposalId, a.reason, a.note);
      return textResult(`proposal ${p.id} is now ${p.state}`);
    }),
  );

  const requestMerge = tool(
    'request_merge',
    'Hand a proposal that has passed its vote to the merge pipeline. The server refuses unless the voting rule is satisfied.',
    { proposalId: z.string(), optionId: z.string() },
    guard(ctx, 'request_merge', async (a) => {
      await ctx.actions.requestMerge(ctx.roomId, a.proposalId, a.optionId);
      return textResult('merge requested');
    }),
  );

  const setStatus = tool(
    'set_status',
    'Show the room what you are doing (for example "Exploring PostgreSQL vs ClickHouse"). Return to idle when done.',
    { status: z.enum(['thinking', 'idle']), detail: z.string().optional() },
    guard(ctx, 'set_status', async (a) => {
      await ctx.actions.setAgentStatus(ctx.roomId, a.status, a.detail ?? null);
      return textResult('ok');
    }),
  );

  return [postChat, readTranscript, getRoomState, commitMain, resolveSuggestion, startExploration, openProposal, closeProposal, requestMerge, setStatus];
}
