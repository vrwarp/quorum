# Quorum implementation plan

Companion to `docs/PRD.md`. This file fixes module boundaries so several engineers (or agents) can
build in parallel against the same contracts. Read the PRD first; this file does not repeat it.

## Layout

```
packages/shared/        types + WS/HTTP protocol + listener intent schema + tunables   (frozen; ask before changing)
packages/server/src/
  contracts/            interfaces between server modules (frozen; ask before changing)
  config.ts             env parsing: QUORUM_DATA_DIR, QUORUM_PASSWORD, PORT, ANTHROPIC_API_KEY, QUORUM_RUNTIME=claude|fake (see "Running it")
  db/                   M1a  node:sqlite implementation of contracts/storage.ts
  git/                  M1a  implementation of contracts/git.ts (bare repo + worktrees, trailers, write lock, formatter hook)
  room/                 M1b  RoomService: all domain logic, implements contracts/agents.ts RoomActions, emits events
  api/                  M1b  http.ts (REST + static client), ws.ts (protocol), auth.ts (password + session cookie)
  agents/               M1c  claude/ (real runtime on the Agent SDK + Messages API), fake/ (scripted runtime), shared prompts
  claudeauth/           M1e  ClaudeAuthService: web sign-in of the Claude CLI (see docs/CLAUDE-SIGNIN.md)
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

### integration and e2e (M2)
`packages/server/src/api/integration.test.ts` boots `startServer()` for real (SQLite, git, HTTP + WebSocket, fake
runtime) and drives it with `fetch` and `ws`: the PRD §2 scenario, restarts, merges through the merge driver,
presence-completed votes, rename/archive and the error paths. It runs under `npm test`.

`e2e/` runs the same server as a separate process (`QUORUM_RUNTIME=fake`, temp data dir) and walks PRD §2 through
the real client in Chromium with two browser contexts: direct request -> Change card; divergence -> exploration ->
Quorum card -> votes -> merge; suggestion -> applied; ask -> answer; revert; rejoin digest (absence tunable set low);
Review proposals (reject, and merge when the window closes); documents and the voting rule; a dropped and restored
socket; Settings.

Found and fixed while wiring it up: the protocol gained one additive event, `room.updated` (a voting-rule change had no
way to reach clients); a revert now flags the original Change card through `chat.updated` (the card embeds its
`Change`); the Merge card has a Revert button; `startServer()` returns `close()`, and `attachWebSocket(...).close()` is
async so shutdown records last-seen times before the database closes; `node:sqlite` is loaded lazily so its
experimental warning can be filtered (a static import warns while the module graph links).

## Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 | scaffold, shared, contracts, this doc | `npm run typecheck` passes for shared |
| M1a–d | the four module groups above, in parallel | each module typechecks and its unit tests pass |
| M2 | main.ts, integration and e2e tests | `npm run validate && npm run test:e2e` green with the fake runtime |
| M3 | Opus review, fixes | findings addressed |
| M4 | final verification | manual walkthrough, screenshots, push |

## Running it

Needs Node >= 22.13 and `git` on the PATH. Install once with `npm install` (npm workspaces: `packages/*` and `e2e`).

### Development (two terminals)

```bash
# terminal 1: the server, restarted on change (http://localhost:8787). The fake agent needs no Claude login.
QUORUM_PASSWORD=dev QUORUM_RUNTIME=fake npm run dev:server

# terminal 2: the Vite client with hot reload (http://localhost:5173); it proxies /api and /ws to :8787
npm run dev:client
```

Open http://localhost:5173 and log in with any display name and the password. The data directory defaults to
`./data` relative to where the server runs (`packages/server/data` under `npm run dev:server`; git-ignored). Drop
`QUORUM_RUNTIME=fake` to use the real agents: they need a Claude login (the Settings page, `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN`; see `docs/CLAUDE-SIGNIN.md`).

### Production (one process)

```bash
npm run build
QUORUM_PASSWORD=change-me QUORUM_DATA_DIR=/var/lib/quorum npm start     # http://localhost:8787
```

`npm start` runs `node packages/server/dist/main.js`, which serves the API, `/ws` and the built client
(`packages/client/dist`, with SPA fallback). SIGINT/SIGTERM shut it down cleanly: agents stop, sockets close and
last-seen times are recorded, then the database closes.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QUORUM_PASSWORD` | required | Shared password (`QUORUM_ALLOW_NO_PASSWORD=1` runs without one: tests and local use only). |
| `PORT` | `8787` | HTTP and WebSocket port. |
| `QUORUM_DATA_DIR` | `./data` | SQLite database, per-room git repositories, the Claude login (`claude/`). |
| `QUORUM_RUNTIME` | `claude` | `claude` (real agents) or `fake` (scripted, no network). |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | unset | Credentials for the real agents; otherwise sign in from Settings. |
| `CLAUDE_CONFIG_DIR` | `<data>/claude` | Where the web sign-in stores the Claude login. |
| `QUORUM_CLAUDE_BINARY` | the Agent SDK's bundled binary | Another Claude Code executable (a path, or a name looked up on the PATH). |
| `QUORUM_MAX_BUDGET_USD_PER_ROOM` | `20` | Spend cap per room. |
| `QUORUM_CLIENT_DIST` | `packages/client/dist` | Built client to serve. |
| `QUORUM_<NAME>_MS` ... | `packages/shared/src/config.ts` | Any `DEFAULTS` key, upper-snake-cased: `QUORUM_DIGEST_ABSENCE_MS`, `QUORUM_REVIEW_WINDOW_MS`, `QUORUM_LISTENER_DEBOUNCE_MS`, ... |
| `QUORUM_FAKE_EXPLORE_MS` | `500` | Fake runtime only: how long an exploration takes. |
| `QUORUM_DEBUG` | unset | `1` enables debug logging. |

### Tests

```bash
npm test             # vitest: unit tests plus the server integration test (real git and SQLite, fake runtime; ~15 s)
npm run typecheck    # tsc -b over shared, server, client and e2e
npm run format       # prettier --write; `npm run format:check` verifies
npm run validate     # typecheck + format:check + test + build: run before pushing
```

### End-to-end tests

```bash
npm run build && npm run test:e2e
```

Playwright starts `node packages/server/dist/main.js` on port 8799 (`QUORUM_E2E_PORT` changes it) with a temporary data directory,
`QUORUM_RUNTIME=fake`, short tunables (digest absence 1.5 s, review window 4 s, listener debounce 200 ms) and a stub
`claude` CLI (`e2e/fake-claude.mjs`, so Settings reliably reads "Not signed in"). It then drives the built client in
Chromium with two or three browser contexts per spec. The fake runtime's phrases are listed at the top of
`e2e/quorum.spec.ts`.

Chromium: `npx playwright install chromium`, or, where a different revision is already installed under
`PLAYWRIGHT_BROWSERS_PATH` and downloads are not possible, the config falls back to it; `QUORUM_E2E_CHROMIUM` pins an
executable. `QUORUM_E2E_VERBOSE=1` shows the server log. Failures leave traces and screenshots in `e2e/test-results/`
and an HTML report in `playwright-report/` (`npx playwright show-report`).

### Docker

`docker compose up -d --build`; see `docs/DEPLOY.md`.
