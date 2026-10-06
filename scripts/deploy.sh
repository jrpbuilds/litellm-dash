#!/usr/bin/env bash
# Deploy litellm-dash: sync the repo to the systemd-managed deploy copy,
# restart the unit, and smoke-check the live endpoints.
# Usage: bash scripts/deploy.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${LITELLM_DASH_DEPLOY_DIR:-/home/agent/docker/litellm/dashboard}"
UNIT="${LITELLM_DASH_UNIT:-litellm-dash}"
PORT="${LITELLM_DASH_PORT:-34998}"

echo "== syncing $REPO -> $DEPLOY_DIR"
rsync -a --delete --exclude .git --exclude node_modules --exclude data \
  "$REPO/" "$DEPLOY_DIR/"

echo "== restarting $UNIT"
systemctl --user restart "$UNIT"

# wait for the service to come back up
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/summary?days=7" >/dev/null; then
    break
  fi
  sleep 0.5
done

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
check "summary"       "http://127.0.0.1:$PORT/api/summary?days=7"
check "chart"         "http://127.0.0.1:$PORT/api/chart?days=7&group=model"
check "latency"       "http://127.0.0.1:$PORT/api/latency?days=7&group=model"
check "recent"        "http://127.0.0.1:$PORT/api/recent?limit=5"

if [ "$fail" -ne 0 ]; then
  echo "== deploy smoke FAILED"
  exit 1
fi
echo "== deploy ok"
