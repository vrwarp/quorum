import type { Proposal, ProposalState } from '@quorum/shared';

/** Closed without merging: the branch is kept and the card collapses (PRD 7.4). */
export const ARCHIVED_STATES: readonly ProposalState[] = [
  'rejected',
  'expired',
  'superseded',
  'abandoned',
];
export const MERGED_STATES: readonly ProposalState[] = ['merged', 'reverted'];

export function isArchived(p: Pick<Proposal, 'state'>): boolean {
  return ARCHIVED_STATES.includes(p.state);
}

export interface CollapseReason {
  kind: 'archived' | 'stale';
  /** the label shown on the collapsed card */
  label: string;
}

/**
 * Why a proposal card renders collapsed (PRD 6.5 stale, 7.4 archived), or null when it renders in full. A merged
 * proposal is history, not stale, whatever its flag says.
 */
export function collapseReason(p: Pick<Proposal, 'state' | 'stale'>): CollapseReason | null {
  if (isArchived(p)) {
    return { kind: 'archived', label: `Archived (${p.state}). The branch is kept.` };
  }
  if (p.stale && !MERGED_STATES.includes(p.state)) {
    return {
      kind: 'stale',
      label: 'Stale: the room moved on while this was being worked out. It can still be voted on.',
    };
  }
  return null;
}

/**
 * Approvals of one option, split by whether the voter is connected. Only connected voters count toward the rule
 * (PRD 7.3: eligibility is who is connected at evaluation), so the card shows those as the tally and the rest apart.
 */
export function tallyOption(
  proposal: Pick<Proposal, 'votes'>,
  optionId: string | undefined,
  connected: ReadonlySet<string>,
): { counted: number; away: number } {
  let counted = 0;
  let away = 0;
  for (const v of proposal.votes) {
    if (v.decision !== 'approve' || v.optionId !== optionId) continue;
    if (connected.has(v.userId)) counted++;
    else away++;
  }
  return { counted, away };
}
