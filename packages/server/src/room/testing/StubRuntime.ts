import type { Change, Message, OptionId, Proposal, Sha, UserId } from '@quorum/shared';
import type { AgentRuntime } from '../../contracts/index.js';

type Event = Parameters<AgentRuntime['onProposalEvent']>[1];

/** Records calls; behaviors are overridable per test. */
export class StubRuntime implements AgentRuntime {
  chat: Message[] = [];
  suggestions: Message[] = [];
  asks: Message[] = [];
  proposalEvents: Event[] = [];
  reverted: Array<{ change: Change; revertSha: Sha; byUserId: UserId }> = [];
  started: string[] = [];
  digests: Array<{ userId: UserId; events: string[] }> = [];
  mergeDriverCalls: Array<{ proposal: Proposal; optionId: OptionId; worktreePath: string }> = [];
  /** set to make the runtime misbehave */
  throwEverywhere = false;
  mergeDriver: (input: {
    worktreePath: string;
  }) => Promise<{ reconciled: boolean; summary: string }> = async () => ({
    reconciled: true,
    summary: 'reconciled by stub',
  });
  semanticRevert: (input: { change: Change; byUserId: UserId }) => Promise<Sha> = async () => {
    throw new Error('semantic revert not configured');
  };
  digestText = 'Here is what you missed.';

  private maybeThrow(): void {
    if (this.throwEverywhere) throw new Error('stub runtime exploded');
  }
  async startRoom(roomId: string) {
    this.maybeThrow();
    this.started.push(roomId);
  }
  async stopRoom() {}
  async stopAll() {}
  onChatMessage(_r: string, m: Message) {
    this.maybeThrow();
    this.chat.push(m);
  }
  onSuggestion(_r: string, m: Message) {
    this.maybeThrow();
    this.suggestions.push(m);
  }
  onAsk(_r: string, m: Message) {
    this.maybeThrow();
    this.asks.push(m);
  }
  onProposalEvent(_r: string, e: Event) {
    this.maybeThrow();
    this.proposalEvents.push(e);
  }
  onReverted(_r: string, change: Change, revertSha: Sha, byUserId: UserId) {
    this.maybeThrow();
    this.reverted.push({ change, revertSha, byUserId });
  }
  async runMergeDriver(
    _r: string,
    input: { proposal: Proposal; optionId: OptionId; worktreePath: string },
  ) {
    this.mergeDriverCalls.push(input);
    return this.mergeDriver(input);
  }
  async runSemanticRevert(_r: string, input: { change: Change; byUserId: UserId }) {
    return this.semanticRevert(input);
  }
  async writeDigest(_r: string, input: { userId: UserId; events: string[] }) {
    this.maybeThrow();
    this.digests.push({ userId: input.userId, events: input.events });
    return this.digestText;
  }
}
