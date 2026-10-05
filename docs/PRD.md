# Quorum: Product & Architecture Specification

Status: draft 2, 2026-10-04. Supersedes the first draft. Decisions taken in review are marked **Decided**; open items are collected in §13; Appendix A lists what changed from the first draft.

## 0. Pitch

Quorum is a live, multiplayer room where a small group deliberates in chat while an autonomous multi-agent engine maintains the group's documents. Humans never edit documents directly. They talk, and the engine listens without being prompted: it applies requested changes, explores disagreements in parallel on branches, and merges only what the group has agreed to. Every document is a markdown file in a git repository, so history, branches, diffs, blame, and revert come from git rather than from a bespoke editing engine.

## 1. Goals, non-goals, deferred

### 1.1 Goals for v1

- Fully passive operation. No mention or command prefix is needed; the engine acts on what it hears. **Decided**
- Live rooms. Participants are present at the same time, as on a call. **Decided**
- Agent-authored documents, directed by humans through chat and in-document suggestions.
- Divergence handling: when participants disagree about something that affects a document, the engine explores each position and a synthesis on separate branches and brings back a vote.
- Quorum gating for contested changes, with configurable voting rules.
- Multi-document rooms with per-document branches and votes. **Decided**
- Traceability: any paragraph can be traced to the conversation that produced it, and participants can ask the engine about any passage. **Decided**
- Single-tenant private deployment, TypeScript throughout, built on the Claude Agent SDK. **Decided**
- Sign the server's Claude Code CLI into the owner's Claude account from the web interface, so no API key is required. **Decided**
- Ship as a single Docker image with one persistent volume. **Decided**

### 1.2 Non-goals for v1

- Citations and a provenance map for external sources. Workers may use web search to find ideas, but no structured source metadata is stored or displayed. **Decided**
- Direct human editing of documents, real-time co-editing, CRDTs, operational transforms, and block leases. **Decided**
- Owner override, owner cancel, or force-merge. **Decided**
- Multi-tenant hosting, billing, SSO.
- Rich text beyond markdown: no in-document comments, tracked changes, table editors, or images beyond markdown image links.
- Mobile layouts.

### 1.3 Deferred until passive mode is proven **Decided**

Guardrails are intentionally absent from v1 so the core question, whether fully passive operation works, is answered without them. Expected later: a per-room pause switch, a cap of one live exploration per document, a cooldown after a rejected proposal, an explicit mention as a priority override, and per-room spend caps surfaced to users.

## 2. Canonical scenario

Assumed target: a small engineering team writing design documents on a live call (see §13). Three engineers are writing an architecture document and an API spec for a new service.

1. Alice says "we should add a section on latency requirements." Twenty seconds later a Change card appears in chat: a new section was added to Architecture.md on main, with a diff link and a Revert button.
2. Alice says "let's use PostgreSQL." Bob says "ClickHouse makes more sense for this write volume." The engine posts "Exploring PostgreSQL vs ClickHouse for Architecture.md" and starts three workers on three branches. Two minutes later a Quorum card appears with options A (PostgreSQL), B (ClickHouse), and C (a synthesis), each with a summary, tradeoffs, and a diff. The room's rule is Unanimous. Alice, Bob, and Carol all pick C. The engine merges C to main, tags a milestone, and then posts a follow-up Change card for API-Spec.md, whose storage section now reflects the decision.
3. Carol clicks a paragraph in the canvas, fixes a typo, and presses Suggest. A Suggestion card appears in chat under her name, and a few seconds later a Change card follows: applied.
4. Dave, who dropped off the call for ten minutes, reconnects and receives a private digest: what merged, what is open for a vote, what was reverted.
5. Bob selects a sentence in the latency section and asks "why does this say 200 ms?" The engine answers in chat, quoting the two earlier messages where that number was agreed, and links the commit.

## 3. System architecture

```
+------------------------------------------------------------------------------+
|                                 QUORUM ROOM                                  |
|                                                                              |
|   +-------------------------+     WebSocket      +-------------------------+ |
|   |  Chat pane              | <================> |  Document canvas        | |
|   |  - transcript           |                    |  - one tab per document | |
|   |  - Change cards         |                    |  - click-to-suggest     | |
|   |  - Suggestion cards     |                    |  - select-to-ask        | |
|   |  - Review / Quorum cards|                    |  - branch rail + diffs  | |
|   +-----------+-------------+                    +------------+------------+ |
|               |                                               |              |
|               v                                               v              |
|   +----------------------------------------------------------------------+   |
|   |                          ROOM SERVER (Node / TypeScript)             |   |
|   |  presence . transcript . proposals . votes . write queue . digests   |   |
|   |  SQLite (room state)            git (one bare repo per room)         |   |
|   +-----+-------------------+----------------------+---------------------+   |
|         |                   |                      |                         |
|         v                   v                      v                         |
|   +-----------+   +------------------+   +--------------------------------+  |
|   | Listener  |   | Orchestrator     |   | Workers (one SDK session each) |  |
|   | Sonnet 5.5|   | Opus 5.5         |   | Exploration   Sonnet 5.5       |  |
|   | Messages  |   | Agent SDK,       |   | Merge driver  Opus 5.5         |  |
|   | API call  |   | long-lived,      |   | Digest writer Sonnet 5.5       |  |
|   | per       |   | one per room     |   | each in its own git worktree   |  |
|   | debounce  |   |                  |   |                                |  |
|   +-----------+   +------------------+   +--------------------------------+  |
+------------------------------------------------------------------------------+
```

Components:

- **Web client.** React and TypeScript. Chat pane and document canvas side by side. The canvas renders markdown from main, or from a selected branch, and offers two interactions on any paragraph: Suggest and Ask. It never holds an editable copy of a document.
- **Room server.** Node.js and TypeScript. Owns presence, the transcript, proposals and votes, the per-room write queue for main, WebSocket fan-out, and the lifecycle of agent sessions. State lives in SQLite; documents live in git.
- **Listener.** A stateless classification call on Sonnet 5.5 at low effort, fired after a debounce on chat activity. With an API key it is a Messages API call; without one (the web sign-in or a setup token) the server runs it as a one-shot Agent SDK session instead (§6.1). It emits structured intents. It has no tools and never writes.
- **Orchestrator.** One long-lived Claude Agent SDK session per room on Opus 5.5. It receives events as user turns, speaks in chat, performs immediate changes to main, decides when to open proposals, and dispatches workers through server-provided tools.
- **Workers.** Short-lived Agent SDK sessions spawned by the server at the orchestrator's request: exploration workers (Sonnet 5.5) that draft on branches, the merge driver (Opus 5.5) that merges proposals into main, and the digest writer (Sonnet 5.5) that briefs a returning participant.

Single tenant: one deployment serves one organization's rooms and all participants are trusted. Agent sessions run on the same host as the room server, inside the deployment container.

**Credentials.** The agent runs on the Claude Agent SDK, which spawns the Claude Code CLI, so it can authenticate with the owner's own Claude login instead of an API key. The server signs that CLI in through the web interface: Settings shows the sign-in link the CLI produces, the owner approves access and pastes the code back, and the server promotes the resulting credentials into the config directory the SDK reads (the same pattern FanZiTong uses for its assistant sidecar). Only the instance admin, the first user to log in, can sign the server in or out. Two alternatives are supported: a long-lived token from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`. Until one of the three is present the agent reports itself unavailable and rooms keep working as plain chat. This is a personal-use arrangement: the login is the owner's, the instance is theirs, and it must not be offered as a service to other people. **Decided**

**Packaging.** The whole system ships as one Docker image: Node 22, git, the SDK's bundled Claude binary, and the built server and client. A single `/data` volume holds the SQLite database, the room repositories, and the Claude credentials, so backing up the volume backs up everything. A compose file runs it on loopback with an optional Caddy profile for HTTPS on a domain. See `docs/DEPLOY.md` and `docs/CLAUDE-SIGNIN.md`. **Decided**

## 4. Document model: markdown in git

### 4.1 Repository layout **Decided**

One bare git repository per room, one markdown file per document, and a worktree per agent session.

```
rooms/<roomId>/
  repo.git/                 bare repository, the source of truth
  worktrees/
    main/                   the only checkout of main
    <proposalId>/           one worktree per exploration branch or merge in progress
  documents are files at the repository root: Architecture.md, PRD.md, API-Spec.md
```

Worktrees are scratch space: a proposal's are removed when it ends, and its branches stay in the repository.

Branches are scoped to a single document. The scope is a convention enforced by the server: a proposal whose diff touches any file other than its document is rejected when the agent tries to open it. A decision that affects two documents therefore produces two proposals and two votes; in practice the second is a follow-up Change after the first merges (§6.3). An alternative, one repository per document, enforces the scope structurally but splits history and complicates cross-document reads; revisit if the convention proves leaky.

Documents are plain markdown with three disciplines:

- One paragraph per line, no hard wrapping. A "block" in the UI is a line in the file, so diffs and blame align with what people see.
- A formatter normalizes every commit (Prettier with `proseWrap: preserve`, run from a repository pre-commit hook the server installs when the room is created). Agent and human round trips therefore never produce formatting-only diffs.
- Headings define sections; the orchestrator uses them as the unit of scope when judging change size.

### 4.2 Commit conventions

Every commit on any branch carries trailers that the server and the agents rely on:

```
Add latency requirements section

Quorum-Actor: agent:orchestrator
Quorum-Trigger: msg_01J8X...,msg_01J8Y...
Quorum-Proposal: prop_7
Quorum-Reverts: 3f9c1a2
```

- `Quorum-Actor` is one of `agent:orchestrator`, `agent:worker:<proposalId>`, `agent:merge`, or `user:<userId>` for suggestions, reverts, and structural operations.
- `Quorum-Trigger` lists the chat messages that caused the change.
- `Quorum-Proposal` is present when the commit belongs to a proposal.
- `Quorum-Reverts` is present on revert commits.

These trailers, `git blame`, and `git log -L` are the entire traceability mechanism. There is no metadata inside the markdown.

### 4.3 Main and the write queue

main is authoritative and changes only through the room's write queue, which serializes four kinds of writes:

1. Immediate changes by the orchestrator (§6.3).
2. Merges of passed proposals (§4.5), reconciled by the merge driver when main has moved.
3. Mechanical reverts requested by participants (§4.6).
4. Mechanical structural operations by the server: create, rename, archive a document.

The queue is per room, so a merge never races an immediate change. Reverts and structural operations run in the main worktree while they hold the queue. The orchestrator never edits the main worktree: it works in its own detached scratch worktree, reset to main's head at the start of every turn, and `commit_main` applies the edited document to main under the queue, directly when main has not moved and by a three-way merge of that one file otherwise (refusing, and asking the model to re-read, when the merge does not apply cleanly). Exact-match suggestions are applied by the server under the queue without a model turn. A merge is made in a detached worktree at main's head (the merge driver does its reconciling there); when the merge commit exists, the queue advances main to it and refreshes the main worktree.

### 4.4 Branches and proposals

A proposal is a branch plus a card in chat. Branch names follow `<doc-slug>/<topic-slug>/<option>`, for example `architecture/storage-engine/b`. There are two kinds:

| Kind   | Origin                                                 | Options                                        | How it closes                                                                                                                              |
| ------ | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Review | A direct request judged too large to apply immediately | One                                            | Merges on the first approval from a connected participant, or when the objection window elapses with no rejection; a rejection archives it |
| Quorum | A divergence exploration                               | Two or more, typically A, B, and a synthesis C | Merges the option that satisfies the room's voting rule                                                                                    |

### 4.5 Merging **Decided: the agent merges, on the Opus tier**

Automatic merges have no semantics, in git just as in CRDTs; two branches can merge cleanly and still contradict each other. Therefore:

- A proposal always lands as a merge commit (`git merge --no-ff`), never as a fast-forward. The proposal is therefore one commit on main, and a single Revert (§4.6) undoes the whole proposal, however many commits its branch holds.
- If main has not moved since the branch point, that merge is trivial: the voted artifact lands unchanged and there is no reconciliation pass. No merge-driver session is started and no model is called.
- Otherwise the merge driver (Opus 5.5) runs `git merge --no-commit`, reads the base, both sides, and the result, repairs semantic contradictions and resolves any textual conflicts, and commits a clean result. Conflict markers never reach main. **Decided**
- When reconciliation changed the voted text, the merge announcement says so and summarizes the change. Revert remains available.
- If the driver cannot produce a result it is confident in, the proposal stays open with an explanation in chat.

### 4.6 Undo

- Every Change card and merge announcement carries Revert. Revert is mechanical: `git revert` of that commit through the write queue, authored as the participant, with a `Quorum-Reverts` trailer. No model call. A merged proposal is a single merge commit (§4.5), reverted as a whole (`git revert -m 1`).
- If the revert conflicts with later commits, the write queue hands it to the merge driver to perform semantically.
- Natural-language undo in chat ("drop the latency section") is an ordinary direct request handled by the orchestrator.

## 5. Human interaction model

### 5.1 Chat is the command surface **Decided**

Participants influence documents only by talking, suggesting, asking, voting, and reverting. There is no document editor. Structural actions (create, rename, or archive a document; change the voting rule) are buttons that post a system message into chat and are executed mechanically by the server.

### 5.2 In-document suggestions **Decided**

Clicking a paragraph opens an inline editor pre-filled with its text, visible only to that participant. Pressing Suggest posts a Suggestion card to chat under their name, anchored to the paragraph and showing a word-level diff. The paragraph shows a small "suggestion pending" marker to everyone until it is resolved.

A suggestion is an explicit intent and bypasses the listener. The orchestrator applies it:

- If the anchor still matches the current text, it applies the replacement as given, with no redrafting, so it lands within seconds. An empty replacement deletes the paragraph.
- If the paragraph changed since the suggestion was made, the orchestrator reconciles and may ask in chat.
- The size rule of §6.3 applies: a long suggestion that rewrites many existing paragraphs becomes a Review proposal instead of an immediate change.
- Two suggestions on the same paragraph are both visible in chat; the orchestrator reconciles them.

Anchor format: `{ documentId, baseSha, startLine, endLine, textHash }`.

### 5.3 Ask about a passage **Decided**

Selecting text and pressing Ask posts the question to chat with the same anchor. The orchestrator answers from the passage's history: `git log -L` and `git blame` on the lines, the trailers on those commits, and the referenced chat messages fetched through the transcript tool. The answer quotes the originating discussion and links the commit and, when there was one, the proposal and vote.

### 5.4 Presence

A participant is active when connected. Presence changes are broadcast and feed vote evaluation (§7.3) and digests (§7.5).

## 6. Passive listening and orchestration

```
chat message --> debounce 3 s (max wait 20 s) --> Listener (Sonnet) --> intents[]
                                                                        |
        none <----------------------------------------------------------+
                                                                        |
  edit_request --> Orchestrator --> small? --yes--> immediate change on main --> Change card
                                      |
                                      no --> worker on a branch --> Review proposal
                                                                        |
  divergence ----> Orchestrator --> "Exploring A vs B" --> 3 workers, 3 branches --> Quorum proposal
                                                                        |
  question ------> Orchestrator --> answer in chat (transcript + git history)
```

### 6.1 Listener

- Trigger: after each human message, start a 3 s timer and classify when it fires with nothing newer. If chat never pauses, classify anyway every 20 s on the accumulated window. Suggestions, Ask requests, votes, and reverts skip the listener.
- Input, in cache-friendly order: a fixed system prompt; room configuration; document outlines (headings plus first lines) and open proposals; then the transcript from the current checkpoint onward, with already-classified messages marked. The transcript portion is appended to rather than slid, so the prefix stays cacheable; the checkpoint is re-anchored every 100 messages or when an outline changes.
- Output: JSON through structured outputs, not forced tool use.

```json
{
  "intents": [
    {
      "type": "edit_request | divergence | question | none",
      "confidence": 0.0,
      "documents": ["Architecture.md"],
      "summary": "add a latency requirements section",
      "messageIds": ["msg_01J8X..."],
      "positions": [
        { "userId": "u_alice", "claim": "PostgreSQL" },
        { "userId": "u_bob", "claim": "ClickHouse" }
      ]
    }
  ]
}
```

- Threshold: intents at or above 0.7 confidence are forwarded. The orchestrator is told what is already in flight so it does not act twice.
- Model: Sonnet 5.5 at effort low with adaptive thinking, prompt caching on the prefix. If classification latency needs it, thinking is switched off with the between-tools thinking mode, which Sonnet 5.5 accepts at effort high or below. Forced tool choice is rejected on Sonnet 5.5, which is another reason the output uses structured outputs.
- Transport: with `ANTHROPIC_API_KEY` set, a classification is a direct Messages API call with explicit prompt-cache breakpoints after the stable prefix. Without a key, which is the default when the server is signed in through the web interface or with a setup token, only the Claude Code subprocess can use the login, so each classification runs as a one-shot Agent SDK session: no tools, the same system prompt, the same JSON schema as structured output. That path costs a process per classification and sets no explicit cache breakpoints, so it is slower and the latency target in §12 is not expected to hold on it. An API key is how to get the direct, cached call.

### 6.2 Orchestrator

- One Agent SDK session per room, Opus 5.5 at effort medium, streaming input, resumable by session id. Events arrive as user turns, one at a time: listener intents, suggestions, Ask requests, worker results, vote outcomes, merge results.
- Working directory: a detached scratch worktree of the room repository, reset to main's head before every turn (§4.3). Built-in tools: Read, Edit, Write, Grep, Glob, Bash. Bash is limited through the SDK's permission callback to an allow-list of git subcommands and flags, the formatter, and read-only shell commands, and runs inside the SDK sandbox with writes confined to that worktree.
- Server-provided tools, registered as an in-process MCP server on the session:

| Tool                | Purpose                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `post_chat`         | Speak in chat, optionally rendering a card. A summary (about 140 characters) plus optional details |
| `read_transcript`   | Fetch messages by id or range                                                                       |
| `get_room_state`    | Participants, presence, documents, open proposals, votes, voting rule                               |
| `commit_main`       | Apply the scratch worktree's edit to main through the write queue, with trailers                    |
| `start_exploration` | Ask the server to spawn exploration workers for a document with a list of theses                    |
| `open_proposal`     | Register a branch as a Review or Quorum proposal and post its card; validates single-document scope |
| `close_proposal`    | Archive a proposal as expired or rejected                                                           |
| `request_merge`     | Hand a passed proposal to the merge driver                                                          |

Every agent chat message leads with a summary of about 140 characters, the answer or outcome itself, which is what
the chat shows; the full text (evidence, quotes, lists, sources) sits behind a Details expander. The target is loose:
the tool reminds the agent when a summary runs long, and the server cuts one past 280 characters. A summary with no
details, or details that say no more, makes a plain message. Agent messages without a summary (older ones, digests)
that are longer than 600 characters are shown clamped with "Show more".

- Memory: the SDK compacts automatically; a PreCompact hook reminds the session to re-read room state after compaction. Durable state is never only in the session: the transcript, proposals, and votes are in SQLite, so a crashed session is restarted and rehydrated from `get_room_state` and the recent transcript.
- A CLAUDE.md in the room workspace carries the house rules: formatting discipline, trailers, scope, the size rule, when to open which proposal kind, and tone in chat.

### 6.3 Intent handling

**Direct request** (`edit_request`). The orchestrator drafts the change. The size rule is applied by the orchestrator before drafting and verified mechanically by the server on the resulting diff:

- Immediate when the change deletes or rewrites at most 3 existing paragraphs. Additions of any size are immediate. The change is committed to main through the write queue and announced with a Change card (summary, diff link, Revert). **Decided**
- Otherwise a worker drafts it on a branch and the orchestrator opens a Review proposal with a 2 minute objection window. The first approval from a connected participant merges it at once, whatever the room's voting rule; a rejection archives it and the orchestrator asks what should change. If the window elapses with no rejection, it merges.
- Both thresholds are room configuration.

**Divergence.** The orchestrator posts "Exploring X vs Y for <document>" and calls `start_exploration` with the theses: each participant's position and a synthesis. The server spawns one worker per thesis. When all return, or time out, the orchestrator reads their summaries and diffs, writes the Quorum card (options, summaries, tradeoffs, diff links), and opens the proposal.

**Question.** Answered in chat. Passage questions use git history as in §5.3. Research questions that need the web are delegated to a single exploration worker and answered when it returns.

**Cross-document consequences.** After a merge, the orchestrator checks the other documents for statements the merge invalidated and handles them as direct requests, usually immediate changes with their own Change cards.

### 6.4 Exploration workers

- One Agent SDK session per thesis, Sonnet 5.5 at effort medium, working directory set to a fresh worktree on a new branch from main.
- Tools: Read, Edit, Write, Grep, Glob, Bash (git and the formatter only), WebSearch and WebFetch for finding ideas **Decided**, `read_transcript`, `get_room_state`. Workers do not post to chat.
- Instructions: edit only the assigned document, draft the change under the assigned thesis, commit with trailers, and return structured output: summary, tradeoffs, assumptions, open questions, and sources consulted as plain text. No provenance metadata is stored.
- Limits: a turn cap and a wall-clock cap, default 5 minutes. On timeout the partial branch is still reported so the orchestrator can decide whether to present it.

### 6.5 Late results **Decided**

Explorations take minutes and the conversation moves on. Before posting a Quorum card the orchestrator reads the transcript since the exploration started. If the topic has been resolved or abandoned, the card is still posted, collapsed and labelled, and the branch rail lists it under Stale. Stale proposals can still be voted on and still expire.

### 6.6 Concurrency between agent activities

Several explorations may run at once, including on the same document; v1 imposes no cap (§1.3). Merges serialize through the write queue, and the second of two merges to the same document reconciles against the first through the merge driver.

## 7. Consensus and governance

### 7.1 Cards

- **Change card:** what changed, by whom (participant or agent), on behalf of which messages, diff link, Revert.
- **Suggestion card:** the proposer, the paragraph, the word-level diff, and its resolution once applied.
- **Review card:** one option, diff link, Approve and Reject, a countdown of the objection window.
- **Quorum card:** two or more options, each with summary, tradeoffs, diff link, and vote buttons; a tally; the rule in force.

### 7.2 Voting rules **Decided**

| Rule                | Passes when                                                                    |
| ------------------- | ------------------------------------------------------------------------------ |
| Unanimous (default) | Every connected participant has approved the same option, and at least one has |
| Majority            | One option's approvals exceed half of the connected participants               |

The rule decides Quorum proposals. A Review proposal has one option and merges on the first approval from a connected participant (§4.4), whatever the rule.

The agent never votes. There is no owner override, cancel, or force-merge. The room owner, its creator, can change the rule and archive the room. Archiving is owner-only. An archived room is read-only history: it takes no further commands and cannot be joined again, its agent session ends, and clients that have it open show a read-only banner.

### 7.3 Eligibility and evaluation **Decided: active means connected**

Eligibility is the set of participants connected at the moment of evaluation. Evaluation runs on every vote and on every presence change. Votes can be changed until a merge begins. A participant who disconnects stops counting either way, so a departure can complete a vote; the digest (§7.5) tells them what happened.

### 7.4 Expiry **Decided: the agent decides; archive, never delete**

The orchestrator closes a proposal as expired when, in its judgment, the discussion that produced it has concluded without it: the topic was settled another way, or the room has moved on and no vote has been cast for a sustained period. It evaluates this on each listener cycle and on a 5 minute timer. Expired and rejected proposals are archived: the branch is kept, the card collapses, and the rail lists it under Archived. Anything archived can be reopened by asking.

### 7.5 Rejoin digest **Decided**

When a participant reconnects after at least 2 minutes away and at least one notable event occurred in their absence (a merge, a proposal opened or closed, a revert, a document created), the server spawns a digest writer (Sonnet 5.5, one-shot) with the transcript and events from the absence. The digest is delivered as a private message visible only to that participant and is not part of the shared transcript.

## 8. Proposal lifecycle

This section replaces the empty "State & Branch Lifecycle Model" of the first draft.

```
                 workers finish
  DRAFTING -------------------------> OPEN ------------------> MERGING ------> MERGED
     |                                 |  |  ^                    |               |
     | workers fail or time out        |  |  | merge driver       |               | participant
     | with nothing usable             |  |  | cannot produce     |               | clicks Revert
     v                                 |  |  | a result           |               v
  ABANDONED                            |  |  +--------------------+           REVERTED
                                       |  |
          rejection (Review) or        |  +--> EXPIRED      orchestrator judges the
          another option passed        |       (archived)   discussion concluded
          (Quorum)                     |
                                       +--> REJECTED / SUPERSEDED (archived)
```

| State      | Meaning                                                                                    | Entered by                                            | Leaves by                                 |
| ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| Drafting   | Branch exists, workers writing                                                             | `start_exploration`, or a large direct request        | Workers return, fail, or time out         |
| Open       | Card posted; Review window running or Quorum voting                                        | `open_proposal`                                       | Vote outcome, rejection, expiry           |
| Merging    | Write queue holds main; a merge commit, reconciled by the merge driver when main has moved | Vote passed, first Review approval, or window elapsed | Merge commit, or failure back to Open     |
| Merged     | On main, milestone tag applied                                                             | Merge commit                                          | Revert                                    |
| Reverted   | A revert commit undid the merge                                                            | Participant Revert                                    | Terminal                                  |
| Rejected   | Review rejected, or Quorum option lost                                                     | Vote                                                  | Terminal, archived                        |
| Superseded | A sibling option merged                                                                    | Sibling merge                                         | Terminal, archived                        |
| Expired    | Orchestrator judged the discussion concluded                                               | `close_proposal`                                      | Terminal, archived, reopenable by request |
| Abandoned  | No usable draft                                                                            | Worker failure                                        | Terminal                                  |

Orthogonal flags: `stale` (posted after the conversation moved on) and `reconciled` (the merge driver altered the voted text).

As built: a Quorum proposal is one record with several options. When one option merges, the proposal becomes Merged and records the winner (`mergedOptionId`); the losing options carry no state of their own, so the Superseded state is never entered. Drafting is not stored either: the record is created, in Open, when the card is posted.

Milestones: every merge of a Quorum proposal tags main `milestone/<n>` with the proposal id in the tag message.

## 9. Model tiering and cost **Decided**

| Role               | Model                           | Effort | Shape                                                                                                | Notes                                                           |
| ------------------ | ------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Listener           | Sonnet 5.5, `claude-sonnet-5-5` | low    | Messages API, structured output, cached prefix; with no API key, a one-shot Agent SDK session (§6.1) | Window bounded for cost and cache stability, not context        |
| Orchestrator       | Opus 5.5, `claude-opus-5-5`     | medium | Long-lived Agent SDK session                                                                         | Auto-compaction; durable state in SQLite                        |
| Exploration worker | Sonnet 5.5, `claude-sonnet-5-5` | medium | One-shot Agent SDK session per branch                                                                | Web search allowed                                              |
| Merge driver       | Opus 5.5, `claude-opus-5-5`     | medium | One-shot Agent SDK session                                                                           | Runs only when main has moved since the proposal's branch point |
| Digest writer      | Sonnet 5.5, `claude-sonnet-5-5` | low    | One-shot Agent SDK session                                                                           | Private output                                                  |

List prices on the Anthropic API, input / output per million tokens: Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, with cache reads at $0.20 on both. Order-of-magnitude expectations for a lively one-hour room with three participants, to be replaced by measurement:

| Activity                                                                    | Rough cost        |
| --------------------------------------------------------------------------- | ----------------- |
| Listener, one classification every 10 to 20 s of active chat, prefix cached | $2 to $4 per hour |
| Orchestrator turn, immediate change or chat reply                           | $0.05 to $0.30    |
| One exploration, three Sonnet workers with web search                       | $2 to $5          |
| One merge by the driver                                                     | $0.20 to $0.50    |

Caches are keyed by model and by exact prefix, so the listener shares nothing with the workers or the orchestrator even where the model matches; its cost lever is a stable, append-only prefix and a tiny per-call delta. The SDK reports usage and cost per turn and per session with a per-model breakdown; the server records it per room.

The listener estimate assumes the API-key path. Without a key the listener is a one-shot Agent SDK session with no explicit cache breakpoints (§6.1), so the estimate does not carry over to it; measure it.

Spend caps. The server hands every Agent SDK session a hard cap, `QUORUM_MAX_BUDGET_USD_PER_SESSION` (default $20; the old name `QUORUM_MAX_BUDGET_USD_PER_ROOM` is still read, with a warning). The cap is per session, not per room: the orchestrator, each exploration worker, each merge-driver run and semantic revert, and each digest writer has its own, so a room's worst case is the sum of its sessions. The listener's classification calls are not capped. Per-room spend caps surfaced to users remain deferred (§1.3).

## 10. Data model

SQLite, one database per deployment:

- `rooms(id, name, ownerId, votingRule, createdAt)`
- `participants(roomId, userId, displayName, role)`
- `presence(roomId, userId, connectedAt, lastSeenAt)`
- `messages(id, roomId, authorId, kind: text | system | card, body, anchor, createdAt)`
- `documents(id, roomId, path, title, status: active | archived)`
- `proposals(id, roomId, documentId, kind: review | quorum, state, branchBase, openedAt, closedAt, stale, reconciled)`
- `options(id, proposalId, label, branch, summary, tradeoffs)`
- `votes(proposalId, optionId, userId, castAt)`
- `changes(sha, roomId, documentId, actor, triggerMessageIds, proposalId, revertsSha)`
- `usage(roomId, sessionId, role, model, inputTokens, outputTokens, costUsd, at)`

Git holds documents only. Commit trailers reference message and proposal ids; the database references commits by sha.

## 11. Interfaces

Server to client over WebSocket: `chat.message`, `chat.card`, `presence.update`, `document.updated { documentId, headSha }`, `document.created`, `document.archived`, `proposal.updated`, `suggestion.pending`, `suggestion.resolved`, `digest.private`.

Client to server: `chat.send`, `suggestion.create`, `ask.create`, `vote.cast`, `revert.request`, `document.create`, `document.rename`, `document.archive`, `room.setRule`, `room.archive`.

Agent-facing tools are listed in §6.2. The listener is called by the server directly through the Anthropic TypeScript SDK when an API key is set, and through a one-shot Agent SDK session otherwise (§6.1).

## 12. Non-functional requirements

Latency targets: listener classification under 2 s after the debounce fires (on the Messages API path; the Agent SDK path used without an API key is slower, §6.1); an exact-match suggestion applied within 10 s; an immediate change within 30 s of the triggering message; exploration results within 3 minutes typical and 5 minutes cap.

Failure handling:

- Orchestrator session crash: restart, resume by session id if possible, otherwise start fresh and rehydrate from room state and the last 50 messages.
- Worker failure or timeout: report partial results; the proposal becomes Abandoned if nothing usable exists.
- Merge driver failure: the proposal stays Open with an explanation.
- API outage: chat keeps working, the agent status indicator shows unavailable, and queued events are processed on recovery.

Security: single tenant, trusted participants. Agent sessions run with the room workspace as working directory and Bash restricted to git and the formatter through the SDK permission callback. Authentication is minimal: a deployment password and a display name, or an invite link per room (open, §13). The first user to log in is the instance admin and the only one who can sign the server in to Claude or out of it; failed logins are throttled (10 per 15 minutes per client address, taken from `X-Forwarded-For` when `QUORUM_TRUST_PROXY=1`), and browser requests that change something, and WebSocket connections, are accepted only from the app's own origin (`QUORUM_ALLOWED_ORIGINS` adds extras). The `/data` volume holds the Claude web login (if one was made), every room's documents and chat history, and the agents' session transcripts; an API key or setup token lives in the deployment's `.env`. The volume, its backups and the `.env` are therefore secrets.

Export: a room's documents are a git repository, so `git clone` is the export.

## 13. Open questions and assumptions

1. Canonical scenario and customer. Assumed: a small engineering team writing design documents on a live call. Confirm or replace; it fixes the example documents and the demo.
2. Authentication for the private instance: deployment password, per-room invite links, or accounts.
3. Thresholds to tune after the first sessions: debounce 3 s, max wait 20 s, listener confidence 0.7, immediate-change limit of 3 rewritten paragraphs, Review window 2 minutes, digest absence 2 minutes, worker cap 5 minutes.
4. Whether a Review proposal should merge when its window elapses with no reaction at all, or only on an approval. Specified above: it merges.
5. Whether the digest should be visible to the whole room as a system message rather than private.
6. Whether a room can import documents from an existing repository, and whether workers may read other rooms' documents (assumed no).
7. Overlapping explorations on one document are allowed in v1; watch whether the resulting double merges are confusing enough to justify the deferred one-per-document cap.
8. Web client stack beyond React and TypeScript: markdown rendering and diff rendering libraries.

### Known limitations of the current build

- Single tenant, trusted users. There is one shared password and an identity is only a display name: anyone with the password can log in under any name. The admin (the first user to log in) controls the Claude sign-in, which is a guard rail rather than a boundary between people who share the password, and there is no per-user isolation.
- No per-room spend cap yet. `QUORUM_MAX_BUDGET_USD_PER_SESSION` limits each agent session separately (§9), the listener's calls are not capped, and the server only records usage per room.
- Mobile is not supported (§1.2): the layouts are for a desktop browser.
- The size-rule and Review-window thresholds (§6.3) are server-wide tunables (`QUORUM_IMMEDIATE_REWRITE_LIMIT`, `QUORUM_REVIEW_WINDOW_MS`), not per-room settings yet.
- The cross-document follow-up after a merge (§6.3) is an instruction to the orchestrator, not a rule the server enforces. The scripted fake runtime does not perform it and the end-to-end suite does not cover it.
- Without an API key the listener runs as a one-shot Agent SDK session (§6.1): slower than the direct call and without explicit prompt-cache breakpoints.

## Appendix A. Changes from the first draft

| Area                     | First draft                                   | This draft                                                                                                                                           |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and history      | CRDT (Automerge or branched Yjs)              | Markdown files in one git repository per room                                                                                                        |
| Concurrency              | Block leases with 15 s TTL                    | Removed; humans do not edit documents, so there is nothing to race                                                                                   |
| Human editing            | Direct live editing supported                 | Chat, in-document suggestions, Ask; the agent is the only writer                                                                                     |
| Merge                    | CRDT merge, agent only on structural conflict | Always a merge commit, so one Revert undoes a proposal; no reconciliation pass when main is unchanged, otherwise the merge driver on Opus reconciles |
| Conflict markers         | Resolution output with diff markers           | Never on main                                                                                                                                        |
| Branch scope             | Per document                                  | Per document, kept, enforced by the server                                                                                                           |
| Direct requests          | Unclear whether a vote was required           | No vote; immediate below a size threshold, Review proposal above it                                                                                  |
| Votes                    | Unanimous, Majority, Owner Override           | Unanimous, Majority; no override, cancel, or force-merge                                                                                             |
| Active participant       | Undefined                                     | Connected now; evaluated on votes and presence changes                                                                                               |
| Vote expiry              | Undefined                                     | Orchestrator decides; archived, never deleted                                                                                                        |
| Citations and provenance | Required                                      | Non-goal; traceability through commit trailers and git blame instead                                                                                 |
| Late results             | Undefined                                     | Posted anyway, collapsed and marked stale                                                                                                            |
| Undo                     | Undefined                                     | Mechanical git revert on every card; the agent for semantic undo                                                                                     |
| Section 5                | Empty                                         | Proposal lifecycle state machine (§8)                                                                                                                |
| Models                   | Unspecified                                   | Sonnet 5.5 listener, workers, and digests; Opus 5.5 orchestrator and merge driver                                                                    |
| Runtime                  | Unspecified                                   | Claude Agent SDK, TypeScript, single tenant                                                                                                          |
| Credentials              | API key implied                               | Web sign-in of the Claude CLI, setup token, or API key                                                                                               |
| Packaging                | Unspecified                                   | One Docker image, one `/data` volume, optional Caddy HTTPS                                                                                           |
