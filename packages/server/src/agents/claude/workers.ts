import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  EFFORT,
  MODELS,
  slugify,
  proposalBranchName,
  type Change,
  type MessageId,
  type OptionId,
  type Proposal,
  type RoomId,
  type Sha,
  type UsageRecord,
  type UserId,
} from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import {
  WORKER_ACTOR,
  errMessage,
  hasConflictMarkers,
  shortSha,
  type Logger,
  type Tunables,
} from '../common.js';
import { DIGEST_SYSTEM, MERGE_SYSTEM, REVERT_SYSTEM, WORKER_SYSTEM } from '../prompts.js';
import type { StatusSink } from '../status.js';
import { compactMessage } from './events.js';
import { makeCanUseTool } from './permissions.js';
import {
  AssistantUsage,
  UsageTracker,
  drainQuery,
  recordAssistantUsage,
  recordResultUsage,
  sdkProcessOptions,
  type ClaudeProcessConfig,
  type QueryFn,
} from './sdk.js';
import {
  createQuorumServer,
  mcpToolNames,
  readOnlyTools,
  type ExplorationRequest,
} from './tools.js';
import { dirtyFiles, enforceScope, restoreFiles } from './worktree.js';

/** Shared environment for every one-shot Agent SDK session. */
export interface WorkerEnv {
  roomId: RoomId;
  actions: RoomActions;
  queryFn: QueryFn;
  logger: Logger;
  tunables: Tunables;
  dataDir: string;
  /** how the Claude Code subprocess is launched and authenticated (binary, credential environment, API key) */
  claude?: ClaudeProcessConfig;
  maxBudgetUsd?: number;
  /** aborts the session (room stopped) */
  signal?: AbortSignal;
  /** the room's status board, so long-running work shows as "thinking" with a detail */
  status?: StatusSink;
}

// --- structured outputs ---------------------------------------------------------------------

export const WorkerOutputSchema = z.object({
  summary: z.string(),
  tradeoffs: z.string(),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  sourcesConsulted: z.array(z.string()).default([]),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

export const WorkerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tradeoffs', 'assumptions', 'openQuestions', 'sourcesConsulted'],
  properties: {
    summary: { type: 'string' },
    tradeoffs: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    sourcesConsulted: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const MergeOutputSchema = z.object({ reconciled: z.boolean(), summary: z.string() });
export const MergeOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reconciled', 'summary'],
  properties: { reconciled: { type: 'boolean' }, summary: { type: 'string' } },
} as const;

// --- one-shot runner with timeout -----------------------------------------------------------

interface OneShotResult {
  result: Awaited<ReturnType<typeof drainQuery>>;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

/**
 * Runs a query with a wall-clock abort (`workerTimeoutMs`) and records its usage. Never throws; reports
 * timeout/abort/error in the result.
 *
 * On timeout the query's AbortController is aborted AND the wait is abandoned (raced against the signal), so a session
 * that ignores the abort cannot hold the caller past the cap; the query is then closed, which terminates the Claude
 * Code subprocess. Usage is recorded from the result message when there is one, and from the assistant messages seen
 * so far when the session was cut off before producing one.
 */
async function runOneShot(
  env: WorkerEnv,
  role: UsageRecord['role'],
  model: string,
  params: Parameters<QueryFn>[0] & { options: Options },
): Promise<OneShotResult> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, env.tunables.workerTimeoutMs);
  const onParentAbort = () => ac.abort();
  if (env.signal?.aborted) ac.abort();
  else env.signal?.addEventListener('abort', onParentAbort, { once: true });

  const usage = new AssistantUsage();
  let q: ReturnType<QueryFn> | null = null;
  let result: OneShotResult['result'] = null;
  let error: string | undefined;
  try {
    q = env.queryFn({
      ...params,
      options: { ...params.options, ...sdkProcessOptions(env.claude), abortController: ac },
    });
    const drained = drainQuery(q, (m) => usage.observe(m));
    drained.catch(() => undefined); // it may settle after we stopped waiting for it
    const cut = new Promise<null>((resolve) => {
      if (ac.signal.aborted) resolve(null);
      else ac.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    result = await Promise.race([drained, cut]);
  } catch (e) {
    if (!ac.signal.aborted) error = errMessage(e);
  } finally {
    clearTimeout(timer);
    env.signal?.removeEventListener('abort', onParentAbort);
    try {
      q?.close?.();
    } catch {
      /* already closed */
    }
  }
  if (result)
    await recordResultUsage(env.actions, env.roomId, role, result, new UsageTracker(), model);
  else if (!usage.empty) await recordAssistantUsage(env.actions, env.roomId, role, usage);
  return { result, timedOut, aborted: ac.signal.aborted && !timedOut, error };
}

function structuredOr<T>(result: OneShotResult['result'], schema: z.ZodType<T>): T | null {
  if (!result || result.subtype !== 'success') return null;
  const parsed = schema.safeParse(result.structured_output);
  if (parsed.success) return parsed.data;
  // some runs put the JSON in the result text
  try {
    const fromText = schema.safeParse(JSON.parse(result.result));
    if (fromText.success) return fromText.data;
  } catch {
    /* not json */
  }
  return null;
}

const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

// --- exploration worker ---------------------------------------------------------------------

export interface ExplorationParams {
  repo: RoomRepository;
  documentPath: string;
  branch: string;
  thesis: string;
  context: string;
  triggerMessageIds?: MessageId[];
  /** ref to fork the branch from (default main). start_exploration passes one sha for every worker. */
  fromRef?: string;
}

export interface ExplorationResult extends WorkerOutput {
  branch: string;
  thesis: string;
  baseSha: Sha;
  /** branch head after the worker's work was committed */
  headSha: Sha | null;
  /** true if the server committed uncommitted edits left in the worktree */
  committed: boolean;
  /** the branch differs from its base: there is a draft to propose */
  changed: boolean;
  /** files outside the assigned document that the session touched and the server reverted */
  scopeReverted?: string[];
  timedOut: boolean;
  error?: string;
}

export async function runExplorationWorker(
  env: WorkerEnv,
  p: ExplorationParams,
): Promise<ExplorationResult> {
  const { worktreePath, baseSha } = await p.repo.createBranch(p.branch, p.fromRef);
  const tools = readOnlyTools({
    roomId: env.roomId,
    actions: env.actions,
    repo: p.repo,
    logger: env.logger,
  });
  const mcpNames = mcpToolNames(tools);
  const prompt = [
    `Document: ${p.documentPath}`,
    `Branch: ${p.branch} (your working directory is its worktree)`,
    `Thesis: ${p.thesis}`,
    p.context ? `\nContext:\n${p.context}` : '',
    `\nDraft the change to ${p.documentPath} under this thesis, then return the structured summary.`,
  ].join('\n');

  const run = await runOneShot(env, 'worker', MODELS.worker, {
    prompt,
    options: {
      model: MODELS.worker,
      effort: EFFORT.worker,
      cwd: worktreePath,
      systemPrompt: WORKER_SYSTEM,
      tools: [...BUILTIN_TOOLS, 'WebSearch', 'WebFetch'],
      canUseTool: makeCanUseTool({
        cwd: worktreePath,
        allowWeb: true,
        allowedMcpTools: mcpNames,
        writableFiles: [p.documentPath],
      }),
      mcpServers: { quorum: createQuorumServer(tools) },
      maxTurns: env.tunables.workerMaxTurns,
      maxBudgetUsd: env.maxBudgetUsd,
      outputFormat: {
        type: 'json_schema',
        schema: WorkerOutputJsonSchema as unknown as Record<string, unknown>,
      },
      permissionMode: 'default',
      settingSources: [],
      persistSession: false,
    },
  });

  // The branch is reported even after a timeout: keep whatever the worker left behind in its document and commit it.
  let scopeReverted: string[] = [];
  let committed = false;
  let commitError: string | undefined;
  try {
    // Scope rule (PRD 4.1): a branch changes exactly its document. The permission policy already confines writes;
    // this reverts anything that slipped through so open_proposal's scope check cannot fail on a worker's branch.
    scopeReverted = await enforceScope(p.repo, worktreePath, p.branch, [p.documentPath]);
    if (scopeReverted.length > 0)
      env.logger('warn', 'worker touched files outside its document; reverted', {
        branch: p.branch,
        files: scopeReverted,
      });
    const sha = await p.repo.commitWorktree(worktreePath, `Draft: ${truncate(p.thesis, 60)}`, {
      actor: WORKER_ACTOR,
      triggerMessageIds: p.triggerMessageIds ?? [],
    });
    committed = sha !== null;
  } catch (e) {
    commitError = errMessage(e);
    env.logger('warn', 'worker commit failed', { branch: p.branch, error: commitError });
  }
  const headSha = await p.repo.headSha(p.branch);

  const out = structuredOr(run.result, WorkerOutputSchema);
  const error =
    run.error ??
    commitError ??
    (run.result && run.result.subtype !== 'success'
      ? `worker ended with ${run.result.subtype}`
      : undefined);
  const fallbackSummary = run.timedOut
    ? `The worker timed out after ${Math.round(env.tunables.workerTimeoutMs / 1000)}s; the branch holds its partial work.`
    : run.aborted
      ? 'The worker was cancelled; the branch holds its partial work.'
      : run.result?.subtype === 'success' && run.result.result
        ? run.result.result
        : `The worker did not finish${error ? `: ${error}` : ''}.`;
  return {
    branch: p.branch,
    thesis: p.thesis,
    baseSha,
    headSha,
    committed,
    changed: headSha !== null && headSha !== baseSha,
    ...(scopeReverted.length > 0 ? { scopeReverted } : {}),
    timedOut: run.timedOut,
    ...(error ? { error } : {}),
    summary: out?.summary ?? fallbackSummary,
    tradeoffs: out?.tradeoffs ?? '',
    assumptions: out?.assumptions ?? [],
    openQuestions: out?.openQuestions ?? [],
    sourcesConsulted: out?.sourcesConsulted ?? [],
  };
}

export interface ExplorationOutcome {
  /** the sha every branch was forked from; pass it to open_proposal as branchBase */
  branchBase: Sha | null;
  workers: Array<ExplorationResult & { label: string }>;
  /** theses whose worker could not be started or crashed outright */
  failures: Array<{ thesis: string; error: string }>;
  /** What the room said while the workers ran (PRD 6.5): read it before posting a Quorum card and open the proposal
   *  with stale: true if the topic was resolved or abandoned in the meantime. */
  chatSinceStart: Array<Record<string, unknown>>;
}

/**
 * start_exploration: one worker per thesis, on branches <doc>/<topic>/a, b, c ... Runs them in parallel. All branches
 * fork from the same main sha (read once), so the proposal has a single, consistent base even if main moves meanwhile.
 */
export async function runExploration(
  env: WorkerEnv,
  repo: RoomRepository,
  req: ExplorationRequest,
): Promise<ExplorationOutcome> {
  const docSlug = slugify(req.documentPath);
  const topic = slugify(req.topic);
  const existing = new Set(await repo.listBranches());
  let topicSlug = topic;
  for (let n = 2; existing.has(proposalBranchName(docSlug, topicSlug, 'a')); n++)
    topicSlug = `${topic}-${n}`;

  const baseSha = await repo.headSha('main');
  if (!baseSha) throw new Error('main has no commits');
  const [lastMessage] = await env.actions.readTranscript(env.roomId, { limit: 1 });
  const startMarker = lastMessage?.id ?? null;
  const recent = await env.actions.readTranscript(env.roomId, { limit: 15 });
  const context = [
    req.context ?? '',
    recent.length > 0
      ? `Recent chat:\n${recent.map((m) => `[${m.id}] ${String(compactMessage(m).from)}: ${m.body}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const statusKey = `exploration:${topicSlug}`;
  env.status?.busy(statusKey, `Exploring ${req.topic}`);
  let settled: PromiseSettledResult<ExplorationResult & { label: string }>[];
  try {
    settled = await Promise.allSettled(
      req.theses.map((thesis, i) => {
        const label = String.fromCharCode('a'.charCodeAt(0) + i);
        return runExplorationWorker(env, {
          repo,
          documentPath: req.documentPath,
          branch: proposalBranchName(docSlug, topicSlug, label),
          thesis,
          context,
          triggerMessageIds: req.triggerMessageIds,
          fromRef: baseSha,
        }).then((r) => ({ ...r, label: label.toUpperCase() }));
      }),
    );
  } finally {
    env.status?.done(statusKey);
  }
  const workers: ExplorationOutcome['workers'] = [];
  const failures: ExplorationOutcome['failures'] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      workers.push(s.value);
      return;
    }
    env.logger('error', 'exploration worker failed', {
      thesis: req.theses[i],
      error: errMessage(s.reason),
    });
    failures.push({ thesis: req.theses[i]!, error: errMessage(s.reason) });
  });

  let chatSinceStart: Array<Record<string, unknown>> = [];
  if (startMarker) {
    try {
      chatSinceStart = (
        await env.actions.readTranscript(env.roomId, { sinceMessageId: startMarker, limit: 50 })
      ).map(compactMessage);
    } catch (e) {
      env.logger('warn', 'could not read the transcript after the exploration', {
        error: errMessage(e),
      });
    }
  }
  return { branchBase: baseSha, workers, failures, chatSinceStart };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// --- merge driver ---------------------------------------------------------------------------

export interface MergeInput {
  proposal: Proposal;
  optionId: OptionId;
  worktreePath: string;
  conflictedFiles: string[];
  documentPath: string;
}

export async function runMergeDriver(
  env: WorkerEnv,
  input: MergeInput,
): Promise<{ reconciled: boolean; summary: string }> {
  const option = input.proposal.options.find((o) => o.id === input.optionId);
  const files = [...new Set([input.documentPath, ...input.conflictedFiles])];
  const prompt = [
    `Proposal: ${input.proposal.title} (option ${option?.label ?? input.optionId}, branch ${option?.branch ?? 'unknown'})`,
    `Document: ${input.documentPath}`,
    input.conflictedFiles.length > 0
      ? `Files with conflict markers: ${input.conflictedFiles.join(', ')}`
      : 'git merged without textual conflicts; review the result for semantic contradictions.',
    '',
    'Leave the merged document clean in the working directory, then report the structured result.',
  ].join('\n');

  const statusKey = `merge:${input.proposal.id}`;
  env.status?.busy(statusKey, `Merging ${input.proposal.title}`);
  let run: OneShotResult;
  try {
    run = await runOneShot(env, 'merge', MODELS.merge, {
      prompt,
      options: {
        model: MODELS.merge,
        effort: EFFORT.merge,
        cwd: input.worktreePath,
        systemPrompt: MERGE_SYSTEM,
        tools: BUILTIN_TOOLS,
        canUseTool: makeCanUseTool({ cwd: input.worktreePath, writableFiles: files }),
        maxTurns: env.tunables.workerMaxTurns,
        maxBudgetUsd: env.maxBudgetUsd,
        outputFormat: {
          type: 'json_schema',
          schema: MergeOutputJsonSchema as unknown as Record<string, unknown>,
        },
        permissionMode: 'default',
        settingSources: [],
        persistSession: false,
      },
    });
  } finally {
    env.status?.done(statusKey);
  }
  if (run.timedOut) throw new Error('merge driver timed out');
  if (run.aborted) throw new Error('merge driver was cancelled');
  if (run.error) throw new Error(`merge driver failed: ${run.error}`);
  if (!run.result || run.result.subtype !== 'success')
    throw new Error(`merge driver ended with ${run.result?.subtype ?? 'no result'}`);

  assertNoMarkers(input.worktreePath, files, 'merge driver');
  const out = structuredOr(run.result, MergeOutputSchema);
  return (
    out ?? { reconciled: input.conflictedFiles.length > 0, summary: run.result.result || 'Merged.' }
  );
}

/** Conflict markers must never reach main (PRD 4.5). */
function assertNoMarkers(dir: string, files: string[], who: string): void {
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    if (hasConflictMarkers(readFileSync(path, 'utf8')))
      throw new Error(`${who} left conflict markers in ${f}`);
  }
}

// --- semantic revert ------------------------------------------------------------------------

export async function runSemanticRevert(
  env: WorkerEnv,
  repo: RoomRepository,
  input: { change: Change; byUserId: UserId },
): Promise<Sha> {
  const info = await repo.show(input.change.sha);
  const state = await env.actions.getRoomState(env.roomId);
  const displayName =
    state.participants.find((p) => p.userId === input.byUserId)?.displayName ?? input.byUserId;
  const doc = state.documents.find((d) => d.id === input.change.documentId);
  const files = doc ? [doc.path] : info.files;
  const prompt = [
    `Undo commit ${input.change.sha} ("${info.subject}") in ${files.join(', ')}.`,
    `It was recorded as: ${input.change.summary}`,
    'A plain git revert conflicted with later edits. Use `git show` to see the change, then edit the working copy by hand.',
  ].join('\n');

  // The edit happens in the main worktree, so it holds the write queue for the whole run.
  return repo.withMainLock(async () => {
    const statusKey = `revert:${shortSha(input.change.sha)}`;
    env.status?.busy(statusKey, 'Reverting a change');
    try {
      const run = await runOneShot(env, 'merge', MODELS.merge, {
        prompt,
        options: {
          model: MODELS.merge,
          effort: EFFORT.merge,
          cwd: repo.mainWorktree,
          systemPrompt: REVERT_SYSTEM,
          tools: BUILTIN_TOOLS,
          canUseTool: makeCanUseTool({ cwd: repo.mainWorktree, writableFiles: files }),
          maxTurns: env.tunables.workerMaxTurns,
          maxBudgetUsd: env.maxBudgetUsd,
          outputFormat: {
            type: 'json_schema',
            schema: MergeOutputJsonSchema as unknown as Record<string, unknown>,
          },
          permissionMode: 'default',
          settingSources: [],
          persistSession: false,
        },
      });
      if (run.timedOut) throw new Error('semantic revert timed out');
      if (run.aborted) throw new Error('semantic revert was cancelled');
      if (run.error) throw new Error(`semantic revert failed: ${run.error}`);
      if (!run.result || run.result.subtype !== 'success')
        throw new Error(`semantic revert ended with ${run.result?.subtype ?? 'no result'}`);
      const stray = await enforceScope(repo, repo.mainWorktree, 'main', files);
      if (stray.length > 0)
        env.logger('warn', 'semantic revert touched other files; reverted', { files: stray });
      assertNoMarkers(repo.mainWorktree, files, 'semantic revert');

      const sha = await repo.commitWorktree(
        repo.mainWorktree,
        `Revert ${shortSha(input.change.sha)}: ${info.subject}`,
        {
          actor: { kind: 'user', userId: input.byUserId, displayName },
          triggerMessageIds: input.change.triggerMessageIds,
          revertsSha: input.change.sha,
        },
      );
      if (!sha) throw new Error('semantic revert changed nothing');
      return sha;
    } catch (e) {
      // A failed run must not leave half-reverted text in the main worktree for the next commit to sweep up.
      try {
        await restoreFiles(
          repo,
          repo.mainWorktree,
          'main',
          await dirtyFiles(repo, repo.mainWorktree, 'main'),
        );
      } catch (cleanup) {
        env.logger('warn', 'could not clean the main worktree after a failed semantic revert', {
          error: errMessage(cleanup),
        });
      }
      throw e;
    } finally {
      env.status?.done(statusKey);
    }
  });
}

// --- digest ---------------------------------------------------------------------------------

export async function writeDigest(
  env: WorkerEnv,
  repo: RoomRepository,
  input: { userId: UserId; sinceMessageId: MessageId | null; events: string[] },
): Promise<string> {
  const tools = readOnlyTools({
    roomId: env.roomId,
    actions: env.actions,
    repo,
    logger: env.logger,
  }).filter((t) => t.name === 'read_transcript');
  const mcpNames = mcpToolNames(tools);
  const prompt = [
    input.sinceMessageId
      ? `The participant last saw message ${input.sinceMessageId}. Read what came after it.`
      : 'Read the transcript from the start of the room.',
    'Events while they were away:',
    ...(input.events.length > 0 ? input.events.map((e) => `- ${e}`) : ['- (none recorded)']),
  ].join('\n');

  const run = await runOneShot(env, 'digest', MODELS.digest, {
    prompt,
    options: {
      model: MODELS.digest,
      effort: EFFORT.digest,
      cwd: env.dataDir,
      systemPrompt: DIGEST_SYSTEM,
      tools: [],
      canUseTool: makeCanUseTool({ cwd: env.dataDir, allowedMcpTools: mcpNames, mcpOnly: true }),
      mcpServers: { quorum: createQuorumServer(tools) },
      maxTurns: 8,
      maxBudgetUsd: env.maxBudgetUsd,
      permissionMode: 'default',
      settingSources: [],
      persistSession: false,
    },
  });
  if (run.timedOut) throw new Error('digest writer timed out');
  if (run.aborted) throw new Error('digest writer was cancelled');
  if (run.error) throw new Error(`digest writer failed: ${run.error}`);
  if (!run.result || run.result.subtype !== 'success' || run.result.is_error)
    throw new Error(`digest writer ended with ${run.result?.subtype ?? 'no result'}`);
  return run.result.result.trim();
}
