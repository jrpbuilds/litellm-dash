/**
 * HTTP layer: builds the Bun.serve options from a Config. Reads no globals,
 * so tests can create isolated servers with any configuration.
 */
import type { BunRequest, Server } from "bun";
import dashboardPage from "./web/index.html";
import loginPage from "./web/login.html";
import { createSessionToken, deriveKey, RateLimiter, safeEqual, verifySessionToken } from "./auth";
import { authMode, type Config } from "./config";
import { makeModelInfoFetcher, type ModelInfo, type ModelInfoFetcher } from "./modelinfo";
import * as q from "./db";

/** Merges the advertised model list with per-model usage over the window.
 * Advertised-but-never-called models get zero usage; called-but-unadvertised
 * models still appear so the view matches the log. */
async function buildModelsPayload(db: q.UsageDb, modelInfo: ModelInfoFetcher, days: q.Days) {
  const [info, usage] = await Promise.all([
    modelInfo().catch(() => ({ configured: false, models: [] as ModelInfo[] })),
    Promise.resolve(q.modelUsage(db, days)),
  ]);
  const models: (ModelInfo & { requests: number; tokens: number })[] = [];
  const seen = new Set<string>();
  for (const m of info.models) {
    seen.add(m.name);
    const u = usage.get(m.name) ?? { requests: 0, tokens: 0 };
    models.push({ ...m, requests: u.requests, tokens: u.tokens });
  }
  // Models with traffic but no /model/info entry (proxy unreachable, or the
  // row predates the model's registration) are listed with usage only.
  for (const [name, u] of usage) {
    if (!seen.has(name)) models.push(blankModel(name, u));
  }
  models.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.name.localeCompare(b.name));
  return { days, dbAvailable: db.available, proxyConfigured: info.configured, models };
}

function blankModel(name: string, u: { requests: number; tokens: number }): ModelInfo & { requests: number; tokens: number } {
  return {
    name,
    provider: null,
    upstream: null,
    contextWindow: null,
    maxOutput: null,
    mode: null,
    vision: false,
    tools: false,
    reasoning: false,
    inputCost: null,
    outputCost: null,
    requests: u.requests,
    tokens: u.tokens,
  };
}

const SESSION_COOKIE = "dash_session";
const BROWSER_SESSION_MS = 12 * 3_600_000;
/** Login bodies are a few form fields; anything larger is rejected unread. */
const MAX_LOGIN_BODY = 8 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Security headers on every response this file builds. API responses are also
 * uncacheable so a shared proxy cannot store usage, client IPs, or errors.
 * The HTML shells are Bun bundles, which cannot take extra headers, so they
 * carry the same CSP and referrer policy as `<meta>` tags. A reverse proxy
 * should still send `X-Frame-Options: DENY` (and the CSP header) for those
 * two pages; `frame-ancestors` in the meta tag is ignored by browsers.
 */
function refererOrigin(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function withSecurity(res: Response, cache: "no-store" | "shell"): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (cache === "no-store") headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type Req = BunRequest<string>;
type Handler = (req: Req, server: Server<undefined>) => Response | Promise<Response>;

export interface ServerDeps {
  db?: q.UsageDb;
  limiter?: RateLimiter;
  /** Overrides the live /model/info fetcher. Tests inject a stub result. */
  modelInfo?: ModelInfoFetcher;
}

export async function createServer(cfg: Config, deps: ServerDeps = {}) {
  const mode = authMode(cfg);
  const db = deps.db ?? new q.UsageDb(cfg.dbPath);
  const limiter = deps.limiter ?? new RateLimiter();
  const modelInfo = deps.modelInfo ?? makeModelInfoFetcher(cfg);

  // Hashed once at boot so the plaintext is only compared via Bun.password.
  const passwordHash = mode === "login" ? await Bun.password.hash(cfg.password) : "";
  const sessionSecret = cfg.sessionSecret || (passwordHash && deriveKey(passwordHash));

  // Bun.serve joins repeated headers with ", ", so take the first entry.
  const firstHeader = (req: Request, name: string): string | undefined =>
    req.headers.get(name)?.split(",")[0].trim() || undefined;

  const clientIp = (req: Request, server: Server<undefined>): string => {
    if (cfg.trustProxy) {
      const forwarded = firstHeader(req, "cf-connecting-ip") ?? firstHeader(req, "x-forwarded-for");
      if (forwarded) return forwarded;
    }
    return server.requestIP(req)?.address ?? "unknown";
  };

  const isHttps = (req: Request): boolean =>
    new URL(req.url).protocol === "https:" ||
    (cfg.trustProxy && firstHeader(req, "x-forwarded-proto") === "https");

  const tokenMatches = (req: Request): boolean => {
    if (!cfg.token) return false;
    const header = req.headers.get("authorization");
    if (!header) return false;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return m != null && safeEqual(m[1]!, cfg.token);
  };

  /**
   * Cross-site form posts are rejected. A missing Origin and Referer is
   * allowed so non-browser clients (curl smoke tests) still work.
   */
  const sameOrigin = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const claimed = origin || (referer ? refererOrigin(referer) : null);
    if (!claimed) return true;
    return claimed === new URL(req.url).origin;
  };

  const authorized = (req: Req): boolean => {
    if (mode === "open") return true;
    if (mode === "login") {
      const session = req.cookies.get(SESSION_COOKIE);
      if (session && verifySessionToken(session, sessionSecret)) return true;
    }
    return tokenMatches(req);
  };

  const gate =
    (handler: (url: URL) => Response | Promise<Response>): Handler =>
    async (req) =>
      withSecurity(
        authorized(req) ? await handler(new URL(req.url)) : new Response("unauthorized\n", { status: 401 }),
        "no-store",
      );

  const login: Handler = async (req, server) => {
    if (mode !== "login") {
      return withSecurity(Response.json({ error: "login is not enabled" }, { status: 404 }), "no-store");
    }
    if (!sameOrigin(req)) {
      return withSecurity(Response.json({ error: "cross-origin request" }, { status: 403 }), "no-store");
    }
    const ip = clientIp(req, server);
    if (limiter.blocked(ip)) {
      return withSecurity(Response.json({ error: "too many attempts" }, { status: 429 }), "no-store");
    }
    // Read the body so a client cannot lie with Content-Length. Bun replaces
    // that header when fetch() is given a body, so the byte length is the check.
    const raw = await req.arrayBuffer().catch(() => null);
    if (!raw || raw.byteLength > MAX_LOGIN_BODY) {
      return withSecurity(Response.json({ error: "request too large" }, { status: 413 }), "no-store");
    }

    const form = await new Request(req.url, {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
      body: raw,
    })
      .formData()
      .catch(() => null);
    const username = String(form?.get("username") ?? "");
    const password = String(form?.get("password") ?? "");
    const remember = form?.get("remember") === "on";
    const ok = safeEqual(username, cfg.user) && (await Bun.password.verify(password, passwordHash));
    if (!ok) {
      limiter.fail(ip);
      return withSecurity(Response.json({ error: "invalid credentials" }, { status: 401 }), "no-store");
    }
    limiter.reset(ip);

    const ttlMs = remember ? cfg.sessionTtlDays * 86_400_000 : BROWSER_SESSION_MS;
    req.cookies.set(SESSION_COOKIE, createSessionToken(ttlMs, sessionSecret), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(req),
      // without maxAge the cookie ends with the browser session
      ...(remember ? { maxAge: cfg.sessionTtlDays * 86_400 } : {}),
    });
    return withSecurity(Response.redirect("/", 303), "no-store");
  };

  const logout: Handler = (req) => {
    if (!sameOrigin(req)) {
      return withSecurity(Response.json({ error: "cross-origin request" }, { status: 403 }), "no-store");
    }
    req.cookies.delete({ name: SESSION_COOKIE, path: "/" });
    return withSecurity(Response.redirect("/login", 303), "no-store");
  };

  const api: Record<string, { GET?: Handler; POST?: Handler }> = {
    "/api/summary": {
      GET: gate((u) => Response.json(q.summary(db, q.parseDays(u.searchParams.get("days"))))),
    },
    "/api/chart": {
      GET: gate((u) =>
        Response.json(
          q.chart(db, q.parseDays(u.searchParams.get("days")), q.parseGroup(u.searchParams.get("group"))),
        ),
      ),
    },
    "/api/latency": {
      GET: gate((u) =>
        Response.json(
          q.latency(db, q.parseDays(u.searchParams.get("days")), q.parseGroup(u.searchParams.get("group"))),
        ),
      ),
    },
    "/api/recent": {
      GET: gate((u) => {
        const p = u.searchParams;
        return Response.json(
          q.recent(db, {
            limit: Number(p.get("limit")) || undefined,
            beforeId: Number(p.get("before_id")) || undefined,
            failuresOnly: p.get("status") === "failure",
          }),
        );
      }),
    },
    "/api/export.csv": {
      GET: gate((u) => {
        const days = q.parseDays(u.searchParams.get("days"));
        const failuresOnly = u.searchParams.get("status") === "failure";
        return new Response(q.exportCsv(db, days, Date.now(), failuresOnly), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="litellm-usage-${days}d.csv"`,
          },
        });
      }),
    },
    "/api/models": {
      GET: gate(async (u) =>
        Response.json(await buildModelsPayload(db, modelInfo, q.parseDays(u.searchParams.get("days")))),
      ),
    },
    "/api/session": {
      GET: (req) =>
        withSecurity(
          authorized(req)
            ? Response.json({ authenticated: true, mode })
            : Response.json({ authenticated: false, mode }, { status: 401 }),
          "no-store",
        ),
    },
    "/api/login": { POST: login },
    "/api/logout": { POST: logout },
  };

  return {
    hostname: cfg.host,
    port: cfg.port,
    development: !cfg.production,
    // The HTML shells contain no data; the client probes /api/session and
    // redirects between them. Everything sensitive is behind /api/*.
    routes: { "/": dashboardPage, "/login": loginPage, ...api },
    fetch(req: Request): Response {
      const route = api[new URL(req.url).pathname];
      if (route) {
        return withSecurity(
          new Response("method not allowed\n", {
            status: 405,
            headers: { Allow: Object.keys(route).join(", ") },
          }),
          "no-store",
        );
      }
      return withSecurity(new Response("not found\n", { status: 404 }), "shell");
    },
  };
}
