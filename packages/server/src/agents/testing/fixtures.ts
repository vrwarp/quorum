import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Change, Proposal, ProposalOption } from '@quorum/shared';
import type { AgentRuntimeOptions } from '../../contracts/index.js';

/** Tunable overrides for tests: DEFAULTS is `as const`, so plain numbers need a cast to fit AgentRuntimeOptions['tunables']. */
export function tunables(over: Record<string, number>): AgentRuntimeOptions['tunables'] {
  return over as AgentRuntimeOptions['tunables'];
}

/** Calls a permission callback the way the SDK does and returns its decision (the callback never answers null here). */
export async function decide(
  can: CanUseTool,
  tool: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const result = await can(tool, input, {
    signal: new AbortController().signal,
  } as Parameters<CanUseTool>[2]);
  if (!result) throw new Error('permission callback returned null');
  return result;
}

export function makeOption(over: Partial<ProposalOption> = {}): ProposalOption {
  return {
    id: 'opt_a',
    proposalId: 'prop_1',
    label: 'A',
    branch: 'architecture/storage/a',
    summary: 'Use PostgreSQL',
    tradeoffs: 'Simple',
    headSha: 'a'.repeat(40),
    ...over,
  };
}

export function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop_1',
    roomId: 'room_test',
    documentId: 'doc_1',
    kind: 'quorum',
    state: 'open',
    title: 'PostgreSQL vs ClickHouse',
    branchBase: 'b'.repeat(40),
    options: [
      makeOption(),
      makeOption({
        id: 'opt_b',
        label: 'B',
        branch: 'architecture/storage/b',
        summary: 'Use ClickHouse',
      }),
    ],
    votes: [],
    windowClosesAt: null,
    stale: false,
    reconciled: false,
    mergedOptionId: null,
    mergeSha: null,
    triggerMessageIds: ['msg_1', 'msg_2'],
    cardMessageId: 'msg_card',
    openedAt: '2026-10-04T10:00:00.000Z',
    closedAt: null,
    createdAt: '2026-10-04T10:00:00.000Z',
    ...over,
  };
}

export function makeChange(over: Partial<Change> = {}): Change {
  return {
    sha: 'c'.repeat(40),
    roomId: 'room_test',
    documentId: 'doc_1',
    actor: { kind: 'agent', role: 'orchestrator' },
    summary: 'Added a latency section',
    triggerMessageIds: ['msg_1'],
    proposalId: null,
    revertsSha: null,
    revertedBySha: null,
    createdAt: '2026-10-04T10:00:00.000Z',
    ...over,
  };
}
