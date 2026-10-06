/**
 * API tests for litellm-dash: spin the route handlers against a temp SQLite
 * file and assert on JSON shapes and pagination math.
 *
 * The server module binds a port on import, so instead of importing it we
 * rebuild its query layer by importing the same SQL via a tiny harness: we
 * import server.ts in a subprocess is overkill — instead these tests drive
 * the real server over HTTP, started on an ephemeral port by the test setup.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";

const DB = `${import.meta.dir}/../data/test-usage.db`;
const PORT = 35099;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: Bun.Subprocess<"ignore", "ignore", "inherit"> | null = null;

const SCHEMA = `
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
);`;

function seed(): void {
  mkdirSync(`${import.meta.dir}/../data`, { recursive: true });
  rmSync(DB, { force: true });
  const db = new Database(DB);
  db.exec("DROP TABLE IF EXISTS requests");
  db.exec(SCHEMA);
  // 120 successes across two models + two providers, plus 2 failures.
  const ins = db.prepare(
    `INSERT INTO requests (ts, model, model_group, provider, call_type, stream,
       prompt_tokens, completion_tokens, total_tokens, duration_ms, status, error)
     VALUES (?, ?, ?, ?, 'acompletion', 0, 100, 50, 150, ?, ?, ?)`,
  );
  for (let n = 1; n <= 120; n++) {
    const model = n % 2 ? "modelA" : "modelB";
    const provider = n % 3 ? "openference" : null; // nulls -> 'unknown'
    const failed = n % 60 === 0;
    ins.run(
      `2026-10-06T10:${String(n % 60).padStart(2, "0")}:00Z`,
      model,
      model,
      provider,
      n * 10,
      failed ? "failure" : "success",
      failed ? "litellm.APIError: test" : null,
    );
  }
  db.close();
}

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

beforeAll(async () => {
  seed();
  proc = Bun.spawn({
    cmd: ["bun", "src/server.ts"],
    env: { ...process.env, PORT: String(PORT), LITELLM_DASH_DB: DB },
    stdout: "ignore",
    stderr: "inherit",
    cwd: import.meta.dir + "/..",
  });
  // wait for the server to accept connections
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/summary?days=7`);
      return;
    } catch {
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  throw new Error("test server did not start");
});

afterAll(() => {
  proc?.kill();
});

describe("GET /api/summary", () => {
  test("aggregates tokens and counts over the window", async () => {
    const s = await getJson("/api/summary?days=7");
    expect(s.dbAvailable).toBe(true);
    expect(s.days).toBe(7);
    expect(s.requests).toBe(120);
    expect(s.tokens).toBe(120 * 150);
    expect(s.promptTokens).toBe(120 * 100);
    expect(s.completionTokens).toBe(120 * 50);
  });

  test("rejects non-whitelisted day windows", async () => {
    const s = await getJson("/api/summary?days=5");
    expect(s.days).toBe(7);
  });
});

describe("GET /api/chart", () => {
  test("model grouping returns per-bucket model rows", async () => {
    const c = await getJson("/api/chart?days=7&group=model");
    expect(c.group).toBe("model");
    expect(c.bucketType).toBe("day");
    const names = new Set(c.rows.map((r: any) => r.name));
    expect(names.has("modelA")).toBe(true);
    expect(names.has("modelB")).toBe(true);
    const total = c.rows.reduce((m: number, r: any) => m + r.tokens, 0);
    expect(total).toBe(120 * 150);
  });

  test("provider grouping rolls null/empty up as unknown", async () => {
    const c = await getJson("/api/chart?days=7&group=provider");
    expect(c.group).toBe("provider");
    const names = new Set(c.rows.map((r: any) => r.name));
    expect(names.has("openference")).toBe(true);
    expect(names.has("unknown")).toBe(true);
    expect(names.size).toBe(2);
  });

  test("1-day windows bucket by hour", async () => {
    const c = await getJson("/api/chart?days=1&group=model");
    expect(c.bucketType).toBe("hour");
  });
});

describe("GET /api/latency", () => {
  test("reports n, avg, p95, max per model, sorted slowest-first", async () => {
    const l = await getJson("/api/latency?days=7&group=model");
    expect(l.rows.length).toBe(2);
    // modelA = odd ids 1..119 (60 rows, durations 10..1190), modelB = even
    const a = l.rows.find((r: any) => r.name === "modelA");
    const b = l.rows.find((r: any) => r.name === "modelB");
    expect(a.n).toBe(60);
    expect(b.n).toBe(58); // 60 even ids minus the 2 failures (60, 120)
    expect(a.maxMs).toBeGreaterThan(a.avgMs);
    expect(a.p95Ms).toBeGreaterThanOrEqual(a.avgMs);
  });
});

describe("GET /api/recent", () => {
  test("page 1 is newest-first with hasMore", async () => {
    const r = await getJson("/api/recent?limit=50");
    expect(r.rows.length).toBe(50);
    expect(r.hasMore).toBe(true);
    expect(r.rows[0].id).toBe(120);
    const ids = r.rows.map((x: any) => x.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1]).toBeGreaterThan(ids[i]);
  });

  test("keyset pages chain without gaps or duplicates", async () => {
    const seen: number[] = [];
    let beforeId: number | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `/api/recent?limit=50${beforeId ? `&before_id=${beforeId}` : ""}`;
      const r = await getJson(url);
      seen.push(...r.rows.map((x: any) => x.id));
      if (!r.hasMore) break;
      beforeId = r.rows[r.rows.length - 1].id;
    }
    expect(seen.length).toBe(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe(120);
    expect(seen[119]).toBe(1);
  });

  test("status=failure returns only failures with error text", async () => {
    const r = await getJson("/api/recent?limit=50&status=failure");
    expect(r.rows.length).toBe(2);
    expect(r.rows.every((x: any) => x.status !== "success")).toBe(true);
    expect(r.rows.every((x: any) => typeof x.error === "string")).toBe(true);
  });

  test("garbage before_id is ignored", async () => {
    const r = await getJson("/api/recent?limit=10&before_id=garbage");
    expect(r.rows[0].id).toBe(120);
  });
});
