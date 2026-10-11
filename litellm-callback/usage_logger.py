"""SQLite usage logger for a LiteLLM proxy.

Writes one row per proxied request (success or failure) to a local SQLite
file that the litellm-dash web UI reads. Records tokens, latency, model,
provider and client metadata. No cost tracking.

Register it in the proxy's config.yaml (with this file next to it):

    litellm_settings:
      callbacks:
      - usage_logger.usage_logger

Environment:
    LITELLM_USAGE_DB              SQLite path (default /app/data/usage.db)
    LITELLM_USAGE_RETENTION_DAYS  rows older than this are pruned (default 90)
    LITELLM_USAGE_PROVIDERS       "https://api.example.com=example,..." maps
                                  api_base prefixes to provider names; other
                                  upstreams are labelled by hostname
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import threading
import time
from typing import Any
from urllib.parse import urlparse

from litellm.integrations.custom_logger import CustomLogger

DB_PATH = os.environ.get("LITELLM_USAGE_DB", "/app/data/usage.db")
RETENTION_DAYS = int(os.environ.get("LITELLM_USAGE_RETENTION_DAYS", "90"))
_PRUNE_INTERVAL = 500  # writes between retention prunes
_ERROR_MAX = 500
_MAX_WALK = 200_000
# Fallback scan when the body is an unparseable string: image_url is the
# chat-completions marker, input_image the Responses API, data: inline base64.
_IMAGE_MARKERS = re.compile(r'image_url|"input_image"|data:image/')

SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    model TEXT,
    model_group TEXT,
    upstream_model TEXT,
    provider TEXT,
    call_type TEXT,
    stream INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms REAL,
    status TEXT NOT NULL,
    user_agent TEXT,
    requester_ip TEXT,
    error TEXT,
    vision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_group_ts ON requests (model_group, ts);
"""

# Columns added after the first release; older DBs are migrated in place.
_MIGRATIONS = {
    "provider": "ALTER TABLE requests ADD COLUMN provider TEXT",
    "vision": "ALTER TABLE requests ADD COLUMN vision INTEGER NOT NULL DEFAULT 0",
}


def _parse_providers(spec: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for pair in spec.split(","):
        if "=" in pair:
            base, name = pair.split("=", 1)
            if base.strip() and name.strip():
                out[base.strip()] = name.strip()
    return out


_PROVIDER_BY_BASE = _parse_providers(os.environ.get("LITELLM_USAGE_PROVIDERS", ""))


def _provider(api_base: Any, mapping: dict[str, str] | None = None) -> str | None:
    """Name of the upstream that served the request, from its api_base."""
    if not isinstance(api_base, str) or not api_base:
        return None
    for base, name in (_PROVIDER_BY_BASE if mapping is None else mapping).items():
        if api_base.startswith(base):
            return name
    try:
        host = urlparse(api_base).hostname or ""
    except ValueError:
        return None
    return host.removeprefix("www.") or None


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _number(value: Any) -> int:
    return value if isinstance(value, (int, float)) else 0


# LiteLLM failure text can echo an upstream key or a bearer token.
_SECRET_RE = re.compile(r"sk-[A-Za-z0-9_-]+|Bearer\s+\S+", re.IGNORECASE)


def _redact(error: str) -> str:
    return _SECRET_RE.sub("[redacted]", error)


def _vision_requested(messages: Any) -> int:
    """1 when any message carries a typed image content part.

    Only structural parts count ({"type": "image_url"}, "input_image",
    "image"), so prompts that merely mention image_url don't flag the row.
    """
    if not messages:
        return 0
    if isinstance(messages, str):
        try:
            messages = json.loads(messages)
        except ValueError:
            return 1 if _IMAGE_MARKERS.search(messages[:1_000_000]) else 0
    return 1 if _has_image_part(messages, depth=0) else 0


def _has_image_part(node: Any, depth: int) -> bool:
    if depth > 6:
        return False
    if isinstance(node, dict):
        if node.get("type") in ("image_url", "input_image", "image"):
            return True
        if len(node) > 64:  # not a message part; skip large payload dicts
            return False
        return any(_has_image_part(v, depth + 1) for v in node.values())
    if isinstance(node, list):
        return any(_has_image_part(v, depth + 1) for v in node[:_MAX_WALK])
    return False


class SQLiteUsageLogger(CustomLogger):
    """CustomLogger that appends request metadata to a local SQLite file."""

    def __init__(self, db_path: str = DB_PATH) -> None:
        super().__init__()
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._writes = 0

    # -- internals ---------------------------------------------------------

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
            conn = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
            os.chmod(self.db_path, 0o600)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            cols = {r[1] for r in conn.execute("PRAGMA table_info(requests)")}
            if cols:
                for col, ddl in _MIGRATIONS.items():
                    if col not in cols:
                        conn.execute(ddl)
            conn.executescript(SCHEMA)
            self._conn = conn
        return self._conn

    def _prune(self, conn: sqlite3.Connection) -> None:
        cutoff = _iso(time.time() - RETENTION_DAYS * 86400)
        conn.execute("DELETE FROM requests WHERE ts < ?", (cutoff,))

    def _write(self, row: tuple) -> None:
        with self._lock:
            conn = self._connection()
            conn.execute(
                "INSERT INTO requests (ts, model, model_group, upstream_model,"
                " provider, call_type, stream, prompt_tokens, completion_tokens,"
                " total_tokens, duration_ms, status, user_agent, requester_ip,"
                " error, vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row,
            )
            self._writes += 1
            if self._writes % _PRUNE_INTERVAL == 0:
                self._prune(conn)
            conn.commit()

    def _extract(self, kwargs: dict[str, Any], status: str, error: str | None) -> tuple:
        slp: dict[str, Any] = kwargs.get("standard_logging_object") or {}

        start = slp.get("startTime")
        end = slp.get("endTime")
        duration_ms = None
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
            duration_ms = round((end - start) * 1000, 1)

        model_group = slp.get("model_group") or kwargs.get("model")
        prompt = _number(slp.get("prompt_tokens"))
        completion = _number(slp.get("completion_tokens"))

        return (
            _iso(end if isinstance(end, (int, float)) else time.time()),
            model_group,  # model
            model_group,
            slp.get("model"),  # upstream_model
            _provider(slp.get("api_base")),
            slp.get("call_type") or kwargs.get("call_type"),
            1 if (slp.get("stream") or kwargs.get("stream")) else 0,
            prompt,
            completion,
            _number(slp.get("total_tokens")) or (prompt + completion),
            duration_ms,
            status,
            slp.get("user_agent"),
            slp.get("requester_ip_address"),
            error,
            _vision_requested(slp.get("messages")),
        )

    # -- CustomLogger hooks -------------------------------------------------

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await asyncio.to_thread(self._write, self._extract(kwargs, "success", None))

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        slp = kwargs.get("standard_logging_object") or {}
        err = kwargs.get("exception") or slp.get("error_str")
        row = self._extract(kwargs, "failure", _redact(str(err))[:_ERROR_MAX] if err else None)
        await asyncio.to_thread(self._write, row)


# config.yaml references this instance as "usage_logger.usage_logger".
usage_logger = SQLiteUsageLogger()
