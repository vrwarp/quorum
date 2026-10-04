#!/usr/bin/env bash
# Smoke-test a built Quorum image: start it, prove it serves, log in, create a
# room (which exercises git, prettier, and SQLite inside the container), check
# the Claude status route, and wait for Docker's own HEALTHCHECK to report
# healthy. Runs with the fake agent runtime, so no credentials are involved.
#
#   scripts/docker-smoke.sh <image>            e.g. scripts/docker-smoke.sh quorum:dry-run
#   SMOKE_PORT=18787 scripts/docker-smoke.sh quorum:dry-run
set -euo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image>}"
PORT="${SMOKE_PORT:-18787}"
NAME="quorum-smoke-$$"
BASE="http://127.0.0.1:${PORT}"
COOKIES="$(mktemp)"
BIND_DIR="$(mktemp -d)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::container logs"
    docker logs "$NAME" 2>&1 | tail -80 || true
    echo "::endgroup::"
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$COOKIES"
  rm -rf "$BIND_DIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

fail() { echo "::error::$*"; exit 1; }

echo "== the bundled Claude Code binary runs =="
docker run --rm "$IMAGE" sh -c 'node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude --version' \
  || fail "the claude binary inside the image does not run"

echo "== start with a bind-mounted /data (the directory the image baked in is replaced) =="
# The container runs as uid 1000; a bind mount must be writable by it.
chmod 777 "$BIND_DIR"
docker run -d --init --name "$NAME" -p "127.0.0.1:${PORT}:8787" \
  -v "$BIND_DIR:/data" \
  -e QUORUM_PASSWORD=smoke-password -e QUORUM_RUNTIME=fake "$IMAGE" >/dev/null

echo "== /api/health =="
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$BASE/api/health" | grep -q '"ok":true' || fail "the server never answered /api/health"

echo "== the SPA is served =="
curl -fsS "$BASE/" | grep -qi '<!doctype html>' || fail "/ did not return the client"
curl -fsS "$BASE/rooms/room_does_not_exist" | grep -qi '<!doctype html>' || fail "SPA fallback for /rooms/<id> failed"

echo "== login, room creation (git + prettier + sqlite), claude status =="
curl -fsS -c "$COOKIES" -H 'content-type: application/json' \
  -d '{"password":"smoke-password","displayName":"Smoke"}' "$BASE/api/login" | grep -q '"userId"' \
  || fail "login failed"
curl -fsS -b "$COOKIES" -H 'content-type: application/json' \
  -d '{"name":"Smoke room"}' "$BASE/api/rooms" | grep -q '"votingRule":"unanimous"' \
  || fail "room creation failed"
curl -fsS -b "$COOKIES" "$BASE/api/claude/status" | grep -q '"signedIn":false' \
  || fail "/api/claude/status did not report the expected signed-out state"
curl -fsS -b "$COOKIES" "$BASE/api/me" | grep -q '"isAdmin":true' \
  || fail "the first user was not made admin"

echo "== the data layout appeared in the bind mount =="
docker exec "$NAME" sh -c 'test -f /data/quorum.sqlite && test -d /data/rooms && test -d /data/claude' \
  || fail "/data does not have quorum.sqlite, rooms/ and claude/"

echo "== Docker HEALTHCHECK reaches healthy =="
for _ in $(seq 1 90); do
  state="$(docker inspect "$NAME" --format '{{.State.Health.Status}}')"
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "$state" = "healthy" ] || fail "container health is '$state', not healthy"

echo "== clean shutdown on SIGTERM =="
start=$(date +%s)
docker stop -t 35 "$NAME" >/dev/null
code="$(docker inspect "$NAME" --format '{{.State.ExitCode}}')"
echo "stopped in $(( $(date +%s) - start ))s with exit code $code"
[ "$code" = "0" ] || fail "the server did not exit cleanly on SIGTERM (exit code $code)"

echo "smoke test passed for $IMAGE"
