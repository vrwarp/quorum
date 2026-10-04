# Quorum

Quorum is a live, multiplayer room where a small group deliberates in chat while an autonomous multi-agent engine, built
on the Claude Agent SDK, writes and maintains the group's documents. Nobody edits a document directly: people talk,
suggest, ask and vote, and the engine listens without being prompted, applies the changes people ask for, explores
disagreements on parallel branches, and merges only what the group has agreed to. Every document is a markdown file in a
git repository, so history, diffs, blame and revert come from git.

## Quick start

### Development

You need Node 22.13 or newer and `git`.

```bash
npm install

# terminal 1: the server on http://localhost:8787, restarted on change
QUORUM_PASSWORD=dev QUORUM_RUNTIME=fake npm run dev:server

# terminal 2: the client with hot reload on http://localhost:5173
npm run dev:client
```

Open http://localhost:5173 and log in with any display name and the password `dev`. `QUORUM_RUNTIME=fake` runs scripted
agents that need no Claude login; leave it out to use the real ones (see "The Claude login" below).

Other scripts: `npm test` (unit and integration tests), `npm run validate` (typecheck, format check, tests and build:
run it before pushing), `npm run test:e2e` (Playwright against the built app, after `npm run build`),
`npm run docker:build` (the image). [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) has the rest.

### Docker

```bash
cp .env.example .env          # set QUORUM_PASSWORD
docker compose up -d --build
```

Then open http://127.0.0.1:8787 and **log in yourself first**: the first person to log in becomes the admin, the only
one who can sign the server in to Claude (Settings -> Sign in with Claude). Alternatively set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` in `.env`. The app listens on loopback only; put HTTPS in front of it with the bundled Caddy
profile or a proxy of your own. Configuration, backups and HTTPS are in [docs/DEPLOY.md](docs/DEPLOY.md).

## The Claude login

The agents need a Claude credential on the server: the web sign-in in Settings, a token from `claude setup-token`, or an
API key. The subscription logins are **for personal use**: your server, your login, people you personally invite.
Anthropic does not allow third-party products to offer claude.ai login to other people, so do not run Quorum as a
service that lets strangers spend your subscription; use an API key, or give each team its own deployment. Details in
[docs/CLAUDE-SIGNIN.md](docs/CLAUDE-SIGNIN.md).

## Documentation

| Document                                                                               | What it covers                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                                                             | Product and architecture specification, including the known limitations     |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)                                       | Module boundaries, configuration, running and testing                       |
| [docs/DEPLOY.md](docs/DEPLOY.md)                                                       | Docker and compose, environment, spend cap, data and backups, HTTPS         |
| [docs/CLAUDE-SIGNIN.md](docs/CLAUDE-SIGNIN.md)                                         | Signing the server in to Claude, who may do it, and the personal-use policy |
| [packages/client/README.md](packages/client/README.md)                                 | The web client                                                              |
| [packages/server/src/agents/fake/README.md](packages/server/src/agents/fake/README.md) | The scripted fake runtime used by tests and demos                           |

## Layout

- `packages/shared`: types, the WebSocket and HTTP protocol, tunable defaults.
- `packages/server`: the Node server: HTTP and WebSocket API, SQLite, git, and the agent runtimes.
- `packages/client`: the React and Vite web client.
- `e2e`: Playwright tests that walk the PRD scenario through the real client.
