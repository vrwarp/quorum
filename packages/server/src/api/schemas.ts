import { z } from 'zod';
import type { ClientCommand } from '@quorum/shared';

const id = z.string().min(1).max(200);
const cid = z.string().max(100).optional();

export const AnchorSchema = z.object({
  documentId: id,
  baseSha: z.string().min(1).max(100),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  textHash: z.string().max(100),
  text: z.string().max(100_000),
});

export const ClientCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.send'), cid, body: z.string().min(1).max(20_000) }),
  z.object({
    type: z.literal('suggestion.create'),
    cid,
    anchor: AnchorSchema,
    replacement: z.string().max(100_000),
    note: z.string().max(2_000).optional(),
  }),
  z.object({
    type: z.literal('ask.create'),
    cid,
    anchor: AnchorSchema,
    question: z.string().min(1).max(5_000),
  }),
  z.object({
    type: z.literal('vote.cast'),
    cid,
    proposalId: id,
    decision: z.enum(['approve', 'reject']),
    optionId: id.optional(),
  }),
  z.object({ type: z.literal('revert.request'), cid, sha: z.string().min(4).max(100) }),
  z.object({ type: z.literal('document.create'), cid, title: z.string().min(1).max(120) }),
  z.object({
    type: z.literal('document.rename'),
    cid,
    documentId: id,
    title: z.string().min(1).max(120),
  }),
  z.object({ type: z.literal('document.archive'), cid, documentId: id }),
  z.object({ type: z.literal('room.setRule'), cid, votingRule: z.enum(['unanimous', 'majority']) }),
]);

// compile-time check: the schema output must be a valid ClientCommand
type Parsed = z.infer<typeof ClientCommandSchema>;
const _assignable = (c: Parsed): ClientCommand => c;
void _assignable;

export type ParseResult =
  { ok: true; cmd: ClientCommand; cid?: string } | { ok: false; message: string; cid?: string };

/** Parse a raw WebSocket frame (string) or an already-decoded value. */
export function parseClientCommand(raw: unknown): ParseResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'invalid JSON' };
    }
  }
  const cid =
    typeof (data as { cid?: unknown } | null)?.cid === 'string'
      ? (data as { cid: string }).cid
      : undefined;
  const r = ClientCommandSchema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    return { ok: false, message: `${issue?.message ?? 'invalid command'}${where}`, cid };
  }
  return { ok: true, cmd: r.data, cid: r.data.cid };
}
