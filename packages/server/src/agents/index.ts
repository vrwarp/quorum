import type { AgentRuntime, AgentRuntimeOptions, RoomActions } from '../contracts/index.js';
import { ClaudeRuntime, type ClaudeRuntimeDeps } from './claude/ClaudeRuntime.js';
import { FakeRuntime } from './fake/FakeRuntime.js';

export type { AgentRuntime, AgentRuntimeOptions, RoomActions } from '../contracts/index.js';
export { ClaudeRuntime } from './claude/ClaudeRuntime.js';
export type { ClaudeRuntimeDeps, ClaudeRuntimeOptions } from './claude/ClaudeRuntime.js';
export { FakeRuntime } from './fake/FakeRuntime.js';
export type { FakeScript } from './fake/FakeRuntime.js';

export type AgentRuntimeKind = 'fake' | 'claude';

/**
 * Builds the runtime selected by QUORUM_RUNTIME. The fake runtime needs no API key and no network.
 * For e2e runs, QUORUM_FAKE_EXPLORE_MS tunes how long fake explorations take (default 500).
 */
export function createAgentRuntime(
  kind: AgentRuntimeKind,
  actions: RoomActions,
  options: AgentRuntimeOptions & { anthropicApiKey?: string; maxBudgetUsd?: number },
  deps?: ClaudeRuntimeDeps,
): AgentRuntime {
  if (kind === 'fake') {
    const env = Number(process.env.QUORUM_FAKE_EXPLORE_MS);
    return new FakeRuntime(actions, options, Number.isFinite(env) && env >= 0 && process.env.QUORUM_FAKE_EXPLORE_MS ? { delays: { exploreMs: env } } : {});
  }
  return new ClaudeRuntime(actions, options, deps);
}
