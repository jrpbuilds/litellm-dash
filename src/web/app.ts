/** Dashboard client — Cursor usage-page style. Polls /api/* every 10s. */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

const fmtTokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);

/** Browser-local log-table date format, e.g. "Oct 5, 06:54 PM". */
function fmtLogDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Stable hue for a provider name — chips self-color, no per-provider CSS. */
function providerHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function providerChip(p: string): string {
  const hue = providerHue(p);
  return `<span class="chip" style="color:hsl(${hue} 70% 75%);background:hsl(${hue} 60% 20% / 0.55);border-color:hsl(${hue} 60% 50% / 0.35)">${esc(p)}</span>`;
}
function fmtDur(ms: number | null): string {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 120) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/**
 * Latency traffic-light buckets. Tuned for LLM traffic (median ~25s): under
 * 10s is genuinely fast, 10-30s is the normal band, 30-60s is slow, over a
 * minute deserves attention.
 */
const LATENCY_TIERS: { maxMs: number | null; cls: string }[] = [
  { maxMs: 10_000, cls: "lat-good" },
  { maxMs: 30_000, cls: "lat-mid" },
  { maxMs: 60_000, cls: "lat-slow" },
  { maxMs: null, cls: "lat-bad" },
];

function latencyTier(ms: number | null): string {
  if (ms == null) return "";
  return (LATENCY_TIERS.find((t) => t.maxMs == null || ms < t.maxMs) ?? LATENCY_TIERS[LATENCY_TIERS.length - 1]).cls;
}

/**
 * Per-request duration with hover latency stats for its model (or provider).
 * The cell shows just the duration; hovering reveals the group's avg/p95/n
 * so the strip under the chart isn't needed.
 */
function latencyCell(ms: number | null, stats: LatencyResp | null, group: string): string {
  if (ms == null) return `<span class="mut">–</span>`;
  const cls = latencyTier(ms);
  if (!stats) return `<span class="${cls}">${fmtDur(ms)}</span>`;
  const row = stats.rows.find((r) => r.name === group);
  if (!row) return `<span class="${cls}">${fmtDur(ms)}</span>`;
  return `<span class="${cls} lat-tip" tabindex="0">${fmtDur(ms)}<span class="lat-pop">${esc(group)} · ${fmtDur(row.avgMs)} avg · ${fmtDur(row.p95Ms)} p95 · ${row.n} req</span></span>`;
}


// ---------------------------------------------------------------- api

/** GET JSON from the API. A 401 (session expired mid-poll) bounces to /login. */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 401) {
      if (location.pathname !== "/login") location.assign("/login");
      return null;
    }
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Single 10s refresh loop; started once from boot. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
function startPolling() {
  if (pollTimer != null) return;
  pollTimer = setInterval(refresh, 10_000);
}

// ---------------------------------------------------------------- types

type Summary = {
  dbAvailable: boolean;
  days: number;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
};

type ChartResp = {
  days: number;
  bucketType: "hour" | "day";
  group: "model" | "provider";
  /** Bucket keys for the whole window, oldest first (UTC hour or day). */
  buckets: string[];
  rows: { b: string; name: string; tokens: number }[];
};

type LatencyResp = {
  days: number;
  group: "model" | "provider";
  rows: { name: string; n: number; avgMs: number; p95Ms: number; maxMs: number }[];
};

type RecentRow = {
  id: number;
  ts: string;
  model: string;
  upstream_model?: string | null;
  provider?: string | null;
  call_type: string | null;
  stream: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  duration_ms: number | null;
  status: string;
  user_agent: string | null;
  requester_ip?: string | null;
  vision?: number | null;
  error?: string | null;
};

// ------------------------------------------------------------- page status

/**
 * The header dot reflects gateway health from the same poll that feeds the
 * page: green + pulse when live, amber when the log DB is missing, red when
 * the API is unreachable. Class + title kept in sync with the footer text.
 */
function setStatus(kind: "live" | "nodb" | "down"): void {
  const dot = $("statusdot");
  dot.className = `statusdot ${kind}`;
  dot.title =
    kind === "live"
      ? "Gateway healthy. Data is current."
      : kind === "nodb"
        ? "usage.db not found. Waiting for the first logged request."
        : "API unreachable.";
}

// ------------------------------------------------------------- stat cards

function renderCards(s: Summary) {
  const cards = [
    { label: "Total tokens", value: fmtTokens(s.tokens) },
    { label: "Input tokens", value: fmtTokens(s.promptTokens) },
    { label: "Output tokens", value: fmtTokens(s.completionTokens) },
    { label: "Requests", value: String(s.requests) },
  ];
  const fresh = cards
    .map(
      (c) =>
        `<div class="card statcard"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`,
    )
    .join("");
  const container = $("cards");
  // First paint OR a skeleton pass left placeholders in place → replace the
  // whole grid (the crossfade path below assumes real label/value nodes).
  const skel = container.querySelector(".skelbar");
  if (!container.childElementCount || skel) {
    container.innerHTML = fresh;
    return;
  }
  // Polls every 10s: crossfade values that actually changed — DOM must not
  // churn (re-rendering the whole grid resets hover states).
  const current = container.querySelectorAll<HTMLElement>(".statcard .value");
  if (current.length !== cards.length) {
    container.innerHTML = fresh;
    return;
  }
  cards.forEach((c, i) => {
    const el = current[i];
    if (el.textContent === c.value) return;
    el.classList.add("update");
    setTimeout(() => {
      el.textContent = c.value;
      el.classList.remove("update");
    }, 180);
  });
}

// ----------------------------------------------------------------- chart

const SERIES_COLORS = [
  "#3ecf8e", // green — first/biggest model gets Cursor's hero color
  "#7fb8ff",
  "#a78bfa",
  "#facc15",
  "#f97316",
  "#e879f9",
  "#22d3ee",
  "#a3e635",
  "#fb7185",
  "#94a3b8",
];

const periodState: { days: number; group: "model" | "provider" } = {
  days: 7,
  group: "model",
};

// Hour buckets are shown in local time. Day buckets are UTC calendar days, so
// they are formatted in UTC to keep the label on the right date.
const xLabel = (b: string, bucketType: "hour" | "day"): string =>
  bucketType === "hour"
    ? new Date(`${b}:00:00Z`).toLocaleString("en-US", { hour: "numeric" })
    : new Date(`${b}T00:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const fullDate = (b: string, bucketType: "hour" | "day"): string =>
  bucketType === "hour"
    ? new Date(`${b}:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric" })
    : new Date(`${b}T00:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

let lastChart: ChartResp | null = null;
let selectedBucket: number | null = null; // null = tooltip hidden

/** Solid + gradient variants for a series color. Model mode uses the fixed
 *  palette; provider mode derives from the same stable hue as the log chips,
 *  so a provider is the same color in the chart, legend, and log table. */
type SeriesColor = { line: string; fillTop: string; fillBottom: string };

function modelColor(i: number): SeriesColor {
  const hex = SERIES_COLORS[i % SERIES_COLORS.length];
  return { line: hex, fillTop: hex + "55", fillBottom: hex + "05" };
}

function providerColor(name: string): SeriesColor {
  const hue = providerHue(name);
  return {
    line: `hsl(${hue} 70% 65%)`,
    fillTop: `hsl(${hue} 70% 65% / 0.33)`,
    fillBottom: `hsl(${hue} 70% 65% / 0.03)`,
  };
}

function renderChart(c: ChartResp) {
  lastChart = c;
  updateCrosshair();
  const labels = c.buckets;
  if (selectedBucket !== null && selectedBucket > labels.length - 1) {
    selectedBucket = null;
  }
  const canvas = $<HTMLCanvasElement>("chart");
  // one series per group (model or provider); in provider mode colors match
  // the log-table chips so the same provider looks the same everywhere
  const names = [...new Set(c.rows.map((r) => r.name))];
  const totals = new Map<string, number>();
  for (const r of c.rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.tokens);
  names.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const colors = new Map(
    names.map((n, i) => [
      n,
      c.group === "provider" ? providerColor(n) : modelColor(i),
    ]),
  );

  const series = names.map((name) => ({
    name,
    color: colors.get(name)!.line,
    fillTop: colors.get(name)!.fillTop,
    fillBottom: colors.get(name)!.fillBottom,
    daily: labels.map((b) => {
      const hit = c.rows.find((r) => r.b === b && r.name === name);
      return hit ? hit.tokens : 0;
    }),
  }));

  // cumulative per model (Cursor's chart is cumulative)
  const cum = series.map((s) => {
    let acc = 0;
    return { ...s, points: s.daily.map((v) => (acc += v)) };
  });

  const cumTotal = labels.map((_, i) => cum.reduce((m, s) => m + s.points[i], 0));
  const max = Math.max(1, ...cumTotal);

  // draw
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padR = 6;
  const x = (i: number) =>
    labels.length === 1 ? w / 2 : (i / (labels.length - 1)) * (w - padR);
  const y = (v: number) => h - (v / max) * (h - 10);

  // stack cumulative areas bottom-up in reverse rank so the top series paints last
  for (let si = cum.length - 1; si >= 0; si--) {
    const s = cum[si];
    if (s.points.every((v) => v === 0)) continue;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, s.fillTop);
    grad.addColorStop(1, s.fillBottom);
    ctx.beginPath();
    ctx.moveTo(x(0), y(s.points[0]));
    s.points.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(s.points.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x(0), y(s.points[0]));
    s.points.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // axes + gridlines
  const ticks = niceTicks(max);
  $("yaxis").innerHTML = ticks
    .slice()
    .reverse()
    .map((t) => `<span>${t === 0 ? "0" : fmtTokens(t)}</span>`)
    .join("");
  const plotH = h;
  $("gridlines").innerHTML = ticks
    .map((t) => {
      const top = plotH - (t / max) * (plotH - 10);
      return `<div class="h" style="top:${top}px"></div>`;
    })
    .join("");
  const step = Math.ceil(labels.length / 7);
  $("xaxis").innerHTML = labels
    .map((b, i) =>
      i % step === 0 || i === labels.length - 1
        ? `<span>${xLabel(b, c.bucketType)}</span>`
        : "<span></span>",
    )
    .join("");

  // legend
  $("legend").innerHTML = series
    .map(
      (s) =>
        `<span class="item"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`,
    )
    .join("");

  // tooltip — only for the user-SELECTED bucket (click/hover), Cursor-style
  const tip = $("tooltip");
  if (selectedBucket === null) {
    tip.hidden = true;
    tip.innerHTML = "";
  } else {
    const last = selectedBucket;
    const dayRows = cum
      .map((s) => ({
        name: s.name,
        color: s.color,
        daily: s.daily[last],
      }))
      .filter((r) => r.daily > 0)
      .sort((a, b) => b.daily - a.daily);
    const dayTotal = dayRows.reduce((m, r) => m + r.daily, 0);
    const cumTotalLast = cumTotal[last];
    let tt = `<div class="t-date">${fullDate(labels[last], c.bucketType)}</div><div class="t-sub">Daily breakdown</div>`;
    if (dayTotal === 0) {
      tt += `<div class="t-row"><span class="m" style="color:var(--muted)">No usage</span></div>`;
    } else {
      for (const r of dayRows) {
        tt += `<div class="t-row"><span class="dot" style="background:${r.color}"></span><span class="m">${esc(r.name)}</span><span class="v">${fmtTokens(r.daily)}</span><span class="p">${((r.daily / dayTotal) * 100).toFixed(1)}%</span></div>`;
      }
    }
    tt += `<div class="t-total"><span>Daily total</span><span class="v">${dayTotal ? fmtTokens(dayTotal) : "–"}</span></div>`;
    tt += `<div class="t-total t-total-stack"><span>Cumulative total</span><span class="v">${cumTotalLast ? fmtTokens(cumTotalLast) : "–"}</span></div>`;
    tip.innerHTML = tt;
    tip.hidden = false;
  }
}

/** Position the hover crosshair under the current bucket selection. */
function updateCrosshair() {
  const plot = document.querySelector<HTMLElement>(".plot");
  let bar = plot?.querySelector<HTMLElement>(".crosshair");
  if (!plot) return;
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "crosshair";
    plot.appendChild(bar);
  }
  if (selectedBucket === null || !lastChart) {
    bar.style.opacity = "0";
    return;
  }
  const canvas = $<HTMLCanvasElement>("chart");
  const w = canvas.clientWidth;
  const padR = 6;
  const labels = lastChart.buckets;
  const x = labels.length === 1 ? w / 2 : (selectedBucket / (labels.length - 1)) * (w - padR);
  bar.style.left = `${x}px`;
  bar.style.opacity = "1";
}

/** Attach hover/click selection on the chart canvas. */
function wireChartHover() {
  const canvas = $<HTMLCanvasElement>("chart");
  if (!canvas) return; // login page has no chart
  const plot = canvas.parentElement as HTMLElement;

  const bucketAt = (clientX: number): number | null => {
    if (!lastChart) return null;
    const rect = canvas.getBoundingClientRect();
    const labels = lastChart.buckets;
    const padR = 6;
    const plotW = rect.width - padR;
    const rel = clientX - rect.left;
    if (rel < -12 || rel > plotW + 12) return null;
    const frac = labels.length === 1 ? 0.5 : Math.min(1, Math.max(0, rel / plotW));
    return Math.round(frac * (labels.length - 1));
  };

  const apply = (clientX: number) => {
    const b = bucketAt(clientX);
    selectedBucket = b;
    if (lastChart) renderChart(lastChart);
  };

  plot.addEventListener("mousemove", (e) => apply((e as MouseEvent).clientX));
  plot.addEventListener("mouseleave", () => {
    selectedBucket = null;
    if (lastChart) renderChart(lastChart);
  });
  plot.addEventListener("click", (e) => apply((e as MouseEvent).clientX));
  // touch support
  plot.addEventListener("touchstart", (e) => apply((e as TouchEvent).touches[0].clientX), {
    passive: true,
  });
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------- tables

type RecentResp = {
  rows: RecentRow[];
  hasMore: boolean;
};

const PAGE_SIZE = 50;
/** Which request row is expanded (mobile accordion — one at a time). */
let expandedId: number | null = null;
const recentState: {
  rows: RecentRow[];
  hasMore: boolean;
  loadingMore: boolean;
  failuresOnly: boolean;
  /** how many tail rows arrived in the last append (entry animation) */
  appendCount: number;
  latency: LatencyResp | null;
} = { rows: [], hasMore: false, loadingMore: false, failuresOnly: false, appendCount: 0, latency: null };

function renderRecent() {
  const head = `<thead><tr>
    <th>Date</th><th>Model</th><th class="num">Tokens</th><th class="num">Duration</th>
  </tr></thead>`;
  const body = recentState.rows
    .map((r, i) => {
      const type = r.call_type === "acompletion" || r.call_type === "completion" ? "chat" : r.call_type ?? "–";
      const tokens = r.total_tokens ?? r.prompt_tokens + r.completion_tokens;
      const failed = r.status !== "success";
      const group = periodState.group === "provider" ? (r.provider ?? "unknown") : r.model;
      const isAppended =
        recentState.appendCount > 0 && i >= recentState.rows.length - recentState.appendCount;
      const rowCls = `rowmain${failed ? " failed" : ""} tappable${isAppended ? " rowin" : ""}`;
      // Clicking a row expands a detail card with the full record: type,
      // token split, upstream, client and, for failures, the error text.
      const detailRow =
        expandedId === r.id
          ? `<tr class="mobilerow"><td colspan="4">${detailCard(r, type, tokens, group)}</td></tr>`
          : "";
      return `<tr class="${rowCls}" data-row="${r.id}" tabindex="0" role="button" aria-expanded="${expandedId === r.id ? "true" : "false"}">
      <td class="mut">${fmtLogDate(r.ts)}</td>
      <td class="name">${esc(r.model)}${r.vision ? `<span class="vision-icon" title="Used vision (image input)" aria-label="Used vision (image input)">👁</span>` : ""}${r.provider ? providerChip(r.provider) : ""}${failed ? `<span class="pill bad failpill">failed</span>` : ""}</td>
      <td class="num">${tokens ? fmtTokens(tokens) : "–"}</td>
      <td class="num">${latencyCell(r.duration_ms, recentState.latency, group)}</td>
    </tr>` + detailRow;
    })
    .join("");
  const emptyMsg = recentState.failuresOnly
    ? "No failed requests in the log. Everything succeeded."
    : "No requests logged yet. Traffic will show up here.";
  const foot =
    recentState.hasMore || recentState.loadingMore
      ? `<tfoot><tr><td colspan="4" class="loadmore"><button class="btn${recentState.loadingMore ? " loading" : ""}" id="loadmore"${recentState.loadingMore ? " disabled" : ""}>Load more</button></td></tr></tfoot>`
      : "";
  $("recent").innerHTML =
    head +
    `<tbody>${
      body || `<tr><td colspan="4" class="empty">${emptyMsg}</td></tr>`
    }</tbody>` +
    foot;
  recentState.appendCount = 0;
}

/** Friendly client name from the recorded user agent, falling back to the
 * UA product token when nothing better matches. */
const CLIENT_NAMES: { test: RegExp; name: string }[] = [
  { test: /^AsyncOpenAI\/Python|openai\/python/i, name: "OpenAI SDK (async)" },
  { test: /^OpenAI\/Python/i, name: "OpenAI SDK" },
  { test: /^Cursor/i, name: "Cursor" },
  { test: /aiohttp/i, name: "aiohttp client" },
  { test: /^curl/i, name: "curl" },
];
function clientName(ua: string | null): string {
  if (!ua) return "unknown client";
  const base = ua.split("(")[0].trim();
  const hit = CLIENT_NAMES.find((c) => c.test.test(base));
  return hit ? hit.name : base || "unknown client";
}

/** Full timestamp with seconds for the detail panel, e.g. "Oct 11, 06:02:14 AM". */
function fmtFullDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function kv(label: string, value: string, cls = ""): string {
  return `<div class="d-kv"><span class="d-key">${label}</span><span class="d-val ${cls}">${value}</span></div>`;
}

/** Token row with a bar sized by its share of the request total. */
function tokenRow(label: string, n: number, total: number, cls: string): string {
  const pct = total > 0 ? (n / total) * 100 : 0;
  return `<div class="d-kv d-tok"><span class="d-key">${label}</span><span class="d-val">${n ? fmtTokens(n) : "–"}</span><span class="d-bar ${cls}">${n ? `<i style="width:${pct.toFixed(1)}%"></i>` : ""}</span></div>`;
}

/**
 * Where this request sits against its group's avg and p95: a track scaled
 * to the larger of p95 and this duration, with tick marks for avg and p95.
 */
function timingScale(ms: number, row: LatencyResp["rows"][number]): string {
  const max = Math.max(row.p95Ms, ms) * 1.08 || 1;
  const at = (v: number) => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
  return `<div class="d-scale" aria-hidden="true">
    <span class="d-scale-fill ${latencyTier(ms)}" style="width:${at(ms)}"></span>
    <span class="d-tick" style="left:${at(row.avgMs)}" title="avg ${fmtDur(row.avgMs)}"></span>
    <span class="d-tick p95" style="left:${at(row.p95Ms)}" title="p95 ${fmtDur(row.p95Ms)}"></span>
  </div>`;
}

/**
 * Detail panel for an expanded request row, grouped as routing / tokens /
 * timing with the calling client underneath. Failures lead with the error.
 */
function detailCard(r: RecentRow, type: string, tokens: number, group: string): string {
  const failed = r.status !== "success";

  const kind = [type, r.stream ? "streamed" : "not streamed", r.vision ? "vision" : null]
    .filter(Boolean)
    .join(" · ");
  const provider = r.provider
    ? `<span class="d-provider" style="--h:${providerHue(r.provider)}">${esc(r.provider)}</span>`
    : `<span class="dim">unknown</span>`;
  const routing = [
    kv("Model", esc(r.model), "strong"),
    kv("Upstream", r.upstream_model ? esc(r.upstream_model) : `<span class="dim">–</span>`, "mono"),
    kv("Provider", provider),
    kv("Request", esc(kind)),
  ].join("");

  const tokenRows = [
    tokenRow("Input", r.prompt_tokens, tokens, "in"),
    tokenRow("Output", r.completion_tokens, tokens, "out"),
    kv("Total", tokens ? fmtTokens(tokens) : "–", "strong"),
  ].join("");

  const stats = recentState.latency?.rows.find((s) => s.name === group);
  const ms = r.duration_ms;
  let timing = kv("Duration", fmtDur(ms), `strong ${latencyTier(ms)}`);
  if (ms != null && stats && stats.n > 1) {
    const ratio = ms / stats.avgMs;
    const verdict = ms > stats.p95Ms ? "lat-bad" : ratio > 1.15 ? "lat-slow" : "lat-good";
    timing +=
      kv("vs avg", `<span class="${verdict}">${ratio.toFixed(1)}×</span> <span class="dim">${fmtDur(stats.avgMs)} avg · ${fmtDur(stats.p95Ms)} p95</span>`) +
      timingScale(ms, stats);
  }
  timing += kv("Logged", fmtFullDate(r.ts));

  const meta = [r.user_agent, r.requester_ip].filter(Boolean).map((s) => esc(s as string)).join(" · ");
  return `<div class="detailcard">
    ${failed ? `<div class="d-error"><span class="d-title">Error</span><pre class="errmsg">${esc(r.error ?? "no error text recorded")}</pre></div>` : ""}
    <div class="d-groups">
      <section class="d-group"><h4 class="d-title">Routing</h4>${routing}</section>
      <section class="d-group"><h4 class="d-title">Tokens</h4>${tokenRows}</section>
      <section class="d-group"><h4 class="d-title">Timing</h4>${timing}</section>
    </div>
    <div class="d-client">
      <span class="d-title">Client</span>
      <span class="d-client-name">${esc(clientName(r.user_agent))}</span>
      ${meta ? `<span class="d-meta">${meta}</span>` : ""}
    </div>
  </div>`;
}

/** Append the next PAGE_SIZE older requests below what's already shown. */
async function loadMore() {
  if (recentState.loadingMore || !recentState.hasMore) return;
  const lastId = recentState.rows[recentState.rows.length - 1]?.id;
  if (lastId == null) return;
  recentState.loadingMore = true;
  renderRecent();
  const resp = await getJson<RecentResp>(recentUrl(PAGE_SIZE, lastId));
  if (resp) {
    recentState.appendCount = resp.rows.length; // mark new rows for entry animation
    recentState.rows = [...recentState.rows, ...resp.rows];
    recentState.hasMore = resp.hasMore;
  }
  recentState.loadingMore = false;
  renderRecent();
}

/** Build a /api/recent URL honouring the current failures filter. */
function recentUrl(limit: number, beforeId?: number): string {
  const p = new URLSearchParams({ limit: String(limit) });
  if (beforeId != null) p.set("before_id", String(beforeId));
  if (recentState.failuresOnly) p.set("status", "failure");
  return `/api/recent?${p}`;
}

/** Switch between all-requests and failures-only views. */
function setFailuresOnly(on: boolean) {
  if (recentState.failuresOnly === on) return;
  recentState.failuresOnly = on;
  expandedId = null;
  document.querySelectorAll("#logfilter button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.filter === (on ? "failures" : "all"));
  });
  refreshLog();
}

async function refreshLog() {
  const resp = await getJson<RecentResp>(recentUrl(PAGE_SIZE));
  if (!resp) return;
  recentState.rows = resp.rows;
  recentState.hasMore = resp.hasMore;
  renderRecent();
}

/**
 * Fold a fresh page-1 fetch into the loaded log: prepend rows newer than what
 * we have (a poll caught new requests), replace wholesale if the log was
 * reset or pruned out from under us. Rows the user loaded stay put.
 */
function mergeRecent(fresh: RecentResp) {
  const maxId = recentState.rows[0]?.id ?? 0;
  if (
    maxId === 0 ||
    fresh.rows.length === 0 ||
    (fresh.rows[0]?.id ?? 0) < maxId
  ) {
    recentState.rows = fresh.rows;
    recentState.hasMore = fresh.hasMore;
    renderRecent();
    return;
  }
  const newer = fresh.rows.filter((r) => r.id > maxId);
  const changed = newer.length > 0 || (!fresh.hasMore && recentState.hasMore);
  if (newer.length) recentState.rows = [...newer, ...recentState.rows];
  if (!fresh.hasMore) recentState.hasMore = false;
  if (changed) renderRecent();
}

// ---------------------------------------------------------------- refresh

async function refresh() {
  const days = periodState.days;
  const chartCard = document.querySelector<HTMLElement>(".chartcard");
  if (chartCard && !lastChart) chartCard.classList.add("skel");
  const [s, c, lat, r] = await Promise.all([
    getJson<Summary>(`/api/summary?days=${days}`),
    getJson<ChartResp>(`/api/chart?days=${days}&group=${periodState.group}`),
    getJson<LatencyResp>(`/api/latency?days=${days}&group=${periodState.group}`),
    getJson<RecentResp>(recentUrl(PAGE_SIZE)),
  ]);
  if (s) renderCards(s);
  if (c) {
    renderChart(c);
    chartCard?.classList.remove("skel");
  }
  if (r) mergeRecent(r);
  // latency feeds the duration hovers — store it, then make sure any
  // already-rendered rows pick it up
  if (lat) {
    const firstLatency = recentState.latency == null;
    recentState.latency = lat;
    if (firstLatency) renderRecent();
  }
  $("export").setAttribute("href", `/api/export.csv?days=${days}`);
  $("updated").textContent = !s
    ? "API unreachable"
    : s.dbAvailable
      ? `Updated ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`
      : "usage.db not found. Waiting for the first logged request.";
  setStatus(!s ? "down" : s.dbAvailable ? "live" : "nodb");
}

function setDays(days: number) {
  periodState.days = days;
  selectedBucket = null; // new window — hide tooltip until re-selected
  document.querySelectorAll("#periods button").forEach((b) => {
    b.classList.toggle("active", Number((b as HTMLElement).dataset.days) === days);
  });
  refresh();
}

function setGroupUI(group: "model" | "provider") {
  const groupDD = $("groupdd");
  const groupMenu = $("groupdd-menu");
  if (!groupDD || !groupMenu) return;
  $("groupdd-value").textContent = group === "provider" ? "Provider" : "Model";
  groupMenu.querySelectorAll("button").forEach((b) => {
    const on = (b as HTMLElement).dataset.group === group;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
}

function setGroupDropdownOpen(open: boolean) {
  const groupDD = $("groupdd");
  const groupMenu = $("groupdd-menu");
  const groupby = $("groupby");
  if (!groupDD || !groupMenu) return;
  groupMenu.hidden = !open;
  groupDD.setAttribute("aria-expanded", String(open));
  groupby?.classList.toggle("open", open);
}

function setGroup(group: "model" | "provider") {
  if (periodState.group === group) return;
  periodState.group = group;
  setGroupUI(group);
  selectedBucket = null; // different series — hide tooltip until re-selected
  refresh();
}

document.querySelectorAll("#periods button").forEach((b) =>
  b.addEventListener("click", () => setDays(Number((b as HTMLElement).dataset.days))),
);
const groupDD = $("groupdd");
const groupMenu = $("groupdd-menu");
if (groupDD && groupMenu) {
  groupDD.addEventListener("click", (e) => {
    e.stopPropagation();
    setGroupDropdownOpen(groupMenu.hidden);
  });
  groupMenu.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setGroupDropdownOpen(false);
      setGroup((b as HTMLElement).dataset.group as "model" | "provider");
    }),
  );
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#groupby")) {
      setGroupDropdownOpen(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      setGroupDropdownOpen(false);
    }
  });
}
window.addEventListener("resize", () => lastChart && renderChart(lastChart));
wireChartHover();
/** Expand the row under `target` (accordion: opening one closes the other).
 * Returns false when the target isn't inside a request row. */
function toggleRow(target: HTMLElement): boolean {
  const el = target.closest<HTMLElement>("tr.rowmain.tappable");
  if (!el) return false;
  const id = Number(el.dataset.row);
  expandedId = expandedId === id ? null : id;
  renderRecent();
  return true;
}

// Delegated: the table body is re-rendered on every update.
const recentTable = $("recent");
if (recentTable) {
  recentTable.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#loadmore")) return void loadMore();
    toggleRow(t);
  });
  recentTable.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (toggleRow(e.target as HTMLElement)) e.preventDefault();
  });
}
document.querySelectorAll("#logfilter button").forEach((b) =>
  b.addEventListener("click", () =>
    setFailuresOnly((b as HTMLElement).dataset.filter === "failures"),
  ),
);

// ------------------------------------------------------- login / logout

const LOGIN_ERRORS: Record<number, string> = {
  401: "Invalid username or password.",
  429: "Too many attempts. Try again in 15 minutes.",
};

/** Submit the login form with fetch so errors render inline instead of as
 * raw JSON (the form still works natively without JS). */
function wireLoginForm(form: HTMLFormElement | null) {
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("loginmsg");
    msg.textContent = "";
    const body = new URLSearchParams(new FormData(form) as unknown as Record<string, string>);
    const r = await fetch("/api/login", { method: "POST", body }).catch(() => null);
    if (r?.ok) return location.assign("/");
    msg.textContent = (r && LOGIN_ERRORS[r.status]) ?? "Sign-in failed. Try again shortly.";
  });
}

function wireLogout(mode: string) {
  const btn = $("logoutbtn");
  if (!btn) return;
  // Without a login there is no session to end.
  btn.hidden = mode !== "login";
  btn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
    location.assign("/login");
  });
}

// ---------------------------------------------------------------- boot

/** Shimmer placeholders for the stat cards and log table until the first
 * fetch resolves. */
function showSkeletons() {
  $("cards").innerHTML = Array.from(
    { length: 4 },
    () => `<div class="card statcard skel"><div class="label skelbar"></div><div class="value skelbar wide"></div></div>`,
  ).join("");
  const cells = `<td class="mut"><div class="skelbar"></div></td>${`<td><div class="skelbar"></div></td>`.repeat(3)}`;
  $("recent").innerHTML = `<tbody>${`<tr class="skelrow">${cells}</tr>`.repeat(6)}</tbody>`;
}

/**
 * Both pages share this script. One probe of /api/session decides where the
 * visitor belongs: signed in on /login goes to the dashboard, signed out on
 * / goes to /login. Polling only starts once the dashboard is shown.
 */
async function boot() {
  const onLogin = location.pathname === "/login";
  const r = await fetch("/api/session", { cache: "no-store" }).catch(() => null);
  const session = r?.ok ? ((await r.json()) as { authenticated: boolean; mode: string }) : null;
  if (!session) {
    if (onLogin) wireLoginForm($<HTMLFormElement>("loginform"));
    else location.replace("/login");
    return;
  }
  if (onLogin) return location.replace("/");
  $("dashboard").hidden = false;
  showSkeletons();
  wireLogout(session.mode);
  await refresh();
  startPolling();
}

boot();

