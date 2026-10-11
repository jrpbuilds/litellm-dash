#!/usr/bin/env bash
# Sync the repo to a local deploy directory, restart its systemd --user unit,
# and smoke-check the running server.
#
#   LITELLM_DASH_DEPLOY_DIR=/opt/litellm-dash bash scripts/deploy.sh
#
# Env: LITELLM_DASH_DEPLOY_DIR (required), LITELLM_DASH_UNIT (default
# litellm-dash), PORT (default 34998). Credentials for the smoke checks are
# read from the environment or from the deploy dir's .env.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${LITELLM_DASH_DEPLOY_DIR:-}"
UNIT="${LITELLM_DASH_UNIT:-litellm-dash}"

if [[ -z "$DEPLOY_DIR" ]]; then
  echo "error: set LITELLM_DASH_DEPLOY_DIR to the deploy directory" >&2
  exit 1
fi

# Read a variable from the environment, falling back to the deploy dir's .env.
env_or_dotenv() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
  elif [[ -f "$DEPLOY_DIR/.env" ]]; then
    grep -oP "^${name}=\K.*" "$DEPLOY_DIR/.env" 2>/dev/null || true
  fi
}

PORT="$(env_or_dotenv PORT)"
PORT="${PORT:-34998}"
TOKEN="$(env_or_dotenv LITELLM_DASH_TOKEN)"
DASH_USER="$(env_or_dotenv LITELLM_DASH_USER)"
DASH_PASSWORD="$(env_or_dotenv LITELLM_DASH_PASSWORD)"
BASE="http://127.0.0.1:$PORT"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "== syncing $REPO -> $DEPLOY_DIR"
rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude .env \
  "$REPO/" "$DEPLOY_DIR/"
(cd "$DEPLOY_DIR" && bun install --production --frozen-lockfile >/dev/null)

echo "== restarting $UNIT"
systemctl --user restart "$UNIT"

for _ in $(seq 1 20); do
  curl -s -o /dev/null "$BASE/login" && break
  sleep 0.5
done

CURL_AUTH=()
if [[ -n "$DASH_USER" && -n "$DASH_PASSWORD" ]]; then
  echo "== logging in as $DASH_USER"
  code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" \
    --data-urlencode "username=$DASH_USER" \
    --data-urlencode "password=$DASH_PASSWORD" \
    --data "remember=on" \
    "$BASE/api/login")
  if [[ "$code" != "303" ]]; then
    echo "== deploy smoke FAILED: login returned HTTP $code"
    exit 1
  fi
  CURL_AUTH=(-b "$JAR")
elif [[ -n "$TOKEN" ]]; then
  CURL_AUTH=(-H "Authorization: Bearer $TOKEN")
fi

echo "== smoke checks"
fail=0
check() {
  local name="$1" path="$2"
  if curl -sf "${CURL_AUTH[@]}" "$BASE$path" >/dev/null; then
    echo "  ok   $name"
  else
    echo "  FAIL $name ($path)"
    fail=1
  fi
}

check "dashboard html" "/"
check "summary"        "/api/summary?days=7"
check "chart"          "/api/chart?days=7&group=model"
check "latency"        "/api/latency?days=7&group=model"
check "recent"         "/api/recent?limit=5"
check "csv export"     "/api/export.csv?days=7"
check "session"        "/api/session"

if [[ ${#CURL_AUTH[@]} -gt 0 ]]; then
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/summary?days=7")" == "401" ]]; then
    echo "  ok   anonymous rejected (401)"
  else
    echo "  FAIL anonymous request was not rejected"
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "== deploy smoke FAILED"
  exit 1
fi
echo "== deploy ok"
