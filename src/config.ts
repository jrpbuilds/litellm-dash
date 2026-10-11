/** Runtime configuration. This is the only module that reads the environment. */

export type AuthMode = "open" | "token" | "login";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  production: boolean;
  /** Login user/password; login mode is on only when both are set. */
  user: string;
  password: string;
  /** "Remember me" cookie lifetime in days, clamped to 1..365. */
  sessionTtlDays: number;
  /** Explicit HMAC key; when empty one is derived from the password hash. */
  sessionSecret: string;
  /** Shared secret accepted as `?token=` or `Authorization: Bearer`. */
  token: string;
  /** Trust CF-Connecting-IP / X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 34998,
  dbPath: "./data/usage.db",
  sessionTtlDays: 30,
} as const;

function intInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function loadConfig(env: Env = Bun.env): Config {
  return {
    host: env.HOST || DEFAULTS.host,
    port: intInRange(env.PORT, 0, 65535, DEFAULTS.port),
    dbPath: env.LITELLM_DASH_DB || DEFAULTS.dbPath,
    production: env.NODE_ENV === "production",
    user: env.LITELLM_DASH_USER ?? "",
    password: env.LITELLM_DASH_PASSWORD ?? "",
    sessionTtlDays: intInRange(env.LITELLM_DASH_SESSION_TTL_DAYS, 1, 365, DEFAULTS.sessionTtlDays),
    sessionSecret: env.LITELLM_DASH_SESSION_SECRET ?? "",
    token: env.LITELLM_DASH_TOKEN ?? "",
    trustProxy: truthy(env.LITELLM_DASH_TRUST_PROXY),
  };
}

export function authMode(cfg: Config): AuthMode {
  if (cfg.user && cfg.password) return "login";
  if (cfg.token) return "token";
  return "open";
}

/** Human-readable problems worth logging at startup. */
export function configWarnings(cfg: Config): string[] {
  const out: string[] = [];
  if (!!cfg.user !== !!cfg.password) {
    out.push("LITELLM_DASH_USER and LITELLM_DASH_PASSWORD must both be set to enable login; ignoring them");
  }
  if (authMode(cfg) === "open" && !["127.0.0.1", "localhost", "::1"].includes(cfg.host)) {
    out.push(`no authentication configured and listening on ${cfg.host}; anyone on the network can view usage`);
  }
  return out;
}
