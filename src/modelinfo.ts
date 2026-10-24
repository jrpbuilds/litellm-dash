/**
 * Live model catalog from the LiteLLM proxy. `/v1/models` is public and
 * lists every advertised alias; `/model/info` (master key) fills provider,
 * capabilities and price. Failure of any kind returns an empty list so the
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
  /** Public alias. `/model/info` uses model_name; `/v1/models` uses id. */
  model_name?: unknown;
  id?: unknown;
  litellm_params?: { model?: unknown; custom_llm_provider?: unknown };
  model_info?: Record<string, unknown>;
  max_model_len?: unknown;
  max_input_tokens?: unknown;
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
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

/**
 * Parses either a LiteLLM `/model/info` payload or an OpenAI `/v1/models`
 * list into the dashboard's model shape. `owned_by` is ignored: this gateway
 * labels every alias "openai", including ones that are not.
 */
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
    const name = typeof m.model_name === "string" ? m.model_name : typeof m.id === "string" ? m.id : null;
    if (!name) continue;
    const upstream = typeof m.litellm_params?.model === "string" ? m.litellm_params.model : null;
    const info = (m.model_info ?? {}) as Record<string, unknown>;
    const prefix = upstream?.split("/", 1)[0];
    const provider = typeof m.litellm_params?.custom_llm_provider === "string"
      ? m.litellm_params.custom_llm_provider
      : prefix || null;
    // Normalize Agnes providers to the single display name agnes-ai.
    const agnesUpstream = typeof upstream === "string" && upstream.includes("agnes");
    const agnesName = typeof name === "string" && name.toLowerCase().includes("agnes");
const displayProvider = (agnesUpstream || agnesName) ? "agnes-ai" : provider;
    out.push({
      name,
      provider: displayProvider,
      upstream,
      // max_model_len may live at top level or inside model_info depending on
      // LiteLLM version; max_input_tokens is the context when present.
      contextWindow:
        num(m.max_model_len) ?? num(m.max_input_tokens) ?? num(info.context_window) ?? num(info.max_model_len) ?? num(info.max_input_tokens),
      maxOutput:
        num(m.max_completion_tokens) ?? num(m.max_tokens) ?? num(m.max_output_tokens) ?? num(info.max_output) ?? num(info.max_output_tokens),
      mode: typeof m.mode === "string" ? m.mode : typeof info.mode === "string" ? info.mode : null,
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

/**
 * Origin of an http(s) proxy URL, or null. A bad scheme must not receive
 * the master key, and a trailing `/v1` is stripped so both catalog paths
 * are joined from the same root.
 */
export function proxyOrigin(proxyUrl: string): string | null {
  const trimmed = proxyUrl.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
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

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown | null> {
  const res = await fetchImpl(url, {
    headers,
    // A slow/unreachable proxy must not hold the dashboard request.
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** `/model/info` wins on shared fields; the public list fills anything it lacks. */
function mergeModel(info: ModelInfo | undefined, listed: ModelInfo | undefined): ModelInfo {
  const base = info ?? listed!;
  const other = info ? listed : undefined;
  if (!other) return base;
  return {
    ...base,
    contextWindow: base.contextWindow ?? other.contextWindow,
    maxOutput: base.maxOutput ?? other.maxOutput,
    mode: base.mode ?? other.mode,
  };
}

export function makeModelInfoFetcher(cfg: Config, fetchImpl: FetchLike = fetch): ModelInfoFetcher {
  const origin = proxyOrigin(cfg.proxyUrl);
  if (!origin) return async () => EMPTY;
  return cached(async () => {
    try {
      // The catalog is public. A failed list means we cannot tell which
      // names were removed, so the whole fetch degrades. The master key is
      // only sent to /model/info, and that failure does not hide the list.
      const listRaw = await getJson(fetchImpl, `${origin}/v1/models`, { accept: "application/json" });
      if (listRaw == null) return EMPTY;
      const listed = parseModels(listRaw);
      let detailed: ModelInfo[] = [];
      if (cfg.proxyToken) {
        const raw = await getJson(fetchImpl, `${origin}/model/info`, {
          accept: "application/json",
          authorization: `Bearer ${cfg.proxyToken}`,
        });
        if (raw) detailed = parseModels(raw);
      }
      const byName = new Map(detailed.map((m) => [m.name, m]));
      const seen = new Set<string>();
      const models: ModelInfo[] = [];
      for (const m of listed) {
        seen.add(m.name);
        models.push(mergeModel(byName.get(m.name), m));
      }
      for (const m of detailed) if (!seen.has(m.name)) models.push(m);
      // Image-generation models often have no token pricing from the proxy
      // (they bill per image, not per token). Inject explicit zero rates so
      // the dashboard shows $0.00 instead of an en dash.
      const IMAGE_MODEL_PRICING: Record<string, { inputCost: number; outputCost: number }> = {
        agnes_image_2_5_flash: { inputCost: 0, outputCost: 0 },
      };
      for (const m of models) {
        const key = m.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const pricing = IMAGE_MODEL_PRICING[key];
        if (pricing && m.inputCost == null && m.outputCost == null) {
          m.inputCost = pricing.inputCost;
          m.outputCost = pricing.outputCost;
        }
      }
      // Inject known capabilities for models whose upstream does not report them.
      const CAP_OVERRIDES: Record<string, { vision?: boolean; tools?: boolean; reasoning?: boolean }> = {
        agnes_3_0_flash: { vision: true, tools: true, reasoning: true },
      };
      for (const m of models) {
        const key = m.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const caps = CAP_OVERRIDES[key];
        if (!caps) continue;
        if (m.vision === false || m.vision === undefined) m.vision = !!caps.vision;
        if (m.tools === false || m.tools === undefined) m.tools = !!caps.tools;
        if (m.reasoning === false || m.reasoning === undefined) m.reasoning = !!caps.reasoning;
      }
      return { configured: true, models };
    } catch {
      return EMPTY;
    }
  });
}
