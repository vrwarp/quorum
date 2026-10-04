# Quorum implementation plan

Companion to `docs/PRD.md`. This file fixes module boundaries so several engineers (or agents) can
build in parallel against the same contracts. Read the PRD first; this file does not repeat it.

## Layout

```
packages/shared/        types + WS/HTTP protocol + listener intent schema + tunables   (frozen; ask before changing)
packages/server/src/
  contracts/            interfaces between server modules (frozen; ask before changing)
  config.ts             env parsing: QUORUM_DATA_DIR, QUORUM_PASSWORD, PORT, ANTHROPIC_API_KEY, QUORUM_RUNTIME=claude|fake
  db/                   M1a  node:sqlite implementation of contracts/storage.ts
  git/                  M1a  implementation of contracts/git.ts (bare repo + worktrees, trailers, write lock, formatter hook)
  room/                 M1b  RoomService: all domain logic, implements contracts/agents.ts RoomActions, emits events
  api/                  M1b  http.ts (REST + static client), ws.ts (protocol), auth.ts (password + session cookie)
  agents/               M1c  claude/ (real runtime on the Agent SDK + Messages API), fake/ (scripted runtime), shared prompts
  main.ts               M2   composition root
packages/client/        M1d  React + Vite SPA
e2e/                    M2   Playwright tests against the server with QUORUM_RUNTIME=fake
```

Dependency direction: `api -> room -> {db, git, agents}`; `agents -> contracts only` (never imports room/db/git
implementations). `client -> shared` only.

## Conventions

- TypeScript strict, ESM (`import x from './x.js'` with the `.js` extension in server code), Node 22.
- Tests: vitest, files `*.test.ts` next to the code. Git tests use a temp dir and the real `git` binary.
- No new root dependencies without noting it in your report; prefer what is already installed
  (`ws`, `diff`, `zod` v4, `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `react-markdown`, `remark-gfm`).
- SQLite via `node:sqlite` (`DatabaseSync`), not better-sqlite3. Suppress the experimental warning in main.
- Logging: a tiny `logger(level, msg, meta)` function; no logging libraries.
- Do not run `git commit`, `git checkout`, or `git stash` in the project repository; the integrator commits.
  (Creating git repositories under temp dirs or under `QUORUM_DATA_DIR` for the app itself is of course fine.)
- Ids: `newId('msg')` etc. from `@quorum/shared`.
- Time: ISO strings in storage and on the wire.

## Module responsibilities

### db (M1a)
Implements `Storage`. Single file `quorum.sqlite` under `QUORUM_DATA_DIR`. Schema in `schema.ts` with a
`migrations` array; `openStorage(path)` applies them. Messages store `card`/`anchor`/`author` as JSON columns.
`ProposalRepo.get` must return options and votes populated.

### git (M1a)
Implements `GitProvider` / `RoomRepository` by shelling out to `git` (`child_process.execFile`, never a shell
string with user input). Layout per PRD §4.1: `rooms/<roomId>/repo.git` and `rooms/<roomId>/worktrees/<name>`.
`init()` creates the bare repo, a `main` branch with an initial empty commit, the `main` worktree, and a
`pre-commit` hook (set `core.hooksPath`) that runs the formatter on staged `*.md`. The formatter is
`prettier --prose-wrap preserve` through `npx prettier` resolved from the project `node_modules`
(find it via `require.resolve('prettier/bin/prettier.cjs')` or the `prettier` API in-process before `git add`).
Trailers via `git -c trailer.ifexists=addIfDifferent commit --trailer`. `withMainLock` is an in-process async
mutex (promise chain). `beginMerge` uses a detached worktree at main; `finishMerge` commits there and then
updates `refs/heads/main` in the bare repo and resets the main worktree. `revert` runs in the main worktree.
`rewrittenLineCount` = removed lines in `git diff --numstat` for the path (added separately).

### room (M1b)
`RoomService` is the only place with domain rules. It:
- creates rooms (also calls `git.open(roomId).init()` and creates no default documents),
- creates documents (`<Title>.md` with `# Title` as first line, committed through the write lock, actor user),
- stores every message and broadcasts via an `EventEmitter` (`emit('event', roomId, ServerEvent, {privateTo?})`),
- routes human text to `runtime.onChatMessage`, suggestions to `onSuggestion`, asks to `onAsk`,
- implements proposals: `openProposal` validates scope with `repo.changedFiles(branchBase, branch)` (must be
  exactly `[document.path]`), sets state open, posts the card message, starts the Review window timer;
  `castVote` persists and evaluates (PRD §7.2–7.3; eligible = currently connected participants, agent excluded);
  presence changes also trigger evaluation; a passed Review/Quorum proposal enters `merging` and the merge pipeline:
  `repo.withMainLock(beginMerge)`; fast-forward => done; else `runtime.runMergeDriver` then `finishMerge`;
  record Change, tag `milestone/<n>` for quorum proposals, post a merge card, mark sibling options `superseded`,
  notify `runtime.onProposalEvent({type:'merged'})`; on failure state back to `open` and `merge_failed` event,
- implements revert: `repo.revert` through the lock, `RevertConflictError` => `runtime.runSemanticRevert`,
- implements presence: connect/disconnect, and the rejoin digest (PRD §7.5): on connect, if lastSeen is older
  than `digestAbsenceMs` and notable events (changes, proposal state changes, document created) happened since,
  call `runtime.writeDigest` and `sendPrivate`,
- exposes `RoomActions` for the agent runtime and a `Hub` API for `api/ws.ts` (`connect(roomId, userId, send)`,
  `handle(roomId, userId, ClientCommand)`, `disconnect`).

### api (M1b)
`http.ts`: Node `http` server (no framework), JSON routes from `packages/shared/src/protocol.ts`, static files
from `packages/client/dist` with SPA fallback, cookie auth. `ws.ts`: `ws` server on `/ws`, one socket per
(room, user) connection, validates `ClientCommand` with zod before handing to the hub. Login compares
`password` with `QUORUM_PASSWORD` (constant-time), finds or creates the user by display name.

### agents (M1c)
Two implementations of `AgentRuntime`:
- `fake/FakeRuntime.ts`: deterministic, keyword-driven, no network. Must exercise every RoomActions path so
  the e2e tests can cover the PRD scenario. Behaviors are documented in `agents/fake/README.md`.
- `claude/ClaudeRuntime.ts`: the real thing. Listener = `@anthropic-ai/sdk` Messages API on
  `MODELS.listener` with structured output (`output_config.format` json schema from `IntentBatchJsonSchema`),
  prompt caching breakpoints after the stable prefix, debounce/max-wait per DEFAULTS. Orchestrator = one
  `query()` from `@anthropic-ai/claude-agent-sdk` per room with streaming input (async iterable of user
  messages), `cwd` = main worktree, `model`/`effort` from shared config, `allowedTools` built-ins +
  the in-process MCP server (`createSdkMcpServer` + `tool()` wrapping RoomActions), `canUseTool` restricting
  Bash to git/prettier/read-only commands, `hooks.PreCompact` reminder, `maxBudgetUsd` from env. Workers =
  one `query()` each with `cwd` set to the branch worktree; exploration workers get `WebSearch`/`WebFetch`;
  merge driver and digest writer as in the PRD. Usage from result messages -> `recordUsage`.
  Read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for exact option names; do not guess.

### client (M1d)
Vite dev proxy `/api` and `/ws` to the server. Screens: Login, Rooms, Room. Room = chat pane (left) +
canvas (right) + branch rail (collapsible). Cards per PRD §7.1 with Approve/Reject/vote/Revert buttons.
Canvas renders markdown by paragraph (one source line = one block) so click-to-suggest and select-to-ask
can compute `Anchor`s (`textHash` from shared). Diff view uses the `diff` package for word-level diffs of
`DiffResponse.before/after`. Keep state in a small store (React context + reducer); no state libraries.

### e2e (M2)
Playwright starts the built server with `QUORUM_RUNTIME=fake` and a temp data dir, logs in two browser
contexts, and walks PRD §2: direct request -> Change card; divergence -> exploration -> Quorum card ->
votes -> merge; suggestion -> applied; ask -> answer; revert; rejoin digest (presence absence tunable set low).

## Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 | scaffold, shared, contracts, this doc | `npm run typecheck` passes for shared |
| M1a–d | the four module groups above, in parallel | each module typechecks and its unit tests pass |
| M2 | main.ts, e2e | `npm run build && npm run test && npm run test:e2e` green with the fake runtime |
| M3 | Opus review, fixes | findings addressed |
| M4 | final verification | manual walkthrough, screenshots, push |
