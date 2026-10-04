/** Tunable defaults from the PRD (§13.3). All durations in milliseconds. */
export const DEFAULTS = {
  listenerDebounceMs: 3_000,
  listenerMaxWaitMs: 20_000,
  listenerConfidenceThreshold: 0.7,
  listenerCheckpointMessages: 100,
  /** immediate when a change rewrites/deletes at most this many existing paragraphs */
  immediateRewriteLimit: 3,
  reviewWindowMs: 2 * 60_000,
  digestAbsenceMs: 2 * 60_000,
  workerTimeoutMs: 5 * 60_000,
  workerMaxTurns: 60,
  expiryCheckMs: 5 * 60_000,
  recentMessagesInHello: 200,
  rehydrateMessages: 50,
} as const;

export const MODELS = {
  listener: 'claude-sonnet-5-5',
  orchestrator: 'claude-opus-5-5',
  worker: 'claude-sonnet-5-5',
  merge: 'claude-opus-5-5',
  digest: 'claude-sonnet-5-5',
} as const;

export const EFFORT = {
  listener: 'low',
  orchestrator: 'medium',
  worker: 'medium',
  merge: 'medium',
  digest: 'low',
} as const;

/** Commit trailer keys (PRD §4.2). */
export const TRAILERS = {
  actor: 'Quorum-Actor',
  trigger: 'Quorum-Trigger',
  proposal: 'Quorum-Proposal',
  reverts: 'Quorum-Reverts',
} as const;

/** Branch naming: <doc-slug>/<topic-slug>/<option> */
export function proposalBranchName(docSlug: string, topicSlug: string, option: string): string {
  return `${docSlug}/${topicSlug}/${option}`;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.md$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'doc'
  );
}
