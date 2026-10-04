import { describe, expect, it } from 'vitest';
import type { Proposal, Vote } from '@quorum/shared';
import { collapseReason, isArchived, tallyOption } from './proposalState';

const vote = (userId: string, optionId: string | null, decision: Vote['decision'] = 'approve') =>
  ({ proposalId: 'p', userId, optionId, decision, castAt: '' }) satisfies Vote;

describe('collapseReason', () => {
  it('collapses and labels archived proposals (rejected, expired, superseded, abandoned)', () => {
    for (const state of ['rejected', 'expired', 'superseded', 'abandoned'] as const) {
      const r = collapseReason({ state, stale: false });
      expect(r?.kind).toBe('archived');
      expect(r?.label).toContain(state);
      expect(isArchived({ state })).toBe(true);
    }
  });

  it('collapses and labels stale proposals that are still being decided', () => {
    for (const state of ['drafting', 'open', 'merging'] as const) {
      expect(collapseReason({ state, stale: true })?.kind).toBe('stale');
    }
    expect(collapseReason({ state: 'open', stale: true })?.label).toMatch(/still be voted on/);
  });

  it('shows everything else in full, and a merged proposal is history, not stale', () => {
    expect(collapseReason({ state: 'open', stale: false })).toBeNull();
    expect(collapseReason({ state: 'merged', stale: true })).toBeNull();
    expect(collapseReason({ state: 'reverted', stale: true })).toBeNull();
    expect(isArchived({ state: 'merged' })).toBe(false);
  });

  it('archived wins over stale', () => {
    expect(collapseReason({ state: 'expired', stale: true })?.kind).toBe('archived');
  });
});

describe('tallyOption', () => {
  const p = {
    votes: [vote('a', 'o1'), vote('b', 'o1'), vote('c', 'o2'), vote('d', null, 'reject')],
  } as Pick<Proposal, 'votes'>;

  it('counts only connected voters, and reports the others apart', () => {
    expect(tallyOption(p, 'o1', new Set(['a', 'b', 'c']))).toEqual({ counted: 2, away: 0 });
    expect(tallyOption(p, 'o1', new Set(['a']))).toEqual({ counted: 1, away: 1 });
    expect(tallyOption(p, 'o2', new Set())).toEqual({ counted: 0, away: 1 });
  });

  it('ignores rejections and other options', () => {
    expect(tallyOption(p, 'o3', new Set(['a', 'b', 'c', 'd']))).toEqual({ counted: 0, away: 0 });
    expect(tallyOption(p, undefined, new Set(['d']))).toEqual({ counted: 0, away: 0 });
  });
});
