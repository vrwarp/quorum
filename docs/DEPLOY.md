# Deploying Quorum

Quorum ships as a single container: the Node server, the built web app it serves, `git`, and the `claude`
binary that the Agent SDK spawns for each agent session. State lives in one volume mounted at `/data`.

## Build and run

You need Docker with Compose 2.24 or newer.

```bash
cp .env.example .env          # set QUORUM_PASSWORD (required)
docker compose up -d --build
```

The app is on `http://127.0.0.1:8787` (loopback only; see "HTTPS" below). `npm run docker:build` builds just the
image (`quorum:latest`). Without compose:

```bash
docker run -d --name quorum --init --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:8787:8787 -v quorum-data:/data \
  -e QUORUM_PASSWORD=change-me quorum
```

Use `--init` (compose sets `init: true`): agent sessions are child processes and need a PID 1 that reaps them.
`--stop-timeout 30` is compose's `stop_grace_period: 30s`: a clean stop lets a merge in flight finish (up to 25 s),
stops the agents, closes the sockets and records last-seen times before the database closes, and the server exits by
itself after 28 s; Docker's default of 10 s would kill it in the middle of a merge. With a reverse proxy in front, also pass `-e QUORUM_TRUST_PROXY=1` (compose sets it for you).

## First run

1. **Log in yourself before you share the password.** Open the site and log in with the deployment password
   (`QUORUM_PASSWORD`) and a display name. The first person to log in becomes the instance **admin**, and only the admin
   can sign the server in to Claude and out again.
2. As the admin, give the agents a Claude login, any one of:
   - **Settings -> Sign in with Claude** in the app. The login is stored in the volume (`/data/claude`) and survives
     restarts and image updates.
   - `ANTHROPIC_API_KEY` in `.env` (pay per token). It outranks the web login, so it also decides how you are billed.
   - `CLAUDE_CODE_OAUTH_TOKEN` in `.env`: a long-lived token from `claude setup-token`, using a Claude subscription.
3. Until one of these exists the server still runs the real agents (`QUORUM_RUNTIME` defaults to `claude`): rooms work
   as plain chat, a banner says "The agent is not signed in", and the agents start by themselves once a credential
   appears. `QUORUM_RUNTIME=fake` in `.env` swaps in scripted agents (no Claude, no cost) to try the interface; it is for
   smoke tests, not for real rooms.

## Configuration

| Variable                            | Where                  | Meaning                                                                                                  |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `QUORUM_PASSWORD`                   | `.env` (required)      | Shared deployment password.                                                                              |
| `ANTHROPIC_API_KEY`                 | `.env` (optional)      | API-key auth for agents. With a key the listener also calls the Messages API directly (see "Resources"). |
| `CLAUDE_CODE_OAUTH_TOKEN`           | `.env` (optional)      | Subscription token from `claude setup-token`.                                                            |
| `QUORUM_MAX_BUDGET_USD_PER_SESSION` | `.env` (optional)      | Spend cap for each agent session, default 20. It is not a per-room cap: see "Spend cap" below.           |
| `QUORUM_RUNTIME`                    | `.env` (optional)      | `claude` (the default) or `fake` (scripted agents, for smoke tests).                                     |
| `QUORUM_TRUST_PROXY`                | `.env` (optional)      | `1` takes the client address from `X-Forwarded-For`. Compose defaults it to `1`; see "HTTPS".            |
| `QUORUM_ALLOWED_ORIGINS`            | `.env` (optional)      | Extra origins allowed to open the WebSocket, comma-separated (for example `https://quorum.example.com`). |
| `QUORUM_DOMAIN`                     | `.env` (caddy profile) | Public host name for automatic HTTPS.                                                                    |

`PORT`, `QUORUM_DATA_DIR`, `QUORUM_CLIENT_DIST`, `HOME`, `CLAUDE_CONFIG_DIR` and `NODE_ENV` are fixed in the image
(8787, `/data`, `/app/packages/client/dist`, `/data/home`, `/data/claude`, `production`). Do not set them in `.env`.

Everything in `.env` is passed into the container (compose `env_file`), and only `.env` is: a variable exported in the
shell that runs `docker compose` does not reach the container, so a stray `ANTHROPIC_API_KEY` in your shell profile
cannot take over the agents' billing. Apply a change with `docker compose up -d` (it recreates the container; a plain
`restart` does not re-read `.env`). Three things to know when editing it:

- **Single-quote a value that contains a `$`**, for example `QUORUM_PASSWORD='ab$cd9!x'`. Compose also expands `$` in
  `.env`, double quotes included, so an unquoted `ab$cd9!x` silently becomes `ab!x`. (`docker compose config` prints
  every literal `$` as `$$`.)
- Leave a setting you do not use commented out. An uncommented empty `ANTHROPIC_API_KEY=` reaches the `claude` CLI as an
  empty string.
- Tunables such as `QUORUM_DIGEST_ABSENCE_MS` and `QUORUM_REVIEW_WINDOW_MS` (listed in `docs/IMPLEMENTATION.md`) can
  simply be added to `.env`.

Only `QUORUM_PASSWORD` is checked before anything starts: compose refuses to run with it unset or empty.

### Spend cap

`QUORUM_MAX_BUDGET_USD_PER_SESSION` (default 20) is handed to the Agent SDK as a hard limit **for each session**, not for a
room. A room's orchestrator, every exploration worker, every merge-driver run and semantic revert, and every digest
writer is a session with its own cap, so a room's worst case is the sum of its sessions, and several explorations at once
multiply it. When a room's orchestrator, which is one long-lived session, reaches its cap, the agent stops answering in
that room ("The agent has reached its spending limit") until its session is started again; a server restart does that,
with a fresh cap, because the cap belongs to the session.

The listener's classification calls are not covered by the cap at all, and a per-room cap that adds everything up is not
built yet (see "Known limitations" in `docs/PRD.md` §13). Watch spend where you are billed, and what Quorum itself
recorded at `GET /api/rooms/<roomId>/usage` (while logged in). The old name `QUORUM_MAX_BUDGET_USD_PER_ROOM` is still
read, with a warning at startup, and means this same per-session cap (the new name wins when both are set).

## Data and backups

Everything is under `/data` (compose volume `quorum-data`):

| Path             | Contents                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `quorum.sqlite*` | The database (WAL mode: the `-wal`/`-shm` files matter).                                                                                 |
| `rooms/<id>/`    | One bare git repo plus worktrees per room.                                                                                               |
| `claude/`        | `CLAUDE_CONFIG_DIR`: the Claude login (`.credentials.json`, **a secret**), the CLI's `.claude.json` and its `backups/`, and `projects/`. |
| `claude-login/`  | Staging directories for sign-ins in progress; empty when nobody is signing in.                                                           |
| `home/`          | `HOME` for the `claude` CLI.                                                                                                             |

`claude/projects/` holds the transcripts of the orchestrators' sessions (the one-shot workers keep none). Nothing prunes
it, so it grows for as long as the instance runs. A transcript is only read to resume a session that is still alive, so
with the container stopped you can delete old ones from `claude/projects/` (never `.credentials.json`).

Back up while stopped (simplest, consistent). Keep the archives out of the checkout, in a directory only you can read:

```bash
mkdir -p -m 700 "$HOME/quorum-backups"
docker compose stop quorum
docker run --rm -v quorum_quorum-data:/data -v "$HOME/quorum-backups":/backup debian:bookworm-slim \
  tar czf /backup/quorum-data-$(date +%F).tgz -C /data .
docker compose start quorum
```

The volume name is `<project>_quorum-data`; `docker volume ls` shows it. The project name is the directory name, so
`quorum_quorum-data` for a checkout called `quorum`. The archive contains the Claude login and every room's documents and
chat: treat it as a secret (`*.tgz` is git-ignored and kept out of the image build context, but do not park it in the
checkout anyway).

To restore, stop the container and unpack the archive you want over an emptied volume (this replaces everything in it):

```bash
docker compose stop quorum
docker run --rm -v quorum_quorum-data:/data -v "$HOME/quorum-backups":/backup:ro debian:bookworm-slim \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/quorum-data-2026-10-04.tgz -C /data && chown -R 1000:1000 /data'
docker compose start quorum
```

A bind mount (`./data:/data`) also works, but the directory has to exist with `home/` and `claude/` in it, and all of it
must be owned by uid/gid 1000 (the image's `node` user), recursively; the same goes for files you restore into it as
root:

```bash
mkdir -p data/home data/claude && sudo chown -R 1000:1000 data
```

A named volume needs no preparation.

## Updating

```bash
git pull
docker compose up -d --build
```

The volume is kept, so rooms and the Claude login survive. Database migrations run on start (on an instance that
predates the admin rule, the first user ever registered becomes the admin). Take a backup first.

## Logs and health

```bash
docker compose logs -f quorum
docker compose ps            # the healthcheck hits /api/health
```

Set `QUORUM_DEBUG=1` in `.env` for debug logging. If the `caddy` container keeps restarting, `docker compose logs caddy`
says what it is missing (usually `QUORUM_DOMAIN`).

## Resources

One container runs everything; each agent session is a child process inside it (the `claude` binary), so memory and CPU
grow with the number of active sessions. A room's agent session is stopped once the room has been empty for 15 minutes (it starts
again when someone connects), and the worktrees of a proposal's options are removed when the proposal ends, so only rooms
in use cost memory and disk. Plan for roughly 1 GB RAM for the server plus
several hundred MB per concurrently running agent, and about 1 GB of disk for the image plus room data. Outbound HTTPS to
the Anthropic API is required for the real runtime.

**The listener depends on how the server is signed in.** With `ANTHROPIC_API_KEY` set, it classifies chat with direct
Messages API calls on a cached prompt prefix. Without a key (the web sign-in, or `CLAUDE_CODE_OAUTH_TOKEN`) only the
`claude` binary can use the login, so each classification runs through the Agent SDK as a one-shot session: a process per
call, no tools, no explicit prompt-cache breakpoints. It works, but it is slower than the direct call, and the PRD's 2 s
classification target (§12) is not expected to hold on that path. If listener latency matters more to you than avoiding
per-token billing, set an API key.

## HTTPS

Never expose port 8787 directly: the app speaks plain HTTP and sends a session cookie. Options:

- **Bundled Caddy**: set `QUORUM_DOMAIN` in `.env`, point the domain's DNS at the host, then
  `docker compose --profile caddy up -d --build`. Caddy obtains a certificate automatically, proxies WebSocket upgrades
  (`/ws`) with no extra config, and sends the `X-Forwarded-For` and `X-Forwarded-Proto` headers Quorum needs. Ports 80 and
  443 must be free. The caddy container refuses to start without `QUORUM_DOMAIN` and says so in its log.
- **Your own proxy**: leave the profile off and proxy to `127.0.0.1:8787`. Pass the upgrade headers, the original `Host`,
  and the two forwarded headers. `X-Forwarded-Proto` is what marks the session cookie `Secure`. `X-Forwarded-For` is where
  the login throttle finds the visitor's address, and the server reads its first entry, so it has to hold the client's
  address alone. The original `Host` matters because the server refuses a browser request (an API post or the WebSocket)
  unless the page's origin has the same host as the `Host` the server receives: a proxy that rewrites `Host` breaks
  login. For nginx (the `map` goes in the `http` block, once):

  ```nginx
  map $http_upgrade $connection_upgrade {
      default upgrade;
      ''      close;
  }

  server {
      listen 443 ssl;
      server_name quorum.example.com;
      # ssl_certificate and ssl_certificate_key: your certificate

      location / {
          proxy_pass http://127.0.0.1:8787;
          proxy_http_version 1.1;
          proxy_set_header Host $http_host;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $remote_addr;   # not $proxy_add_x_forwarded_for: its first entry is what the client sent
      }
  }
  ```

Either way the server has to be told to believe `X-Forwarded-For`: `QUORUM_TRUST_PROXY=1`. Compose sets it by default,
because the compose deployment is only reachable through a proxy (set `QUORUM_TRUST_PROXY=0` in `.env` if something else
talks to port 8787 directly); with `docker run` or `npm start` behind a proxy, set it yourself. Without it every visitor
looks like the proxy, and the login throttle is one shared bucket. Only turn it on when a proxy you control is the only
way to reach the port: otherwise a client can forge the header and walk around the throttle. If people reach the app
under an address other than the `Host` the server receives, list that origin in `QUORUM_ALLOWED_ORIGINS` (a full origin such
as `https://quorum.example.com`, or a bare host).

## Security

- Quorum is **single tenant** and for **trusted users**. Everyone with the password can create rooms and drive agents
  that read and write files in the container and spend your budget. There is no per-user isolation.
- The first person to log in is the **admin**, and only the admin can sign the server in to Claude or out of it. Identity
  is only a display name behind the shared password, though: anyone who has the password can log in under any name,
  including the admin's. The password is what protects the Claude login; the admin rule keeps ordinary participants away
  from it, it is not a boundary between people who share the password.
- Wrong passwords are throttled: after 10 in 15 minutes from one client address (the address from `X-Forwarded-For`
  when `QUORUM_TRUST_PROXY=1`), logins from it are refused for a while, and a successful login clears the count. Browser
  requests that change something, and the WebSocket, are accepted only from the app's own origin (the `Origin` host must
  equal the `Host` the server receives) plus any listed in `QUORUM_ALLOWED_ORIGINS`.
- The agents' subprocesses do not inherit the server's own `QUORUM_*` settings (`QUORUM_PASSWORD` included); they do
  inherit the rest of the container's environment, `ANTHROPIC_API_KEY` among it.
- The Claude login (the app's sign-in, or `CLAUDE_CODE_OAUTH_TOKEN`) is the **owner's personal login**. Anyone in the
  deployment uses it implicitly; do not offer it to people you would not hand your Claude account to, and do not
  run a shared service on it for others.
- Use a long `QUORUM_PASSWORD`, serve only over HTTPS, and keep `.env` and `/data` backups private: the volume holds the
  Claude credential and every room's documents and chat.
- The container runs as an unprivileged user and holds no host mounts by default.

Known limitations, among them that there is no per-room spend cap yet, are listed in `docs/PRD.md` §13.
