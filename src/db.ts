/**
 * Read-only queries over the `requests` table written by
 * litellm-callback/usage_logger.py. Timestamps are stored as
 * "YYYY-MM-DDTHH:MM:SSZ" (UTC), so string comparison orders them correctly.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";

export type Group = "model" | "provider";
export type Row = Record<string, unknown>;

export const PERIODS = [1, 7, 30] as const;
export type Days = (typeof PERIODS)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Lazily opened read-only handle that reopens after errors (e.g. the file
 * was replaced or did not exist yet). */
export class UsageDb {
  private db: Database | null = null;

  constructor(readonly path: string) {}

  private handle(): Database | null {
    if (this.db) return this.db;
    try {
      this.db = new Database(this.path, { readonly: true });
    } catch (err) {
      console.warn(`usage db unavailable (${this.path}): ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
    return this.db;
  }

  get available(): boolean {
    return this.handle() !== null;
  }

  all<T extends Row = Row>(sql: string, ...params: SQLQueryBindings[]): T[] | null {
    const db = this.handle();
    if (!db) return null;
    try {
      return db.query<T, SQLQueryBindings[]>(sql).all(...params);
    } catch (err) {
      console.warn(`usage db query failed (${this.path}): ${err instanceof Error ? err.message : err}`);
      this.close();
      return null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export function parseDays(raw: string | null): Days {
  const d = Number(raw);
  return (PERIODS as readonly number[]).includes(d) ? (d as Days) : 7;
}

export type DaysOrAll = Days | "all";

/** Like parseDays, but "all" selects the whole log (the models page). */
export function parseDaysOrAll(raw: string | null): DaysOrAll {
  return raw === "all" ? "all" : parseDays(raw);
}

export const parseGroup = (raw: string | null): Group => (raw === "provider" ? "provider" : "model");

const groupExpr = (group: Group) =>
  group === "provider" ? `COALESCE(NULLIF(provider, ''), 'unknown')` : `COALESCE(model_group, model)`;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Chart buckets for a window: 24 hourly buckets for 1 day, otherwise one per
 * UTC day, ending with the bucket that contains `now`. Keys match
 * `substr(ts, 1, 13)` / `substr(ts, 1, 10)`.
 */
export function buckets(days: Days, now = Date.now()): string[] {
  const hourly = days === 1;
  const step = hourly ? HOUR : DAY;
  const count = hourly ? 24 : days;
  const last = Math.floor(now / step) * step;
  return Array.from({ length: count }, (_, i) =>
    new Date(last - (count - 1 - i) * step).toISOString().slice(0, hourly ? 13 : 10),
  );
}

/** Inclusive lower bound of a window: the start of its first bucket. Summary,
 * chart, latency and export all share it so their totals agree. */
export function windowStart(days: Days, now = Date.now()): string {
  const first = buckets(days, now)[0]!;
  return days === 1 ? `${first}:00:00Z` : `${first}T00:00:00Z`;
}

export function summary(db: UsageDb, days: DaysOrAll, now = Date.now()) {
  const since = days === "all" ? null : windowStart(days, now);
  const r =
    db.all(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM requests ${since ? "WHERE ts >= ?" : ""}`,
      ...(since ? [since] : []),
    )?.[0] ?? {};
  return {
    dbAvailable: db.available,
    days,
    requests: num(r.requests),
    tokens: num(r.tokens),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
  };
}

/** Per-bucket, per-group token totals. The client fills empty buckets. */
export function chart(db: UsageDb, days: Days, group: Group, now = Date.now()) {
  const bucketType = days === 1 ? ("hour" as const) : ("day" as const);
  const name = groupExpr(group);
  const rows =
    db.all(
      `SELECT substr(ts, 1, ${days === 1 ? 13 : 10}) AS b, ${name} AS name, SUM(total_tokens) AS tokens
       FROM requests
       WHERE ts >= ? AND ${name} != ''
       GROUP BY b, name
       ORDER BY b`,
      windowStart(days, now),
    ) ?? [];
  return {
    days,
    group,
    bucketType,
    buckets: buckets(days, now),
    rows: rows.map((r) => ({ b: String(r.b), name: String(r.name), tokens: num(r.tokens) })),
  };
}

/** All-time token totals per model, biggest first — the canonical order the
 *  client uses to hand out stable chart colors: a model keeps its palette
 *  slot in every window and grouping. Ties break alphabetically so the
 *  order (and therefore the colors) is fully deterministic. */
export function modelPalette(db: UsageDb) {
  const rows =
    db.all(
      `SELECT COALESCE(model_group, model) AS name, SUM(total_tokens) AS tokens
       FROM requests
       WHERE COALESCE(model_group, model) != ''
       GROUP BY name
       ORDER BY tokens DESC, name`,
    ) ?? [];
  return rows.map((r) => ({ name: String(r.name), tokens: num(r.tokens) }));
}

/** Request count, average, p95 and max duration of successful requests per
 * group, slowest average first. p95 is nearest-rank. */
export function latency(db: UsageDb, days: Days, group: Group, now = Date.now()) {
  const rows =
    db.all(
      `WITH d AS (
         SELECT ${groupExpr(group)} AS name, duration_ms
         FROM requests
         WHERE ts >= ? AND status = 'success' AND duration_ms IS NOT NULL
       ), ranked AS (
         SELECT name, duration_ms,
                ROW_NUMBER() OVER (PARTITION BY name ORDER BY duration_ms) AS rn,
                COUNT(*) OVER (PARTITION BY name) AS n
         FROM d
       )
       SELECT name, MAX(n) AS n, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms,
              MIN(CASE WHEN rn >= n * 0.95 - 1e-9 THEN duration_ms END) AS p95_ms
       FROM ranked
       GROUP BY name
       ORDER BY avg_ms DESC`,
      windowStart(days, now),
    ) ?? [];
  return {
    days,
    group,
    rows: rows.map((r) => ({
      name: String(r.name),
      n: num(r.n),
      avgMs: Math.round(num(r.avg_ms)),
      p95Ms: Math.round(num(r.p95_ms)),
      maxMs: Math.round(num(r.max_ms)),
    })),
  };
}

export interface RecentQuery {
  limit?: number;
  beforeId?: number;
  failuresOnly?: boolean;
}

/**
 * Newest requests first, keyset-paginated on id so pages stay stable while
 * new rows arrive. Pass the last id already shown as `beforeId`.
 * Unlike summary, chart, latency, and export, the log is not period-scoped.
 */
export function recent(db: UsageDb, { limit = 50, beforeId, failuresOnly = false }: RecentQuery) {
  const lim = Math.min(200, Math.max(1, Math.floor(limit) || 50));
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (failuresOnly) where.push("status != 'success'");
  if (beforeId != null && Number.isFinite(beforeId) && beforeId > 0) {
    where.push("id < ?");
    params.push(beforeId);
  }
  const rows =
    db.all(
      `SELECT id, ts, COALESCE(model_group, model) AS model, upstream_model, provider,
              call_type, stream, prompt_tokens, completion_tokens, total_tokens,
              duration_ms, status, user_agent, requester_ip, vision, error
       FROM requests
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`,
      ...params,
      lim + 1,
    ) ?? [];
  const hasMore = rows.length > lim;
  return { rows: hasMore ? rows.slice(0, lim) : rows, hasMore };
}

export interface ModelUsage {
  requests: number;
  tokens: number;
  /** Output tokens per second over successful timed requests; null when none. */
  outputTokPerSec: number | null;
  failures: number;
  /** Distinct providers and upstreams seen in the window, from the log. */
  logProviders: string[];
  logUpstreams: string[];
}

/** Requests, tokens and output rate per model group over the window. */
export function modelUsage(db: UsageDb, days: DaysOrAll, now = Date.now()) {
  const since = days === "all" ? null : windowStart(days, now);
  const rows =
    db.all(
      `SELECT COALESCE(model_group, model) AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              SUM(CASE WHEN status = 'success' AND duration_ms > 0 THEN completion_tokens END) AS out_tokens,
              SUM(CASE WHEN status = 'success' AND duration_ms > 0 THEN duration_ms END) AS out_ms,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failures,
              GROUP_CONCAT(DISTINCT NULLIF(provider, '')) AS log_providers,
              GROUP_CONCAT(DISTINCT NULLIF(upstream_model, '')) AS log_upstreams
       FROM requests
       WHERE COALESCE(model_group, model) != '' ${since ? "AND ts >= ?" : ""}
       GROUP BY name`,
      ...(since ? [since] : []),
    ) ?? [];
  const byName = new Map<string, ModelUsage>();
  for (const r of rows) {
    const outMs = num(r.out_ms);
    byName.set(String(r.name), {
      requests: num(r.requests),
      tokens: num(r.tokens),
      outputTokPerSec: outMs > 0 ? (num(r.out_tokens) / outMs) * 1000 : null,
      failures: num(r.failures),
      logProviders: splitList(r.log_providers),
      logUpstreams: splitList(r.log_upstreams),
    });
  }
  return byName;
}

function splitList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  return v.split(",").filter(Boolean).sort();
}

const CSV_COLUMNS = [
  "ts",
  "model",
  "upstream_model",
  "provider",
  "call_type",
  "stream",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "duration_ms",
  "status",
  "vision",
  "user_agent",
  "requester_ip",
  "error",
] as const;

/**
 * Quote per RFC 4180 and neutralise spreadsheet formulas in text cells.
 * A leading formula after optional whitespace (`=`, `+`, `-`, `@`, `|`, tab,
 * CR) is prefixed so Excel does not execute it.
 */
export function csvField(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (typeof v === "string" && /^\s*[=+\-@|\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(db: UsageDb, days: Days, now = Date.now(), failuresOnly = false): string {
  const where = failuresOnly ? "ts >= ? AND status != 'success'" : "ts >= ?";
  const rows =
    db.all(
      `SELECT ts, COALESCE(model_group, model) AS model, upstream_model, provider, call_type,
              stream, prompt_tokens, completion_tokens, total_tokens, duration_ms, status,
              vision, user_agent, requester_ip, error
       FROM requests WHERE ${where} ORDER BY id`,
      windowStart(days, now),
    ) ?? [];
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => csvField(r[c])).join(","));
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}
