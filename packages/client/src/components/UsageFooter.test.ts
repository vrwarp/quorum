import { describe, expect, it } from 'vitest';
import { usageTitle } from './UsageFooter';

describe('usageTitle', () => {
  it('reads the cost of each role from the shape the server sends', () => {
    expect(
      usageTitle({
        totalCostUsd: 1.6,
        byRole: {
          orchestrator: { costUsd: 1.2, inputTokens: 100, outputTokens: 10 },
          worker: { costUsd: 0.4, inputTokens: 50, outputTokens: 5 },
        },
      }),
    ).toBe('orchestrator $1.20, worker $0.40');
  });

  it('does not throw on an empty or unexpected answer', () => {
    expect(usageTitle(null)).toBe('');
    expect(usageTitle({ totalCostUsd: 0, byRole: {} })).toBe('');
    expect(usageTitle({ totalCostUsd: 0, byRole: { x: 2 } } as never)).toBe('x $2.00');
    expect(usageTitle({ totalCostUsd: 0, byRole: { x: null } } as never)).toBe('x $?');
  });
});
