/**
 * Auth-mode integration tests: spawn the real server with
 * LITELLM_DASH_USER/PASSWORD set and drive login -> cookie -> API over HTTP.
 * The open/token modes of tests/api.test.ts already cover the other modes;
 * these only exercise user/pass mode (port 35098; 35099 is api.test.ts's).
 *
 * Note: the rate-limit test leaves the in-memory limiter blocked for this
 * runner's IP, so it intentionally runs LAST in this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";

const DB = `${import.meta.dir}/../data/test-auth-usage.db`;
const PORT = 35098;
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

beforeAll(async () => {
  mkdirSync(`${import.meta.dir}/../data`, { recursive: true });
  rmSync(DB, { force: true });
  const db = new Database(DB);
  db.exec(SCHEMA);
  db.close();
  proc = Bun.spawn({
    cmd: ["bun", "src/server.ts"],
    env: {
      ...process.env,
      PORT: String(PORT),
      LITELLM_DASH_DB: DB,
      LITELLM_DASH_USER: "admin",
      LITELLM_DASH_PASSWORD: "hunter2",
      LITELLM_DASH_SESSION_TTL_DAYS: "30",
    },
    stdout: "ignore",
    stderr: "inherit",
    cwd: import.meta.dir + "/..",
  });
  // wait for the server to accept connections
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/login`, { method: "POST", body: "x=1" });
      return; // any HTTP response (even 401/500) means it's up
    } catch {
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  throw new Error("auth test server did not start");
}, 20_000);

afterAll(() => {
  proc?.kill();
});

/** POST /api/login, redirect-manual so we can inspect 303 + Set-Cookie. */
function login(user: string, pass: string, remember = false): Promise<Response> {
  const body = new URLSearchParams({ username: user, password: pass });
  if (remember) body.set("remember", "on");
  return fetch(`${BASE}/api/login`, { method: "POST", body, redirect: "manual" });
}

describe("auth mode (user/pass)", () => {
  test("dashboard API rejects unauthenticated requests", async () => {
    const r = await fetch(`${BASE}/api/summary?days=7`);
    expect(r.status).toBe(401);
  });

  test("session probe rejects unauthenticated requests", async () => {
    const r = await fetch(`${BASE}/api/session`);
    expect(r.status).toBe(401);
  });

  test("wrong username and wrong password → 401", async () => {
    expect((await login("admin", "wrongpass")).status).toBe(401);
    expect((await login("nobody", "hunter2")).status).toBe(401);
  });

  test("valid login → 303 + HttpOnly SameSite=Lax dash_session cookie", async () => {
    const r = await login("admin", "hunter2");
    expect(r.status).toBe(303);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("dash_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  test("session cookie authorizes the data API", async () => {
    const r = await login("admin", "hunter2", true); // remember → Max-Age
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    const api = await fetch(`${BASE}/api/summary?days=7`, { headers: { cookie } });
    expect(api.status).toBe(200);
    const s = await api.json();
    expect(s.dbAvailable).toBe(true);
    // /api/session behaves as a lightweight probe
    const probe = await fetch(`${BASE}/api/session`, { headers: { cookie } });
    expect(probe.status).toBe(200);
    expect((await probe.json()).authenticated).toBe(true);
  });

  test("remember=on → Max-Age within the 30-day window", async () => {
    const r = await login("admin", "hunter2", true);
    const maxAge = Number((r.headers.get("set-cookie") ?? "").match(/Max-Age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(86_400 * 25); // > 25d
    expect(maxAge).toBeLessThanOrEqual(86_400 * 31); // <= 31d
  });

  test("remember off → session cookie (no Max-Age set)", async () => {
    const r = await login("admin", "hunter2", false);
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/Max-Age=\d+/);
  });

  test("logout clears the cookie", async () => {
    const r = await fetch(`${BASE}/api/logout`, { method: "POST", redirect: "manual" });
    expect(r.status).toBe(303);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("dash_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  test("garbage cookie → 401 (no auth bypass)", async () => {
    const r = await fetch(`${BASE}/api/summary?days=7`, {
      headers: { cookie: "dash_session=1.9999999999999.deadbeef" },
    });
    expect(r.status).toBe(401);
  });

  test("tampered token → 401 (signature mismatch)", async () => {
    const r = await login("admin", "hunter2");
    const tok = (r.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
    const parts = tok.split(".");
    parts[1] = String(Number(parts[1]) + 86_400_000 * 365); // forge +1y expiry
    const forged = await fetch(`${BASE}/api/summary?days=7`, {
      headers: { cookie: `dash_session=${parts.join(".")}` },
    });
    expect(forged.status).toBe(401);
  });

  test("rate limiter: 6th consecutive failure → 429 (runs last)", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login("admin", "wrongpass")).status).toBe(401);
    }
    expect((await login("admin", "wrongpass")).status).toBe(429);
  });
});
