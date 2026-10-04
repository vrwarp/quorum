import { textHash, type Change, type Message, type RoomId, type Sha } from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';
import { errMessage, type Logger } from '../common.js';
import { paragraphChange } from './worktree.js';

export type SuggestionOutcome =
  | {
      applied: true;
      sha: Sha;
      documentPath: string;
      /** the commit is on main but its Change card or the suggestion card could not be updated */
      bookkeepingFailed?: string;
    }
  | { applied: false; reason: string };

export interface SuggestionDeps {
  roomId: RoomId;
  actions: RoomActions;
  repo: RoomRepository;
  /** size rule: an immediate change may delete or rewrite at most this many existing paragraphs */
  rewriteLimit: number;
  logger: Logger;
}

const no = (reason: string): SuggestionOutcome => ({ applied: false, reason });

/**
 * The exact-match fast path for a suggestion (PRD 5.2: the replacement is applied as given, with no redrafting, so it
 * lands within seconds; PRD 12: an exact-match suggestion within 10 s). When the anchored lines on main still hash to
 * the anchor's text and the change is within the size rule, the replacement is committed under the write queue, the
 * Change is recorded and the suggestion card is resolved, all without a model turn. Anything else (the paragraph
 * changed, the suggestion is large, something unexpected) is not applied, and the reason says why: the orchestrator
 * reconciles those, as before.
 */
export async function tryApplySuggestion(
  deps: SuggestionDeps,
  message: Message,
): Promise<SuggestionOutcome> {
  const { roomId, actions, repo } = deps;
  const card = message.card;
  if (!card || card.type !== 'suggestion') return no('the message has no suggestion card');
  if (card.status !== 'pending') return no(`the suggestion is already ${card.status}`);
  if (message.author.kind !== 'user') return no('the suggestion was not made by a participant');
  const author = message.author;
  const doc = await actions.getDocument(roomId, card.anchor.documentId);
  if (!doc) return no('the document no longer exists');
  if (doc.status !== 'active') return no(`${doc.path} is archived`);
  const actor: Change['actor'] = {
    kind: 'user',
    userId: author.userId,
    displayName: author.displayName,
  };
  const deleting = card.replacement === '';

  const committed = await repo.withMainLock(async (): Promise<SuggestionOutcome> => {
    const content = await repo.readFile(doc.path, 'main');
    if (content === null) return no(`${doc.path} is not on main`);
    const lines = content.split('\n');
    const { startLine, endLine } = card.anchor;
    if (!(startLine >= 1 && endLine >= startLine && endLine <= lines.length))
      return no('the anchored lines are outside the document now');
    const anchored = lines.slice(startLine - 1, endLine).join('\n');
    if (textHash(anchored) !== card.anchor.textHash)
      return no('the anchored text changed since the suggestion was made');

    const replacement = deleting ? [] : card.replacement.replace(/\n$/, '').split('\n');
    const at = startLine - 1;
    const next = [...lines];
    next.splice(at, endLine - startLine + 1, ...replacement);
    // deleting a paragraph takes its blank separator line with it
    if (replacement.length === 0 && next[at] === '' && (at === 0 || next[at - 1] === ''))
      next.splice(at, 1);
    const text = next.join('\n');
    if (text === content) return no('the suggestion changes nothing');
    const { removed } = paragraphChange(content, text);
    if (removed > deps.rewriteLimit)
      return no(
        `it deletes or rewrites ${removed} existing paragraphs, more than the ${deps.rewriteLimit} an immediate change may`,
      );
    try {
      const sha = await repo.commitToMain(
        { [doc.path]: text },
        `${deleting ? 'Delete' : 'Update'} paragraph in ${doc.title} (suggestion)`,
        { actor, triggerMessageIds: [message.id] },
      );
      return { applied: true, sha, documentPath: doc.path };
    } catch (e) {
      // the formatter can normalize the replacement into what main already has
      if (/nothing to commit/i.test(errMessage(e))) return no('the suggestion changes nothing');
      throw e;
    }
  });
  if (!committed.applied) return committed;

  const failures: string[] = [];
  try {
    await actions.recordChange(roomId, {
      sha: committed.sha,
      documentId: doc.id,
      actor,
      summary: `${deleting ? 'Deleted' : 'Updated'} a paragraph in ${doc.title} from ${author.displayName}'s suggestion`,
      triggerMessageIds: [message.id],
      proposalId: null,
      revertsSha: null,
    });
  } catch (e) {
    failures.push(`could not record the change: ${errMessage(e)}`);
  }
  try {
    await actions.updateCard(roomId, message.id, {
      ...card,
      status: 'applied',
      resolutionSha: committed.sha,
      note: null,
    });
  } catch (e) {
    failures.push(`could not resolve the suggestion card: ${errMessage(e)}`);
  }
  if (failures.length > 0) {
    deps.logger('warn', 'suggestion applied, but its bookkeeping failed', {
      roomId,
      messageId: message.id,
      sha: committed.sha,
      failures,
    });
    return { ...committed, bookkeepingFailed: failures.join('; ') };
  }
  return committed;
}
