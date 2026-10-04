# Fake agent runtime

`FakeRuntime` (`FakeRuntime.ts`) is the deterministic stand-in for the Claude runtime. It has no network access, needs
no Claude credential, and reacts to a small set of phrases in chat plus the explicit intents (suggestions, asks) and
lifecycle events the room server sends it. It exists so the integration and Playwright tests can walk the whole PRD §2
scenario: direct request, divergence, vote, merge, suggestion, ask, revert, digest. It is selected with
`QUORUM_RUNTIME=fake`.

Everything it does goes through `RoomActions` exactly as the real runtime would (`recordChange`, `openProposal`,
`postChat`, `updateCard`, `closeProposal`, `setAgentStatus`, `repo()`), so the server's own pipeline (Change cards,
scope check, Review window, merge driver, milestones) runs for real. It ignores every Claude option
(`claudeBinary`, `claudeEnv`, `claudeAvailable`, `onCredentialsChanged`, `anthropicApiKey`, `maxBudgetUsd`): it is always
available and never records usage.

Matching is case-insensitive on the trimmed message. Anything that matches nothing is ignored (no reply, no status change).

## Chat triggers

Only human text messages are considered (`author.kind === 'user'`). They are batched like the real listener: the
debounce `listenerDebounceMs` restarts on every message (300 ms when the tunable is not set; the e2e config sets 200),
and a batch is also released after `listenerMaxWaitMs` (20 s) if chat never pauses. A batch is handled message by
message in arrival order; a failure on one message is logged and the next one still runs.

Each message is tested against these rules in order; the first rule that matches handles it (rule 0 never stops the others).

| # | Phrase (regex) | Behavior |
|---|---|---|
| 0 | `never ?mind`, `forget it`, `forget that`, `scrap that` | Marks every exploration that is running in the room as **stale** (see divergence). The message is then handled by the other rules as usual. |
| 1 | `add [a] section on\|about <topic>` | **Immediate change** on main. |
| 2 | `rewrite the whole\|entire document` | **Review proposal** (a large rewrite). |
| 3 | `let's use X` / `we should use X` / `go with X` and `Y makes more sense`, from two different people within the room's last 6 human messages (the current one included) | **Divergence**: exploration card, then a Quorum proposal with 3 options. |
| 4 | `drop\|abandon\|close [the\|that] [last\|latest] proposal` at the start of the message | Closes the latest open proposal. |
| 5 | starts with `why`, `what`, `how` or `explain` (as a whole word), or ends with `?` and contains one of those words | Canned **answer**. |

"Which document" for rules 1-3: the document whose title, file name, or file name without `.md` appears in the message
(the longest match wins); otherwise the first active document of the room. With no active document the agent replies
`There is no active document yet. Create one and ask again.` (rule 3: `There is no active document to explore against.`).

### 1. Direct request: `add [a] section on|about <topic>`

- `<topic>` is the rest of the message with trailing `.`/`!`/`?` removed, then a trailing `please`, `thanks`, `thank you` or
  `asap` removed, then a trailing `to|in|into [the] <document name> [doc|document]` removed, then Title Cased
  ("latency requirements" becomes "Latency Requirements").
- If the document already has an H2 `## <Title>` (any case) the agent replies `<doc title> already has a "<Title>" section.`
  and changes nothing.
- Otherwise it appends `## <Title>`, a blank line, and `Placeholder text about <Title>: this section will be expanded as
  the discussion continues.` to the end of the document and commits it to **main** immediately, through the write lock.
  - commit subject `Add <Title> section`; trailers `Quorum-Actor: agent:orchestrator`, `Quorum-Trigger: <message id>`;
  - `recordChange` with summary `Added a "<Title>" section to <doc title>` (the server posts the Change card).
- Unreadable file: `I could not read <path>.`

### 2. Direct request: `rewrite the whole|entire document`

Opens a **Review** proposal (the size rule says a rewrite this large is not immediate). The agent creates the branch
`<doc-slug>/rewrite/a` (`rewrite-2`, `rewrite-3`, ... when taken) from main, replaces the file with the document's first
H1 line plus a fixed three-block text ("This document was rewritten end to end for clarity and consistency." and two
H2 sections), commits it with `Quorum-Actor: agent:worker`, and calls `openProposal`:
kind `review`, title `Rewrite <doc title>`, one option `A` (summary `Rewrites <doc title> from the top, keeping the title.`,
tradeoffs `Reads more consistently, but replaces most of the existing wording.`). Main is untouched until the Review
window elapses or someone approves; a rejection produces the "rejected" reply below.

### 3. Divergence: exploration, then a Quorum proposal

The runtime keeps the last 6 human messages of the room (the current one included). When the current message contains a **use** phrase or a
**sense** phrase and an earlier message in that window, from a *different* user, contains the complementary phrase:

- use phrase: `let's use X`, `lets use X`, `we should use X`, `go with X`. The term X ends at the first of
  ` for|because|since|as|so|to|in|on|over|instead|rather|and|but|with|due` or at `, . ; : ! ?`.
- sense phrase: `Y makes more sense`. Y is the last (up to) three words before it, after cutting at the last
  `, ; . ! ?` or ` but ` / ` and `, and dropping leading hedges (`I think`, `we feel`, `honestly`, `actually`, `well`, `but`, `and`,
  `hmm`, `imo`, `maybe`, `probably`, `then`, `still`, `just`, `really`, `that`, `using`, `the`).
- Pairings: (earlier use, current sense) -> X from the use side, Y from the sense side; (earlier sense, current use) -> the
  same, either order; (earlier use, current use) -> X is the earlier term, Y the current one.
- Identical terms (ignoring case) never pair. A pair is explored once per room (the key is the unordered, lower-cased pair).
  Messages from the same user never pair. Both messages are removed from the window once used.

What happens next:

1. Immediately, the agent posts a chat message `Exploring X vs Y for <doc title>` carrying an `exploration_started` card
   (`documentId`, `title` = that same text, `theses` = `[X, Y, "X with Y fallback"]`), `inReplyTo` both messages.
2. The agent shows `thinking` while the exploration runs. It runs detached: chat, suggestions and asks are still handled.
   The delay is `exploreMs` (default 500 ms; `QUORUM_FAKE_EXPLORE_MS` overrides it through `createAgentRuntime`).
3. Then it creates three branches `<doc-slug>/<x-vs-y-slug>/a`, `/b`, `/c` (`-2`, `-3`, ... on the topic slug when taken), all
   forked from the same main sha, each committed with `Quorum-Actor: agent:worker` and the two trigger ids:

   | Option | Appended to the document | summary | tradeoffs |
   |---|---|---|---|
   | A | `## Decision: X` + "We will use X as the primary choice. It is the simpler path and keeps the surface area small." | `Commit to X everywhere.` | `Simplest to operate and explain; gives up what Y offers.` |
   | B | `## Decision: Y` + "We will use Y as the primary choice. It fits the access patterns we expect best." | `Commit to Y everywhere.` | `Best fit for the expected workload; gives up what X offers.` |
   | C | `## Decision: X with Y fallback` + "We will start with X and keep Y available as a fallback behind a narrow interface." | `Start with X, keep Y as a fallback.` | `Hedges the risk of either choice; costs an extra abstraction to maintain.` |

4. `openProposal`: kind `quorum`, title `X vs Y for <doc title>`, options A, B, C as above, `branchBase` = the shared fork sha,
   the two trigger ids. If a rule-0 phrase ("never mind", ...) was said while the exploration ran, `stale: true` is passed
   (the card is still posted, PRD 6.5); explorations are flagged independently.
5. If something fails (for example the scope check rejects the proposal) the agent says
   `The exploration of X vs Y failed: <message>` and goes back to idle.

### 4. Closing a proposal

`drop the proposal`, `abandon that proposal`, `close the latest proposal`, ... closes the last proposal in the room state whose
state is `open` with `closeProposal(..., 'abandoned', 'Closed on request')`. If none is open: `There is no open proposal to close.`

### 5. Questions

A message that starts with `why`, `what`, `how` or `explain` (whole word), or that ends with `?` and contains one of them,
gets one reply (`inReplyTo` the message): `Short answer: the documents answer that on a first read; ask me about a
specific passage if you want the history behind it.` Statements such as "that's what I said" or "somehow it works" do not match.

## Explicit intents

### Suggestions (`onSuggestion`)

The message must carry a `suggestion` card (otherwise it is ignored with a warning). Suggestions skip the debounce and are
handled in order with everything else.

1. The document comes from `anchor.documentId`; the text is read from main. The anchor is valid when
   `1 <= startLine <= endLine <= lines` and `textHash(lines startLine..endLine joined by "\n")` equals `anchor.textHash`.
2. **Stale or invalid anchor** -> the card becomes `declined` with note `The paragraph changed since this suggestion was made`,
   and the agent posts `That paragraph changed since the suggestion was made, so I did not apply it. Please suggest again on
   the current text.` (with the anchor, `inReplyTo` the suggestion). A missing document declines with note `Document not found`
   and `I could not find the document this suggestion refers to.`; a missing file with `I could not read <path>.`.
3. **Size rule**: if the anchored span has more non-blank lines than `immediateRewriteLimit` (default 3), nothing is applied
   directly. The agent creates `<doc-slug>/suggestion/a` (`suggestion-2`, ... when taken) from main, applies the change
   there as the suggesting participant, and opens a Review proposal titled `Suggestion on <doc title>` with one option A
   (summary `Rewrites N paragraphs of <doc title> as suggested by <name>.`, or `Deletes ...` for an empty replacement;
   tradeoffs `Larger than an immediate change (limit 3 paragraphs), so it waits for review.`). The card becomes
   `superseded` with note `Too large to apply directly; opened a review proposal`.
4. **Otherwise it applies the replacement as given**: the anchored lines are replaced by the replacement's lines (one trailing
   newline trimmed). An empty replacement deletes the paragraph and, if that would leave two blank lines in a row, one blank
   line too. The commit goes to main as the participant: subject `Update paragraph in <doc title> (suggestion)` (or `Delete
   paragraph in ...`), `Quorum-Actor: user:<id>`, `Quorum-Trigger: <suggestion message id>`; `recordChange` summary
   `Updated a paragraph in <doc title> from <name> suggestion` (or `Deleted a paragraph in ...`). The card becomes `applied`
   with `resolutionSha` = the new commit and no note.

### Ask (`onAsk`)

The anchor comes from the `ask` card (or the message's own anchor); without one the message is ignored with a warning. A
missing document gets `I could not find the document that question refers to.` Otherwise the answer is built from
`git log -L <start>,<end>:<path>` and `git blame` on main and posted with the anchor, `inReplyTo` the ask:

```
Here is the history of line 7 of Architecture:          (or "lines 3-5")

- `a1b2c3d` Add Latency Requirements section (agent:orchestrator)      <- up to 5 commits, newest first, Quorum-Actor in brackets
  > Alice: add a section on latency requirements          <- first line of each Quorum-Trigger message found in the transcript

Last changed in `a1b2c3d`.                                <- blame sha of the last line of the range
```

With no commits: `There is no recorded history beyond the initial draft.` If git cannot trace the range (out of range, moved):
`I could not trace the history of <line(s)> of <doc title>: the passage may have moved since you selected it.`

## Lifecycle events

| Event | Reply |
|---|---|
| `onProposalEvent` `merged` | `Merged "<title>" (option <label>) as <sha7>.`, or `... as <sha7> after reconciling it with newer edits.` when `reconciled` |
| `onProposalEvent` `rejected` | `"<title>" was rejected. What should change?` |
| `onProposalEvent` `expired`, `superseded`, `abandoned`, `merge_failed` | none (the room already posted a system message) |
| `onReverted` | none (debug log only) |

## Merge driver, semantic revert, digest

- **`runMergeDriver`**: for every conflicted file it rewrites the working copy keeping the proposal's side ("theirs") of each
  conflict block (plain and diff3-style markers) and removes all markers. Returns `{reconciled: true, summary: "Resolved N
  conflicted file(s) by keeping the proposal's side of each conflict."}`; with no conflicted files it touches nothing and
  returns `{reconciled: false, summary: "Clean merge; nothing to reconcile."}`. The server then verifies no markers remain.
- **`runSemanticRevert`** (used when `git revert` conflicts): applies the reverse of the change (after -> before) to the current
  text, tolerating up to two lines of changed context, so later edits next to the change survive and replaced paragraphs come
  back. If that cannot be placed, a change that only added lines is undone by removing those lines when all of them are still
  present verbatim. Anything else (later edits rewrote the change's text, or it also removed text) throws `... cannot be undone
  automatically` rather than undoing half of it. The commit goes to main as the reverting participant: subject
  `Revert <sha7>: <original subject>`, `Quorum-Actor: user:<id>`, `Quorum-Reverts: <sha>`, the original trigger ids.
- **`writeDigest`**: `While you were away:` then one `- <event>` line per event (`- Nothing notable happened.` when there are
  none); then, if there is chat since `sinceMessageId` (at most 20 messages read, text messages only), a blank line, `In chat:`, and
  the last 8 as `- <author>: <first line, cut to 100 characters with …>`.

## Status

`setAgentStatus(room, 'thinking')` when the agent starts handling something and `'idle'` once all queued work and running explorations
have finished. Messages that trigger nothing do not change it. Suggestions, asks and lifecycle replies are serialized with chat
handling per room, so replies never interleave.

## Test hooks

`flush()` releases any batch the debounce is still holding and waits until all queued work and explorations are done;
`idle()` only waits. Both are for tests and are not part of the `AgentRuntime` contract. Unit tests for every behavior above
are in `FakeRuntime.test.ts`, written against the in-memory repository in `../testing/`.
