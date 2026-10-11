"""Tests for usage_logger.py. Run with: python3 -m unittest discover -s litellm-callback

litellm is stubbed, so these run without it installed.
"""
import asyncio
import os
import sqlite3
import sys
import tempfile
import types
import unittest

_integrations = types.ModuleType("litellm.integrations")
_custom_logger = types.ModuleType("litellm.integrations.custom_logger")
_custom_logger.CustomLogger = type("CustomLogger", (), {"__init__": lambda self: None})
sys.modules.setdefault("litellm", types.ModuleType("litellm"))
sys.modules.setdefault("litellm.integrations", _integrations)
sys.modules.setdefault("litellm.integrations.custom_logger", _custom_logger)

import usage_logger as ul  # noqa: E402

OLD_SCHEMA = """
CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, model TEXT,
    model_group TEXT, upstream_model TEXT, call_type TEXT,
    stream INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms REAL, status TEXT NOT NULL, user_agent TEXT, requester_ip TEXT, error TEXT
);
"""


def _kwargs(**slp):
    base = {
        "model_group": "gpt-x",
        "model": "openai/gpt-x-2025",
        "api_base": "https://api.example.com/v1",
        "startTime": 1_700_000_000.0,
        "endTime": 1_700_000_002.5,
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "total_tokens": 15,
        "call_type": "acompletion",
        "user_agent": "curl/8",
        "requester_ip_address": "10.0.0.1",
        "messages": [{"role": "user", "content": "hi"}],
    }
    base.update(slp)
    return {"standard_logging_object": base}


class TestHelpers(unittest.TestCase):
    def test_provider_mapping_and_hostname_fallback(self):
        mapping = ul._parse_providers("https://api.example.com=example, bad, =x")
        self.assertEqual(mapping, {"https://api.example.com": "example"})
        self.assertEqual(ul._provider("https://api.example.com/v1", mapping), "example")
        self.assertEqual(ul._provider("https://www.other.ai/v1", mapping), "other.ai")
        self.assertIsNone(ul._provider(None, mapping))
        self.assertIsNone(ul._provider("", mapping))

    def test_vision_detects_typed_image_parts_only(self):
        image = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]
        self.assertEqual(ul._vision_requested(image), 1)
        self.assertEqual(ul._vision_requested([{"type": "input_image"}]), 1)
        mention = [{"role": "user", "content": "the image_url field takes a URL"}]
        self.assertEqual(ul._vision_requested(mention), 0)
        self.assertEqual(ul._vision_requested(None), 0)
        self.assertEqual(ul._vision_requested('[{"type": "image_url"}]'), 1)
        self.assertEqual(ul._vision_requested("not json but data:image/png"), 1)


class TestLogger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "sub", "usage.db")
        self.logger = ul.SQLiteUsageLogger(self.path)

    def tearDown(self):
        if self.logger._conn:
            self.logger._conn.close()
        self.tmp.cleanup()

    def rows(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute("SELECT * FROM requests ORDER BY id")]
        finally:
            conn.close()

    def test_success_row(self):
        asyncio.run(self.logger.async_log_success_event(_kwargs(), None, None, None))
        (row,) = self.rows()
        self.assertEqual(row["ts"], "2023-11-14T22:13:22Z")
        self.assertEqual(row["model_group"], "gpt-x")
        self.assertEqual(row["upstream_model"], "openai/gpt-x-2025")
        self.assertEqual(row["provider"], "api.example.com")
        self.assertEqual(row["total_tokens"], 15)
        self.assertEqual(row["duration_ms"], 2500.0)
        self.assertEqual(row["status"], "success")
        self.assertEqual(row["vision"], 0)
        self.assertIsNone(row["error"])

    def test_db_file_is_owner_readable_only(self):
        asyncio.run(self.logger.async_log_success_event(_kwargs(), None, None, None))
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_failure_row_redacts_secrets_then_truncates(self):
        kwargs = _kwargs()
        kwargs["exception"] = "upstream rejected sk-abcDEF123 and Bearer super-secret " + "x" * 600
        asyncio.run(self.logger.async_log_failure_event(kwargs, None, None, None))
        (row,) = self.rows()
        self.assertNotIn("sk-abcDEF123", row["error"])
        self.assertNotIn("super-secret", row["error"])
        self.assertIn("[redacted]", row["error"])
        self.assertEqual(len(row["error"]), ul._ERROR_MAX)

    def test_failure_row_truncates_error(self):
        kwargs = _kwargs(total_tokens=None, prompt_tokens=3, completion_tokens=None)
        kwargs["exception"] = "x" * 1000
        asyncio.run(self.logger.async_log_failure_event(kwargs, None, None, None))
        (row,) = self.rows()
        self.assertEqual(row["status"], "failure")
        self.assertEqual(len(row["error"]), ul._ERROR_MAX)
        self.assertEqual(row["total_tokens"], 3)

    def test_migrates_old_schema(self):
        os.makedirs(os.path.dirname(self.path))
        conn = sqlite3.connect(self.path)
        conn.executescript(OLD_SCHEMA)
        conn.execute("INSERT INTO requests (ts, status) VALUES ('2024-01-01T00:00:00Z', 'success')")
        conn.commit()
        conn.close()
        asyncio.run(self.logger.async_log_success_event(_kwargs(), None, None, None))
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["vision"], 0)
        self.assertIsNone(rows[0]["provider"])


if __name__ == "__main__":
    unittest.main()
