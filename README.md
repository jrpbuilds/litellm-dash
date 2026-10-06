# litellm-dash

A small, self-hosted usage dashboard for a [LiteLLM](https://github.com/BerriAI/litellm)
proxy — styled after Cursor's usage page.

![dark-mode dashboard: token cards, cumulative area chart, request log](docs/screenshot.png)

## What it does

LiteLLM's first-party UI needs a Postgres database and its own admin stack.
If you run the proxy headless — config-only, no DB — you get no visibility at
all into what's flowing through it. This project adds usage tracking with
zero extra infrastructure:

- **`litellm-callback/usage_logger.py`** — a LiteLLM `CustomLogger` that
  writes one row per proxied request (success and failure) to a local
  SQLite file. Tokens, latency, model, and which upstream provider actually
  served the request. No cost tracking.
- **`src/`** — a Bun web app that reads that SQLite file **read-only** and
  renders:

  - token summary cards (total / input / output / requests)
  - a cumulative per-model area chart with a hover tooltip and
    1d / 7d / 30d period switching (hourly buckets for 1d, daily otherwise)
  - a request log with per-request provider chips, token counts, and durations
  - CSV export

Times render in the viewer's browser timezone. The dashboard never writes to
the database, so it can never corrupt the log.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2
- A LiteLLM proxy (any recent version) with a writable data directory

## Setup

### 1. Install the callback into your LiteLLM config dir

Copy `litellm-callback/usage_logger.py` next to your `config.yaml` and
register it:

```yaml
litellm_settings:
  callbacks:
  - usage_logger.usage_logger
```

The callback writes to `/app/data/usage.db` inside the container (override
with `LITELLM_USAGE_DB`). It creates and migrates its own schema, keeps WAL
on, and prunes rows older than 90 days (`LITELLM_USAGE_RETENTION_DAYS`).

If your config serves the same model name from multiple upstreams (fallbacks
via `order:`), the log records which provider actually served each request,
derived from the deployment's `api_base`. Extend the provider map with:

```
LITELLM_USAGE_PROVIDERS=https://api.example.com=example,...
```

Then restart the proxy.

### 2. Run the dashboard

```bash
bun install
LITELLM_DASH_DB=/path/to/usage.db bun start
```

It listens on `0.0.0.0:34998` by default; override with `PORT` / `HOST`.
The database is opened read-only, so the dashboard can run as an unprivileged
user as long as it can read the file.

The unit below binds to localhost (`HOST=127.0.0.1`) — the dashboard has no
authentication, so don't expose it beyond the host unless something in front
of it (reverse proxy with auth, an SSH tunnel, etc.) provides access control.

### 3. (Optional) systemd user unit

```ini
[Unit]
Description=LiteLLM usage dashboard

[Service]
WorkingDirectory=/opt/litellm-dash
ExecStart=/usr/local/bin/bun src/server.ts
Restart=on-failure
Environment=PORT=34998
Environment=HOST=127.0.0.1
Environment=LITELLM_DASH_DB=/var/lib/litellm/usage.db

[Install]
WantedBy=default.target
```

## API

| Route | Returns |
|---|---|
| `/` | dashboard UI (10s auto-refresh) |
| `/api/summary?days=7` | token aggregates for the window (1/7/30) |
| `/api/chart?days=7&group=model` | per-bucket per-group token totals for the cumulative chart (`group` = `model` or `provider`) |
| `/api/latency?days=7&group=model` | per-group request count, avg and p95 duration over successful requests |
| `/api/export.csv?days=7` | CSV of all logged requests in the window |
| `/api/recent?limit=50&before_id=<id>` | latest logged requests — `{ rows, hasMore }`, keyset-paged; `before_id` = last row id already shown (max 200 per page) |

## Notes

- `bash scripts/deploy.sh` syncs the repo to the systemd deploy copy,
  restarts the unit, and smoke-checks the live endpoints. `bun test` runs
  the API test suite against a seeded temp DB.

- No authentication is built in — the default unit binds to localhost
  (`HOST=127.0.0.1`); if you must expose it, put a reverse proxy with auth in
  front.
- The SQLite file is written by the LiteLLM process; if LiteLLM runs as
  root in a container with a bind-mounted data dir, host-side reads may
  need appropriate permissions (the WAL sidecar files too).
- Not affiliated with LiteLLM or Cursor; the UI is just inspired by
  Cursor's usage page.

## License

MIT
