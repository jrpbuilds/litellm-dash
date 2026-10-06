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

/** Explicit hues per provider; unknown providers fall back to a stable hash. */
const PROVIDER_HUES: Record<string, number> = {
  openference: 225, // brand cornflower blue (#7D94DA)
  "opencode-go": 150, // green
};

/** Stable hue for a provider name — chips self-color, no per-provider CSS. */
function providerHue(name: string): number {
  if (name in PROVIDER_HUES) return PROVIDER_HUES[name];
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


async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
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
  now: string;
  rows: { b: string; name: string; tokens: number }[];
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
};

// ------------------------------------------------------------- stat cards

function renderCards(s: Summary) {
  const cards = [
    { label: "Total tokens", value: fmtTokens(s.tokens) },
    { label: "Input tokens", value: fmtTokens(s.promptTokens) },
    { label: "Output tokens", value: fmtTokens(s.completionTokens) },
    { label: "Requests", value: String(s.requests) },
  ];
  $("cards").innerHTML = cards
    .map(
      (c) =>
        `<div class="card statcard"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`,
    )
    .join("");
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

function bucketLabels(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  if (days === 1) {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3_600_000);
      out.push(d.toISOString().slice(0, 13));
    }
  } else {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

const xLabel = (b: string, bucketType: "hour" | "day"): string => {
  if (bucketType === "hour") {
    const d = new Date(`${b}:00:00Z`);
    return d.toLocaleString("en-US", { hour: "numeric" });
  }
  const d = new Date(`${b}T00:00:00Z`);
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
};

const fullDate = (b: string, bucketType: "hour" | "day"): string => {
  const d =
    bucketType === "hour"
      ? new Date(`${b}:00:00Z`)
      : new Date(`${b}T00:00:00Z`);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(bucketType === "hour"
      ? ({ hour: "numeric" } as const)
      : ({} as const)),
  });
};

let lastChart: ChartResp | null = null;
let selectedBucket: number | null = null; // null = tooltip hidden

function renderChart(c: ChartResp) {
  lastChart = c;
  const labels = bucketLabels(c.days);
  if (selectedBucket !== null && selectedBucket > labels.length - 1) {
    selectedBucket = null;
  }
  const canvas = $<HTMLCanvasElement>("chart");
  // one series per model — totals across providers (per-provider split stays
  // in the log table chips and the tooltip)
  const names = [...new Set(c.rows.map((r) => r.name))];
  const totals = new Map<string, number>();
  for (const r of c.rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.tokens);
  names.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const colors = new Map(names.map((n, i) => [n, SERIES_COLORS[i % SERIES_COLORS.length]]));

  const series = names.map((name) => ({
    name,
    color: colors.get(name)!,
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

  // stack cumulative areas bottom-up in reverse rank so green paints last
  for (let si = cum.length - 1; si >= 0; si--) {
    const s = cum[si];
    if (s.points.every((v) => v === 0)) continue;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, s.color + "55");
    grad.addColorStop(1, s.color + "05");
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
    tt += `<div class="t-total" style="border-top:0;margin-top:2px;padding-top:2px"><span>Cumulative total</span><span class="v">${cumTotalLast ? fmtTokens(cumTotalLast) : "–"}</span></div>`;
    tip.innerHTML = tt;
    tip.hidden = false;
  }
}

/** Attach hover/click selection on the chart canvas. */
function wireChartHover() {
  const canvas = $<HTMLCanvasElement>("chart");
  const plot = canvas.parentElement as HTMLElement;

  const bucketAt = (clientX: number): number | null => {
    if (!lastChart) return null;
    const rect = canvas.getBoundingClientRect();
    const labels = bucketLabels(lastChart.days);
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
const recentState: { rows: RecentRow[]; hasMore: boolean; loadingMore: boolean } =
  { rows: [], hasMore: false, loadingMore: false };

function renderRecent() {
  const head = `<thead><tr>
    <th>Date</th><th>Type</th><th>Model</th>
    <th class="num">Tokens</th><th class="num">Input</th><th class="num">Output</th>
    <th class="num">Duration</th>
  </tr></thead>`;
  const body = recentState.rows
    .map((r) => {
      const type = r.call_type === "acompletion" || r.call_type === "completion" ? "chat" : r.call_type ?? "—";
      const typePill = r.stream ? "chat · stream" : type;
      const tokens = r.total_tokens ?? r.prompt_tokens + r.completion_tokens;
      return `<tr>
      <td class="mut">${fmtLogDate(r.ts)}</td>
      <td><span class="pill ${r.status === "success" ? "dim" : "bad"}">${esc(typePill)}</span></td>
      <td class="name">${esc(r.model)}${r.provider ? providerChip(r.provider) : ""}</td>
      <td class="num">${tokens ? fmtTokens(tokens) : "–"}</td>
      <td class="num mut">${r.prompt_tokens ? fmtTokens(r.prompt_tokens) : "–"}</td>
      <td class="num mut">${r.completion_tokens ? fmtTokens(r.completion_tokens) : "–"}</td>
      <td class="num mut">${fmtDur(r.duration_ms)}</td>
    </tr>`;
    })
    .join("");
  const foot =
    recentState.hasMore || recentState.loadingMore
      ? `<tfoot><tr><td colspan="7" class="loadmore"><button class="btn" id="loadmore"${recentState.loadingMore ? " disabled" : ""}>${recentState.loadingMore ? "Loading…" : "Load more"}</button></td></tr></tfoot>`
      : "";
  $("recent").innerHTML =
    head +
    `<tbody>${
      body ||
      `<tr><td colspan="7" class="empty">No requests logged yet — traffic will show up here.</td></tr>`
    }</tbody>` +
    foot;
}

/** Append the next PAGE_SIZE older requests below what's already shown. */
async function loadMore() {
  if (recentState.loadingMore || !recentState.hasMore) return;
  const lastId = recentState.rows[recentState.rows.length - 1]?.id;
  if (lastId == null) return;
  recentState.loadingMore = true;
  renderRecent();
  const resp = await getJson<RecentResp>(
    `/api/recent?limit=${PAGE_SIZE}&before_id=${lastId}`,
  );
  if (resp) {
    recentState.rows = [...recentState.rows, ...resp.rows];
    recentState.hasMore = resp.hasMore;
  }
  recentState.loadingMore = false;
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
  const [s, c, r] = await Promise.all([
    getJson<Summary>(`/api/summary?days=${days}`),
    getJson<ChartResp>(`/api/chart?days=${days}&group=${periodState.group}`),
    getJson<RecentResp>(`/api/recent?limit=${PAGE_SIZE}`),
  ]);
  if (s) renderCards(s);
  if (c) renderChart(c);
  if (r) mergeRecent(r);
  $("export").setAttribute("href", `/api/export.csv?days=${days}`);
  $("updated").textContent = !s
    ? "api unreachable"
    : s.dbAvailable
      ? `updated ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`
      : "usage.db not found — waiting for the first logged request";
}

function setDays(days: number) {
  periodState.days = days;
  selectedBucket = null; // new window — hide tooltip until re-selected
  document.querySelectorAll("#periods button").forEach((b) => {
    b.classList.toggle("active", Number((b as HTMLElement).dataset.days) === days);
  });
  refresh();
}

function setGroup(group: "model" | "provider") {
  if (periodState.group === group) return;
  periodState.group = group;
  selectedBucket = null; // different series — hide tooltip until re-selected
  document.querySelectorAll("#groupby button").forEach((b) => {
    b.classList.toggle(
      "active",
      (b as HTMLElement).dataset.group === group,
    );
  });
  refresh();
}

document.querySelectorAll("#periods button").forEach((b) =>
  b.addEventListener("click", () => setDays(Number((b as HTMLElement).dataset.days))),
);
document.querySelectorAll("#groupby button").forEach((b) =>
  b.addEventListener("click", () =>
    setGroup((b as HTMLElement).dataset.group as "model" | "provider"),
  ),
);
window.addEventListener("resize", () => lastChart && renderChart(lastChart));
wireChartHover();
// delegation — the button is re-rendered whenever the table updates
$("recent").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#loadmore")) loadMore();
});

refresh();
setInterval(refresh, 10_000);
