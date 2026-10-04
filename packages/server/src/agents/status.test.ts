import { describe, expect, it } from 'vitest';
import { createStubActions } from './testing/stubActions.js';
import { MemoryRepo } from './testing/memoryRepo.js';
import { StatusBoard } from './status.js';

function board() {
  const stub = createStubActions({ repo: new MemoryRepo() });
  const logs: string[] = [];
  const b = new StatusBoard(stub.roomId, stub.actions, (level, msg) =>
    logs.push(`${level}:${msg}`),
  );
  return { stub, b, logs };
}

describe('StatusBoard', () => {
  it('publishes nothing until something changes, and only changes', async () => {
    const { stub, b } = board();
    b.done('orchestrator');
    b.recover('credentials');
    await b.settled();
    expect(stub.statuses).toEqual([]);

    b.busy('orchestrator');
    b.busy('orchestrator'); // same effective status: not repeated
    b.done('orchestrator');
    await b.settled();
    expect(stub.statuses).toEqual([
      { status: 'thinking', detail: null },
      { status: 'idle', detail: null },
    ]);
  });

  it('shows the latest detail while thinking and stays thinking until every source is done', async () => {
    const { stub, b } = board();
    b.busy('orchestrator', null);
    b.busy('exploration:storage', 'Exploring PostgreSQL vs ClickHouse');
    b.done('orchestrator');
    expect(b.current).toEqual({ status: 'thinking', detail: 'Exploring PostgreSQL vs ClickHouse' });
    b.done('exploration:storage');
    await b.settled();
    expect(stub.statuses.map((s) => [s.status, s.detail])).toEqual([
      ['thinking', null],
      ['thinking', 'Exploring PostgreSQL vs ClickHouse'],
      ['idle', null],
    ]);
  });

  it('unavailable wins over thinking, and the first failure is the one shown', async () => {
    const { stub, b } = board();
    b.busy('orchestrator');
    b.fail('credentials', 'Sign in to Claude in Settings');
    b.fail('listener', 'The listener is failing');
    expect(b.current).toEqual({ status: 'unavailable', detail: 'Sign in to Claude in Settings' });
    b.recover('credentials');
    expect(b.current).toEqual({ status: 'unavailable', detail: 'The listener is failing' });
    b.recover('listener');
    expect(b.current).toEqual({ status: 'thinking', detail: null });
    await b.settled();
    expect(stub.statuses.map((s) => [s.status, s.detail])).toEqual([
      ['thinking', null],
      ['unavailable', 'Sign in to Claude in Settings'],
      ['unavailable', 'The listener is failing'],
      ['thinking', null],
    ]);
  });

  it('reset clears everything and can leave one failure, publishing once', async () => {
    const { stub, b } = board();
    b.busy('orchestrator');
    b.fail('listener', 'x');
    b.reset({ key: 'credentials', detail: 'Sign in to Claude in Settings' });
    await b.settled();
    expect(stub.statuses.at(-1)).toEqual({
      status: 'unavailable',
      detail: 'Sign in to Claude in Settings',
    });
    b.reset();
    await b.settled();
    expect(stub.statuses.at(-1)).toEqual({ status: 'idle', detail: null });
  });

  it('delivers pushes in order and survives a failing setAgentStatus', async () => {
    const { stub, b, logs } = board();
    let n = 0;
    stub.actions.setAgentStatus = async (_room, status, detail) => {
      n += 1;
      if (n === 1) throw new Error('socket closed');
      stub.statuses.push({ status, detail });
    };
    b.busy('a');
    b.done('a');
    b.busy('a');
    await b.settled();
    expect(stub.statuses.map((s) => s.status)).toEqual(['idle', 'thinking']);
    expect(logs).toEqual(['warn:setAgentStatus failed']);
  });
});
