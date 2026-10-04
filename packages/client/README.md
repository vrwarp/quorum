# @quorum/client

React 19 + Vite SPA for Quorum. Depends only on `@quorum/shared`.

## Run

```
npm run dev -w @quorum/client      # vite dev server; proxies /api -> :8787 and /ws -> ws://localhost:8787
npm run build -w @quorum/client    # tsc -b && vite build -> packages/client/dist
```

Routes use the History API: `/` (login, or rooms when authenticated), `/rooms`, `/rooms/:roomId`, `/settings`.
The server must serve `index.html` for unknown paths.

## Source map

- `src/api.ts` typed fetch helpers (and `normalizeCode`, which turns a pasted sign-in address into `code#state`); `src/ws.ts` reconnecting WebSocket; `src/store.tsx` context + reducer (`src/store.test.ts` runs it against the server's event shapes under `npm test`); `src/commands.ts` correlates commands with the errors that answer them
- `src/LoginScreen.tsx`, `RoomsScreen.tsx`, `RoomScreen.tsx`, `SettingsScreen.tsx` (Claude account sign-in)
- `src/components/Chat`, `Canvas` (`canvasModel.ts` holds the pure line/anchor logic), `Rail`, `Diff`
- `src/proposalState.ts` (what collapses, who counts in a tally), `src/agentStatus.ts` (which unavailable reasons Settings can fix), `src/ErrorBoundary.tsx`

Unit tests (`*.test.ts` next to the code) cover the reducer, the socket's reconnect and refusal handling (against a fake `WebSocket`), the command tracker, anchor and marker logic, and the sign-in address parsing. The browser behavior is covered by `e2e/` (see its specs).

## Canvas interaction

Click a block: the Suggest textarea and an `ask-button` appear. `ask-button` reveals `ask-input` + `ask-submit`.
Selecting text inside a rendered block shows a floating `ask-button` (only while no block editor is open); it opens
the editor with the ask prompt already revealed. Questions are sent with the anchor of the whole block.

- **The anchor is captured when the editor opens** (`{documentId, baseSha, startLine, endLine, textHash, text}`, with `baseSha` the revision the shown text was fetched at) and is what gets submitted, however the document moves meanwhile. If the paragraph changes while the editor is open, `editor-stale-notice` says so; the editor follows the paragraph if it only moved, keeps what was typed, and the server reconciles by comparing against main (PRD 5.2). The editor closes when the document or branch on screen changes.
- Keyboard: the caret starts at the end of the paragraph, Ctrl/Cmd+Enter suggests, Escape closes, and focus returns to the paragraph afterwards.
- `pending-<line>` marks the paragraph whose text hash a pending suggestion names, wherever that paragraph is now; the repository head is not compared, so everyone sees the same markers.
- Links in a document open in a new tab (`rel="noreferrer noopener"`) and do not open the editor.
- Stale and archived proposal cards render collapsed with a label (`card-collapsed-label`) and a toggle (`card-toggle`); a stale proposal can still be expanded and voted on.
- A Change card says on behalf of which messages it was made (`change-triggers`, each entry jumps to the message) and every Change card carries Revert, a revert's too.
- Tallies count connected voters only, as the server's rule does; the rest show as `tally-away-<optionId>`.
- Archived room: owner-only `room-archive` asks for confirmation (`room-archive-confirm`, `room-archive-yes`, `room-archive-cancel`) and sends `room.archive`; once `room.archivedAt` is set everyone gets `room-archived-banner` and nothing can be typed, suggested, voted on or reverted. An archived room cannot be joined again (the server refuses the socket with `room_archived`): `room-archived-notice`.

## data-testid reference

| testid | element |
|---|---|
| `login-name`, `login-password`, `login-submit` | login form |
| `room-create-name`, `room-create-submit` | create-room form |
| `room-link-<roomId>` | room link in the list (navigates to `/rooms/<roomId>`) |
| `chat-input`, `chat-send` | chat box (Enter sends, Shift+Enter newline) |
| `message-<messageId>` | one transcript entry |
| `card-change`, `card-suggestion`, `card-ask`, `card-review`, `card-quorum`, `card-digest`, `card-merge` | cards (also `card-exploration`, `card-agent-status`) |
| `vote-<optionId>` | Quorum vote button; `tally-<optionId>` vote count; `diff-<optionId>` option diff button |
| `review-approve`, `review-reject` | Review card buttons; `review-countdown` |
| `revert-<sha>` | Revert button on a Change card or a Merge card (disabled once reverted) |
| `doc-tab-<documentId>` | document tab |
| `doc-create`, `doc-create-title`, `doc-create-submit` | new document |
| `doc-menu`, `doc-rename-input`, `doc-rename-submit`, `doc-archive` | rename/archive menu |
| `block-<line>` | document block (1-based source line); `pending-<line>` suggestion-pending marker |
| `suggest-textarea`, `suggest-submit` | inline suggestion editor |
| `ask-button`, `ask-input`, `ask-submit` | ask flow |
| `rail-toggle` | collapse/expand the branch rail; `rail`, `rail-proposal-<proposalId>`, `rail-option-<optionId>` |
| `branch-banner`, `branch-exit` | branch view banner / back to main |
| `presence-<userId>` | connected-user chip |
| `settings-link` | "Settings" link in the rooms header and the room header (navigates to `/settings`) |
| `claude-status` | status line on `/settings` (e.g. "Signed in with a Claude subscription login (email)", "Not signed in") |
| `claude-signin` | "Sign in with Claude" button (shown while not signed in; reads "Start again" after a rejected code); step 1 |
| `claude-signin-link` | link to Claude's sign-in page, opens in a new tab; step 2 |
| `claude-code`, `claude-code-submit` | paste box for the code (or whole redirect URL; an address with `code` and `state` is sent as `code#state`) and its Finish button |
| `claude-cancel` | cancels the pending sign-in (leaving the screen cancels it too) |
| `claude-signout` | "Sign out" (only for a stored web login; token/API-key credentials come from the server env) |
| `agent-unavailable-banner` | room banner shown when `agentStatus === 'unavailable'`: "The agent is not signed in" with a link (`agent-banner-settings`) to `/settings` when the server's detail mentions signing in, otherwise "The agent is unavailable: <detail>" with no link |
| `claude-admin-note` | "Only the first registered user can sign the agent in" (Settings); for anyone else the sign-in controls and the status line are not rendered |
| `chat-error`, `doc-error`, `editor-error`, `card-error`, `rule-error`, `room-archive-error` | why the server rejected a command, next to the control that sent it |
| `editor-stale-notice`, `suggest-cancel` | editor notice that the paragraph changed meanwhile / cancel button |
| `card-toggle`, `card-collapsed-label`, `card-proposal-missing` | collapsed proposal cards; a card whose proposal cannot be fetched |
| `change-triggers`, `trigger-<messageId>` | "on behalf of" line of a Change or Merge card |
| `tally-away-<optionId>` | votes on an option from people who are not connected |
| `room-archive`, `room-archive-confirm`, `room-archive-yes`, `room-archive-cancel`, `room-archived-banner`, `room-archived-notice` | archiving a room, and its result |
| `room-not-found`, `room-session-ended`, `error-boundary` | an unknown room, a revoked session, a screen that failed to render |
| `diff-range` | "path · base → head" line of the diff drawer |
| `agent-status`, `private-marker`, `rule-select` (owner), `rule-label` (others), `usage`, `diff-drawer`, `diff-raw-toggle`, `diff-close`, `word-diff`, `whoami`, `room-name` | misc |

## API assumptions

- `GET /api/me` returns 401 when unauthenticated and `{userId, displayName, isAdmin}`; errors are JSON `{error}` or `{message}`. `isAdmin` is true for the first registered user only; a server that omits it leaves the decision to the server.
- `/api/claude/*` (status, login/start, login/code, login/cancel, logout) needs a session, and the admin's at that; 503 when the server has no sign-in service. Error bodies are `{error: code, message}`; the client shows `message` when present. A 4xx other than 429 on `login/code` means the server ended that login, and the screen goes back to its first step.
- Document fetch is `?ref=main` or `?ref=<branch>`; `ref` omitted is not used.
- Every command carries a `cid`; the server echoes it as `inReplyTo` on the `error` event that rejects the command, and the control that sent it shows the reason and gets its input back. Errors without a matching command go to the room banner.
- A socket that never opens is probed with `GET /api/rooms/:id/usage`: 401 ends the room screen with a way to log in again, 404 says the room does not exist; anything else is retried with jittered backoff that only resets after `hello`. `error` with code `room_archived` ends the retrying too.
- `hello` carries `agentStatus` and `agentDetail`; `agent.status` updates both. After a reconnect whose snapshot starts after the newest message held (more than a snapshot's worth was missed), the missing messages are fetched with `GET /messages?before=` and replace what preceded the snapshot.
- A card whose proposal is not in the snapshot is looked up in `GET /api/rooms/:id/state` after a short grace period (there is no single-proposal route; that list carries the same recent closed proposals the snapshot does, so a much older proposal stays "details not available").
- WebSocket uses the cookie (no `token` query); server sends `hello` first, then events. `hello` replaces the room snapshot (documents, proposals, presence, rule) and is merged into the transcript: its messages win, earlier pages and events that raced ahead of it (a private digest) stay.
- `document.created` is an upsert (it is also how a rename arrives); `chat.updated` only replaces a message already on screen; `room.updated` carries a changed voting rule.
- `GET /api/rooms/:id/messages?before=` returns older messages oldest-first.
