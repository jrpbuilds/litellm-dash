#!/usr/bin/env bash
# Deploy litellm-dash: sync the repo to the systemd-managed deploy copy,
# restart the unit, and smoke-check the live endpoints.
# Usage: bash scripts/deploy.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${LITELLM_DASH_DEPLOY_DIR:-/home/agent/docker/litellm/dashboard}"
UNIT="${LITELLM_DASH_UNIT:-litellm-dash}"
PORT="${LITELLM_DASH_PORT:-34998}"
# Pick up the shared secret from the unit file if the server requires one
TOKEN="${LITELLM_DASH_TOKEN:-$(systemctl show --user "$UNIT" --property=Environment 2>/dev/null | grep -oP 'LITELLM_DASH_TOKEN=\K\S+' || true)}"
AUTH=""
[ -n "$TOKEN" ] && AUTH="token=$TOKEN"
# User/pass auth (bake cookies + Authorization smoke below)
DASH_USER="${LITELLM_DASH_USER:-$(systemctl show --user "$UNIT" --property=Environment 2>/dev/null | grep -oP 'LITELLM_DASH_USER=\K\S+' || true)}"
DASH_PASSWORD="${LITELLM_DASH_PASSWORD:-$(systemctl show --user "$UNIT" --property=Environment 2>/dev/null | grep -oP 'LITELLM_DASH_PASSWORD=\K\S+' || true)}"
# also load from the deploy dir's .env (Bun auto-loads it)
if [ -z "$DASH_USER" ] && [ -f "$DEPLOY_DIR/.env" ]; then
  DASH_USER="$(grep -oP '^LITELLM_DASH_USER=\K.*' "$DEPLOY_DIR/.env" 2>/dev/null || true)"
  DASH_PASSWORD="$(grep -oP '^LITELLM_DASH_PASSWORD=\K.*' "$DEPLOY_DIR/.env" 2>/dev/null || true)"
fi
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "== syncing $REPO -> $DEPLOY_DIR"
rsync -a --delete --exclude .git --exclude node_modules --exclude data \
  "$REPO/" "$DEPLOY_DIR/"

echo "== restarting $UNIT"
systemctl --user restart "$UNIT"

# wait for the service to come back up
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/summary?days=7&$AUTH" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# user/pass mode: log in once; the cookie jar drives the remaining checks
if [ -n "$DASH_USER" ] && [ -n "$DASH_PASSWORD" ]; then
  echo "== logging in as $DASH_USER"
  LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" \
    --data-urlencode "username=$DASH_USER" \
    --data-urlencode "password=$DASH_PASSWORD" \
    --data "remember=on" \
    "http://127.0.0.1:$PORT/api/login")
  if [ "$LOGIN_CODE" != "303" ]; then
    echo "== deploy smoke FAILED: login returned HTTP $LOGIN_CODE"
    exit 1
  fi
fi

echo "== smoke checks"
fail=0
check() {
  local name="$1" url="$2"
  if curl -sf "$url" >/dev/null; then
    echo "  ok   $name"
  else
    echo "  FAIL $name ($url)"
    fail=1
  fi
}
check "dashboard html" "http://127.0.0.1:$PORT/"
# summary/chart/latency/recent pass the cookie jar (user/pass mode), the
# token query param (token mode), or nothing (open mode)
check "summary"       "http://127.0.0.1:$PORT/api/summary?days=7&$AUTH"
check "chart"         "http://127.0.0.1:$PORT/api/chart?days=7&group=model&$AUTH"
check "latency"       "http://127.0.0.1:$PORT/api/latency?days=7&group=model&$AUTH"
check "recent"        "http://127.0.0.1:$PORT/api/recent?limit=5&$AUTH"
check "session"       "http://127.0.0.1:$PORT/api/session&$AUTH"

# re-run the data checks with the cookie jar when in user/pass mode
if [ -n "$DASH_USER" ] && [ -n "$DASH_PASSWORD" ]; then
  check() {
    local name="$1" url="$2"
    if curl -sf -b "$JAR" "$url" >/dev/null; then
      echo "  ok   $name (cookie)"
    else
      echo "  FAIL $name ($url)"
      fail=1
    fi
  }
  check "summary"       "http://127.0.0.1:$PORT/api/summary?days=7"
  check "chart"         "http://127.0.0.1:$PORT/api/chart?days=7&group=model"
  check "latency"       "http://127.0.0.1:$PORT/api/latency?days=7&group=model"
  check "recent"        "http://127.0.0.1:$PORT/api/recent?limit=5"
  check "csv export"    "http://127.0.0.1:$PORT/api/export.csv?days=7"
fi

if [ "$fail" -ne 0 ]; then
  echo "== deploy smoke FAILED"
  exit 1
fi
echo "== deploy ok"
