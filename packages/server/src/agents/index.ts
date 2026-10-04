import type { AgentRuntime, RoomActions } from '../contracts/index.js';
import {
  ClaudeRuntime,
  type ClaudeRuntimeDeps,
  type ClaudeRuntimeOptions,
} from './claude/ClaudeRuntime.js';
import { FakeRuntime } from './fake/FakeRuntime.js';

export type { AgentRuntime, AgentRuntimeOptions, RoomActions } from '../contracts/index.js';
export { ClaudeRuntime } from './claude/ClaudeRuntime.js';
export type { ClaudeRuntimeDeps, ClaudeRuntimeOptions } from './claude/ClaudeRuntime.js';
export { FakeRuntime } from './fake/FakeRuntime.js';
export type { FakeScript } from './fake/FakeRuntime.js';

export type AgentRuntimeKind = 'fake' | 'claude';

/**
 * Builds the runtime selected by QUORUM_RUNTIME. The fake runtime needs no API key and no network, and ignores every
 * Claude option. For e2e runs, QUORUM_FAKE_EXPLORE_MS tunes how long fake explorations take (default 500).
 *
 * `options` for the claude runtime (see ClaudeRuntimeOptions):
 * - `anthropicApiKey`, `maxBudgetUsd`: API key and per-session spending cap (the SDK counts a cap per `query()`: the
 *   orchestrator and the merge driver get it whole, exploration workers a quarter of it, at least $1, and the digest
 *   writer $0.50; `workerBudgetUsd` overrides the worker share);
 * - `claudeBinary`: the Claude Code executable the Agent SDK launches (`pathToClaudeCodeExecutable`);
 * - `claudeEnv()`: credential environment merged over `process.env` for every `query()` (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN);
 * - `claudeAvailable()`: false while there is no credential, which makes the agent "unavailable" (no model work);
 * - `onCredentialsChanged(listener)`: sign-in / sign-out notifications; sessions restart or stop accordingly;
 * - `sandbox`: Bash isolation in agent sessions, 'auto' (default; needs bubblewrap on Linux and otherwise runs without,
 *   with a CLI warning), 'required' (such a session fails) or 'off';
 * - `idleAfterMs`, `idleCheckMs`: a room with nobody connected and nothing in flight is stopped after `idleAfterMs`
 *   (default 15 minutes, 0 = never) and starts again with the next event.
 */
export function createAgentRuntime(
  kind: AgentRuntimeKind,
  actions: RoomActions,
  options: ClaudeRuntimeOptions,
  deps?: ClaudeRuntimeDeps,
): AgentRuntime {
  if (kind === 'fake') {
    const env = Number(process.env.QUORUM_FAKE_EXPLORE_MS);
    return new FakeRuntime(
      actions,
      options,
      Number.isFinite(env) && env >= 0 && process.env.QUORUM_FAKE_EXPLORE_MS
        ? { delays: { exploreMs: env } }
        : {},
    );
  }
  return new ClaudeRuntime(actions, options, deps);
}
