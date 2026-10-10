import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  deriveKey,
  safeEqual,
  sessionFromCookie,
  verifySessionToken,
} from "../src/auth";

describe("session tokens", () => {
  const secret = "a".repeat(64);

  test("round-trips a valid token", async () => {
    const tok = await createSessionToken(1000, secret);
    expect(await verifySessionToken(tok, secret)).toBe(true);
  });

  test("rejects a different secret", async () => {
    const tok = await createSessionToken(1000, secret);
    expect(await verifySessionToken(tok, "b".repeat(64))).toBe(false);
  });

  test("rejects an expired token", async () => {
    const tok = await createSessionToken(-1, secret); // expired at mint
    expect(await verifySessionToken(tok, secret)).toBe(false);
  });

  test("rejects a tampered expiry", async () => {
    const tok = await createSessionToken(1000, secret);
    const parts = tok.split(".");
    parts[1] = String(Number(parts[1]) + 60_000);
    expect(await verifySessionToken(parts.join("."), secret)).toBe(false);
  });

  test("rejects garbage", async () => {
    for (const bad of ["", "x", "1.2", "1.2.3", "1.2." + "g".repeat(64)]) {
      expect(await verifySessionToken(bad, secret)).toBe(false);
    }
  });

  test("safeEqual is exact", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("sessionFromCookie finds dash_session among others", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "other=1; dash_session=abc.def; more=2" },
    });
    expect(sessionFromCookie(req)).toBe("abc.def");
    expect(sessionFromCookie(new Request("https://x/"))).toBe("");
  });
});

describe("deriveKey", () => {
  test("stable, 64 hex chars, distinct per input", async () => {
    const a = await deriveKey("s1");
    expect(a).toBe(await deriveKey("s1"));
    expect(a).not.toBe(await deriveKey("s2"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("tokens signed with a derived key verify", async () => {
    const secret = await deriveKey("some password hash");
    const tok = await createSessionToken(1000, secret);
    expect(await verifySessionToken(tok, secret)).toBe(true);
  });
});
