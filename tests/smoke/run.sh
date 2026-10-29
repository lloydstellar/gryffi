#!/usr/bin/env bash
# Smoke test: install Gryffi from its images on this machine and walk through
# setup, a journey and the player in a browser (smoke.mjs).
#
#   tests/smoke/run.sh
#
# Environment:
#   GRYFFI_IMAGE, GRYFFI_VERSION   images to test (default: ghcr.io/lloydstellar/gryffi:latest)
#   SMOKE_PORT                     port for Gryffi on 127.0.0.1 (default 3480)
#   SMOKE_KEEP=1                   leave the containers running afterwards
#
# Needs Docker with Compose. The browser runs in the official Playwright image.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$ROOT/tests/smoke"
PORT="${SMOKE_PORT:-3480}"
MOCKS_PORT="${SMOKE_MOCKS_PORT:-4012}"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.56.1-noble"
PROJECT="gryffi-smoke"

env_file="$(mktemp)"
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    echo "--- last app log lines"
    compose logs --no-log-prefix --tail 60 app 2>/dev/null || true
  fi
  if [ "${SMOKE_KEEP:-0}" != 1 ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
cat > "$env_file" <<EOF
GRYFFI_IMAGE=${GRYFFI_IMAGE:-ghcr.io/lloydstellar/gryffi}
GRYFFI_VERSION=${GRYFFI_VERSION:-latest}
APP_URL=http://127.0.0.1:$PORT
COMPOSE_PROFILES=
GRYFFI_PORT=$PORT
SMOKE_MOCKS_PORT=$MOCKS_PORT
DB_PASSWORD=$(secret 16)
APP_DB_PASSWORD=$(secret 16)
REDIS_PASSWORD=$(secret 16)
SESSION_SECRET=$(secret 32)
OAUTH_TOKEN_KEY=$(secret 32)
EOF

compose() {
  docker compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$env_file" \
    -f "$ROOT/compose.yml" -f "$SMOKE_DIR/compose.smoke.yml" "$@"
}

echo "== Starting Gryffi ($(grep GRYFFI_IMAGE= "$env_file" | cut -d= -f2):$(grep GRYFFI_VERSION= "$env_file" | cut -d= -f2))"
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --quiet-pull

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null && break
  sleep 3
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "Gryffi did not start"; exit 1; }

code="$(compose logs app 2>/dev/null | grep -o 'setup?code=[A-Z0-9-]*' | tail -1 | cut -d= -f2)"
[ -n "$code" ] || { echo "no setup code in the log"; exit 1; }

echo "== Running the browser test"
docker run --rm --network host --ipc host \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$SMOKE_DIR:/smoke" -w /smoke \
  -e SMOKE_SCREENSHOTS=/smoke/screenshots \
  "$PLAYWRIGHT_IMAGE" \
  sh -c "npm ci --silent --no-audit --no-fund && node smoke.mjs http://127.0.0.1:$PORT '$code' http://127.0.0.1:$MOCKS_PORT"
