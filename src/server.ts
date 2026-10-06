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
 */
function recent(limitRaw: string | null, beforeIdRaw: string | null) {
  const limit = Math.min(200, Math.max(1, Number(limitRaw) || 50));
  const beforeId = Number(beforeIdRaw);
  const hasBefore = Number.isFinite(beforeId) && beforeId > 0;
  const rows =
    q<Row>(
      `SELECT id, ts, COALESCE(model_group, model) AS model, upstream_model, provider,
              call_type, stream, prompt_tokens, completion_tokens, total_tokens,
              duration_ms, status, user_agent
       FROM requests
       ${hasBefore ? "WHERE id < ?" : ""}
       ORDER BY id DESC
       LIMIT ?`,
      ...(hasBefore ? [beforeId] : []),
      limit + 1, // fetch one extra just to know whether more exist
    ) ?? [];
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

const server = serve({
  port: PORT,
  hostname: HOST,
  development: false,
  routes: {
    "/": index,
    "/api/summary": (req) =>
      Response.json(summary(parseDays(new URL(req.url)))),
    "/api/chart": (req) => {
      const u = new URL(req.url);
      return Response.json(
        chart(parseDays(u), u.searchParams.get("group")),
      );
    },
    "/api/export.csv": (req) => exportCsv(parseDays(new URL(req.url))),
    "/api/recent": (req) => {
      const u = new URL(req.url);
      return Response.json(
        recent(u.searchParams.get("limit"), u.searchParams.get("before_id")),
      );
    },
  },
});

console.log(`litellm-dash listening on http://0.0.0.0:${server.port}`);
console.log(`db: ${DB_PATH}`);
