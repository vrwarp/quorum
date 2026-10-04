# Signing the server in to Claude

The agents run on the Claude Agent SDK, which needs a Claude credential on the **server**. This is separate from the
deployment password people use to join Quorum. The credential can be supplied three ways; the server starts without
any of them (the agent shows as "not signed in" until one is present). Signing the server in or out from the web is
**admin-only**: the admin is the first person who logged in to the instance, so log in yourself before you share the
deployment password.

| Method                | How                                                                     | Billing                     |
| --------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Web sign-in (default) | Settings -> **Sign in with Claude** in the app (admin only)             | Owner's Claude subscription |
| Long-lived token      | `claude setup-token` on any machine, then set `CLAUDE_CODE_OAUTH_TOKEN` | Owner's Claude subscription |
| API key               | set `ANTHROPIC_API_KEY`                                                 | Pay per token               |

If more than one is present the order is: API key, then token, then the stored web login. An API key therefore outranks
a web login that is still stored, and moves billing to the Console account.

The choice also decides how the listener (the part that reads the chat) runs. With `ANTHROPIC_API_KEY` it calls the
Messages API directly, with a cached prompt prefix. With a token or the web login, only the `claude` subprocess can use
the credential, so each classification runs as a one-shot Agent SDK session: a process per call and no explicit
prompt-cache breakpoints, slower than the direct call (PRD §6.1).

## Web sign-in flow

Any logged-in Quorum user can open `/settings` (linked from the rooms and room headers), but only the admin can use it:
the server refuses every `/api/claude/*` route to anyone else, and the page hides the sign-in controls for them. (In a
room, everyone still sees the "agent is not signed in" banner.) The admin is the first user who registered on the instance
(the first person to log in with a new display name creates the user), so **log in yourself before sharing the
password**. The flow is the one the Claude Code CLI already supports over pipes:

1. **Sign in with Claude** -> `POST /api/claude/login/start`. The server spawns `claude auth login --claudeai` with
   `CLAUDE_CONFIG_DIR` pointing at a per-attempt staging directory (`<dataDir>/claude-login/<id>`) and
   `BROWSER=/bin/true`, and returns the https URL the CLI prints.
2. The person opens the link in a new tab, approves access on Claude's site, and copies the code it shows.
3. They paste the code (or the whole redirect URL; the client extracts `code=`) -> `POST /api/claude/login/code`.
   The server writes it to the CLI's stdin. **Exit code 0 means accepted.**
4. Only then is the staged `.credentials.json` promoted (write + rename, mode 0600) into the real config dir, the
   staging dir is deleted, the status cache is dropped and `onChange` listeners fire (so the runtime can restart
   room sessions with the new login). A rejected, cancelled or timed-out attempt leaves existing credentials untouched.

Limits: at most 3 pending logins (each is a live subprocess), 5 starts and 20 code submissions per client address per
10 minutes, 10 minutes for an unfinished login, 60 s for the CLI to answer a code. The client address is the one in
`X-Forwarded-For` when `QUORUM_TRUST_PROXY=1` (set it behind Caddy or nginx; the compose file does); without it, behind a
proxy, every visitor shares the proxy's address and these limits are global rather than per client. **Sign out** deletes
`.credentials.json`; it cannot remove a token or API key supplied through the environment.

All `/api/claude/*` routes require the admin's Quorum session. They answer 503 if the server was built without the
service.

| Route                           | Body                             | Result                                                                                |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/claude/status`        |                                  | `{signedIn, method: oauth_login\|oauth_token\|api_key\|none, account, pendingLogins}` |
| `POST /api/claude/login/start`  | `{mode?: "claudeai"\|"console"}` | `{loginId, url}`                                                                      |
| `POST /api/claude/login/code`   | `{loginId, code}`                | status (400 with `message` if rejected)                                               |
| `POST /api/claude/login/cancel` | `{loginId}`                      | `{ok: true}`                                                                          |
| `POST /api/claude/logout`       |                                  | status                                                                                |

Status is probed with `claude auth status` (exit 0 = signed in) under the same config dir, cached for 30 s; if the CLI
cannot run, it falls back to checking that `.credentials.json` exists.

## Where credentials live

`<QUORUM_DATA_DIR>/claude/.credentials.json`. That directory is `CLAUDE_CONFIG_DIR` for the sign-in flow, the status
probe and the Agent SDK (override with `CLAUDE_CONFIG_DIR`). Besides the login it holds what the CLI keeps for itself:
`.claude.json`, `backups/`, and `projects/`, the transcripts of the orchestrators' sessions, which grow without bound
(see "Data and backups" in `docs/DEPLOY.md`). Sign-in attempts in flight are staged in a sibling directory,
`<QUORUM_DATA_DIR>/claude-login/<id>`, outside the one the SDK reads, and removed when the attempt ends. In Docker both
are inside the `/data` volume, so they survive restarts; treat the volume like a secret. The token and API key are read
from the environment only and never written to disk by Quorum.

## Operator-supplied alternatives

- **Token:** run `claude setup-token` on a machine where you are signed in; it prints a token valid for about a year.
  Put it in `CLAUDE_CODE_OAUTH_TOKEN`. No web sign-in is needed, and Settings shows "token" with no sign-out.
- **API key:** `ANTHROPIC_API_KEY`. Billed per token against the Console account.

## Policy note: personal use only

Anthropic does not allow third-party products to offer claude.ai login to other people. The subscription sign-in
(web sign-in or `setup-token`) is intended for the owner's own use: your server, your login, people you personally
invite. Do not run a Quorum deployment as a service that lets strangers spend your subscription; anyone who needs
their own agent should run their own deployment with their own credentials, or use an API key. The Settings page
repeats this. The admin rule keeps ordinary participants away from the sign-in, but identity in Quorum is only a display
name behind the shared password: anyone who has the password can log in under the admin's name. The deployment password
is therefore what stands between your Claude login and everyone who can reach the server, so keep it long and private.
