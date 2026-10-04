# Deploying Quorum

Quorum ships as a single container: the Node server, the built web app it serves, `git`, and the `claude`
binary that the Agent SDK spawns for each agent session. State lives in one volume mounted at `/data`.

## Build and run

```bash
cp .env.example .env          # set QUORUM_PASSWORD (required)
docker compose up -d --build
```

The app is on `http://127.0.0.1:8787` (loopback only; see "HTTPS" below). `npm run docker:build` builds just the
image (`quorum:latest`). Without compose:

```bash
docker run -d --name quorum --init --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v quorum-data:/data \
  -e QUORUM_PASSWORD=change-me quorum
```

Use `--init` (compose sets `init: true`): agent sessions are child processes and need a PID 1 that reaps them.

## First run

1. Open the site and log in with the deployment password (`QUORUM_PASSWORD`) and a display name.
2. Give the agents a Claude login, any one of:
   - **Settings -> Sign in with Claude** in the app. The login is stored in the volume (`/data/claude`) and survives
     restarts and image updates.
   - `ANTHROPIC_API_KEY` in `.env` (pay per token). With a key set and no `QUORUM_RUNTIME`, the real runtime is used.
   - `CLAUDE_CODE_OAUTH_TOKEN` in `.env`: a long-lived token from `claude setup-token`, using a Claude subscription.
3. With none of these and no `QUORUM_RUNTIME`, the server runs the scripted **fake** runtime (no Claude, no cost),
   which is good for trying the UI. Set `QUORUM_RUNTIME=claude` to force the real one.

## Configuration

| Variable                         | Where                  | Meaning                                                                    |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `QUORUM_PASSWORD`                | `.env` (required)      | Shared deployment password.                                                |
| `ANTHROPIC_API_KEY`              | `.env` (optional)      | API-key auth for agents.                                                   |
| `CLAUDE_CODE_OAUTH_TOKEN`        | `.env` (optional)      | Subscription token from `claude setup-token`.                              |
| `QUORUM_MAX_BUDGET_USD_PER_ROOM` | `.env` (optional)      | Spend cap per room, default 20.                                            |
| `QUORUM_RUNTIME`                 | `.env` (optional)      | `claude` or `fake`.                                                        |
| `QUORUM_DOMAIN`                  | `.env` (caddy profile) | Public host name for automatic HTTPS.                                      |
| `PORT`, `QUORUM_DATA_DIR`, `QUORUM_CLIENT_DIST`, `HOME`, `CLAUDE_CONFIG_DIR`, `NODE_ENV` | image | Fixed in the image (8787, `/data`, `/app/packages/client/dist`, `/data/home`, `/data/claude`, `production`). Do not override. |

Optional variables that are unset in `.env` are not passed into the container at all. Tunables such as
`QUORUM_DIGEST_ABSENCE_MS` can be added to the `environment:` list in `compose.yml`.

## Data and backups

Everything is under `/data` (compose volume `quorum-data`):

| Path                | Contents                                              |
| ------------------- | ----------------------------------------------------- |
| `quorum.sqlite*`    | The database (WAL mode: the `-wal`/`-shm` files matter) |
| `rooms/<id>/`       | One bare git repo plus worktrees per room             |
| `claude/`           | The Claude login (`CLAUDE_CONFIG_DIR`). A secret.     |
| `home/`             | `HOME` for the `claude` CLI                           |

Back up while stopped (simplest, consistent):

```bash
docker compose stop quorum
docker run --rm -v quorum_quorum-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/quorum-data-$(date +%F).tgz -C /data .
docker compose start quorum
```

(The volume name is `<project>_quorum-data`; `docker volume ls` shows it. The project name is the directory name,
so `quorum_quorum-data` for a checkout called `quorum`.) The backup contains the Claude login: treat it as a secret.
Restore by extracting into an empty volume with the container stopped.

A bind mount (`./data:/data`) also works, but the directory must be writable by uid/gid 1000 (the image's `node`
user): `mkdir -p data && sudo chown 1000:1000 data`. A named volume needs no preparation.

## Updating

```bash
git pull
docker compose up -d --build
```

The volume is kept, so rooms and the Claude login survive. Database migrations run on start. Take a backup first.

## Logs and health

```bash
docker compose logs -f quorum
docker compose ps            # the healthcheck hits /api/health
```

Set `QUORUM_DEBUG=1` in the `environment:` list for debug logging.

## Resources

One container runs everything; each agent session is a child process inside it (the `claude` binary), so memory and CPU
grow with the number of active sessions. Plan for roughly 1 GB RAM for the server plus several hundred MB per
concurrently running agent, and about 1 GB of disk for the image plus room data. Outbound HTTPS to the Anthropic API is
required for the real runtime.

## HTTPS

Never expose port 8787 directly: the app speaks plain HTTP and sends a session cookie. Options:

- **Bundled Caddy**: set `QUORUM_DOMAIN` in `.env`, point the domain's DNS at the host, then
  `docker compose --profile caddy up -d --build`. Caddy obtains a certificate automatically and proxies
  WebSocket upgrades (`/ws`) with no extra config. Ports 80 and 443 must be free.
- **Your own proxy**: leave the profile off and proxy to `127.0.0.1:8787`, passing `Upgrade`/`Connection` headers
  (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;`).

## Security

- Quorum is **single tenant** and for **trusted users**. Everyone with the password can create rooms and drive agents
  that read and write files in the container and spend your budget. There is no per-user isolation.
- The Claude login (the app's sign-in, or `CLAUDE_CODE_OAUTH_TOKEN`) is the **owner's personal login**. Anyone in the
  deployment uses it implicitly; do not offer it to people you would not hand your Claude account to, and do not
  run a shared service on it for others.
- Use a long `QUORUM_PASSWORD`, serve only over HTTPS, and keep `.env` and `/data` backups private.
- The container runs as an unprivileged user and holds no host mounts by default.
