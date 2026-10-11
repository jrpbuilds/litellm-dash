import { describe, expect, test } from "bun:test";
import { authMode, configWarnings, DEFAULTS, loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("defaults with an empty environment", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      host: DEFAULTS.host,
      port: DEFAULTS.port,
      dbPath: DEFAULTS.dbPath,
      production: false,
      sessionTtlDays: 30,
      trustProxy: false,
    });
    expect(authMode(cfg)).toBe("open");
  });

  test("reads every variable", () => {
    const cfg = loadConfig({
      HOST: "0.0.0.0",
      PORT: "8080",
      LITELLM_DASH_DB: "/x/usage.db",
      NODE_ENV: "production",
      LITELLM_DASH_USER: "u",
      LITELLM_DASH_PASSWORD: "p",
      LITELLM_DASH_SESSION_TTL_DAYS: "7",
      LITELLM_DASH_SESSION_SECRET: "s",
      LITELLM_DASH_TOKEN: "t",
      LITELLM_DASH_TRUST_PROXY: "true",
    });
    expect(cfg).toEqual({
      host: "0.0.0.0",
      port: 8080,
      dbPath: "/x/usage.db",
      production: true,
      user: "u",
      password: "p",
      sessionTtlDays: 7,
      sessionSecret: "s",
      token: "t",
      trustProxy: true,
    });
  });

  test.each([["0"], ["366"], ["1.5"], ["abc"], [""]])("TTL %p falls back to the default", (v) => {
    expect(loadConfig({ LITELLM_DASH_SESSION_TTL_DAYS: v }).sessionTtlDays).toBe(30);
  });

  test("invalid port falls back to the default", () => {
    expect(loadConfig({ PORT: "99999" }).port).toBe(DEFAULTS.port);
  });
});

describe("authMode", () => {
  test.each([
    ["nothing set", {}, "open"],
    ["token only", { LITELLM_DASH_TOKEN: "t" }, "token"],
    ["user + password", { LITELLM_DASH_USER: "u", LITELLM_DASH_PASSWORD: "p" }, "login"],
    ["user + password + token", { LITELLM_DASH_USER: "u", LITELLM_DASH_PASSWORD: "p", LITELLM_DASH_TOKEN: "t" }, "login"],
    ["user without password", { LITELLM_DASH_USER: "u" }, "open"],
  ] as const)("%s -> %s", (_label, env, mode) => {
    expect(authMode(loadConfig(env))).toBe(mode);
  });
});

describe("configWarnings", () => {
  test("half-configured login", () => {
    expect(configWarnings(loadConfig({ LITELLM_DASH_USER: "u" }))).toHaveLength(1);
  });

  test("open mode on a public interface", () => {
    expect(configWarnings(loadConfig({ HOST: "0.0.0.0" }))[0]).toContain("no authentication");
    expect(configWarnings(loadConfig({ HOST: "0.0.0.0", LITELLM_DASH_TOKEN: "t" }))).toEqual([]);
    expect(configWarnings(loadConfig({}))).toEqual([]);
  });
});
