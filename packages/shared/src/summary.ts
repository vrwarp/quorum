/** The length an agent message's summary aims for (the agent is told this; it is not cut there). */
export const SUMMARY_TARGET_CHARS = 140;
/** A summary longer than this is cut at a word boundary: the target is loose, this limit is not. */
export const SUMMARY_MAX_CHARS = 280;

/** Cuts `text` to at most `max` characters, at a word boundary when there is one nearby, with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The summary and body an agent message is stored with. `summary` is the gist, `details` the full text (markdown).
 * The summary is cut to SUMMARY_MAX_CHARS. When there are no details, or they say no more than the summary, the
 * message is just its text (`summary: null`): there is nothing to expand.
 */
export function summarizedMessage(input: { summary?: string | null; details?: string | null }): {
  body: string;
  summary: string | null;
} {
  const details = input.details?.trim() ?? '';
  const raw = input.summary?.trim() ?? '';
  if (!raw) return { body: details, summary: null };
  const summary = clip(raw, SUMMARY_MAX_CHARS);
  const plain = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (!details || plain(details) === plain(raw)) return { body: raw, summary: null };
  return { body: details, summary };
}
