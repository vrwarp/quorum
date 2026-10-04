# syntax=docker/dockerfile:1
#
# Quorum, as one container: the Node server, the built SPA it serves, and the
# `claude` binary the Agent SDK spawns for each agent session.
#
#   docker build -t quorum .          (or: npm run docker:build)
#   docker compose up -d --build      (see docs/DEPLOY.md)

# ---------------------------------------------------------------- builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /build

# Manifests and lockfile first, so a source change does not reinstall.
# Every workspace manifest has to be here or `npm ci` rejects the lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY e2e/package.json e2e/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

COPY tsconfig.base.json ./
COPY packages packages
# shared -> server -> client
RUN npm run build

# ---------------------------------------------------------------- runtime ---
FROM node:22-bookworm-slim AS runtime

# git: the room layer shells out to it. ca-certificates: TLS to the Anthropic API.
# bubblewrap + socat: the Agent SDK's Bash sandbox; without them it silently degrades to unsandboxed Bash.
# No init in the image: run it with one (compose sets `init: true`; with plain
# docker use `--init`) so the agent child processes are reaped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bubblewrap socat \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system user.name Quorum \
  && git config --system user.email quorum@localhost \
  && git config --system safe.directory '*'

WORKDIR /app

# Production dependencies only. `prettier` (git pre-commit formatter) is a
# dependency of @quorum/server, and the SDK brings its per-platform package
# with the `claude` binary. Only the server workspace (and what it depends on)
# is installed; the client is already built to static files.
#
# The lockfile does not say which libc a platform package is for, so npm installs
# both the glibc (`linux-x64`) and the musl (`linux-x64-musl`) build of the SDK's
# binary for this CPU (`-arm64` on arm64). This image is glibc (bookworm), so the
# musl package, about 230 MB, is dead weight: remove it and keep the glibc one.
# config.ts looks the glibc package up first and skips one that is not installed,
# so nothing else has to know. The checks that follow fail the build if the glibc
# binary is not there afterwards.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace=@quorum/server --include-workspace-root=false \
  && npm cache clean --force \
  && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
  && ls node_modules/@anthropic-ai \
  && node -e "require.resolve('prettier/bin/prettier.cjs')" \
  && ls node_modules/@anthropic-ai | grep -Eq '^claude-agent-sdk-linux-(x64|arm64)$' \
  && find node_modules/@anthropic-ai -maxdepth 2 -type f -name claude -perm -u+x | grep -q .

COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/server/dist packages/server/dist
COPY --from=builder /build/packages/client/dist packages/client/dist

# The node image's `node` user is uid/gid 1000. /data is the only writable
# place: sqlite + rooms (git repos) at its root, the Claude login and the agent
# session transcripts in claude/ (CLAUDE_CONFIG_DIR), and HOME for the claude CLI
# in home/. A named volume is initialised from this directory (owner and all) and
# just works. A bind mount is not: it has to be created with home/ and claude/
# and owned by uid/gid 1000, `chown -R 1000:1000` (docs/DEPLOY.md).
RUN mkdir -p /data/home /data/claude && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8787 \
    QUORUM_DATA_DIR=/data \
    QUORUM_CLIENT_DIST=/app/packages/client/dist \
    HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/claude

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
