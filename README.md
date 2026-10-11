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

### 3. Authentication

Three modes, controlled entirely by env:

| `LITELLM_DASH_TOKEN` | `LITELLM_DASH_USER` + `LITELLM_DASH_PASSWORD` | Behaviour |
|---|---|---|
| unset | unset | **open** — LAN/localhost only |
| set | unset | shared-secret gate (`?token=` / Bearer) |
| any | set | **login screen + session cookie**; token also accepted |

Public exposure (e.g. through a Cloudflare tunnel) requires the user/pass
mode:

```bash
# in the deploy dir's .env (auto-loaded by Bun) or systemd Environment= lines
LITELLM_DASH_USER=admin
LITELLM_DASH_PASSWORD=<plaintext>
LITELLM_DASH_SESSION_TTL_DAYS=30        # remember-me lifetime, 1..365
# optional: LITELLM_DASH_SESSION_SECRET — manual HMAC key (else derived
# from the password hash; changing the password logs everyone out)
# legacy: LITELLM_DASH_TOKEN — programmatic ?token=/Bearer fallback
```

How it works and why it's safe to expose:

- The password is argon2id-hashed in memory at boot; nothing is written to
  disk. Login POSTs go to `/api/login`, rate-limited to 5 failed attempts /
  15 min / IP (`429` after that).
- Sessions are HMAC-SHA256-signed tokens with an embedded, server-checked
  expiry, carried in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` too when
  served over HTTPS). "Remember me" keeps the cookie for
  `LITELLM_DASH_SESSION_TTL_DAYS` days (default 30); unchecked, it's a
  browser-session cookie (server-side validity 12h).
- The HTML shell stays public — it's identical to the public repo and
  contains no data; everything sensitive lives behind the gated `/api/*`
  routes. Changing the password (restart) invalidates every issued session.
- Client-side, the SPA shows a login form whenever an API call gets a 401
  and works without JS too (native form POST → redirect → cookie set).

### 4. (Optional) systemd user unit

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
| `POST /api/login` | form-encoded `username`/`password`(+`remember`) → 303 + `dash_session` cookie; 401 on bad credentials, 429 when rate-limited |
| `POST /api/logout` | clears the session cookie |
| `/api/session` | `{ authenticated: true }` or 401 — the SPA's auth probe |

## Developing against the gateway DB from another machine

You can run a dev copy of the dashboard on your own laptop while it reads
the usage DB from the gateway host (192.168.0.200):

```bash
git clone <repo-url> litellm-dash && cd litellm-dash
bun install
ssh-copy-id agent@192.168.0.200      # if you don't have key auth yet

bash scripts/dev.sh                  # snapshot mode + start dev server
LIVE=1 bash scripts/dev.sh           # sshfs live view instead of snapshot
bash scripts/dev.sh --no-start       # just refresh the snapshot
```

Snapshot mode copies a consistent SQLite backup to `data/usage.db` locally
(WAL-safe, ~600 kB) and starts Bun with a throwaway dev login
(`LITELLM_DASH_USER=dev` / `LITELLM_DASH_PASSWORD=dev` unless you override).
The dashboard opens the DB read-only either way, so dev work can't corrupt
the gateway's log.

## Notes

- `bash scripts/deploy.sh` syncs the repo to the systemd deploy copy,
  restarts the unit, and smoke-checks the live endpoints (log in first when
  user/pass auth is configured). `bun test` runs the API + auth test suites
  against seeded temp DBs.

- In open/token mode nothing changed; in user/pass mode all `/api/*` routes
  accept a valid session cookie **and** the legacy `?token=`/Bearer header.
- The SQLite file is written by the LiteLLM process; if LiteLLM runs as
  root in a container with a bind-mounted data dir, host-side reads may
  need appropriate permissions (the WAL sidecar files too).
- Not affiliated with LiteLLM or Cursor; the UI is just inspired by
  Cursor's usage page.

### Authentication schema reference

All optional; see "3. Authentication" above for behaviour per mode.

| Variable | Meaning | Default |
|---|---|---|
| `LITELLM_DASH_USER` | login username | unset (open) |
| `LITELLM_DASH_PASSWORD` | login password (argon2id-hashed in memory at boot) | unset |
| `LITELLM_DASH_SESSION_TTL_DAYS` | remember-me cookie lifetime (1–365) | `30` |
| `LITELLM_DASH_SESSION_SECRET` | manual HMAC key — else derived from the password hash | derived |
| `LITELLM_DASH_TOKEN` | legacy `?token=`/Bearer gate, still honoured alongside login | unset |

## License

MIT
