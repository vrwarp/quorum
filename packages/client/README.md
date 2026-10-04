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

- `src/api.ts` typed fetch helpers; `src/ws.ts` reconnecting WebSocket; `src/store.tsx` context + reducer (`src/store.test.ts` runs it against the server's event shapes under `npm test`)
- `src/LoginScreen.tsx`, `RoomsScreen.tsx`, `RoomScreen.tsx`, `SettingsScreen.tsx` (Claude account sign-in)
- `src/components/Chat`, `Canvas`, `Rail`, `Diff`

## Canvas interaction

Click a block: the Suggest textarea and an `ask-button` appear. `ask-button` reveals `ask-input` + `ask-submit`.
Selecting text inside a rendered block shows a floating `ask-button` (only while no block editor is open); it opens
the editor with the ask prompt already revealed. Questions are sent with the anchor of the whole block.

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
| `claude-signin` | "Sign in with Claude" button (shown while not signed in); step 1 |
| `claude-signin-link` | link to Claude's sign-in page, opens in a new tab; step 2 |
| `claude-code`, `claude-code-submit` | paste box for the code (or whole redirect URL) and its Finish button |
| `claude-cancel` | cancels the pending sign-in |
| `claude-signout` | "Sign out" (only for a stored web login; token/API-key credentials come from the server env) |
| `agent-unavailable-banner` | room banner "The agent is not signed in" linking to `/settings`, shown when `agentStatus === 'unavailable'` |
| `agent-status`, `private-marker`, `rule-select` (owner), `rule-label` (others), `usage`, `diff-drawer`, `diff-raw-toggle`, `diff-close`, `word-diff`, `whoami`, `room-name` | misc |

## API assumptions

- `GET /api/me` returns 401 when unauthenticated; errors are JSON `{error}` or `{message}`.
- `/api/claude/*` (status, login/start, login/code, login/cancel, logout) needs a session; 503 when the server has no sign-in service. Error bodies are `{error: code, message}`; the client shows `message` when present.
- Document fetch is `?ref=main` or `?ref=<branch>`; `ref` omitted is not used.
- WebSocket uses the cookie (no `token` query); server sends `hello` first, then events. `hello` replaces the room snapshot (documents, proposals, presence, rule) and is merged into the transcript: its messages win, earlier pages and events that raced ahead of it (a private digest) stay.
- `document.created` is an upsert (it is also how a rename arrives); `chat.updated` only replaces a message already on screen; `room.updated` carries a changed voting rule.
- `GET /api/rooms/:id/messages?before=` returns older messages oldest-first.
