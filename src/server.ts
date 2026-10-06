/**
 * LiteLLM usage dashboard — a small read-only web UI over the SQLite usage
 * log written by usage_logger.py, the LiteLLM proxy custom callback.
 *
 * No cost tracking — tokens/latency only, by design.
 */
import { serve } from "bun";
import { Database } from "bun:sqlite";
import index from "./web/index.html";

const PORT = Number(process.env.PORT ?? 34998);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.LITELLM_DASH_DB ?? "./data/usage.db";
/**
 * Shared-secret gate. When set, requests must carry it as a `?token=` query
 * param (page URL) or `Authorization: Bearer` header (API calls). When unset,
 * the dashboard is open — fine on localhost, not on a LAN.
 */
const TOKEN = process.env.LITELLM_DASH_TOKEN ?? "";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const PERIODS = new Set([1, 7, 30]);

type Row = Record<string, unknown>;

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    return db;
  } catch {
    return null;
  }
}

/** Run a readonly query; on any error drop the handle (stale/replaced file). */
function q<T extends Row>(sql: string, ...params: unknown[]): T[] | null {
  const handle = getDb();
  if (!handle) return null;
  try {
    return handle.query(sql).all(...(params as any[])) as T[];
  } catch {
    db = null;
    return null;
  }
}

/** ISO cutoff in the same second-precision format the callback writes. */
function cutoff(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19) + "Z";
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

function parseDays(url: URL): number {
  const d = Number(url.searchParams.get("days"));
  return PERIODS.has(d) ? d : 7;
}

function summary(days: number) {
  const since = cutoff(days * DAY);
  const r =
    q<Row>(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM requests WHERE ts >= ?`,
      since,
    )?.[0] ?? {};
  return {
    dbAvailable: !!getDb(),
    days,
    requests: num(r.requests),
    tokens: num(r.tokens),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
  };
}

/**
 * Per-bucket per-group token totals for the cumulative chart.
 * `group=model` (default) buckets by model_group; `group=provider`
 * buckets by the provider that actually routed each request (rows with
 * no known provider roll up under "unknown"). 1d buckets by hour,
 * 7d/30d by UTC day. The client fills zero-buckets.
 */
function chart(days: number, group: string | null) {
  const bucket = days === 1 ? `substr(ts, 1, 13)` : `substr(ts, 1, 10)`;
  const byProvider = group === "provider";
  const nameExpr = byProvider
    ? `COALESCE(NULLIF(provider, ''), 'unknown')`
    : `COALESCE(model_group, model)`;
  const rows =
    q<Row>(
      `SELECT ${bucket} AS b,
              ${nameExpr} AS name,
              SUM(total_tokens) AS tokens
       FROM requests
       WHERE ts >= ? AND ${nameExpr} != ''
       GROUP BY b, name
       ORDER BY b`,
      cutoff(days * DAY),
    ) ?? [];
  return {
    days,
    group: byProvider ? ("provider" as const) : ("model" as const),
    bucketType: days === 1 ? ("hour" as const) : ("day" as const),
    now: new Date().toISOString(),
    rows: rows.map((r) => ({
      b: String(r.b),
      name: String(r.name),
      tokens: num(r.tokens),
    })),
  };
}

/**
 * Per-model (or per-provider) latency stats for the selected window:
 * request count, average and p95 duration over successful requests.
 * Same grouping expr as chart() so the toggle stays consistent.
 */
function latency(days: number, group: string | null) {
  const byProvider = group === "provider";
  const nameExpr = byProvider
    ? `COALESCE(NULLIF(provider, ''), 'unknown')`
    : `COALESCE(model_group, model)`;
  const rows =
    q<Row>(
      `SELECT ${nameExpr} AS name,
              COUNT(*) AS n,
              AVG(duration_ms) AS avg_ms,
              MAX(duration_ms) AS max_ms
       FROM requests
       WHERE ts >= ? AND status = 'success' AND duration_ms IS NOT NULL
       GROUP BY name
       ORDER BY avg_ms DESC`,
      cutoff(days * DAY),
    ) ?? [];
  // p95 per group — cheap at this scale: one bounded query per group
  const p95 = new Map<string, number>();
  for (const r of rows) {
    const name = String(r.name);
    const dur =
      q<Row>(
        `SELECT duration_ms FROM requests
         WHERE ts >= ? AND status = 'success' AND duration_ms IS NOT NULL
           AND ${nameExpr} = ?
         ORDER BY duration_ms`,
        cutoff(days * DAY),
        name,
      ) ?? [];
    if (dur.length) p95.set(name, Number(dur[Math.floor(dur.length * 0.95)]?.duration_ms ?? 0));
  }
  return {
    days,
    group: byProvider ? ("provider" as const) : ("model" as const),
    rows: rows.map((r) => ({
      name: String(r.name),
      n: num(r.n),
      avgMs: Math.round(num(r.avg_ms)),
      p95Ms: Math.round(p95.get(String(r.name)) ?? 0),
      maxMs: Math.round(num(r.max_ms)),
    })),
  };
}

function csvEscape(field: unknown): string {
  const s = field == null ? "" : String(field);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(days: number): Response {
  const rows =
    q<Row>(
      `SELECT ts, COALESCE(model_group, model) AS model, upstream_model,
              call_type, stream, prompt_tokens, completion_tokens,
              total_tokens, duration_ms, status, user_agent
       FROM requests WHERE ts >= ? ORDER BY id`,
      cutoff(days * DAY),
    ) ?? [];
  const header =
    "timestamp,model,upstream_model,call_type,stream,prompt_tokens,completion_tokens,total_tokens,duration_ms,status,user_agent";
  const body = rows
    .map((r) =>
      [
        r.ts,
        r.model,
        r.upstream_model,
        r.call_type,
        r.stream,
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.duration_ms,
        r.status,
        r.user_agent,
      ]
        .map(csvEscape)
        .join(","),
    )
    .join("\n");
  return new Response(`${header}\n${body}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="litellm-usage-${days}d.csv"`,
    },
  });
}

/**
 * Latest requests, newest first. Keyset pagination on the autoincrement id —
 * pass `before_id` (the id of the last row already shown) to page further
 * back. Stable even while new requests land, unlike offset pagination.
 * `status=failure` restricts the page to failed requests.
 */
function recent(limitRaw: string | null, beforeIdRaw: string | null, statusRaw: string | null) {
  const limit = Math.min(200, Math.max(1, Number(limitRaw) || 50));
  const beforeId = Number(beforeIdRaw);
  const hasBefore = Number.isFinite(beforeId) && beforeId > 0;
  const failuresOnly = statusRaw === "failure";
  const rows =
    q<Row>(
      `SELECT id, ts, COALESCE(model_group, model) AS model, upstream_model, provider,
              call_type, stream, prompt_tokens, completion_tokens, total_tokens,
              duration_ms, status, user_agent, error
       FROM requests
       WHERE ${failuresOnly ? "status != 'success' AND " : ""}${hasBefore ? "id < ?" : "1=1"}
       ORDER BY id DESC
       LIMIT ?`,
      ...(hasBefore ? [beforeId] : []),
      limit + 1, // fetch one extra just to know whether more exist
    ) ?? [];
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Shared-secret gate for /api/* routes. When LITELLM_DASH_TOKEN is set,
 * requests must carry it as a `?token=` query param (the client appends it
 * to every fetch) or an `Authorization: Bearer` header (API clients).
 * Without the env var every request passes. The HTML/JS/CSS shell stays
 * open — it's identical to the public repo, and all data lives in the API.
 */
const authorized = (req: Request): boolean => {
  if (!TOKEN) return true;
  const u = new URL(req.url);
  const supplied =
    u.searchParams.get("token") ??
    req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(TOKEN);
  // compare over the longer of the two lengths so runtime doesn't leak
  // how many bytes matched
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
};

/** Wrap an API handler with the token check. */
const gate =
  (handler: (req: Request) => Response) =>
  (req: Request): Response =>
    authorized(req)
      ? handler(req)
      : new Response("unauthorized\n", { status: 401 });

const server = serve({
  port: PORT,
  hostname: HOST,
  development: false,
  routes: {
    "/": index,
    "/api/summary": gate((req) =>
      Response.json(summary(parseDays(new URL(req.url)))),
    ),
    "/api/chart": gate((req) => {
      const u = new URL(req.url);
      return Response.json(
        chart(parseDays(u), u.searchParams.get("group")),
      );
    }),
    "/api/latency": gate((req) => {
      const u = new URL(req.url);
      return Response.json(
        latency(parseDays(u), u.searchParams.get("group")),
      );
    }),
    "/api/export.csv": gate((req) => exportCsv(parseDays(new URL(req.url)))),
    "/api/recent": gate((req) => {
      const u = new URL(req.url);
      return Response.json(
        recent(
          u.searchParams.get("limit"),
          u.searchParams.get("before_id"),
          u.searchParams.get("status"),
        ),
      );
    }),
  },
});

console.log(`litellm-dash listening on http://0.0.0.0:${server.port}`);
console.log(`db: ${DB_PATH}`);
