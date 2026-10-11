#!/usr/bin/env bash
# Run a local dev server against the usage DB on the host running LiteLLM.
#
#   DASH_HOST=user@gateway bash scripts/dev.sh            # snapshot copy, then bun --watch
#   DASH_HOST=user@gateway bash scripts/dev.sh --no-start # just refresh the snapshot
#   LIVE=1 DASH_HOST=user@gateway bash scripts/dev.sh     # mount the live DB over sshfs
#
# Snapshot mode copies a consistent SQLite backup to data/usage.db (needs
# sqlite3 on the remote host). Live mode needs sshfs locally. The dashboard
# opens the DB read-only in both modes.
#
# Env: DASH_HOST (required), DASH_REMOTE_DB_DIR (default /app/data), PORT.
# Dev login defaults to dev/dev unless LITELLM_DASH_USER/PASSWORD are set.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DATA="$REPO/data"
REMOTE_DB_DIR="${DASH_REMOTE_DB_DIR:-/app/data}"

if [[ -z "${DASH_HOST:-}" ]]; then
  echo "error: set DASH_HOST to the SSH target of the LiteLLM host, e.g. DASH_HOST=user@gateway" >&2
  exit 1
fi

mkdir -p "$LOCAL_DATA"

snapshot() {
  echo "== snapshot: copying usage.db from $DASH_HOST:$REMOTE_DB_DIR"
  local remote_snap="/tmp/litellm-dash-snapshot.db"
  ssh "$DASH_HOST" "sqlite3 '$REMOTE_DB_DIR/usage.db' \".backup $remote_snap\" && cat $remote_snap && rm -f $remote_snap" \
    > "$LOCAL_DATA/usage.db"
  echo "   -> $LOCAL_DATA/usage.db ($(( $(stat -c%s "$LOCAL_DATA/usage.db") / 1024 )) kB)"
  DB_PATH="$LOCAL_DATA/usage.db"
}

live() {
  echo "== live: mounting $DASH_HOST:$REMOTE_DB_DIR over sshfs"
  mkdir -p "$LOCAL_DATA/live"
  mountpoint -q "$LOCAL_DATA/live" || sshfs "$DASH_HOST:$REMOTE_DB_DIR" "$LOCAL_DATA/live"
  DB_PATH="$LOCAL_DATA/live/usage.db"
}

if [[ "${LIVE:-0}" == "1" ]]; then live; else snapshot; fi

[[ "${1:-}" == "--no-start" ]] && exit 0

cd "$REPO"
LITELLM_DASH_DB="$DB_PATH" \
  LITELLM_DASH_USER="${LITELLM_DASH_USER:-dev}" \
  LITELLM_DASH_PASSWORD="${LITELLM_DASH_PASSWORD:-dev}" \
  exec bun run dev
