/**
 * Live model metadata from the LiteLLM proxy's /model/info, with a small
 * in-memory cache. Failure of any kind returns an empty list so the
 * dashboard keeps working without the proxy reachable.
 */
import type { Config } from "./config";

export interface ModelInfo {
  /** Public model alias clients request, e.g. "glm-5.3-flash". */
  name: string;
  /** Provider prefix of the upstream, e.g. "openai" from "openai/glm-5.3". */
  provider: string | null;
  /** Full litellm model string, e.g. "openai/glm-5.3-flash". */
  upstream: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  mode: string | null;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** USD per million tokens, when the proxy exposes pricing. */
  inputCost: number | null;
  outputCost: number | null;
}

interface RawModel {
  model_name?: unknown;
  litellm_params?: { model?: unknown; custom_llm_provider?: unknown };
  model_info?: Record<string, unknown>;
  max_model_len?: unknown;
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  mode?: unknown;
  supports_function_calls?: unknown;
  supports_parallel_function_calling?: unknown;
  supports_vision?: unknown;
  supports_reasoning?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

/** Parses a LiteLLM /model/info payload into the dashboard's model shape. */
function modelList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  // LiteLLM wraps the list as { data: [...] }.
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: unknown[] }).data;
  }
  return null;
}

export function parseModels(raw: unknown): ModelInfo[] {
  const list = modelList(raw);
  if (!list) return [];
  const out: ModelInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as RawModel;
    const name = typeof m.model_name === "string" ? m.model_name : null;
    if (!name) continue;
    const upstream = typeof m.litellm_params?.model === "string" ? m.litellm_params.model : null;
    const info = (m.model_info ?? {}) as Record<string, unknown>;
    const prefix = upstream?.split("/", 1)[0];
    const provider = typeof m.litellm_params?.custom_llm_provider === "string"
      ? m.litellm_params.custom_llm_provider
      : prefix || null;
    out.push({
      name,
      provider,
      upstream,
      // max_model_len may live at top level or inside model_info depending on
      // LiteLLM version; max_input_tokens is the context when present.
      contextWindow: num(m.max_model_len) ?? num(info.max_model_len) ?? num(info.max_input_tokens),
      maxOutput: num(m.max_completion_tokens) ?? num(m.max_tokens) ?? num(info.max_output_tokens),
      mode: typeof m.mode === "string" ? m.mode : null,
      vision: bool(m.supports_vision ?? info.supports_vision) || bool(info.supports_image_input),
      tools: bool(m.supports_function_calls) || bool(m.supports_parallel_function_calling),
      reasoning: bool(m.supports_reasoning) || bool(info.supports_reasoning),
      inputCost: num(m.input_cost_per_token) ?? num(info.input_cost_per_token),
      outputCost: num(m.output_cost_per_token) ?? num(info.output_cost_per_token),
    });
  }
  return out;
}

/**
 * `configured` is true only when a proxy URL is set and the last fetch
 * succeeded, including a successful empty list. Failure and "unset" are both
 * `configured: false` so the client can say the gateway is not available.
 */
export interface ModelInfoResult {
  configured: boolean;
  models: ModelInfo[];
}

export interface ModelInfoFetcher {
  (): Promise<ModelInfoResult>;
}

/** Injected in tests so the production fetcher can be exercised without HTTP. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CACHE_MS = 60_000;
const EMPTY: ModelInfoResult = { configured: false, models: [] };

/** Only http(s) URLs are fetched, so a typo cannot send the master key elsewhere. */
export function proxyInfoUrl(proxyUrl: string): string | null {
  const trimmed = proxyUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}/model/info`;
  } catch {
    return null;
  }
}

function cached(load: () => Promise<ModelInfoResult>): ModelInfoFetcher {
  let hit: { at: number; result: ModelInfoResult } | null = null;
  return async () => {
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = await load();
    // Failures are not cached, so the next request retries.
    if (result.configured) hit = { at: Date.now(), result };
    else hit = null;
    return result;
  };
}

export function makeModelInfoFetcher(cfg: Config, fetchImpl: FetchLike = fetch): ModelInfoFetcher {
  const url = proxyInfoUrl(cfg.proxyUrl);
  if (!url) return async () => EMPTY;
  return cached(async () => {
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (cfg.proxyToken) headers.authorization = `Bearer ${cfg.proxyToken}`;
      const res = await fetchImpl(url, {
        headers,
        // A slow/unreachable proxy must not hold the dashboard request.
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return EMPTY;
      return { configured: true, models: parseModels(await res.json()) };
    } catch {
      return EMPTY;
    }
  });
}
