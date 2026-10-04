# @quorum/client

React 19 + Vite SPA for Quorum. Depends only on `@quorum/shared`.

## Run

```
npm run dev -w @quorum/client      # vite dev server; proxies /api -> :8787 and /ws -> ws://localhost:8787
npm run build -w @quorum/client    # tsc -b && vite build -> packages/client/dist
```

Routes use the History API: `/` (login, or rooms when authenticated), `/rooms`, `/rooms/:roomId`.
The server must serve `index.html` for unknown paths.

## Source map

- `src/api.ts` typed fetch helpers; `src/ws.ts` reconnecting WebSocket; `src/store.tsx` context + reducer
- `src/LoginScreen.tsx`, `RoomsScreen.tsx`, `RoomScreen.tsx`
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
| `revert-<sha>` | Change card revert button (disabled once reverted) |
| `doc-tab-<documentId>` | document tab |
| `doc-create`, `doc-create-title`, `doc-create-submit` | new document |
| `doc-menu`, `doc-rename-input`, `doc-rename-submit`, `doc-archive` | rename/archive menu |
| `block-<line>` | document block (1-based source line); `pending-<line>` suggestion-pending marker |
| `suggest-textarea`, `suggest-submit` | inline suggestion editor |
| `ask-button`, `ask-input`, `ask-submit` | ask flow |
| `rail-toggle` | collapse/expand the branch rail; `rail`, `rail-proposal-<proposalId>`, `rail-option-<optionId>` |
| `branch-banner`, `branch-exit` | branch view banner / back to main |
| `presence-<userId>` | connected-user chip |
| `agent-status`, `private-marker`, `rule-select` (owner), `rule-label` (others), `usage`, `diff-drawer`, `diff-raw-toggle`, `diff-close`, `word-diff`, `whoami`, `room-name` | misc |

## API assumptions

- `GET /api/me` returns 401 when unauthenticated; errors are JSON `{error}` or `{message}`.
- Document fetch is `?ref=main` or `?ref=<branch>`; `ref` omitted is not used.
- WebSocket uses the cookie (no `token` query); server sends `hello` first, then events; `hello` replaces state.
- `GET /api/rooms/:id/messages?before=` returns older messages oldest-first.
