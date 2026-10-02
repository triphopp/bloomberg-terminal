"use client";

/**
 * PORT → RISK → MONTE CARLO: the book exactly as it is held, run forward over
 * thousands of paths — nothing bought, nothing sold.
 *
 * Scope follows the account selector: ALL = every account as one book (the
 * holdings of different accounts move together as they really did); an account
 * = that account's holdings and cash only.
 *
 * Reads, in the order a person asks: where does it end (median, 90% range),
 * how likely is a loss, how bad is the worst 5%, how deep does it dip on the
 * way, and which holdings carry that worst 5%.
 *
 * Model (filtered historical simulation), path-count and speed notes:
 * backend/port_mc.py. Endpoint: GET /api/v2/portfolio/risk/monte-carlo.
 * Palette: the WHAT-IF pair (validated) — blue = the distribution, amber = its
 * worst 5%; dark #3b8fd9 / #c77700, light #2a7bc4 / #b86e00.
 */

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import { LazyResponsiveContainer as ResponsiveContainer } from "../../../ui/LazyResponsiveContainer";
import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";
import { Shell } from "./WhatIfSimPanel";

// ── types ────────────────────────────────────────────────────────────────────

interface McHolding {
  symbol: string;
  yf_symbol: string;
  exposure: number;
  weight_pct: number;
  vol_now_pct: number;
  vol_longrun_pct: number;
  history_days: number;
  filled_days: number;
  factor: string;
  /** Mean P&L of this holding in the book's worst 5% of paths, % of NAV. */
  tail_contrib_pct: number;
  tail_share_pct: number;
  /** The holding on its own at the horizon, %. */
  ret_p5: number;
  ret_p50: number;
  ret_p95: number;
}

interface Prob {
  worse_than_pct: number;
  prob_pct: number;
}

interface McData {
  model: string;
  account_id: string;
  base_currency: "THB" | "USD";
  horizon: number;
  n_paths: number;
  vol: "current" | "longrun";
  drift_annual_pct: number;
  nav: number;
  cash: number;
  option_delta_value: number;
  window_days: number;
  window_from: string;
  as_of: string;
  elapsed_ms: number;
  /** Kept day numbers (0 = today); every series below is aligned to it. */
  days: number[];
  /** NAV index, 100 = today. */
  bands: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  sample_paths: number[][];
  /** Return at the horizon, % of NAV. */
  final: Record<"mean" | "p1" | "p5" | "p25" | "p50" | "p75" | "p95" | "p99", number>;
  var95_pct: number;
  cvar95_pct: number;
  var99_pct: number;
  cvar99_pct: number;
  p_loss: number;
  /** Sampling error (1 sd) of the numbers above — shrinks with √paths. */
  se: Record<"var95_pct" | "cvar95_pct" | "var99_pct" | "cvar99_pct" | "p_loss" | "p50", number>;
  loss_prob: Prob[];
  max_dd: { p50: number; p95: number; prob: Prob[] };
  hist: { edges: number[]; pct: number[] };
  holdings: McHolding[];
  groups: { key: string; tail_contrib_pct: number; tail_share_pct: number }[];
  excluded: { symbol: string; reason: string; bars: number; weight_pct: number }[];
  note?: string;
}

interface Settings {
  horizon: number;
  paths: number;
  vol: "current" | "longrun";
  drift: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const STORE_KEY = "bloomberg_port_mc";
const DEFAULTS: Settings = { horizon: 63, paths: 20_000, vol: "current", drift: 0 };
const HORIZONS = [
  [21, "1M"],
  [63, "3M"],
  [126, "6M"],
  [252, "1Y"],
] as const;
const PATHS = [
  [10_000, "10K", "ขั้นต่ำ — เส้น 95% คลาดได้ราว ±0.2% ของพอร์ต"],
  [20_000, "20K", "ค่าเริ่มต้น — คลาดราว ±0.1%, คำนวณ ~0.1 วินาที"],
  [50_000, "50K", "สำหรับตัวเลข 99% — คลาดราว ±0.1–0.2%"],
] as const;
const DRIFTS = [0, 5, 10, 20] as const;
const SAMPLES = 30;
/** Above this the 95% loss line is too noisy to read to one decimal. */
const NOISY_SE = 0.3;

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;
const money = (v: number, sym: string) => `${v >= 0 ? "+" : "−"}${sym}${fmtAmt(Math.abs(v))}`;
const ofNav = (p: number, nav: number) => (nav * p) / 100;

// ── component ────────────────────────────────────────────────────────────────

export function MonteCarloPanel({
  accountId,
  currency,
  colors,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
}) {
  const [s, setS] = useState<Settings>(() => {
    if (typeof window === "undefined") return DEFAULTS;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      /* ignore */
    }
    return DEFAULTS;
  });
  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  }, [s]);
  const [showModel, setShowModel] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const qc = useQueryClient();

  const dark = colors.bg === "#000000";
  const C_MAIN = dark ? "#3b8fd9" : "#2a7bc4";
  const C_TAIL = dark ? "#c77700" : "#b86e00";
  const sym = currency === "THB" ? "฿" : "$";

  const key = ["risk-monte-carlo", accountId, currency, s.horizon, s.paths, s.vol, s.drift];
  const load = async (fresh: boolean): Promise<McData> => {
    const qs = new URLSearchParams({
      horizon: String(s.horizon),
      n_paths: String(s.paths),
      vol: s.vol,
      drift_annual_pct: String(s.drift),
      base_currency: currency,
    });
    if (accountId !== "all") qs.set("account_id", accountId);
    if (fresh) qs.set("fresh", "true");
    const r = await fetch(`/api/v2/portfolio/risk/monte-carlo?${qs}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const { data, isFetching, error } = useQuery<McData>({
    queryKey: key,
    queryFn: () => load(false),
    // Ask every time the tab opens: the backend answers from its cache in a few
    // ms when the book is unchanged, and re-simulates when a lot was bought or sold.
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  // RERUN also re-reads prices, cash and history, which otherwise refresh every 10 min.
  const rerun = async () => {
    setRerunning(true);
    try {
      qc.setQueryData(key, await load(true));
    } catch {
      /* the last good result stays on screen */
    } finally {
      setRerunning(false);
    }
  };

  const opt = (on: boolean) => ({
    color: on ? colors.accent : colors.textSecondary,
    textDecoration: on ? "underline" : "none",
  });
  const controls = (
    <>
      <span style={{ color: colors.textSecondary }}>ช่วง</span>
      {HORIZONS.map(([h, label]) => (
        <button
          type="button"
          key={h}
          title={`${h} วันทำการ`}
          onClick={() => setS((v) => ({ ...v, horizon: h }))}
          style={opt(s.horizon === h)}
        >
          {label}
        </button>
      ))}
      <span style={{ color: colors.textSecondary }}>เส้นทาง</span>
      {PATHS.map(([n, label, title]) => (
        <button
          type="button"
          key={n}
          title={title}
          onClick={() => setS((v) => ({ ...v, paths: n }))}
          style={opt(s.paths === n)}
        >
          {label}
        </button>
      ))}
      <span style={{ color: colors.textSecondary }}>ความผันผวนเริ่มต้น</span>
      <button
        type="button"
        title="เริ่มจากความผันผวนของแต่ละตัว ณ วันนี้ แล้วค่อยๆ กลับเข้าหาค่าเฉลี่ย"
        onClick={() => setS((v) => ({ ...v, vol: "current" }))}
        style={opt(s.vol === "current")}
      >
        วันนี้
      </button>
      <button
        type="button"
        title="เริ่มจากค่าเฉลี่ย 3 ปีของแต่ละตัว — ไม่สนว่าตอนนี้ตลาดนิ่งหรือเหวี่ยง"
        onClick={() => setS((v) => ({ ...v, vol: "longrun" }))}
        style={opt(s.vol === "longrun")}
      >
        เฉลี่ย 3 ปี
      </button>
      <span
        style={{ color: colors.textSecondary }}
        title="ผลตอบแทนคาดหวังต่อปีที่ใส่ให้ทุกตัวเท่ากัน — 0% = ไม่เดาทิศทาง"
      >
        ผลตอบแทนคาด/ปี
      </span>
      {DRIFTS.map((d) => (
        <button
          type="button"
          key={d}
          onClick={() => setS((v) => ({ ...v, drift: d }))}
          style={opt(s.drift === d)}
        >
          {d}%
        </button>
      ))}
      <button
        type="button"
        onClick={rerun}
        disabled={rerunning}
        title="ดึงราคาและประวัติใหม่ แล้วจำลองอีกรอบ"
        style={{ color: colors.textSecondary }}
      >
        {rerunning || isFetching ? "running…" : "RERUN"}
      </button>
    </>
  );

  if (error && !data) {
    return (
      <Shell colors={colors} title="MONTE CARLO" right={controls}>
        <span style={{ color: colors.negative }}>unavailable — {String(error)}</span>
      </Shell>
    );
  }
  if (!data?.bands) {
    return (
      <Shell colors={colors} title="MONTE CARLO" right={controls}>
        <span style={{ color: colors.textSecondary }}>
          {data?.note === "no open positions"
            ? "ไม่มีหุ้นที่ถืออยู่ในบัญชีนี้"
            : (data?.note ?? `กำลังจำลอง ${s.paths.toLocaleString()} เส้นทาง…`)}
        </span>
      </Shell>
    );
  }

  const nav = data.nav;
  const f = data.final;
  const scope =
    data.account_id === "all" ? "ALL (ทุกบัญชีรวมเป็นพอร์ตเดียว)" : data.account_id.toUpperCase();
  const noisy = data.se.var95_pct > NOISY_SE;

  return (
    <Shell colors={colors} title="MONTE CARLO · ถือแบบนี้ต่อ จะไปได้ถึงไหน" right={controls}>
      <div style={{ color: colors.textSecondary }}>
        {scope} · มูลค่า {sym}
        {fmtAmt(nav)} · {data.holdings.length} ตัว · {data.horizon} วันทำการข้างหน้า ·{" "}
        {data.n_paths.toLocaleString()} เส้นทาง · ไม่ซื้อไม่ขายระหว่างทาง
      </div>

      {data.excluded.length > 0 && (
        <div style={{ color: "#B06000" }}>
          ไม่มีประวัติราคาพอ — ไม่ได้จำลอง:{" "}
          {data.excluded.map((e) => `${e.symbol} (${e.weight_pct.toFixed(1)}%)`).join(", ")} ·
          น้ำหนักส่วนนี้ถูกเกลี่ยให้ตัวที่เหลือ ผลจึงคลาดได้มากกว่าปกติ
        </div>
      )}

      <div className="grid gap-x-4 gap-y-1.5 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          colors={colors}
          label="ตรงกลาง (median)"
          value={pct(f.p50)}
          sub={money(ofNav(f.p50, nav), sym)}
          title="ครึ่งหนึ่งของเส้นทางจบดีกว่านี้ อีกครึ่งแย่กว่า — ต่ำกว่า 0 เล็กน้อยเป็นเรื่องปกติเมื่อไม่ใส่ผลตอบแทนคาดหวัง (หุ้นเหวี่ยงแรงเสียเปรียบจากการทบต้น)"
        />
        <Tile
          colors={colors}
          label="90% ของเส้นทางจบในช่วง"
          value={`${pct(f.p5)} … ${pct(f.p95)}`}
          sub={`${money(ofNav(f.p5, nav), sym)} … ${money(ofNav(f.p95, nav), sym)}`}
        />
        <Tile
          colors={colors}
          label="โอกาสจบขาดทุน"
          value={`${data.p_loss.toFixed(0)}%`}
          sub={`±${data.se.p_loss.toFixed(1)} จากการสุ่ม`}
        />
        <Tile
          colors={colors}
          label="5% ที่แย่สุด เริ่มที่ (VaR 95)"
          value={`${pct(-data.var95_pct)}`}
          sub={`${money(-ofNav(data.var95_pct, nav), sym)} · ±${data.se.var95_pct.toFixed(1)}`}
          title="1 ใน 20 เส้นทางจบแย่กว่านี้ · ± คือความคลาดจากจำนวนเส้นทางที่สุ่ม"
        />
        <Tile
          colors={colors}
          label="เฉลี่ยของ 5% ที่แย่สุด (CVaR 95)"
          value={pct(-data.cvar95_pct)}
          sub={money(-ofNav(data.cvar95_pct, nav), sym)}
          title="ถ้าตกไปอยู่ใน 5% ที่แย่สุด โดยเฉลี่ยขาดทุนเท่านี้"
        />
        <Tile
          colors={colors}
          label="ลงลึกสุดระหว่างทาง"
          value={`${pct(data.max_dd.p50)} / ${pct(data.max_dd.p95)}`}
          sub="ปกติ / 5% ที่แย่สุด"
          title="max drawdown จากจุดสูงสุดระหว่างทาง — ต่อให้จบบวก ระหว่างทางก็ลงได้ลึกขนาดนี้"
        />
      </div>

      {noisy && (
        <div style={{ color: "#B06000" }}>
          จำนวนเส้นทางน้อยไปสำหรับพอร์ตนี้ — เส้น 95% คลาดได้ ±{data.se.var95_pct.toFixed(1)}% ของพอร์ต ·
          เพิ่มเป็น 20K หรือ 50K
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <FanChart data={data} colors={colors} cMain={C_MAIN} sym={sym} />
        <div className="min-w-0 flex flex-col gap-2">
          <Histogram data={data} colors={colors} cMain={C_MAIN} cTail={C_TAIL} />
          <ProbTables data={data} colors={colors} sym={sym} />
        </div>
      </div>

      <HoldingsTable data={data} colors={colors} cTail={C_TAIL} sym={sym} />

      <div className="flex gap-3 items-baseline flex-wrap" style={{ fontSize: 9 }}>
        <button
          type="button"
          onClick={() => setShowModel((v) => !v)}
          style={{ color: colors.accent }}
        >
          {showModel ? "▾ ซ่อนวิธีคิด" : "▸ วิธีคิดและข้อจำกัด"}
        </button>
        <span style={{ color: colors.textSecondary, opacity: 0.75 }}>
          สุ่ม "วันจริงทั้งวัน" จากประวัติ {data.window_days} วัน ({data.window_from} → {data.as_of})
          มาเรียงต่อกัน ปรับขนาดตามความผันผวน{data.vol === "current" ? "วันนี้" : "เฉลี่ย 3 ปี"} ·
          ผลตอบแทนคาดหวัง {data.drift_annual_pct}%/ปี · คำนวณ {data.elapsed_ms.toFixed(0)} ms ·
          เป็นช่วงของความเป็นไปได้ภายใต้สมมติฐานนี้ ไม่ใช่การพยากรณ์
        </span>
      </div>
      {showModel && <ModelNotes data={data} colors={colors} />}
    </Shell>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Tile({
  colors,
  label,
  value,
  sub,
  title,
}: {
  colors: Colors;
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div style={{ color: colors.textSecondary, fontSize: 8.5 }}>{label}</div>
      <div
        className="tabular-nums font-bold whitespace-nowrap"
        style={{ color: colors.text, fontSize: 13 }}
      >
        {value}
      </div>
      {sub && (
        <div className="tabular-nums" style={{ color: colors.textSecondary, fontSize: 9 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const Swatch = ({
  color,
  opacity = 1,
  line,
}: { color: string; opacity?: number; line?: boolean }) => (
  <span
    style={{
      width: 12,
      height: line ? 2 : 8,
      background: color,
      opacity,
      display: "inline-block",
      verticalAlign: "middle",
    }}
  />
);

// memo: the settings row re-renders the panel; the charts only change with the result.
const FanChart = memo(function FanChart({
  data,
  colors,
  cMain,
  sym,
}: {
  data: McData;
  colors: Colors;
  cMain: string;
  sym: string;
}) {
  const { rows, domain, ticks, shown } = useMemo(() => {
    const b = data.bands;
    const n = Math.min(SAMPLES, data.sample_paths.length);
    const out = data.days.map((d, i) => {
      const r: Record<string, number | number[]> = {
        d,
        p50: b.p50[i],
        outer: [b.p5[i], b.p95[i]],
        inner: [b.p25[i], b.p75[i]],
      };
      for (let k = 0; k < n; k++) r[`s${k}`] = data.sample_paths[k][i];
      return r;
    });
    const lo = Math.min(...b.p5);
    const hi = Math.max(...b.p95);
    const pad = (hi - lo) * 0.2 || 1;
    // Round ticks that always include 100 (= today): every step divides 100.
    const step = [1, 2, 5, 10, 20, 25, 50, 100].find((x) => (hi - lo + 2 * pad) / x <= 6) ?? 100;
    const from = Math.floor((lo - pad) / step) * step;
    const to = Math.ceil((hi + pad) / step) * step;
    return {
      rows: out,
      domain: [from, to] as [number, number],
      ticks: Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step),
      shown: n,
    };
  }, [data]);

  const axis = { fill: colors.textSecondary, fontSize: 8.5 };
  const tip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload as { p50: number; outer: number[]; inner: number[] };
    const line = (name: string, v: number) => (
      <div className="flex justify-between gap-3" style={{ color: colors.text }}>
        <span style={{ color: colors.textSecondary }}>{name}</span>
        <span className="tabular-nums">
          {pct(v - 100)} · {money(ofNav(v - 100, data.nav), sym)}
        </span>
      </div>
    );
    return (
      <div
        className="font-mono px-2 py-1"
        style={{ background: colors.surface, border: `1px solid ${colors.border}`, fontSize: 9 }}
      >
        <div style={{ color: colors.textSecondary }}>วันทำการที่ {label}</div>
        {line("ดีกว่า 95%", r.outer[1])}
        {line("ดีกว่า 75%", r.inner[1])}
        {line("ตรงกลาง", r.p50)}
        {line("แย่กว่า 75%", r.inner[0])}
        {line("แย่กว่า 95%", r.outer[0])}
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <div style={{ height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={colors.border} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="d"
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: colors.border }}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              domain={domain}
              ticks={ticks}
              allowDataOverflow
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={(v: number) => (v === 100 ? "0%" : pct(v - 100, 0))}
            />
            <Area
              dataKey="outer"
              stroke="none"
              fill={cMain}
              fillOpacity={0.18}
              isAnimationActive={false}
              activeDot={false}
            />
            <Area
              dataKey="inner"
              stroke="none"
              fill={cMain}
              fillOpacity={0.26}
              isAnimationActive={false}
              activeDot={false}
            />
            {Array.from({ length: shown }, (_, k) => (
              <Line
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed set of sample paths
                key={k}
                dataKey={`s${k}`}
                stroke={colors.textSecondary}
                strokeWidth={0.6}
                strokeOpacity={0.35}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
            <ReferenceLine y={100} stroke={colors.textDimmed} strokeDasharray="3 3" />
            <Line
              dataKey="p50"
              stroke={cMain}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip content={tip} cursor={{ stroke: colors.textSecondary, strokeWidth: 1 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div
        className="flex gap-3 flex-wrap items-center"
        style={{ color: colors.textSecondary, fontSize: 8.5 }}
      >
        <span>มูลค่าพอร์ตเทียบวันนี้ · แกน x = วันทำการ</span>
        <span className="flex items-center gap-1">
          <Swatch color={cMain} line /> ตรงกลาง
        </span>
        <span className="flex items-center gap-1">
          <Swatch color={cMain} opacity={0.44} /> 50% ของเส้นทาง
        </span>
        <span className="flex items-center gap-1">
          <Swatch color={cMain} opacity={0.18} /> 90% ของเส้นทาง
        </span>
        <span className="flex items-center gap-1">
          <Swatch color={colors.textSecondary} opacity={0.5} line /> ตัวอย่าง {shown} เส้นทาง
        </span>
      </div>
    </div>
  );
});

const Histogram = memo(function Histogram({
  data,
  colors,
  cMain,
  cTail,
}: {
  data: McData;
  colors: Colors;
  cMain: string;
  cTail: string;
}) {
  const { rows, zero, ticks } = useMemo(() => {
    const e = data.hist.edges;
    const out = data.hist.pct.map((p, i) => {
      const mid = (e[i] + e[i + 1]) / 2;
      return { i, lo: e[i], hi: e[i + 1], mid, pct: p, tail: mid < -data.var95_pct };
    });
    const z = out.find((r) => r.lo <= 0 && r.hi > 0)?.i;
    const step = Math.max(1, Math.round(out.length / 6));
    return { rows: out, zero: z, ticks: out.filter((r) => r.i % step === 0).map((r) => r.i) };
  }, [data]);

  const axis = { fill: colors.textSecondary, fontSize: 8.5 };
  const last = rows.length - 1;
  const tip = ({ active, payload }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload as (typeof rows)[number];
    const range =
      r.i === 0
        ? `แย่กว่า ${pct(r.hi)}`
        : r.i === last
          ? `ดีกว่า ${pct(r.lo)}`
          : `${pct(r.lo)} ถึง ${pct(r.hi)}`;
    return (
      <div
        className="font-mono px-2 py-1"
        style={{ background: colors.surface, border: `1px solid ${colors.border}`, fontSize: 9 }}
      >
        <div style={{ color: colors.textSecondary }}>จบที่ {range}</div>
        <div className="tabular-nums" style={{ color: colors.text }}>
          {r.pct.toFixed(1)}% ของเส้นทาง{r.tail ? " · อยู่ใน 5% ที่แย่สุด" : ""}
        </div>
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <div style={{ height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            barCategoryGap={1}
          >
            <CartesianGrid stroke={colors.border} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="i"
              ticks={ticks}
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: colors.border }}
              tickFormatter={(i: number) => pct(rows[i]?.mid ?? 0, 0)}
            />
            <YAxis
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={30}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            {zero != null && (
              <ReferenceLine x={zero} stroke={colors.textDimmed} strokeDasharray="3 3" />
            )}
            <Bar dataKey="pct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {rows.map((r) => (
                <Cell key={r.i} fill={r.tail ? cTail : cMain} />
              ))}
            </Bar>
            <Tooltip content={tip} cursor={{ fill: colors.textSecondary, fillOpacity: 0.12 }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div
        className="flex gap-3 flex-wrap items-center"
        style={{ color: colors.textSecondary, fontSize: 8.5 }}
      >
        <span>จบวันที่ {data.horizon} ที่เท่าไร (% ของเส้นทาง)</span>
        <span className="flex items-center gap-1">
          <Swatch color={cTail} /> 5% ที่แย่สุด
        </span>
        <span className="flex items-center gap-1">
          <Swatch color={cMain} /> ที่เหลือ
        </span>
      </div>
    </div>
  );
});

function ProbTables({ data, colors, sym }: { data: McData; colors: Colors; sym: string }) {
  const cell = "text-right px-1 tabular-nums";
  const head = (h: string, left = false) => (
    <th
      className={`${left ? "text-left" : "text-right"} font-normal px-1`}
      style={{ color: colors.textSecondary }}
    >
      {h}
    </th>
  );
  return (
    <div className="grid gap-3 grid-cols-2" style={{ fontSize: 9 }}>
      <table className="w-full">
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            {head("จบขาดทุนเกิน", true)}
            {head("โอกาส")}
            {head(`= ${sym}`)}
          </tr>
        </thead>
        <tbody>
          {data.loss_prob.map((p) => (
            <tr key={p.worse_than_pct}>
              <td className="px-1" style={{ color: colors.text }}>
                {p.worse_than_pct === 0 ? "ขาดทุน (ต่ำกว่าวันนี้)" : `−${p.worse_than_pct}%`}
              </td>
              <td className={cell} style={{ color: colors.text }}>
                {p.prob_pct.toFixed(1)}%
              </td>
              <td className={cell} style={{ color: colors.textSecondary }}>
                {p.worse_than_pct === 0 ? "—" : fmtAmt(ofNav(p.worse_than_pct, data.nav))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full self-start">
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            {head("ระหว่างทางลงลึกเกิน", true)}
            {head("โอกาส")}
          </tr>
        </thead>
        <tbody>
          {data.max_dd.prob.map((p) => (
            <tr key={p.worse_than_pct}>
              <td className="px-1" style={{ color: colors.text }}>
                −{p.worse_than_pct}% จากจุดสูงสุด
              </td>
              <td className={cell} style={{ color: colors.text }}>
                {p.prob_pct.toFixed(1)}%
              </td>
            </tr>
          ))}
          <tr>
            <td
              className="px-1 pt-1"
              colSpan={2}
              style={{ color: colors.textSecondary }}
              title="ตัวเลข 99% มาจากเส้นทางเพียง 1% — ทดสอบย้อนหลังแล้วเส้นนี้ถูกทะลุบ่อยกว่าที่ควรเล็กน้อย ให้มองว่าอ่อนไปนิด"
            >
              1% ที่แย่สุด: เริ่ม {pct(-data.var99_pct)} · เฉลี่ย {pct(-data.cvar99_pct)} (±
              {data.se.cvar99_pct.toFixed(1)})
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function HoldingsTable({
  data,
  colors,
  cTail,
  sym,
}: {
  data: McData;
  colors: Colors;
  cTail: string;
  sym: string;
}) {
  const hd = (h: string, right = true, title?: string) => (
    <th
      key={h}
      title={title}
      className={`${right ? "text-right" : "text-left"} font-normal px-1 py-0.5`}
      style={{ color: colors.textSecondary }}
    >
      {h}
    </th>
  );
  const top = Math.max(1, ...data.holdings.map((h) => h.tail_share_pct));
  return (
    <div className="min-w-0">
      <div className="mb-0.5" style={{ color: colors.textSecondary, fontSize: 9 }}>
        ใครแบก 5% ที่แย่สุด — เรียงจากตัวที่ทำให้พอร์ตเจ็บที่สุดในเส้นทางเหล่านั้น
        {data.groups.length > 0 && (
          <span style={{ color: colors.text }}>
            {" "}
            · รายบัญชี:{" "}
            {data.groups
              .map((g) => `${g.key.toUpperCase()} ${g.tail_share_pct.toFixed(0)}%`)
              .join(" · ")}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {hd("SYMBOL", false)}
              {hd("น้ำหนัก")}
              {hd(
                "ส่วนของ 5% ที่แย่สุด",
                false,
                "ส่วนแบ่งของขาดทุนเฉลี่ยในเส้นทาง 5% ที่แย่สุดของพอร์ต — มากกว่าน้ำหนัก = แบกความเสี่ยงเกินตัว"
              )}
              {hd(`= ${sym}`, true, "ขาดทุนเฉลี่ยของตัวนี้ในเส้นทาง 5% ที่แย่สุดของพอร์ต")}
              {hd("ตัวมันเอง แย่ 5%", true, "ผลตอบแทนของหุ้นตัวนี้เองที่ปลายช่วง — 1 ใน 20 เส้นทางแย่กว่านี้")}
              {hd("ดี 5%", true, "1 ใน 20 เส้นทางดีกว่านี้")}
              {hd("σ วันนี้ /ปี", true, "ความผันผวนต่อปี ณ วันนี้ (จุดเริ่มของการจำลอง)")}
              {hd("σ เฉลี่ย", true, "ความผันผวนเฉลี่ยทั้งช่วงประวัติ — การจำลองค่อยๆ กลับเข้าหาค่านี้")}
              {hd("ประวัติ", true, "จำนวนวันที่มีราคาจริงในช่วงที่ใช้สุ่ม")}
            </tr>
          </thead>
          <tbody>
            {data.holdings.map((h) => (
              <tr key={h.yf_symbol} style={{ borderBottom: `1px solid ${colors.border}33` }}>
                <td
                  className="px-1 py-0.5 font-bold whitespace-nowrap"
                  style={{ color: colors.text }}
                >
                  {h.symbol}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {h.weight_pct.toFixed(1)}%
                </td>
                <td className="px-1" style={{ minWidth: 120 }}>
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1" style={{ height: 6 }}>
                      <div
                        style={{
                          height: 6,
                          width: `${Math.max(0, (h.tail_share_pct / top) * 100)}%`,
                          background: cTail,
                          borderRadius: "0 2px 2px 0",
                        }}
                      />
                    </div>
                    <span
                      className="text-right"
                      style={{
                        width: 38,
                        color: colors.text,
                        fontWeight: h.tail_share_pct > h.weight_pct * 1.5 ? 700 : 400,
                      }}
                    >
                      {h.tail_share_pct.toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                  {money(ofNav(h.tail_contrib_pct, data.nav), sym)}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {pct(h.ret_p5)}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {pct(h.ret_p95)}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {h.vol_now_pct.toFixed(0)}%
                </td>
                <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                  {h.vol_longrun_pct.toFixed(0)}%
                </td>
                <td
                  className="px-1 text-right whitespace-nowrap"
                  style={{ color: h.filled_days > 0 ? "#B06000" : colors.textSecondary }}
                  title={
                    h.filled_days > 0
                      ? `เข้าตลาดไม่ถึง ${data.window_days} วัน — ${h.filled_days} วันที่ขาดถูกเติมจาก ${h.factor} + ส่วนเฉพาะตัวของมันเอง`
                      : undefined
                  }
                >
                  {h.history_days}
                  {h.filled_days > 0 ? ` +${h.filled_days} เติม` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelNotes({ data, colors }: { data: McData; colors: Colors }) {
  const li = (head: string, body: string) => (
    <li>
      <span style={{ color: colors.text }}>{head}</span> — {body}
    </li>
  );
  return (
    <ul
      className="list-disc pl-4 space-y-0.5"
      style={{ color: colors.textSecondary, fontSize: 9, lineHeight: 1.5 }}
    >
      {li(
        "สุ่มวันจริงทั้งวัน (Filtered Historical Simulation)",
        "แต่ละก้าวหยิบ 'วันหนึ่งในอดีต' มาใช้กับทุกตัวพร้อมกัน หุ้นที่เคยร่วงด้วยกันจึงร่วงด้วยกันในแบบจำลอง ไม่ต้องสมมติ bell curve หรือ correlation"
      )}
      {li(
        "ปรับขนาดตามความผันผวน",
        "วันที่หยิบมาถูกย่อ/ขยายตามความผันผวนของแต่ละตัว ณ ขณะนั้น (GARCH) — วันแย่ๆ จึงมาเป็นชุด ซึ่งเป็นสิ่งที่ทำให้เกิด drawdown ลึก"
      )}
      {li(
        "ผลตอบแทนคาดหวัง",
        `ตั้งไว้ ${data.drift_annual_pct}%/ปี ให้ทุกตัวเท่ากัน — 0% คือไม่เดาทิศทาง ค่ากลางจึงติดลบเล็กน้อยจากการทบต้น นี่คือสมมติฐานที่ขยับผลมากที่สุด ลองเปลี่ยนดูได้ด้านบน`
      )}
      {li(
        "จำนวนเส้นทาง",
        "ค่า ± ข้างตัวเลขคือความคลาดจากการสุ่ม: 10K ≈ ±0.2% ของพอร์ตที่เส้น 95%, 20K ≈ ±0.1% เกินกว่านั้นสมมติฐานของแบบจำลองคลาดมากกว่าการสุ่มแล้ว"
      )}
      {li(
        "สิ่งที่ไม่ได้จำลอง",
        "การซื้อขายและ stop (ดู WHAT-IF) · ดอกเบี้ยเงินสด · option คิดเป็น delta ของหุ้นอ้างอิง (ไม่มี gamma) · วันที่แย่กว่าที่เคยเกิดในช่วงประวัติ"
      )}
      {li(
        "ค่าเงิน",
        `ผลตอบแทนทุกตัวแปลงเป็น ${data.base_currency} แล้ว การแกว่งของค่าเงินจึงอยู่ในแบบจำลองด้วย`
      )}
      {data.option_delta_value !== 0 &&
        li("Option", `มี delta เทียบเท่าหุ้น ${fmtAmt(data.option_delta_value)} รวมอยู่ในน้ำหนักของหุ้นอ้างอิง`)}
    </ul>
  );
}
