import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/auth";
import { makeModelInfoFetcher, parseModels, proxyOrigin, type FetchLike } from "../src/modelinfo";
import { iso, startServer, stubModelInfo, tempUsageDb, testConfig } from "./helpers";

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

  test("palette ranks models by all-time tokens, biggest first", async () => {
    expect(await (await srv.get("/api/palette")).json()).toEqual([{ name: "alpha", tokens: 10 }]);
  });

  test("models and summary accept days=all", async () => {
    const m = await (await srv.get("/api/models?days=all")).json();
    expect(m.days).toBe("all");
    expect(m.models).toEqual([expect.objectContaining({ name: "alpha", requests: 1, tokens: 10 })]);
    const s = await (await srv.get("/api/summary?days=all")).json();
    expect(s).toMatchObject({ days: "all", requests: 1, tokens: 10 });
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

  test("API responses are uncacheable and carry security headers", async () => {
    const res = await srv.get("/api/summary?days=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("HTML shells bundle the client and carry a CSP meta tag", async () => {
    const res = await srv.get("/");
    const html = await res.text();
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("frame-ancestors 'none'");
    expect(html).toMatch(/<script type="module"[^>]+src="\/[^"]+\.js"/);
    expect(html).not.toContain('src="./app.ts"');
  });

  test("wrong method is 405 with Allow, unknown path is 404", async () => {
    const res = await srv.get("/api/summary", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect((await srv.get("/api/login")).headers.get("allow")).toBe("POST");
    expect((await srv.get("/nope")).status).toBe(404);
  });
});

describe("models endpoint", () => {
  // Raw /model/info payloads, like the proxy actually returns.
  const advertised = [
    {
      model_name: "alpha",
      litellm_params: { model: "openai/alpha-v2" },
      model_info: { max_model_len: 128_000, max_output_tokens: 16_000, supports_vision: true },
      input_cost_per_token: 1.1e-7,
      output_cost_per_token: 4.4e-7,
    },
    {
      model_name: "never-called",
      litellm_params: { model: "vertex/gemini" },
      mode: "chat",
      supports_function_calling: true,
    },
  ];
  const info = () => stubModelInfo({ configured: true, models: parseModels(advertised) });

  test("merges /model/info with usage from the DB", async () => {
    const srv = await startServer(testConfig(), { db: data.db, modelInfo: info() });
    try {
      const body = await (await srv.get("/api/models?days=7")).json();
      expect(body.dbAvailable).toBe(true);
      expect(body.proxyConfigured).toBe(true);
      expect(body.models).toEqual([
        {
          name: "alpha",
          provider: "openai",
          upstream: "openai/alpha-v2",
          contextWindow: 128_000,
          maxOutput: 16_000,
          mode: null,
          vision: true,
          tools: false,
          reasoning: false,
          inputCost: 1.1e-7,
          outputCost: 4.4e-7,
          requests: 1,
          tokens: 10,
          outputTokPerSec: 5,
          failures: 0,
          logProviders: [],
          logUpstreams: [],
          retired: false,
        },
        {
          name: "never-called",
          provider: "vertex",
          upstream: "vertex/gemini",
          contextWindow: null,
          maxOutput: null,
          mode: "chat",
          vision: false,
          tools: true,
          reasoning: false,
          inputCost: null,
          outputCost: null,
          requests: 0,
          tokens: 0,
          outputTokPerSec: null,
          failures: 0,
          logProviders: [],
          logUpstreams: [],
          retired: false,
        },
      ]);
    } finally {
      srv.stop();
    }
  });

  test("a called-but-unadvertised model is retired when the catalog was fetched", async () => {
    const srv = await startServer(testConfig(), {
      db: data.db,
      modelInfo: stubModelInfo({ configured: true, models: [] }),
    });
    try {
      const body = await (await srv.get("/api/models?days=7")).json();
      expect(body.proxyConfigured).toBe(true);
      expect(body.models).toEqual([
        expect.objectContaining({ name: "alpha", requests: 1, tokens: 10, retired: true }),
      ]);
    } finally {
      srv.stop();
    }
  });

  test("proxy failure degrades to usage-only", async () => {
    const srv = await startServer(testConfig(), {
      db: data.db,
      // Raw fetcher that throws, like an unreachable proxy does in production.
      modelInfo: stubModelInfo(() => Promise.reject(new Error("connection refused"))),
    });
    try {
      const res = await srv.get("/api/models?days=7");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proxyConfigured).toBe(false);
      expect(body.models).toEqual([expect.objectContaining({ name: "alpha", retired: false })]);
    } finally {
      srv.stop();
    }
  });

  test("the endpoint is gated in token mode", async () => {
    const srv = await startServer(testConfig({ token: "t" }), { db: data.db, modelInfo: info() });
    try {
      expect((await srv.get("/api/models")).status).toBe(401);
      expect((await srv.get("/api/models?token=t")).status).toBe(401);
      expect((await srv.get("/api/models", { headers: { Authorization: "Bearer t" } })).status).toBe(200);
    } finally {
      srv.stop();
    }
  });

  test("the palette is gated in token mode", async () => {
    const srv = await startServer(testConfig({ token: "t" }), { db: data.db, modelInfo: info() });
    try {
      expect((await srv.get("/api/palette")).status).toBe(401);
      expect(
        (await srv.get("/api/palette", { headers: { Authorization: "Bearer t" } })).status,
      ).toBe(200);
    } finally {
      srv.stop();
    }
  });
});

describe("model info fetcher", () => {
  const payload = {
    data: [
      { model_name: "kept", litellm_params: { model: "openai/kept", custom_llm_provider: "custom" }, max_model_len: 4096 },
      { model_name: "reasoner", model_info: { supports_reasoning: true } },
      { litellm_params: { model: "openai/skipped" } },
      "not-an-object",
    ],
  };

  test("parseModels keeps the useful rows and ignores the rest", () => {
    expect(parseModels("nope")).toEqual([]);
    expect(parseModels(null)).toEqual([]);
    const models = parseModels(payload);
    expect(models.map((m) => m.name)).toEqual(["kept", "reasoner"]);
    expect(models[0]).toMatchObject({ provider: "custom", contextWindow: 4096, upstream: "openai/kept" });
    expect(models[1]).toMatchObject({ reasoning: true, provider: null });
  });

  test("parses the public /v1/models list without treating owned_by as the provider", () => {
    const models = parseModels({
      data: [
        { id: "glm-5.3", owned_by: "openai", mode: "chat", max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        { id: "unused" },
      ],
    });
    expect(models).toEqual([
      expect.objectContaining({
        name: "glm-5.3",
        provider: null,
        mode: "chat",
        contextWindow: 1_000_000,
        maxOutput: 128_000,
      }),
      expect.objectContaining({ name: "unused", contextWindow: null, maxOutput: null }),
    ]);
  });

  test("only http(s) proxy URLs are fetched", () => {
    expect(proxyOrigin("")).toBeNull();
    expect(proxyOrigin("file:///etc/passwd")).toBeNull();
    expect(proxyOrigin("http://litellm:4000/")).toBe("http://litellm:4000");
    expect(proxyOrigin("https://litellm.example/v1")).toBe("https://litellm.example");
  });

  test("the public list is fetched without a token; /model/info failure still returns it", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/v1/models")) {
        return Response.json({
          data: [{ id: "listed", mode: "chat", max_input_tokens: 8000 }, { id: "enriched" }],
        });
      }
      return new Response("nope", { status: 401 });
    };
    const cfg = testConfig({ proxyUrl: "https://litellm.example/v1", proxyToken: "master" });
    const fetcher = makeModelInfoFetcher(cfg, fetchImpl);

    const ok = await fetcher();
    expect(ok.configured).toBe(true);
    expect(ok.models.map((m) => m.name)).toEqual(["listed", "enriched"]);
    expect(ok.models[0]).toMatchObject({ contextWindow: 8000, mode: "chat", provider: null });
    expect(await fetcher()).toEqual(ok);
    expect(calls).toEqual([
      { url: "https://litellm.example/v1/models", authorization: null },
      { url: "https://litellm.example/model/info", authorization: "Bearer master" },
    ]);
  });

  test("a non-http proxy URL never calls fetch", async () => {
    let called = false;
    const fetcher = makeModelInfoFetcher(testConfig({ proxyUrl: "file:///tmp/x", proxyToken: "master" }), async () => {
      called = true;
      return new Response("no");
    });
    expect(await fetcher()).toEqual({ configured: false, models: [] });
    expect(called).toBe(false);
  });
});

describe("token mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (srv = await startServer(testConfig({ token: "s3cret" }), { db: data.db })));
  afterAll(() => srv.stop());

  test.each(API)("GET %s requires the token", async (path) => {
    expect((await srv.get(path)).status).toBe(401);
    expect((await srv.get(`${path}&token=s3cret`)).status).toBe(401);
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
    expect((await srv.get("/api/palette")).status).toBe(401);
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

  test("repeated forwarding headers use the first value", async () => {
    const res = await login(
      srv,
      { username: "admin", password: "hunter2" },
      { "X-Forwarded-Proto": "https, http", "CF-Connecting-IP": "192.0.2.7, 10.0.0.1" },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("a forged cookie is rejected", async () => {
    const res = await srv.get("/api/summary", { headers: { Cookie: `dash_session=1.9999999999999.${"A".repeat(43)}` } });
    expect(res.status).toBe(401);
  });

  test("the bearer token works alongside login; a query token does not", async () => {
    expect((await srv.get("/api/summary?token=tok")).status).toBe(401);
    expect((await srv.get("/api/summary", { headers: { Authorization: "Bearer tok" } })).status).toBe(200);
  });

  test("a foreign Origin is rejected; a missing Origin is allowed", async () => {
    const foreign = await login(srv, { username: "admin", password: "hunter2" }, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const noOrigin = await login(srv, { username: "admin", password: "hunter2" });
    expect(noOrigin.status).toBe(303);
  });

  test("behind a trusted proxy, an https-Origin over a plain-http hop matches", async () => {
    const host = srv.server.url.host; // same host the proxy forwards
    const https = await login(srv, { username: "admin", password: "hunter2" }, {
      Origin: `https://${host}`,
      "X-Forwarded-Proto": "https",
    });
    expect(https.status).toBe(303);
    expect(https.headers.get("set-cookie")).toContain("Secure");
    const wrongScheme = await login(srv, { username: "admin", password: "hunter2" }, {
      Origin: `http://${host}`,
      "X-Forwarded-Proto": "https",
    });
    expect(wrongScheme.status).toBe(403);
  });

  test("a foreign Referer is rejected on logout", async () => {
    const logout = await srv.get("/api/logout", {
      method: "POST",
      headers: { Referer: "https://evil.example/phish" },
    });
    expect(logout.status).toBe(403);
  });

  test("an oversized login body is rejected before it is parsed", async () => {
    const res = await srv.get("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=hunter2&pad=" + "x".repeat(9 * 1024),
    });
    expect(res.status).toBe(413);
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
