/**
 * Stateless session tokens for the dashboard: "<v>.<exp_ms>.<hmac>" where the
 * HMAC-SHA256 signature covers "v.exp" and the key is a derived session
 * secret. No DB, no revocation list — the secret is derived from the login
 * password's argon2id hash, so changing the password invalidates all tokens.
 */

const enc = new TextEncoder();

/** Timing-safe byte equality, compared over the longer of the two lengths
 * so neither content nor length leaks through timing. */
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
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Mint a token that stays valid for `ttlMs` from now. */
export async function createSessionToken(
  ttlMs: number,
  secret: string,
): Promise<string> {
  const payload = `1.${Date.now() + ttlMs}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** True only for a well-formed, correctly signed, unexpired token. */
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
  if (Date.now() > Number(payload.split(".")[1])) return false;
  return safeEqual(await sign(payload, secret), sig);
}

/** Value of the `dash_session` cookie from a Request, or "". */
export function sessionFromCookie(req: Request): string {
  const m = req.headers.get("cookie")?.match(/dash_session=([^\s;]+)/);
  return m?.[1] ?? "";
}

/** Cookie-safe token form: "<payload>.<base64url-hmac>". */
export function encodeToken(token: string): string {
  const i = token.lastIndexOf(".");
  if (i < 0) return token;
  const sig = Buffer.from(token.slice(i + 1), "hex").toString("base64url");
  return `${token.slice(0, i)}.${sig}`;
}

/** Inverse of encodeToken (back to "<payload>.<hex-hmac>"). */
export function decodeToken(cookieVal: string): string {
  const i = cookieVal.lastIndexOf(".");
  if (i < 0) return cookieVal;
  const sig = Buffer.from(cookieVal.slice(i + 1), "base64url").toString("hex");
  return `${cookieVal.slice(0, i)}.${sig}`;
}

/** SHA-256 of a string as 64 hex chars — turns a variable-length secret
 * (the argon2id password hash) into a stable 32-byte HMAC key. */
export async function deriveKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
