import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RateLimiter } from "../src/auth";
import { loadConfig, type Config } from "../src/config";
import { UsageDb } from "../src/db";
import { createServer } from "../src/server";

/** The schema exactly as the Python callback creates it. */
const SCHEMA = (() => {
  const src = readFileSync(join(import.meta.dir, "../litellm-callback/usage_logger.py"), "utf8");
  const m = /^SCHEMA = """([\s\S]*?)"""/m.exec(src);
  if (!m) throw new Error("SCHEMA not found in usage_logger.py");
  return m[1]!;
})();

export interface SeedRow {
  ts: string;
  model?: string | null;
  provider?: string | null;
  upstream_model?: string | null;
  call_type?: string;
  stream?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_ms?: number | null;
  status?: "success" | "failure";
  user_agent?: string | null;
  requester_ip?: string | null;
  error?: string | null;
  vision?: number;
}

/** A throwaway usage DB on disk (the dashboard opens it read-only by path). */
export function tempUsageDb() {
  const dir = mkdtempSync(join(tmpdir(), "litellm-dash-test-"));
  const path = join(dir, "usage.db");
  const writer = new Database(path, { create: true });
  writer.exec(SCHEMA);
  const reader = new UsageDb(path);

  const insert = writer.prepare(
    `INSERT INTO requests (ts, model, model_group, upstream_model, provider, call_type, stream,
       prompt_tokens, completion_tokens, total_tokens, duration_ms, status, user_agent,
       requester_ip, error, vision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    path,
    db: reader,
    seed(...rows: SeedRow[]) {
      for (const r of rows) {
        const prompt = r.prompt_tokens ?? 0;
        const completion = r.completion_tokens ?? 0;
        insert.run(
          r.ts,
          r.model ?? "model-a",
          r.model ?? "model-a",
          r.upstream_model ?? null,
          r.provider ?? null,
          r.call_type ?? "acompletion",
          r.stream ?? 0,
          prompt,
          completion,
          r.total_tokens ?? prompt + completion,
          r.duration_ms === undefined ? 1000 : r.duration_ms,
          r.status ?? "success",
          r.user_agent ?? null,
          r.requester_ip ?? null,
          r.error ?? null,
          r.vision ?? 0,
        );
      }
    },
    cleanup() {
      reader.close();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}), production: true, ...overrides };
}

/** Start an isolated server on a random port. */
export async function startServer(cfg: Config, deps: { db?: UsageDb; limiter?: RateLimiter } = {}) {
  const server = Bun.serve({ ...(await createServer(cfg, deps)), hostname: "127.0.0.1", port: 0 });
  const url = (path: string) => new URL(path, server.url).toString();
  return {
    server,
    url,
    get: (path: string, init?: RequestInit) => fetch(url(path), { redirect: "manual", ...init }),
    stop: () => server.stop(true),
  };
}

/** Format a millisecond timestamp the way the callback stores it. */
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
