/**
 * LiteLLM usage dashboard — a small read-only web UI over the SQLite usage
 * log written by usage_logger.py, the LiteLLM proxy custom callback.
 *
 * No cost tracking — tokens/latency only, by design.
 */
import { serve } from "bun";
import { Database } from "bun:sqlite";
import dashboardIndex from "./web/index.html";
import loginIndex from "./web/login.html";
import {
  createSessionToken,
  decodeToken,
  deriveKey,
  encodeToken,
  sessionFromCookie,
  verifySessionToken,
} from "./auth";

const PORT = Number(process.env.PORT ?? 34998);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.LITELLM_DASH_DB ?? "./data/usage.db";
/**
 * Shared-secret gate. When set, requests must carry it as a `?token=` query
 * param (page URL) or `Authorization: Bearer` header (API calls). When unset,
 * the dashboard is open — fine on localhost, not on a LAN.
 */
const TOKEN = process.env.LITELLM_DASH_TOKEN ?? "";

// ------------------------------------------------------------------ auth
/**
 * User/pass login (in addition to the token gate above). Both vars must be
 * set; anything else falls back to open or token-only mode. The password is
 * argon2id-hashed once at boot (nothing written to disk); the HMAC session
 * key is derived from that hash, so changing the password kills every
 * outstanding session.
 */
const USER = process.env.LITELLM_DASH_USER ?? "";
const PASSWORD = process.env.LITELLM_DASH_PASSWORD ?? "";
const TTL_DAYS_RAW = Number(process.env.LITELLM_DASH_SESSION_TTL_DAYS ?? 30);
const TTL_DAYS =
  Number.isFinite(TTL_DAYS_RAW) && TTL_DAYS_RAW >= 1 && TTL_DAYS_RAW <= 365
    ? TTL_DAYS_RAW
    : 30;
const SESSION_SECRET_OVERRIDE = process.env.LITELLM_DASH_SESSION_SECRET ?? "";
const AUTH_ON = !!(USER && PASSWORD);

if (!AUTH_ON && (USER || PASSWORD)) {
  console.log(
    "auth: both LITELLM_DASH_USER and LITELLM_DASH_PASSWORD must be set to enable login auth; running open",
  );
}

let SESSION_SECRET = "";
let PASSWORD_HASH = "";
if (AUTH_ON) {
  PASSWORD_HASH = await Bun.password.hash(PASSWORD); // argon2id, ~200ms once
  SESSION_SECRET = SESSION_SECRET_OVERRIDE || (await deriveKey(PASSWORD_HASH));
}

/** Per-IP failed-login tracker: 5 misses in 15 min → 429 until it cools. */
const RL_MAX = 5;
const RL_WINDOW = 15 * 60 * 1000;
const failedLogins = new Map<string, { n: number; until: number }>();

function tooManyFails(ip: string): boolean {
  const e = failedLogins.get(ip);
  if (!e) return false;
  if (Date.now() > e.until) {
    failedLogins.delete(ip);
    return false;
  }
  return e.n >= RL_MAX;
}

function recordFail(ip: string): void {
  const e = failedLogins.get(ip);
  const now = Date.now();
  if (!e || now > e.until) failedLogins.set(ip, { n: 1, until: now + RL_WINDOW });
  else e.n += 1;
}

async function handleLogin(req: Request, server: any): Promise<Response> {
  const ip = `${(server.requestIP(req) as any)?.address ?? "unknown"}|login`;
  if (!AUTH_ON)
    return Response.json({ error: "auth not configured" }, { status: 500 });
  if (tooManyFails(ip))
    return Response.json({ error: "too many attempts" }, { status: 429 });
  const form = await req.formData().catch(() => null);
  const username = String(form?.get("username") ?? "");
  const password = String(form?.get("password") ?? "");
  const remember = String(form?.get("remember") ?? "") === "on";
  const userOk = username === USER;
  // verify() re-derives work from the stored hash — never re-hash per request
  const passOk = userOk
    ? await Bun.password.verify(password, PASSWORD_HASH)
    : false;
  if (!userOk || !passOk) {
    recordFail(ip);
    return Response.json({ error: "invalid credentials" }, { status: 401 });
  }
  failedLogins.delete(ip);
  const ttl = remember ? TTL_DAYS * DAY : 12 * HOUR;
  const tok = await createSessionToken(ttl, SESSION_SECRET);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  const res = new Response(null, { status: 303, headers: { Location: "/" } });
  res.headers.append(
    "Set-Cookie",
    `dash_session=${encodeToken(tok)}; Path=/; HttpOnly; SameSite=Lax${secure}` +
      (remember ? `; Max-Age=${TTL_DAYS * 86400}` : ""),
  );
  return res;
}

const handleLogout = (): Response =>
  new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": "dash_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    },
  });

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
              duration_ms, status, user_agent, requester_ip, error
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
 * Auth gate for /api/* routes. Two modes compose:
 *  - user/pass (LITELLM_DASH_USER + LITELLM_DASH_PASSWORD): a valid signed
 *    `dash_session` cookie authorizes the request.
 *  - shared secret (LITELLM_DASH_TOKEN): `?token=` or `Authorization: ***
 *    header, unchanged legacy behaviour that keeps deploy.sh and API clients
 *    working.
 * With neither set, every request passes (open mode).
 */
const authorized = async (req: Request): Promise<boolean> => {
  if (AUTH_ON) {
    const tok = decodeToken(sessionFromCookie(req));
    if (tok && (await verifySessionToken(tok, SESSION_SECRET))) return true;
  }
  if (!AUTH_ON && !TOKEN) return true;
  if (!TOKEN) return false;
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

/** Wrap an API handler with the auth check. */
const gate =
  (handler: (req: Request) => Response | Promise<Response>) =>
  async (req: Request): Promise<Response> =>
    (await authorized(req))
      ? handler(req)
      : new Response("unauthorized\n", { status: 401 });

/**
 * Fallback handler for the server-side page gate. In auth mode the GET /
 * route is unmapped (`false`) so every anonymous visit lands here: a valid
 * session re-dispatches to the guarded `/__dash` route (the bundled
 * dashboard shell), anything else gets a 303 to /login. Anything the route
 * table did not match (unknown paths) treats the visitor as anonymous —
 * gated pages stay hidden, everything else 404s.
 */
const AuthGate = async (
  req: Request,
  server: Parameters<Parameters<typeof serve>[0]["fetch"]>[1],
): Promise<Response> => {
  const u = new URL(req.url);
  const locked = AUTH_ON || !!TOKEN;
  if (!locked) {
    // Open mode: everything reaches the dashboard directly.
    return fetch(new Request(new URL("/__dash", u.origin)), {
      headers: req.headers,
    });
  }
  if (await authorized(req)) {
    if (u.pathname === "/") {
      // Serve the dashboard shell through the route system (keeps the
      // hashed assets + ETag caching behavior intact).
      return fetch(new Request(new URL("/__dash", u.origin)), {
        headers: req.headers,
      });
    }
    // Signed-in visitor hitting an unknown path → dashboard shell (SPA).
    return fetch(new Request(new URL("/__dash", u.origin)), {
      headers: req.headers,
    });
  }
  // Anonymous: gated pages redirect to /login; unknown paths 404.
  if (u.pathname === "/") {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }
  return new Response("not found", { status: 404 });
};

const server = serve({
  port: PORT,
  hostname: HOST,
  development: false,
  fetch: AuthGate,
  routes: {
    // The dashboard shell is only served with a valid session. The GET /
    // route is a guard: in auth mode it maps to nothing (false) so the
    // request falls through to fetch() above, which redirects anonymous
    // visitors to /login and re-dispatches authed ones to the guarded
    // /__dash route that maps straight to the bundled dashboard. In open
    // mode / maps directly to the dashboard (no gate exists).
    "/": AUTH_ON || TOKEN
      ? (false as const)
      : (dashboardIndex as unknown as Response),
    "/__dash": dashboardIndex as unknown as Response,
    "/login": loginIndex as unknown as Response,
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
    "/api/login": { POST: (req, server) => handleLogin(req, server) },
    "/api/logout": { POST: () => handleLogout() },
    "/api/session": async (req: Request): Promise<Response> => {
      if (await authorized(req)) return Response.json({ authenticated: true });
      return Response.json({ authenticated: false }, { status: 401 });
    },
  },
});

console.log(`litellm-dash listening on http://0.0.0.0:${server.port}`);
console.log(`db: ${DB_PATH}`);
