"""SQLite usage logger for the LiteLLM gateway (headless, no-DB deployment).

Writes one row per proxied request to /app/data/usage.db (host path:
~/docker/litellm/data/usage.db) for the Bun dashboard in ../dashboard/ to
read. Tracks tokens, latency, model and client metadata. No cost columns —
this deployment does not track spend.

Registered in config.yaml:

    litellm_settings:
      callbacks:
      - usage_logger.usage_logger
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

from litellm.integrations.custom_logger import CustomLogger

DB_PATH = os.environ.get("LITELLM_USAGE_DB", "/app/data/usage.db")
RETENTION_DAYS = int(os.environ.get("LITELLM_USAGE_RETENTION_DAYS", "90"))
_PRUNE_INTERVAL = 500  # writes between retention prunes
_ERROR_MAX = 500
# image_url is the OpenAI chat-completions multimodal marker; "input_image"
# is the Responses-API shape; data: URIs cover inline base64 images.
_IMAGE_MARKERS = re.compile(r'image_url|"input_image"|data:image/')

_SCHEMA = """
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
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_group_ts ON requests (model_group, ts);
"""

# api_base prefix -> provider name for the dashboard chips. Extend via
# LITELLM_USAGE_PROVIDERS="https://api.example.com=example,..." if needed.
_PROVIDER_BY_BASE = {
    "https://api.openference.com": "openference",
    "https://opencode.ai": "opencode-go",
    "https://api.z.ai": "zai-coding",
}

_extra = os.environ.get("LITELLM_USAGE_PROVIDERS", "")
for pair in _extra.split(","):
    if "=" in pair:
        base, name = pair.split("=", 1)
        _PROVIDER_BY_BASE[base.strip()] = name.strip()


def _provider(api_base: Any) -> str | None:
    """Map the upstream api_base that served the request to a provider name."""
    if not isinstance(api_base, str) or not api_base:
        return None
    for base, name in _PROVIDER_BY_BASE.items():
        if api_base.startswith(base):
            return name
    # fallback: hostname of the upstream
    try:
        from urllib.parse import urlparse

        host = urlparse(api_base).hostname or ""
        return host.removeprefix("www.") or None
    except Exception:
        return None


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _number(value: Any) -> int:
    return value if isinstance(value, (int, float)) else 0


def _vision_requested(messages: Any) -> int:
    """1 when any message carries a multimodal image PART.

    Strict structural walk: a part only counts when its content block is a
    dict/list explicitly typed image ({type: image_url}, {type: input_image}
    or {type: image_url} inside a JSON-encoded string a proxy passes
    through). Plain text that merely MENTIONS image_url (tool schemas, docs
    pasted into the prompt) must not flag the row.
    """
    if not messages:
        return 0
    if isinstance(messages, str):
        # Some proxies hand the body over as a JSON string; parse it back so
        # the structural walk still applies (fall back to marker scan).
        try:
            messages = json.loads(messages)
        except Exception:
            return 1 if _IMAGE_MARKERS.search(messages[:1_000_000]) else 0
    if _has_image_part(messages, depth=0):
        return 1
    return 0


_MAX_WALK = 200_000


def _has_image_part(node: Any, depth: int) -> bool:
    """Depth-limited structural search for typed image content parts."""
    if depth > 6:
        return False
    if isinstance(node, dict):
        t = node.get("type")
        if t in ("image_url", "input_image", "image"):
            return True
        if len(node) > 64:  # guard: ignore giant non-message dicts
            return False
        return any(_has_image_part(v, depth + 1) for v in node.values())
    if isinstance(node, list):
        if len(node) > _MAX_WALK:
            node = node[:_MAX_WALK]
        return any(_has_image_part(v, depth + 1) for v in node)
    return False


class SQLiteUsageLogger(CustomLogger):
    """CustomLogger that appends request metadata to a local SQLite file."""

    def __init__(self) -> None:
        super().__init__()
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._writes = 0

    # -- internals ---------------------------------------------------------

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(_SCHEMA)
            # migrate DBs written by older callback versions in place
            cols = {r[1] for r in conn.execute("PRAGMA table_info(requests)")}
            if "provider" not in cols:
                conn.execute("ALTER TABLE requests ADD COLUMN provider TEXT")
            if "vision" not in cols:
                conn.execute("ALTER TABLE requests ADD COLUMN vision INTEGER NOT NULL DEFAULT 0")
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
        litellm_params: dict[str, Any] = kwargs.get("litellm_params") or {}
        _ = litellm_params  # model id not reliably present at log time

        start = slp.get("startTime")
        end = slp.get("endTime")
        duration_ms = None
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
            duration_ms = round((end - start) * 1000, 1)

        model_group = slp.get("model_group") or kwargs.get("model")
        model = model_group
        upstream_model = slp.get("model")
        provider = _provider(slp.get("api_base"))
        stream = 1 if (slp.get("stream") or kwargs.get("stream")) else 0
        vision = _vision_requested(slp.get("messages"))

        prompt = _number(slp.get("prompt_tokens"))
        completion = _number(slp.get("completion_tokens"))
        total = _number(slp.get("total_tokens")) or (prompt + completion)

        return (
            _iso(end if isinstance(end, (int, float)) else time.time()),
            model,
            model_group,
            upstream_model,
            provider,
            slp.get("call_type") or kwargs.get("call_type"),
            stream,
            prompt,
            completion,
            total,
            duration_ms,
            status,
            slp.get("user_agent"),
            slp.get("requester_ip_address"),
            error,
            vision,
        )

    # -- CustomLogger hooks -------------------------------------------------

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await asyncio.to_thread(self._write, self._extract(kwargs, "success", None))

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        slp = kwargs.get("standard_logging_object") or {}
        err = kwargs.get("exception") or slp.get("error_str")
        row = self._extract(kwargs, "failure", str(err)[:_ERROR_MAX] if err else None)
        await asyncio.to_thread(self._write, row)


# Module-level instance — config.yaml references "usage_logger.usage_logger".
usage_logger = SQLiteUsageLogger()
