import { describe, expect, test } from "bun:test";
import { createSessionToken, deriveKey, RateLimiter, safeEqual, verifySessionToken } from "../src/auth";

const SECRET = deriveKey("some-password-hash");
const NOW = 1_800_000_000_000;

describe("session tokens", () => {
  test("round-trip with the same secret", () => {
    const tok = createSessionToken(60_000, SECRET, NOW);
    expect(tok).toMatch(/^1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifySessionToken(tok, SECRET, NOW)).toBe(true);
  });

  test("rejects a different secret", () => {
    const tok = createSessionToken(60_000, SECRET, NOW);
    expect(verifySessionToken(tok, deriveKey("other"), NOW)).toBe(false);
  });

  test("rejects once expired", () => {
    const tok = createSessionToken(60_000, SECRET, NOW);
    expect(verifySessionToken(tok, SECRET, NOW + 60_000)).toBe(true);
    expect(verifySessionToken(tok, SECRET, NOW + 60_001)).toBe(false);
  });

  test("rejects a tampered expiry", () => {
    const [v, exp, sig] = createSessionToken(60_000, SECRET, NOW).split(".");
    expect(verifySessionToken(`${v}.${Number(exp) + 1e9}.${sig}`, SECRET, NOW)).toBe(false);
  });

  test.each(["", "garbage", "1.2.3", "1.abc.def", `2.${NOW}.${"a".repeat(43)}`])(
    "rejects malformed token %p",
    (tok) => expect(verifySessionToken(tok, SECRET, NOW)).toBe(false),
  );
});

describe("safeEqual", () => {
  test("exact match only, any lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("deriveKey", () => {
  test("stable 64-char hex, distinct per input", () => {
    expect(deriveKey("a")).toBe(deriveKey("a"));
    expect(deriveKey("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveKey("a")).not.toBe(deriveKey("b"));
  });
});

describe("RateLimiter", () => {
  test("blocks after max failures within the window, then cools down", () => {
    let now = 0;
    const rl = new RateLimiter(3, 1000, () => now);
    rl.fail("ip");
    rl.fail("ip");
    expect(rl.blocked("ip")).toBe(false);
    rl.fail("ip");
    expect(rl.blocked("ip")).toBe(true);
    expect(rl.blocked("other")).toBe(false);
    now = 1001;
    expect(rl.blocked("ip")).toBe(false);
  });

  test("reset clears a key", () => {
    const rl = new RateLimiter(1, 1000, () => 0);
    rl.fail("ip");
    expect(rl.blocked("ip")).toBe(true);
    rl.reset("ip");
    expect(rl.blocked("ip")).toBe(false);
  });

  test("expired entries are pruned on the next failure", () => {
    let now = 0;
    const rl = new RateLimiter(5, 1000, () => now);
    for (let i = 0; i < 10; i++) rl.fail(`ip${i}`);
    expect(rl.size).toBe(10);
    now = 2000;
    rl.fail("fresh");
    expect(rl.size).toBe(1);
  });
});
