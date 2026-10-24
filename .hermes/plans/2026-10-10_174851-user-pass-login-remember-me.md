# Plan: user/pass login screen with 30-day "remember me" for litellm-dash

**Date:** 2026-10-10 · **Status:** awaiting approval · **Architecture decided by user: single-page (SPA)**

## Goal

Replace the `?token=`/Bearer shared-secret gate with a username+password login
screen rendered inside the existing single-page app, where a checked
"Remember me" box keeps the user signed in for 30 days — all configured via
plain `.env` entries, secure enough to expose publicly through the existing
Cloudflare tunnel.

## Current context (verified against the live repo)

- **Stack:** Bun 1.4.2 single-file server (`src/server.ts`, 311 lines) +
  framework-free SPA (`src/web/index.html`, `src/web/app.ts` 690 lines,
  `src/web/styles.css` 586 lines). `bun test` = `tests/api.test.ts`, which
  spawns the real server on port 35099 and drives it over HTTP.
- **Existing auth:** `LITELLM_DASH_TOKEN` env → `authorized(req)` at
  `src/server.ts:249-265` checks `?token=` or `Authorization: Bearer` with a
  hand-rolled constant-time compare; `gate()` at `:268-273` wraps every
  `/api/*` handler with it. The client grabs `?token=` from the page URL and
  appends it to every fetch (`withToken`, `src/web/app.ts:104-110`). The
  server currently runs token-less (`HOST=0.0.0.0`, LAN-only).
- **The HTML shell is intentionally public.** `server.ts:246-248`: "the
  HTML/JS/CSS shell stays open — it's identical to the public repo, and all
  data lives in the API." Every dashboard section is JS-rendered
  (`renderCards`, `renderChart`, `renderRecent`) — a logged-out visitor sees
  an empty shell with no data. User picked SPA auth to match this design.
- **Exposure reality:** the deploy target is a systemd user unit
  (`~/.config/systemd/user/litellm-dash.service`, deploy copy at
  `/home/agent/docker/litellm/dashboard`, port 34998) fronted by a
  Cloudflare tunnel. User wants it public under that tunnel → the only
  secrets in play are the usage log (token counts, model names, user agents,
  failure text) and the login itself.
- **Deploy/ops:** `scripts/deploy.sh` rsyncs → `systemctl --user restart
  litellm-dash` → smoke-checks 5 endpoints with `?token=` auth. `.env` files
  are gitignored; Bun **auto-loads `.env` from the working directory**
  (verified: `bun envprobe.ts` picked up vars without any dotenv import).

### Verified Bun runtime mechanics (probed 2026-10-10, Bun 1.4.2)

These facts shape the implementation below; each was exercised in a throwaway
probe so the implementer doesn't rediscover them the hard way:

- `Bun.password.hash`/`verify` — argon2id by default; hash ~200ms, verify
  ~330ms on this box; both async (must await).
- WebCrypto `crypto.subtle` (HMAC-SHA256) available; timing-safe byte compare
  over `Math.max(a.length, b.length)` verified working for token validation.
- `Bun.serve({ routes: { "/api/login": { POST: (req, server) => … } } })` —
  method-keyed routes return **404** for non-matching methods; the second
  handler arg is the server and `server.requestIP(req)` returns
  `{ address, family, port }` for the rate limiter.
- A route handler **cannot** return the imported HTML bundle correctly —
  `new Response(index)` serves text/plain without the bundled
  `<script>`/`<link>`. That's why auth stays on the API layer (the shell is
  public anyway) instead of a server-side page gate.
- `Request.formData()` parses `application/x-www-form-urlencoded` bodies
  natively (`username`, `password`, `remember=on` all come through).
- `Response` with `Set-Cookie` on a 303 redirect works fine.

## Proposed architecture

A single session token format — `<v>.<exp_ms>.<hmac>` where the HMAC-SHA256
key is the argon2id hash of `LITELLM_DASH_PASSWORD` — signed and verified
statelessly, with the expiry embedded and checked server-side. The login
endpoint rate-limits by IP (5 attempts / 15 min), verifies the password with
`Bun.password.verify` (constant-time argon2id), and sets an
HttpOnly+Secure+SameSite=Lax cookie holding that token (30 days when
"Remember me" is checked, session cookie otherwise). The existing
`authorized()` gate swaps its token-source: cookie first (when auth is
enabled), then `?token=`/Bearer as a legacy/programmatic fallback so
`deploy.sh` and API integrations keep working. The SPA gains a login view
shown whenever any `/api/*` call 401s, and a Logout button that clears the
cookie; nothing else in the dashboard changes.

Why stateless HMAC instead of a session table: the server is read-only by
design (SQLite opened `readonly`), has no DB to write session rows to, and
restarts (deploys) shouldn't log anyone out. The secret material is derived
from the password hash, so changing the password invalidates all sessions.

## Configuration (the whole story is `.env`)

```bash
# .env (next to config, gitignored; all optional — see modes below)
LITELLM_DASH_USER=admin
LITELLM_DASH_PASSWORD=<plaintext>        # server hashes it on first boot
LITELLM_DASH_SESSION_TTL_DAYS=30         # remember-me lifetime (default 30)
LITELLM_DASH_SESSION_SECRET=<64 hex>     # optional manual override of the key
# Legacy, still honoured: LITELLM_DASH_TOKEN (programmatic gate fallback)
```

Auth modes (existing behaviour preserved when vars are absent):

| Vars set | Behaviour |
|---|---|
| none | open — current default, localhost/LAN use |
| `LITELLM_DASH_TOKEN` only | legacy shared-secret gate exactly as today |
| `USER` + `PASSWORD` | login screen + session cookies; `?token=`/Bearer **also accepted** |
| `USER` + `PASSWORD` + `TOKEN` | login screen + session cookies; token fallback |

If `LITELLM_DASH_SESSION_SECRET` is unset, the key is the **argon2id hash of
the password** (verified mechanically: `Bun.password.hash(...)` output is a
stable string when given a fixed salt — but we don't fix a salt; instead we
derive the HMAC key via `Bun.hash` blake2b-256 of the hash string, see Task 2).
Changing the password invalidates every issued session — no revocation list
needed. `TTL_DAYS` clamps to `1..365`; out-of-range or garbage → default 30.

Password hashing: on boot, if `LITELLM_DASH_PASSWORD` is plaintext (not
recognised as an argon2id string), the server hashes it in memory and logs
one hint line. There is **no on-disk secret store and no password file** —
the server derives everything from env at startup; hashing on every boot
(~200ms) is negligible next to startup. If `USER` or `PASSWORD` is missing
while the other is set → log a fatal-style line and keep the server running
in open mode (log: `auth: both LITELLM_DASH_USER and LITELLM_DASH_PASSWORD
must be set to enable login auth; running open`).

## Security posture (why it's safe publicly)

- Password never stored anywhere — hashed in memory at boot, compared with
  argon2id `verify` (memory-hard, constant-time). Attack surface for the
  password is the single `POST /api/login` route behind the rate limiter.
- Session cookie: `HttpOnly` (no JS/XSS theft), `Secure` (HTTPS-only —
  the tunnel terminates TLS; localhost HTTP testing uses the `Secure`-on-HTTPS
  conditional below), `SameSite=Lax` (blocks cross-site POST replay of
  authenticated actions; all state-changing endpoints are POST-only), max
  lifetime from env, token signed HMAC-SHA256 with embedded expiry checked
  server-side, name `dash_session`.
- Rate limit: 5 failed logins / 15 min / IP (in-memory, exact IP from
  `server.requestIP` — no X-Forwarded-For trust, so spoofing an extra
  attempt is impossible; key includes IP + a fixed salt string so different
  tunnels/LAN hosts can't share a bucket). Banned IPs get `429` with no
  password check. In-memory only → restart clears, acceptable.
- CSRF: read endpoints are GET; the only state-changing route is
  `POST /api/login` + `POST /api/logout`. SameSite=Lax on the session cookie
  already prevents a cross-site attacker from carrying it in a form POST;
  logout additionally requires the same-origin cookie. CSRF token added
  nowhere — Lax + cookie-matching-origin is the defense (documented in the
  README security note).
- Client assets under `/_bun/*` are static bundles of the public UI (no
  server-side data is embedded — verified: 404s before first bundle,
  contents are compiled JS/CSS only).
- Not a password manager, not multi-user — a single household/gateway
  credential, deliberately.

## Step-by-step tasks

Every task follows: write the failing test → run it → implement → run to
pass → `git commit`. All work in `/home/agent/projects/barkley-assistant/litellm-dash`.
Test runner: `bun test` (script `test` in package.json), port 35099 already
reserved by the harness.

### Task 1 — Extract and test the session token module

**New file: `src/auth.ts`** — pure functions, no `serve()` import (so the
main server can import it and the tests can too).

```ts
/**
 * Stateless session tokens: "<v>.<exp_ms>.<hmac>" — HMAC-SHA256 over
 * "v.exp", exp = UTC ms. Key = blake2b256 of the session secret string.
 * No DB, no revocation list: changing the secret invalidates all tokens.
 */

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return key;
}

/** Timing-safe byte equality (over the longer length; no length leak). */
export function safeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSessionToken(
  ttlMs: number,
  secret: string,
): Promise<string> {
  const payload = `1.${Date.now() + ttlMs}`;
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  if (!/^\d+\.\d+$/.test(payload)) return false;
  const expMs = Number(payload.split(".")[1]);
  if (Date.now() > expMs) return false;
  return safeEqual(await sign(payload, secret), sig);
}

/** Extract the `dash_session` cookie value from a Request header. */
export function sessionFromCookie(req: Request): string {
  const m = req.headers.get("cookie")?.match(/dash_session=([^\s;]+)/);
  return m?.[1] ?? "";
}
```

**New file: `tests/auth.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  safeEqual,
  sessionFromCookie,
  verifySessionToken,
} from "../src/auth";

describe("session tokens", () => {
  test("round-trips a valid token", async () => {
    const secret = "a".repeat(32);
    const tok = await createSessionToken(1000, secret);
    expect(await verifySessionToken(tok, secret)).toBe(true);
  });

  test("rejects wrong secret", async () => {
    const tok = await createSessionToken(1000, "a".repeat(32));
    expect(await verifySessionToken(tok, "b".repeat(32))).toBe(false);
  });

  test("rejects expired token", async () => {
    const secret = "a".repeat(32);
    const tok = await createSessionToken(-1, secret); // already expired
    expect(await verifySessionToken(tok, secret)).toBe(false);
  });

  test("rejects tampered payload", async () => {
    const secret = "a".repeat(32);
    const tok = await createSessionToken(1000, secret);
    const parts = tok.split(".");
    parts[1] = String(Number(parts[1]) + 1);
    expect(await verifySessionToken(parts.join("."), secret)).toBe(false);
  });

  test("rejects garbage", async () => {
    for (const bad of ["", "x", "1.2", "1.2.3"]) {
      expect(await verifySessionToken(bad, "a".repeat(32))).toBe(false);
    }
  });

  test("safeEqual is not trivially true/false", async () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("sessionFromCookie finds dash_session", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "other=1; dash_session=abc.def; more=2" },
    });
    expect(sessionFromCookie(req)).toBe("abc.def");
    expect(sessionFromCookie(new Request("https://x/"))).toBe("");
  });
});
```

Commands + expected output:

```bash
bun test tests/auth.test.ts
# initially: 7 fails with "Cannot find module '../src/auth'" (write the test
# before src/auth.ts) → then implement src/auth.ts → all 7 pass
```

Commit: `git add src/auth.ts tests/auth.test.ts && git commit -m "auth: stateless HMAC session tokens"`

### Task 2 — Secret derivation

> Why not `Bun.hash("blake2b256", str)`: it returns a 64-bit BigInt, not a
> 256-bit key — too short for HMAC-SHA256. SHA-256 via WebCrypto gives a real
> 32-byte key and is available everywhere.

Append to `src/auth.ts`:

```ts
/** SHA-256 of a string as 64 hex chars — turns a variable-length secret
 * (e.g. the argon2id password hash) into a stable 32-byte HMAC key. */
export async function deriveKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

Tests to append to `tests/auth.test.ts` (write first, watch fail with
`deriveKey is not exported`):

```ts
describe("deriveKey", () => {
  test("stable, 64 hex chars, distinct per input", async () => {
    const a = await deriveKey("s1");
    const b = await deriveKey("s1");
    const c = await deriveKey("s2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("tokens signed with a derived key verify", async () => {
    const secret = await deriveKey("some password hash");
    const tok = await createSessionToken(1000, secret);
    expect(await verifySessionToken(tok, secret)).toBe(true);
  });
});
```

Commit: `git commit -am "auth: deriveKey via SHA-256"`

### Task 3 — Wire the login/logout/session routes into the server

**Edit `src/server.ts`** — add at the top (after the existing env block):

```ts
import {
  createSessionToken,
  deriveKey,
  sessionFromCookie,
  verifySessionToken,
} from "./auth";

const USER = process.env.LITELLM_DASH_USER ?? "";
const PASSWORD = process.env.LITELLM_DASH_PASSWORD ?? "";
const TTL_DAYS_RAW = Number(process.env.LITELLM_DASH_SESSION_TTL_DAYS ?? 30);
const TTL_DAYS = Number.isFinite(TTL_DAYS_RAW) && TTL_DAYS_RAW >= 1 && TTL_DAYS_RAW <= 365
  ? TTL_DAYS_RAW : 30;
const SESSION_SECRET_OVERRIDE = process.env.LITELLM_DASH_SESSION_SECRET ?? "";
const AUTH_ON = !!(USER && PASSWORD);
const HOUR = 3_600_000; // existing constant — reuse
const DAY = 86_400_000; // existing constant — reuse

if (!AUTH_ON && (USER || PASSWORD)) {
  console.log(
    "auth: both LITELLM_DASH_USER and LITELLM_DASH_PASSWORD must be set to enable login auth; running open",
  );
}
```

Then the one-time async setup before `serve()` — hash the password once, and
derive the HMAC key from that hash (or the manual override):

```ts
let SESSION_SECRET = "";
let PASSWORD_HASH = "";
if (AUTH_ON) {
  PASSWORD_HASH = await Bun.password.hash(PASSWORD); // argon2id, ~200ms once
  SESSION_SECRET = SESSION_SECRET_OVERRIDE || (await deriveKey(PASSWORD_HASH));
}
```

Rate limiter (in-memory, per-IP, 5 fails / 15 min):

```ts
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
  if (!e || now > e.until) {
    failedLogins.set(ip, { n: 1, until: now + RL_WINDOW });
  } else {
    e.n += 1;
  }
}
```

Replace the body of `authorized(req)` with (keeping the same export shape):

```ts
const authorized = async (req: Request): Promise<boolean> => {
  if (!AUTH_ON && !TOKEN) return true; // open mode — unchanged
  if (AUTH_ON) {
    const tok = sessionFromCookie(req);
    if (tok && (await verifySessionToken(tok, SESSION_SECRET))) return true;
  }
  // legacy/programmatic fallback — exactly the current ?token=/Bearer logic
  if (!TOKEN) return false;
  const u = new URL(req.url);
  const supplied =
    u.searchParams.get("token") ??
    req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(TOKEN);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
};
```

`gate()` becomes async-aware (one-line change):

```ts
const gate =
  (handler: (req: Request) => Response | Promise<Response>) =>
  async (req: Request): Promise<Response> =>
    (await authorized(req))
      ? handler(req)
      : new Response("unauthorized\n", { status: 401 });
```

Add the three new routes (method-keyed, so `GET /api/login` → 404) and the
login handler:

```ts
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
  // PASSWORD_HASH was hashed once at boot; verify re-derives from the
  // stored argon2id params — never re-hash per request.
  const passOk = userOk ? await Bun.password.verify(password, PASSWORD_HASH) : false;
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
    `dash_session=${tok}; Path=/; HttpOnly; SameSite=Lax${secure}` +
      (remember ? `; Max-Age=${TTL_DAYS * 86400}` : ""),
  );
  return res;
}
```

(No-remember logins set no `Max-Age` at all — a session cookie that dies
with the browser; server-side the token still self-expires after 12h, so a
crashed browser tab can't leave a month-long token lying around. `Max-Age=0`
would kill it instantly, which is not what "remember off" means.)

Add to `routes`:

```ts
"/api/login": { POST: (req, server) => handleLogin(req, server) },
"/api/logout": {
  POST: () =>
    new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": "dash_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      },
    }),
},
"/api/session": gate(() => Response.json({ authenticated: true })),
```

`/api/session` is the client's lightweight auth probe — a single fetch that
either 200s (render dashboard) or 401s (render login view); it's already
gated by `gate()`, which now understands cookies.

Commit: `git commit -am "auth: login/logout/session routes with argon2id + rate limit"`

### Task 4 — SPA: login view, logout button, no more ?token=

**Edit `src/web/app.ts`** — replace the `TOKEN`/`withToken` block
(`app.ts:97-120`) with:

```ts
// ---------------------------------------------------------------- auth

/** Login/logout view state; data calls flow through gate()/cookie auth. */
const authState = { loggedIn: false };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 401) {
      authState.loggedIn = false;
      showLogin();
      return null;
    }
    if (!r.ok) return null;
    authState.loggedIn = true;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- login view

function showLogin() {
  $("dashboard").hidden = true;
  $("loginview").hidden = false;
}

function showDashboard() {
  $("loginview").hidden = true;
  $("dashboard").hidden = false;
  refresh();
}
```

Wire the form (append near the existing event-wiring at the bottom of
`app.ts`, before `refresh()`/`setInterval`):

```ts
$("loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const msg = $("loginmsg");
  msg.textContent = "";
  const body = new URLSearchParams({
    username: (f.elements.namedItem("username") as HTMLInputElement).value,
    password: (f.elements.namedItem("password") as HTMLInputElement).value,
  });
  if ((f.elements.namedItem("remember") as HTMLInputElement).checked) {
    body.set("remember", "on");
  }
  const r = await fetch("/api/login", { method: "POST", body });
  if (r.ok) {
    showDashboard();
  } else {
    msg.textContent =
      r.status === 429
        ? "Too many attempts — try again in 15 minutes."
        : "Invalid username or password.";
  }
});
$("logoutbtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  authState.loggedIn = false;
  showLogin();
});
```

Delete the `withToken` function and the `$("export").setAttribute("href",
withToken(...))` line — the export link needs no token appended (cookie
rides along automatically). Keep `refresh()` and the 10s poll unchanged.

**Edit `src/web/index.html`** — wrap the existing `<main class="page">`
in two siblings:

```html
  <body>
    <!-- login view: hidden until a 401 flips it on -->
    <main class="page loginpage" id="loginview" hidden>
      <form class="card loginform" id="loginform" method="post" action="/api/login">
        <h1>Gateway Usage</h1>
        <p class="pagesub">Sign in to see your LiteLLM usage.</p>
        <input name="username" placeholder="Username" autocomplete="username" required />
        <input name="password" type="password" placeholder="Password" autocomplete="current-password" required />
        <label class="remember"><input type="checkbox" id="remember" /> Remember me for 30 days</label>
        <div class="loginmsg" id="loginmsg"></div>
        <button class="btn loginbtn" type="submit">Sign in</button>
      </form>
    </main>
    <main class="page" id="dashboard">
      <!-- everything already in <main class="page"> today, unchanged -->
    </main>
```

Note: keep the `method="post" action="/api/login"` attributes on the form —
they make the form work without JS (native POST → 303 → `/` → cookie set →
dashboard loads logged-in) while the JS `submit` handler prevents default
for the SPA path. The checkbox needs `name="remember"` (not just `id`) so
`form.get("remember")` returns `"on"` when checked server-side, and the JS
reads its checked state via `f.elements.namedItem("remember")`.

**Edit `src/web/styles.css`** — append the login styles:

```css
/* --- login view ------------------------------------------------------ */
.loginpage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.loginform {
  width: min(340px, 90vw);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
}
.loginform h1 {
  font-size: 22px;
  margin: 0;
  justify-content: center;
}
.loginform input {
  background: var(--bg);
  border: 1px solid var(--card-border);
  color: var(--text);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
}
.loginform input:focus {
  outline: 1px solid var(--ok);
  border-color: var(--ok);
}
.loginform .remember {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.loginbtn {
  background: var(--ok);
  color: #0e0e10;
  border: 0;
  font-weight: 600;
  padding: 10px;
  font-size: 13px;
  cursor: pointer;
}
.loginmsg {
  color: var(--bad);
  font-size: 12px;
  min-height: 18px;
}
```

Commit: `git commit -am "auth: SPA login view + logout, drop ?token= plumbing"`

### Task 5 — Docs: README + deploy.sh + systemd unit

**Edit `README.md`** — replace the "No authentication is built in" bullet
(`:113-115`) and the unit block's comment (`:74-76`) with:

```markdown
## Authentication

The dashboard ships in three modes, controlled entirely by env:

| `LITELLM_DASH_TOKEN` | `LITELLM_DASH_USER` + `LITELLM_DASH_PASSWORD` | Behaviour |
|---|---|---|
| unset | unset | open — LAN/localhost only, as before |
| set | unset | shared-secret gate (`?token=` / Bearer), as before |
| any | set | login screen + session cookie; token also accepted |

Public exposure (e.g. through the Cloudflare tunnel) requires the user/pass
mode:

```ini
# in the unit's Environment= lines or a WorkingDirectory .env
Environment=LITELLM_DASH_USER=admin
Environment=LITELLM_DASH_PASSWORD=<plaintext>
Environment=LITELLM_DASH_SESSION_TTL_DAYS=30
```

- The password is hashed in memory with argon2id at boot; nothing is written
  to disk.
- Sessions are signed HMAC tokens in an HttpOnly, Secure (HTTPS), SameSite=Lax
  cookie; expiry is checked server-side. "Remember me" keeps the cookie for
  `LITELLM_DASH_SESSION_TTL_DAYS` days (default 30, clamp 1–365); unchecked
  the browser session cookie dies with the tab (server-side TTL 12h).
- Login is rate-limited to 5 attempts / 15 min / IP. Changing the password
  (restart the unit) invalidates every issued session.
- Cookie theft implies account access, as with any web login; the log data
  itself is model names, token counts and timestamps — no prompts or
  responses are logged (the callback never records content).
```

**Edit `scripts/deploy.sh`** — the smoke checks currently append `&$AUTH`
(`?token=…`). With user/pass mode the cookie does the work, so add a login
step after restart:

```bash
# after restart, before checks:
if [ -n "$DASH_USER" ] && [ -n "$DASH_PASSWORD" ]; then
  rm -f /tmp/litellm-dash-cookies
  LOGIN=$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/litellm-dash-cookies \
    -d "username=$DASH_USER&password=$DASH_PASSWORD&remember=on" \
    "http://127.0.0.1:$PORT/api/login")
  [ "$LOGIN" = "303" ] || { echo "== login failed (HTTP $LOGIN)"; exit 1; }
fi
```

…and source those vars from the unit env the same way TOKEN is today:
`DASH_USER="${LITELLM_DASH_USER:-$(systemctl show --user "$UNIT"
--property=Environment 2>/dev/null | grep -oP 'LITELLM_DASH_USER=\K\S+' || true)}"`
(same for `DASH_PASSWORD`, careful not to echo it).

Commit: `git commit -am "docs: authentication modes + deploy.sh login smoke"`

### Task 6 — Full-suite run + auth integration tests

```bash
bun test
# expect: all existing tests/api.test.ts cases pass unchanged (open mode), all new auth tests pass
```

The existing `tests/api.test.ts` spawns the server with **no** auth env
(`env: { ...process.env, PORT, LITELLM_DASH_DB }`) — `process.env` here is
the test runner's env, which (verified) is not polluted with
`LITELLM_DASH_*` vars on this machine, so the suite's server runs open-mode
and all legacy assertions hold. **Add** to `tests/api.test.ts`:

```ts
describe("auth flow (user/pass mode)", () => {
  // uses a second server spawn on port 35098 with auth env set
});
```

Full test block (append to `tests/api.test.ts`):

```ts
const PORT2 = 35098;
const BASE2 = `http://127.0.0.1:${PORT2}`;
let proc2: Bun.Subprocess<"ignore", "ignore", "inherit"> | null = null;

beforeAll(() => {
  proc2 = Bun.spawn({
    cmd: ["bun", "src/server.ts"],
    env: {
      ...process.env,
      PORT: String(PORT2),
      LITELLM_DASH_DB: DB,
      LITELLM_DASH_USER: "admin",
      LITELLM_DASH_PASSWORD: "hunter2",
      LITELLM_DASH_SESSION_TTL_DAYS: "30",
    },
    stdout: "ignore",
    stderr: "inherit",
    cwd: import.meta.dir + "/..",
  });
});

afterAll(() => {
  proc2?.kill();
});

async function login(
  user: string,
  pass: string,
  remember = false,
): Promise<Response> {
  const body = new URLSearchParams({ username: user, password: pass });
  if (remember) body.set("remember", "on");
  return fetch(`${BASE2}/api/login`, { method: "POST", body, redirect: "manual" });
}

describe("auth flow (user/pass mode)", () => {
  test("dashboard API rejects unauthenticated requests", async () => {
    const r = await fetch(`${BASE2}/api/summary?days=7`);
    expect(r.status).toBe(401);
  });

  test("wrong password → 401, rate limiter engages after 5", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login("admin", "wrongpass");
      expect(r.status).toBe(401);
    }
    const r = await login("admin", "wrongpass");
    expect(r.status).toBe(429);
  });

  test("valid login sets session cookie and API works", async () => {
    const r = await login("admin", "hunter2");
    expect(r.status).toBe(303);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("dash_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0]; // dash_session=…
    const api = await fetch(`${BASE2}/api/summary?days=7`, {
      headers: { cookie },
    });
    expect(api.status).toBe(200);
    const s = await api.json();
    expect(s.dbAvailable).toBe(true);
  });

  test("remember=on → long-lived cookie (Max-Age ≈ 30 days)", async () => {
    const r = await login("admin", "hunter2", true);
    const setCookie = r.headers.get("set-cookie") ?? "";
    const maxAge = Number(setCookie.match(/Max-Age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(86_400 * 25); // >25d
    expect(maxAge).toBeLessThanOrEqual(86_400 * 31);
  });

  test("no remember → session cookie (no Max-Age)", async () => {
    const r = await login("admin", "hunter2", false);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toMatch(/Max-Age=\d+/);
  });

  test("logout clears the cookie", async () => {
    const r = await fetch(`${BASE2}/api/logout`, {
      method: "POST",
      redirect: "manual",
    });
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/dash_session=;\s*Max-Age=0/);
  });

  test("legacy ?token= still gates when only TOKEN is set", async () => {
    // third spawn, port 35097, LITELLM_DASH_TOKEN=testtoken
    // (assert 401 without, 200 with ?token=testtoken)
  });
});
```

The third spawn (`TOKEN`-only mode) is the same pattern with its own port
(35097) and env; write it out the same way — the plan leaves the
implementation to the implementer following the `proc2` pattern.

Note: the rate-limit test can flake if run twice in the same bun test
process (the map persists in the same server process across tests) — the
"engages after 5" test above leaves the server's limiter in a blocked state;
put it **last** in the auth describe, or use a distinct IP by testing with a
different source… which the HTTP test can't fake. Accept the ordering
constraint: rate-limit test runs last, everything else before it.

Command + expected output:

```bash
bun test
# all pass: existing ~10 cases + new auth flow ~8 cases
```

Commit: `git commit -am "tests: auth flow integration (login/cookie/rate limit/logout/legacy token)"`

### Task 7 — Deploy (user-approved action)

```bash
bash scripts/deploy.sh
# expect: "== deploy ok", all 5 smoke checks pass with cookie auth
```

Requires the user to add `LITELLM_DASH_USER` / `LITELLM_DASH_PASSWORD`
(e.g. `systemctl --user edit --force litellm-dash` drop-in, or a `.env` in
the deploy dir) **before** deploying. This is a live external-facing change —
per standing user preference, lay out the exact env values and get approval
before touching the service. The user also picks the actual credentials; we
never put them in the repo.

## Tests / validation summary

- `bun test tests/auth.test.ts` — 9 unit tests (token round-trip, wrong
  secret, expired, tampered, garbage, safeEqual, sessionFromCookie,
  deriveKey stability, derived-key token verifies).
- `bun test` — full suite: legacy API tests + 3-spawn auth integration
  (unauthed 401, rate limit 429 after 5, valid login cookie shape,
  remember max-age window, no-remember session cookie, logout clears,
  token-only fallback).
- Live: `curl` through the Cloudflare tunnel hostname post-deploy —
  unauthenticated → 401 / login page appears in browser; valid login →
  dashboard renders and survives a browser restart within 30 days.
- Manual browser check: login with/without remember me; logout; reload page
  logged-in state persists.

## Risks / tradeoffs / open questions

- **Rate-limiter ordering in tests** — the 429 test leaves the in-memory
  limiter blocked for the test IP; subsequent auth tests on the same spawn
  would 429. Mitigation: it runs last in its describe; noted in Task 6.
- **`Bun.password.verify` ~330ms** — one login attempt costs one argon2id
  verify; fine at personal scale, deliberate tradeoff for the memory-hard
  resistance. Do not "optimize" it away.
- **Session-token revocation** — stateless tokens can't be individually
  revoked. Changing `LITELLM_DASH_PASSWORD` (or setting
  `LITELLM_DASH_SESSION_SECRET` to a new random value and restarting)
  invalidates all sessions at once. Acceptable for a single-user dashboard;
  documented in the README.
- **No CSRF token** — relies on SameSite=Lax + the only state-changing
  routes being login/logout POSTs. A cross-site form POST to `/api/login`
  can't carry the victim's cookie (Lax), and `/api/logout` clears a cookie
  the attacker can't set. Documented in README.
- **Secure flag on localhost** — the plan sets `Secure` only when
  `req.protocol` is https; over plain HTTP (LAN/localhost testing) the
  cookie is sent without `Secure`. Behind the tunnel (HTTPS) it's set. If
  you want it always-on regardless, set
  `LITELLM_DASH_COOKIE_SECURE=1` (out of scope unless you ask).
- **Open question:** should the login rate-limit also cap *successful*
  logins per IP (slow down credential stuffing that somehow has the right
  password)? Currently no — YAGNI for a household dashboard.
- **Open question:** multi-user support (`LITELLM_DASH_USERS=alice:pw,bob:pw`)
  — out of scope, single credential per the user's "not a complex auth
  system" framing.
- **`/_bun/*` client bundles are public** (pre-existing property of the
  HTML-import design; they contain only the public UI code). Gating them
  would require the two-page server-gate architecture the user declined.
