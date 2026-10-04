/**
 * Whether the reason the agent is unavailable is that it has no Claude credential (the server words it "Sign in to
 * Claude in Settings"), which the Settings screen can fix. Any other reason (billing, a spending limit, a failing
 * session) is shown as the server wrote it, with no link.
 */
export function needsSignIn(detail: string | null): boolean {
  return !!detail && /\bsign(ed|ing)?[ -]?in\b/i.test(detail);
}
