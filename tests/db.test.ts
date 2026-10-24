import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as q from "../src/db";
import { iso, tempUsageDb } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-03-15T12:30:00Z");

let t: ReturnType<typeof tempUsageDb>;

beforeAll(() => {
  t = tempUsageDb();
  t.seed(
    // today
    { ts: "2026-03-15T12:00:00Z", model: "alpha", provider: "p1", prompt_tokens: 100, completion_tokens: 50 },
    { ts: "2026-03-15T11:10:00Z", model: "beta", provider: "", prompt_tokens: 10, completion_tokens: 10 },
    // first hour of the 1d window, and just before it
    { ts: "2026-03-14T13:00:00Z", model: "alpha", provider: "p1", total_tokens: 7 },
    { ts: "2026-03-14T12:59:59Z", model: "alpha", provider: "p1", total_tokens: 1000 },
    // first day of the 7d window, and just before it
    { ts: "2026-03-09T00:00:00Z", model: "beta", provider: null, total_tokens: 3 },
    { ts: "2026-03-08T23:59:59Z", model: "beta", total_tokens: 100_000 },
    // failures
    { ts: "2026-03-15T10:00:00Z", model: "alpha", status: "failure", error: "boom", duration_ms: null },
  );
});

afterAll(() => t.cleanup());

describe("windows", () => {
  test("buckets end with the bucket containing now", () => {
    expect(q.buckets(1, NOW)).toHaveLength(24);
    expect(q.buckets(1, NOW).at(0)).toBe("2026-03-14T13");
    expect(q.buckets(1, NOW).at(-1)).toBe("2026-03-15T12");
    expect(q.buckets(7, NOW)).toEqual([
      "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15",
    ]);
    expect(q.buckets(30, NOW)).toHaveLength(30);
  });

  test("windowStart is the start of the first bucket", () => {
    expect(q.windowStart(1, NOW)).toBe("2026-03-14T13:00:00Z");
    expect(q.windowStart(7, NOW)).toBe("2026-03-09T00:00:00Z");
  });

  test.each([1, 7, 30] as const)("summary tokens equal the chart total for %dd", (days) => {
    const s = q.summary(t.db, days, NOW);
    const c = q.chart(t.db, days, "model", NOW);
    expect(c.rows.reduce((m, r) => m + r.tokens, 0)).toBe(s.tokens);
    expect(c.rows.every((r) => c.buckets.includes(r.b))).toBe(true);
  });

  test("parseDays and parseGroup only accept known values", () => {
    expect(q.parseDays("1")).toBe(1);
    expect(q.parseDays("30")).toBe(30);
    expect(q.parseDays("5")).toBe(7);
    expect(q.parseDays(null)).toBe(7);
    expect(q.parseGroup("provider")).toBe("provider");
    expect(q.parseGroup("x")).toBe("model");
  });
});

describe("summary", () => {
  test("aggregates the 7d window", () => {
    expect(q.summary(t.db, 7, NOW)).toEqual({
      dbAvailable: true,
      days: 7,
      requests: 6,
      tokens: 150 + 20 + 7 + 1000 + 3,
      promptTokens: 110,
      completionTokens: 60,
    });
  });

  test("missing DB file reports unavailable with zeros", () => {
    const db = new q.UsageDb("/nonexistent/usage.db");
    expect(q.summary(db, 7, NOW)).toMatchObject({ dbAvailable: false, requests: 0, tokens: 0 });
    expect(q.recent(db, {})).toEqual({ rows: [], hasMore: false });
  });
  });

/** Per-model usage over the window, the DB half of /api/models. */
describe("modelUsage", () => {
  test("groups by model_group across the window", () => {
    // 3 alpha rows in the 7d window: 150 (today) + 7 (Mar 14) + 1000 (Mar 14 12:59,
    // inside the 7d window that starts Mar 9) — the failure row has no tokens.
    expect([...q.modelUsage(t.db, 7, NOW).entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["alpha", { requests: 4, tokens: 150 + 7 + 1000, outputTokPerSec: 50 / 3, failures: 1, logProviders: ["p1"], logUpstreams: [] }],
      ["beta", { requests: 2, tokens: 20 + 3, outputTokPerSec: 10 / 2, failures: 0, logProviders: [], logUpstreams: [] }],
    ]);
    // In the 1d window (starting Mar 14 13:00 UTC): today's 150 and Mar 14
    // 13:00's explicit 7; the 12:59:59 failure row has zero tokens but counts
    // as a request, and one seeded alpha row sits outside the 1d window.
    expect(q.modelUsage(t.db, 1, NOW).get("alpha")).toEqual({
      requests: 3,
      tokens: 150 + 7,
      outputTokPerSec: 50 / 2,
      failures: 1,
      logProviders: ["p1"],
      logUpstreams: [],
    });
  });

  test("output rate is completion tokens over successful duration, failures excluded", () => {
    const db = tempUsageDb();
    db.seed(
      { ts: iso(NOW), model: "fast", completion_tokens: 100, duration_ms: 2000 },
      { ts: iso(NOW), model: "fast", completion_tokens: 50, duration_ms: 1000 },
      { ts: iso(NOW), model: "fast", status: "failure", completion_tokens: 9_000, duration_ms: 100 },
      { ts: iso(NOW - 40 * DAY), model: "fast", completion_tokens: 9_000, duration_ms: 100 },
    );
    // 150 output tokens over 3s of successful requests in the window.
    expect(q.modelUsage(db.db, 7, NOW).get("fast")?.outputTokPerSec).toBe(50);
    db.cleanup();
  });

  test("all-time ignores the window", () => {
    // beta's 100k-token row sits outside the 7d window; all-time counts it
    expect(q.modelUsage(t.db, "all", NOW).get("beta")).toMatchObject({
      requests: 3,
      tokens: 100_023,
      failures: 0,
    });
    expect(q.summary(t.db, "all", NOW)).toMatchObject({ requests: 7, tokens: 101_180 });
  });
});

describe("chart", () => {
  test("1d buckets by hour", () => {
    const c = q.chart(t.db, 1, "model", NOW);
    expect(c.bucketType).toBe("hour");
    expect(c.rows).toContainEqual({ b: "2026-03-14T13", name: "alpha", tokens: 7, requests: 1 });
    expect(c.rows.find((r) => r.b === "2026-03-14T12")).toBeUndefined();
  });

  test("provider grouping rolls null and empty up as unknown", () => {
    const c = q.chart(t.db, 7, "provider", NOW);
    const names = new Set(c.rows.map((r) => r.name));
    expect(names).toEqual(new Set(["p1", "unknown"]));
    expect(c.group).toBe("provider");
  });
});

describe("latency", () => {
  test("nearest-rank p95, avg and max over successful requests", () => {
    const l = tempUsageDb();
    l.seed(
      ...Array.from({ length: 100 }, (_, i) => ({ ts: iso(NOW - HOUR), model: "m", duration_ms: (i + 1) * 10 })),
      { ts: iso(NOW - HOUR), model: "single", duration_ms: 42 },
      { ts: iso(NOW - HOUR), model: "m", duration_ms: 99_999, status: "failure" as const },
      { ts: iso(NOW - 40 * DAY), model: "m", duration_ms: 99_999 },
    );
    const rows = q.latency(l.db, 7, "model", NOW).rows;
    expect(rows).toEqual([
      { name: "m", n: 100, avgMs: 505, p95Ms: 950, maxMs: 1000 },
      { name: "single", n: 1, avgMs: 42, p95Ms: 42, maxMs: 42 },
    ]);
    l.cleanup();
  });

  test("p95 of 20 samples is the 19th value", () => {
    const l = tempUsageDb();
    l.seed(...Array.from({ length: 20 }, (_, i) => ({ ts: iso(NOW), model: "m", duration_ms: i + 1 })));
    expect(q.latency(l.db, 1, "model", NOW).rows[0]!.p95Ms).toBe(19);
    l.cleanup();
  });
});

describe("recent", () => {
  const p = tempUsageDb();
  p.seed(...Array.from({ length: 25 }, (_, i) => ({ ts: iso(NOW - i * 1000), status: i % 5 === 0 ? ("failure" as const) : ("success" as const) })));
  afterAll(() => p.cleanup());

  test("newest first with hasMore", () => {
    const page = q.recent(p.db, { limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    const ids = page.rows.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  test("keyset pages chain without gaps or duplicates", () => {
    const seen: number[] = [];
    let beforeId: number | undefined;
    for (;;) {
      const page = q.recent(p.db, { limit: 10, beforeId });
      seen.push(...page.rows.map((r) => r.id as number));
      if (!page.hasMore) break;
      beforeId = seen.at(-1);
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test("failuresOnly filters, and limit is clamped", () => {
    const f = q.recent(p.db, { failuresOnly: true });
    expect(f.rows).toHaveLength(5);
    expect(f.rows.every((r) => r.status === "failure")).toBe(true);
    expect(q.recent(p.db, { limit: 0 }).rows).toHaveLength(25);
    expect(q.recent(p.db, { limit: 1 }).rows).toHaveLength(1);
    expect(q.recent(p.db, { beforeId: -5 }).rows).toHaveLength(25);
  });
});

describe("csv", () => {
  test("csvField quotes and neutralises formulas", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(12)).toBe("12");
    expect(csvField(-3)).toBe("-3");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("@sum")).toBe("'@sum");
    expect(csvField("|cmd")).toBe("'|cmd");
    expect(csvField(" =1+1")).toBe("' =1+1");
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  test("export has the full header and one line per row in the window", () => {
    const csv = q.exportCsv(t.db, 7, NOW).trimEnd().split("\n");
    expect(csv[0]).toBe(
      "ts,model,upstream_model,provider,call_type,stream,prompt_tokens,completion_tokens,total_tokens,duration_ms,status,vision,user_agent,requester_ip,error",
    );
    expect(csv).toHaveLength(1 + 6);
    expect(csv.at(-1)).toContain(",failure,0,,,boom");
  });

  test("failuresOnly omits successes", () => {
    const csv = q.exportCsv(t.db, 7, NOW, true).trimEnd().split("\n");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(",failure,");
    expect(csv.join("\n")).not.toContain(",success,");
  });
});

const csvField = q.csvField;
