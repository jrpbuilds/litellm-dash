#!/usr/bin/env bash
# Run litellm-dash on YOUR machine against the usage DB on the gateway host
# (192.168.0.200). Read-only: the dashboard never writes the DB.
#
# Two connection modes:
#
#   1. SNAPSHOT (default): copy the DB locally, change nothing on the host.
#      Re-run to refresh. Safest — a bug in dev code can't touch the source.
#
#   2. LIVE (LIVE=1): SSH-port-forward the gateway's dashboard port and the
#      data dir over SSHFS so dev reads the file the gateway is writing.
#      Needs sshfs. Fine read-only; do NOT run with a modified callback.
#
# Usage:
#   bash scripts/dev.sh                 # snapshot mode, then starts bun
#   bash scripts/dev.sh --no-start      # just refresh snapshot
#   LIVE=1 bash scripts/dev.sh          # live mount mode
#
# First-time setup (your machine):
#   git clone <this repo> litellm-dash && cd litellm-dash && bun install
#   ssh-copy-id agent@192.168.0.200     # or use an existing key
set -euo pipefail

HOST="${DASH_HOST:-agent@192.168.0.200}"
REMOTE_DB_DIR=/home/agent/docker/litellm/data
LOCAL_DATA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-34998}"

mkdir -p "$LOCAL_DATA"

snap() {
  echo "== snapshot: copying usage.db (+wal) from $HOST"
  # sqlite backup via the WAL-safe .backup cmd on the host keeps a consistent copy
  ssh "$HOST" "sqlite3 $REMOTE_DB_DIR/usage.db \".backup $REMOTE_DB_DIR/usage-dev-snapshot.db\" && cp $REMOTE_DB_DIR/usage-dev-snapshot.db /dev/stdout" > "$LOCAL_DATA/usage.db"
  echo "   → $LOCAL_DATA/usage.db ($(( $(stat -c%s "$LOCAL_DATA/usage.db") / 1024 )) kB)"
}

live() {
  echo "== live mode: sshfs + port-forward"
  mkdir -p "$LOCAL_DATA/live"
  mountpoint -q "$LOCAL_DATA/live" \
    || sshfs "$HOST:$REMOTE_DB_DIR" "$LOCAL_DATA/live"
  # forward the gateway HTTP port too, in case dev code wants the live API
  ssh -fNT -L 44000:127.0.0.1:34000 "$HOST" || true
  DB_PATH="$LOCAL_DATA/live/usage.db"
}

mode_db() {
  if [[ "${LIVE:-0}" == "1" ]]; then live; else snap; DB_PATH="$LOCAL_DATA/usage.db"; fi
}

case "${1:-}" in
  --no-start)
    mode_db
    exit 0
    ;;
  *)
    mode_db
    LITELLM_DASH_DB="$DB_PATH" \
      LITELLM_DASH_USER="${LITELLM_DASH_USER:-dev}" \
      LITELLM_DASH_PASSWORD="${LITELLM_DASH_PASSWORD:-dev}" \
      PORT="$PORT" \
      bun src/server.ts
    ;;
esac
