/**
 * HTTP layer: builds the Bun.serve options from a Config. Reads no globals,
 * so tests can create isolated servers with any configuration.
 */
import type { BunRequest, Server } from "bun";
import dashboardPage from "./web/index.html";
import loginPage from "./web/login.html";
import { createSessionToken, deriveKey, RateLimiter, safeEqual, verifySessionToken } from "./auth";
import { authMode, type Config } from "./config";
import * as q from "./db";

const SESSION_COOKIE = "dash_session";
const BROWSER_SESSION_MS = 12 * 3_600_000;

type Req = BunRequest<string>;
type Handler = (req: Req, server: Server<undefined>) => Response | Promise<Response>;

export interface ServerDeps {
  db?: q.UsageDb;
  limiter?: RateLimiter;
}

export async function createServer(cfg: Config, deps: ServerDeps = {}) {
  const mode = authMode(cfg);
  const db = deps.db ?? new q.UsageDb(cfg.dbPath);
  const limiter = deps.limiter ?? new RateLimiter();

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
    const supplied =
      new URL(req.url).searchParams.get("token") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    return supplied != null && safeEqual(supplied, cfg.token);
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
    (handler: (url: URL) => Response): Handler =>
    (req) =>
      authorized(req) ? handler(new URL(req.url)) : new Response("unauthorized\n", { status: 401 });

  const login: Handler = async (req, server) => {
    if (mode !== "login") return Response.json({ error: "login is not enabled" }, { status: 404 });
    const ip = clientIp(req, server);
    if (limiter.blocked(ip)) return Response.json({ error: "too many attempts" }, { status: 429 });

    const form = await req.formData().catch(() => null);
    const username = String(form?.get("username") ?? "");
    const password = String(form?.get("password") ?? "");
    const remember = form?.get("remember") === "on";
    const ok = safeEqual(username, cfg.user) && (await Bun.password.verify(password, passwordHash));
    if (!ok) {
      limiter.fail(ip);
      return Response.json({ error: "invalid credentials" }, { status: 401 });
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
    return Response.redirect("/", 303);
  };

  const logout: Handler = (req) => {
    req.cookies.delete({ name: SESSION_COOKIE, path: "/" });
    return Response.redirect("/login", 303);
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
        return new Response(q.exportCsv(db, days), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="litellm-usage-${days}d.csv"`,
          },
        });
      }),
    },
    "/api/session": {
      GET: (req) =>
        authorized(req)
          ? Response.json({ authenticated: true, mode })
          : Response.json({ authenticated: false, mode }, { status: 401 }),
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
        return new Response("method not allowed\n", {
          status: 405,
          headers: { Allow: Object.keys(route).join(", ") },
        });
      }
      return new Response("not found\n", { status: 404 });
    },
  };
}
