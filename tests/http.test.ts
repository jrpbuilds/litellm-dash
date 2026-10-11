import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/auth";
import { iso, startServer, tempUsageDb, testConfig } from "./helpers";

let data: ReturnType<typeof tempUsageDb>;

beforeAll(() => {
  data = tempUsageDb();
  data.seed({ ts: iso(Date.now()), model: "alpha", prompt_tokens: 5, completion_tokens: 5 });
});
afterAll(() => data.cleanup());

const API = [
  "/api/summary?days=7",
  "/api/chart?days=7&group=model",
  "/api/latency?days=7&group=provider",
  "/api/recent?limit=5",
  "/api/export.csv?days=7",
];

const login = (
  srv: Awaited<ReturnType<typeof startServer>>,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) => srv.get("/api/login", { method: "POST", body: new URLSearchParams(fields), headers });

const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("open mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (srv = await startServer(testConfig(), { db: data.db })));
  afterAll(() => srv.stop());

  test.each(API)("GET %s is public", async (path) => {
    expect((await srv.get(path)).status).toBe(200);
  });

  test("summary returns the seeded data", async () => {
    expect(await (await srv.get("/api/summary?days=1")).json()).toMatchObject({ requests: 1, tokens: 10 });
  });

  test("session reports open mode", async () => {
    expect(await (await srv.get("/api/session")).json()).toEqual({ authenticated: true, mode: "open" });
  });

  test("login is not available", async () => {
    expect((await login(srv, { username: "a", password: "b" })).status).toBe(404);
  });

  test("HTML pages are served", async () => {
    for (const path of ["/", "/login"]) {
      const res = await srv.get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  test("CSV export is a download", async () => {
    const res = await srv.get("/api/export.csv?days=30");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("litellm-usage-30d.csv");
  });

  test("wrong method is 405 with Allow, unknown path is 404", async () => {
    const res = await srv.get("/api/summary", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect((await srv.get("/api/login")).headers.get("allow")).toBe("POST");
    expect((await srv.get("/nope")).status).toBe(404);
  });
});

describe("token mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (srv = await startServer(testConfig({ token: "s3cret" }), { db: data.db })));
  afterAll(() => srv.stop());

  test.each(API)("GET %s requires the token", async (path) => {
    expect((await srv.get(path)).status).toBe(401);
    expect((await srv.get(`${path}&token=s3cret`)).status).toBe(200);
    expect((await srv.get(path, { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await srv.get(path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("HTML shells stay public", async () => {
    expect((await srv.get("/")).status).toBe(200);
  });
});

describe("login mode", () => {
  const cfg = testConfig({ user: "admin", password: "hunter2", token: "tok", trustProxy: true });
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (srv = await startServer(cfg, { db: data.db, limiter: new RateLimiter(3) })));
  afterAll(() => srv.stop());

  test("anonymous API requests are rejected", async () => {
    for (const path of API) expect((await srv.get(path)).status).toBe(401);
    const s = await srv.get("/api/session");
    expect(s.status).toBe(401);
    expect(await s.json()).toEqual({ authenticated: false, mode: "login" });
  });

  test("bad credentials are 401", async () => {
    const h = { "X-Forwarded-For": "10.0.0.1" };
    expect((await login(srv, { username: "admin", password: "nope" }, h)).status).toBe(401);
    expect((await login(srv, { username: "root", password: "hunter2" }, h)).status).toBe(401);
  });

  test("login sets a browser-session cookie that authorizes the API", async () => {
    const res = await login(srv, { username: "admin", password: "hunter2" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Max-Age");
    expect(setCookie).not.toContain("Secure");
    const cookie = cookieOf(res);
    for (const path of API) expect((await srv.get(path, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  test("remember me sets Max-Age; X-Forwarded-Proto https sets Secure", async () => {
    const res = await login(
      srv,
      { username: "admin", password: "hunter2", remember: "on" },
      { "X-Forwarded-Proto": "https" },
    );
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`Max-Age=${30 * 86400}`);
    expect(setCookie).toContain("Secure");
  });

  test("a forged cookie is rejected", async () => {
    const res = await srv.get("/api/summary", { headers: { Cookie: `dash_session=1.9999999999999.${"A".repeat(43)}` } });
    expect(res.status).toBe(401);
  });

  test("the legacy token still works alongside login", async () => {
    expect((await srv.get("/api/summary?token=tok")).status).toBe(200);
  });

  test("logout clears the cookie", async () => {
    const res = await srv.get("/api/logout", { method: "POST" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie")).toMatch(/dash_session=;.*(Max-Age=0|Expires=)/);
  });

  test("rate limiting is per forwarded client IP", async () => {
    const attacker = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < 3; i++) {
      expect((await login(srv, { username: "admin", password: "x" }, attacker)).status).toBe(401);
    }
    expect((await login(srv, { username: "admin", password: "hunter2" }, attacker)).status).toBe(429);
    // another client behind the same proxy is unaffected
    const other = { "CF-Connecting-IP": "198.51.100.1" };
    expect((await login(srv, { username: "admin", password: "hunter2" }, other)).status).toBe(303);
  });
});

describe("session secret", () => {
  test("an explicit secret keeps sessions valid across password changes", async () => {
    const base = { user: "admin", sessionSecret: "fixed" };
    const a = await startServer(testConfig({ ...base, password: "one" }), { db: data.db });
    const cookie = cookieOf(await login(a, { username: "admin", password: "one" }));
    a.stop();
    const b = await startServer(testConfig({ ...base, password: "two" }), { db: data.db });
    expect((await b.get("/api/summary", { headers: { Cookie: cookie } })).status).toBe(200);
    b.stop();
  });

  test("a derived secret signs everyone out when the password changes", async () => {
    const a = await startServer(testConfig({ user: "admin", password: "one" }), { db: data.db });
    const cookie = cookieOf(await login(a, { username: "admin", password: "one" }));
    a.stop();
    const b = await startServer(testConfig({ user: "admin", password: "two" }), { db: data.db });
    expect((await b.get("/api/summary", { headers: { Cookie: cookie } })).status).toBe(401);
    b.stop();
  });
});
