/**
 * Stateless session tokens and login rate limiting.
 *
 * Token format: "1.<expiry_ms>.<base64url HMAC-SHA256 of '1.<expiry_ms>'>".
 * There is no revocation list; rotating the secret (or the password it is
 * derived from) invalidates every issued token.
 */
import { timingSafeEqual } from "node:crypto";

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest();

/** Constant-time string equality. Both sides are hashed first so the
 * comparison never leaks the length of the secret. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sign(payload: string, secret: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(payload).digest("base64url");
}

/** 64 hex chars derived from any secret string, usable as an HMAC key. */
export function deriveKey(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

export function createSessionToken(ttlMs: number, secret: string, now = Date.now()): string {
  const payload = `1.${now + ttlMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * True only for a well-formed, correctly signed, unexpired token.
 * The MAC is checked before expiry so a forged timestamp is not
 * distinguishable from a bad signature without the key.
 */
export function verifySessionToken(token: string, secret: string, now = Date.now()): boolean {
  const m = /^(1\.(\d{1,16}))\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const [, payload, expiry, sig] = m;
  if (!safeEqual(sign(payload!, secret), sig!)) return false;
  return now <= Number(expiry);
}

/** Fixed-window failure counter per key (client IP). */
export class RateLimiter {
  private hits = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const e = this.hits.get(key);
    if (!e) return false;
    if (this.now() > e.until) {
      this.hits.delete(key);
      return false;
    }
    return e.n >= this.max;
  }

  fail(key: string): void {
    const now = this.now();
    this.prune(now);
    const e = this.hits.get(key);
    if (!e || now > e.until) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else e.n += 1;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private prune(now: number): void {
    for (const [k, e] of this.hits) if (now > e.until) this.hits.delete(k);
  }
}
