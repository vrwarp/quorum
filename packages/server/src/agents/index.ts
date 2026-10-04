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
 * - `anthropicApiKey`, `maxBudgetUsd`: API key and per-session spending cap;
 * - `claudeBinary`: the Claude Code executable the Agent SDK launches (`pathToClaudeCodeExecutable`);
 * - `claudeEnv()`: credential environment merged over `process.env` for every `query()` (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN);
 * - `claudeAvailable()`: false while there is no credential, which makes the agent "unavailable" (no model work);
 * - `onCredentialsChanged(listener)`: sign-in / sign-out notifications; sessions restart or stop accordingly.
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
