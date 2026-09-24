"use client";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Colors, fmtK, pnlColor } from "../helpers";
import type { Dividend, Summary, Trade } from "../types";
import { AccBadge } from "../ui/AccBadge";
import { AllocationBasisCard } from "../ui/AllocationBasisCard";
import { NavGrowthChart } from "../ui/NavGrowthChart";
import { OptionAttributionCard } from "../ui/OptionAttributionCard";
import {
  PortfolioRotationChart,
  type RotationGroup,
  type RotationMode,
} from "../ui/PortfolioRotationChart";

interface CapmRow {
  beta: number | null;
  alpha_annual_pct: number | null;
  r_squared: number | null;
  n_days: number;
  port_return_annual_pct: number | null;
  bench_return_annual_pct: number | null;
  name?: string;
  // Native-currency pair (both sides unconverted) — comparable to a published
  // beta. The primary fields above are translated to the report currency.
  beta_local?: number | null;
  alpha_local_annual_pct?: number | null;
  r_squared_local?: number | null;
  benchmark_fit?: "WEAK" | "MODERATE" | "OK";
  // Performance side — cost-based returns over the account's own span, from the
  // RETURNS card. No trade DATES involved: the log's dates cannot be trusted
  // (bulk-import placeholders), and everything here is checkable by hand.
  return_annual_pct?: number | null; // XIRR — money-weighted
  return_cagr_pct?: number | null; // cost-based; denominator counts every buy
  invested_gross?: number | null;
  alpha_cagr_annual_pct?: number | null;
  holding_days?: number | null;
  first_date?: string | null;
  index_annual_pct?: number | null;
  index_cumulative_pct?: number | null;
  expected_annual_pct?: number | null;
  excess_vs_index_pct?: number | null;
  market_value?: number;
  hedge_notional?: number | null;
  covered_weight_pct?: number;
  excluded_symbols?: { symbol: string; reason: string; bars: number; weight_pct: number }[];
}
interface CapmResponse {
  benchmark: string;
  benchmark_currency?: string;
  benchmark_last_date?: string | null;
  base_currency?: string;
  lookback?: number;
  min_days_required?: number;
  rf_annual?: number;
  rf_source?: string;
  rf_series?: string | null;
  rf_as_of?: string | null;
  rf_currency?: string;
  benchmark_available: boolean;
  portfolio: CapmRow;
  accounts?: Record<string, CapmRow>;
}
interface RfRate {
  rate: number;
  source: string;
  series: string | null;
  as_of: string | null;
  currency: string;
}
interface RfResponse {
  rates: Record<string, RfRate>;
  alternatives?: RfRate[];
  fallback?: Record<string, number>;
}

const RF_KEY = "bloomberg_capm_rf";
// v2: GROWTH became the default view (2026-09-25); the old key held VALUE/INDEX.
const NAV_MODE_KEY = "bloomberg_nav_chart_mode_v2";

/** One day of the time-weighted equity curve (see /api/v2/portfolio/nav-index). */
interface NavIndexPoint {
  date: string;
  nav: number;
  flow: number;
  return_pct: number;
  port_index: number;
  bench_index: number | null;
  suspect: boolean;
}
interface NavIndexResponse {
  benchmark: string;
  benchmark_currency: string | null;
  benchmark_available: boolean;
  base_currency: string;
  points: NavIndexPoint[];
  n_days: number;
  suspect_days: number;
  start: string | null;
  end: string | null;
  port_twr_pct: number | null;
  bench_pct: number | null;
  excess_pct: number | null;
  net_flow: number;
  note?: string;
}

interface ReturnsRow {
  cagr_pct: number | null;
  xirr_pct: number | null;
  simple_pct: number | null;
  invested: number;
  end_value: number;
  holding_days: number;
  first_date: string | null;
  name?: string;
}
interface ReturnsResponse {
  base_currency: string;
  total: ReturnsRow;
  accounts?: Record<string, ReturnsRow>;
}

type VolRegime = "CALM" | "ELEVATED" | "STRESSED" | "UNKNOWN";

interface VolMetrics {
  volatility_daily_pct: number;
  volatility_annual_pct: number;
  lookback_days: number;
  n_positions: number;
  vol_regime: VolRegime;
  account_breakdown?: Record<
    string,
    { volatility_daily_pct: number; volatility_annual_pct: number; vol_regime: VolRegime }
  >;
}

interface TradeStats {
  closed: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  wl_ratio: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  payoff: number | null;
  expectancy: number | null;
  /** Per-trade return on cost, averaged. Native currency — no FX leg. */
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  expectancy_pct: number | null;
  /** Closed trades that carried a cost basis, so could be expressed as %. */
  pct_basis: number;
  total_win: number;
  total_loss: number;
}

/** Signed percent for the small corner figure. null when the backend had no
 *  cost basis to divide by, so the caller can drop the element entirely
 *  instead of printing a misleading 0.0%. */
const fmtPct = (n: number | null | undefined): string | null =>
  n == null ? null : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;

/** The four lines of the NAV card, in the order they are read.
 *
 *  NAV = HOLDINGS + CASH is an identity, not a coincidence, so the three are
 *  drawn as one family (the total filled, its two parts as lines) and COST sits
 *  apart in grey: the gap between NAV and COST is the unrealized P&L. Each
 *  series carries its own colour and a Thai gloss, because a chart with four
 *  unlabelled lines is a chart nobody reads twice. */
const NAV_SERIES = [
  { key: "value", label: "NAV", color: "#60a5fa", hint: "มูลค่ารวม = หุ้นที่ถือ + เงินสด" },
  { key: "holdings", label: "HOLDINGS", color: "#a78bfa", hint: "มูลค่าตลาดของที่ถืออยู่" },
  { key: "cash", label: "CASH", color: "#facc15", hint: "เงินสดคงเหลือ (ประมาณจากบัญชี)" },
  {
    key: "cost",
    label: "COST",
    color: "#9ca3af",
    hint: "ต้นทุนของที่ถืออยู่ — ช่องว่างกับ NAV คือกำไรที่ยังไม่ขาย",
  },
] as const;

type NavRow = { date: string; value: number; holdings: number; cash: number; cost: number };

/** Portfolio value over time: the total, what it is made of, and what it cost.
 *
 *  The previous version drew all four with no key and two of them in the same
 *  blue, which made the card unreadable — hence the legend, which doubles as
 *  the on/off switch (CASH next to a 2M NAV is a flat line at the floor until
 *  you hide the big series and let the axis rescale to it). */
function NavValueChart({
  data,
  colors,
  sym,
  tooltipContentStyle,
  height = 240,
}: {
  data: NavRow[];
  colors: Colors;
  sym: string;
  tooltipContentStyle: Record<string, unknown>;
  height?: number;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      // Hiding everything leaves an empty frame; the last one stays on.
      return n.size >= NAV_SERIES.length ? h : n;
    });

  const last = data[data.length - 1];
  const first = data[0];
  const navChange = last && first ? last.value - first.value : 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
        {NAV_SERIES.map((s) => {
          const off = hidden.has(s.key);
          return (
            <button
              type="button"
              key={s.key}
              onClick={() => toggle(s.key)}
              title={`${s.hint} — คลิกเพื่อซ่อน/แสดง`}
              className="flex items-center gap-1 text-[8px] font-mono"
              style={{ color: off ? "#555" : colors.textSecondary }}
            >
              <span
                className="inline-block"
                style={{
                  width: 10,
                  height: s.key === "cost" ? 0 : 2,
                  borderTop: s.key === "cost" ? `2px dashed ${off ? "#555" : s.color}` : undefined,
                  background: s.key === "cost" ? undefined : off ? "#555" : s.color,
                }}
              />
              {s.label}
              {last && (
                <span style={{ color: off ? "#555" : colors.text }}>
                  {sym}
                  {fmtK(Math.abs(last[s.key]))}
                </span>
              )}
            </button>
          );
        })}
        {data.length > 1 && (
          <span className="text-[8px] font-mono ml-auto" style={{ color: colors.textSecondary }}>
            ตั้งแต่ {first.date}: NAV{" "}
            <span style={{ color: pnlColor(navChange) }}>
              {navChange >= 0 ? "+" : "−"}
              {sym}
              {fmtK(Math.abs(navChange))}
            </span>
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        {/* Composed, not Area: recharts 2.x renders <Line> children only inside
            ComposedChart, so holdings/cash/cost were silently dropped. */}
        <ComposedChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "#666", fontSize: 8 }} tickLine={false} />
          <YAxis
            tick={{ fill: "#666", fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmtK(v)}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              const row = payload?.[0]?.payload as NavRow | undefined;
              if (!active || !row) return null;
              const unreal = row.value - row.cash - row.cost;
              return (
                <div style={{ ...tooltipContentStyle, padding: 6 }}>
                  <div style={{ color: "#e5e5e5", marginBottom: 2 }}>{label}</div>
                  {NAV_SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
                    <div key={s.key} style={{ color: s.color }}>
                      {s.label} {row[s.key] < 0 ? "−" : ""}
                      {sym}
                      {fmtK(Math.abs(row[s.key]))}
                    </div>
                  ))}
                  <div style={{ color: pnlColor(unreal), marginTop: 2 }}>
                    ยังไม่ขาย (HOLDINGS − COST) {unreal >= 0 ? "+" : "−"}
                    {sym}
                    {fmtK(Math.abs(unreal))}
                  </div>
                </div>
              );
            }}
          />
          {!hidden.has("value") && (
            <Area
              dataKey="value"
              stroke="#60a5fa"
              strokeWidth={1.8}
              fill="url(#navGrad)"
              dot={data.length < 2}
            />
          )}
          {!hidden.has("holdings") && (
            <Line dataKey="holdings" stroke="#a78bfa" strokeWidth={1.2} dot={false} />
          )}
          {!hidden.has("cash") && (
            <Line dataKey="cash" stroke="#facc15" strokeWidth={1.2} dot={false} />
          )}
          {!hidden.has("cost") && (
            <Line
              dataKey="cost"
              stroke="#9ca3af"
              strokeWidth={1.2}
              strokeDasharray="4 3"
              dot={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

/** The book's time-weighted return against an index, both rebased to 100.
 *
 *  Raw NAV answers "how much money is in here", which moves on a deposit and is
 *  therefore not comparable with an index. This chart answers "how did the
 *  money that WAS in here do" — the backend nets each day's external flow out
 *  of that day's return and links the rest geometrically. */
function NavIndexChart({
  data,
  loading,
  colors,
  benchmark,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipItemStyle,
  height = 240,
}: {
  data: NavIndexResponse | null;
  loading: boolean;
  colors: Colors;
  benchmark: string;
  tooltipContentStyle: Record<string, unknown>;
  tooltipLabelStyle: Record<string, unknown>;
  tooltipItemStyle: Record<string, unknown>;
  height?: number;
}) {
  const pts = data?.points ?? [];
  if (loading && pts.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  }
  if (pts.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[8px] text-center px-4"
        style={{ color: colors.textSecondary, height }}
      >
        {data?.note ?? "ยังไม่มี snapshot พอจะสร้างเส้นผลตอบแทน — NAV ถูกเก็บวันละครั้งตอนเปิดหน้า"}
      </div>
    );
  }

  const chart = pts.map((p) => ({
    date: p.date.slice(5),
    port: p.port_index,
    bench: p.bench_index,
  }));
  const twr = data?.port_twr_pct ?? null;
  const bench = data?.bench_pct ?? null;
  const excess = data?.excess_pct ?? null;

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1 text-[8px] font-mono"
        style={{ color: colors.textSecondary }}
      >
        <span title="Time-weighted return over the snapshot span — external cash flows removed">
          TWR{" "}
          <span style={{ color: pnlColor(twr ?? 0) }} className="font-bold">
            {twr == null ? "—" : `${twr >= 0 ? "+" : ""}${twr.toFixed(2)}%`}
          </span>
        </span>
        <span>
          {benchmark}{" "}
          <span style={{ color: pnlColor(bench ?? 0) }} className="font-bold">
            {bench == null ? "—" : `${bench >= 0 ? "+" : ""}${bench.toFixed(2)}%`}
          </span>
        </span>
        <span title="TWR − benchmark over the same dates">
          EXCESS{" "}
          <span style={{ color: pnlColor(excess ?? 0) }} className="font-bold">
            {excess == null ? "—" : `${excess >= 0 ? "+" : ""}${excess.toFixed(2)}%`}
          </span>
        </span>
        <span>
          {data?.start} → {data?.end} · {data?.n_days}d
        </span>
        {(data?.suspect_days ?? 0) > 0 && (
          <span
            style={{ color: "#f87171" }}
            title="วันที่ NAV ขยับเกิน 50% — มักเป็นเงินฝาก/ถอนที่ยังไม่ได้บันทึกใน CASH ไม่ใช่ผลตอบแทน"
          >
            ⚠ {data?.suspect_days} วันน่าสงสัย
          </span>
        )}
        {data && !data.benchmark_available && <span style={{ color: "#f87171" }}>ไม่มีราคาดัชนี</span>}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="twrGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "#666", fontSize: 8 }} tickLine={false} />
          <YAxis
            tick={{ fill: "#666", fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
            formatter={(v: any, name: any) => [
              v == null ? "—" : `${Number(v).toFixed(2)} (${(Number(v) - 100).toFixed(2)}%)`,
              name === "port" ? "Portfolio (TWR)" : benchmark,
            ]}
          />
          {/* 100 = the first snapshot. Above it the book made money, below it lost. */}
          <ReferenceLine y={100} stroke="#444" strokeDasharray="3 3" />
          <Area
            dataKey="port"
            stroke="#60a5fa"
            strokeWidth={1.6}
            fill="url(#twrGrad)"
            dot={false}
          />
          <Line
            dataKey="bench"
            stroke="#facc15"
            strokeWidth={1.2}
            dot={false}
            connectNulls
            fill="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

/** Signed percent with two decimals for KPI tiles; "—" when unknown. */
const sgnPct = (n: number | null | undefined, digits = 1): string =>
  n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;

const NAV_RANGES = [
  ["1M", 31],
  ["3M", 92],
  ["6M", 183],
  ["ALL", 0],
] as const;
type NavRange = (typeof NAV_RANGES)[number][0];
const NAV_RANGE_KEY = "bloomberg_nav_chart_range";
const MONTHLY_VIEW_KEY = "bloomberg_analytics_monthly_view";

/** One panel of the ANALYTICS dashboard. Every card shares the header row —
 *  title, a short grey subtitle, controls on the right — and keeps its long
 *  methodology text behind ⓘ so the numbers are what the eye lands on. */
function Card({
  title,
  sub,
  right,
  note,
  colors,
  className = "",
  children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  note?: React.ReactNode;
  colors: Colors;
  className?: string;
  children: React.ReactNode;
}) {
  const [showNote, setShowNote] = useState(false);
  return (
    <section
      className={`border flex flex-col min-w-0 ${className}`}
      style={{ borderColor: colors.border, background: "#050505" }}
    >
      <header
        className="flex items-center gap-2 px-2 py-1.5 border-b flex-wrap"
        style={{ borderColor: "#1a1a1a" }}
      >
        <h3 className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
          {title}
        </h3>
        {sub && (
          <span className="text-[8px] font-mono" style={{ color: "#666" }}>
            {sub}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {right}
          {note && (
            <button
              type="button"
              onClick={() => setShowNote((v) => !v)}
              className="text-[9px] font-mono"
              style={{ color: showNote ? colors.accent : "#666" }}
              title="How this is calculated"
              aria-expanded={showNote}
            >
              ⓘ
            </button>
          )}
        </div>
      </header>
      <div className="p-2 flex-1 min-w-0">{children}</div>
      {note && showNote && (
        <div className="px-2 pb-2 text-[8px] leading-relaxed font-mono" style={{ color: "#777" }}>
          {note}
        </div>
      )}
    </section>
  );
}

/** Text-only segmented control — state is the colour, never a fill. */
function Seg<T extends string | number>({
  options,
  value,
  onChange,
  colors,
}: {
  options: readonly (readonly [string, T])[];
  value: T;
  onChange: (v: T) => void;
  colors: Colors;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {options.map(([label, v]) => (
        <button
          type="button"
          key={label}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className="text-[8px] font-bold font-mono"
          style={{ color: value === v ? colors.accent : "#666" }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Headline figure for the KPI strip. */
function Kpi({
  label,
  value,
  sub,
  color,
  title,
  colors,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
  title?: string;
  colors: Colors;
}) {
  return (
    <div className="px-3 py-2 min-w-0" style={{ background: "#080808" }} title={title}>
      <div className="text-[8px] font-mono tracking-wider" style={{ color: colors.textSecondary }}>
        {label}
      </div>
      <div
        className="text-[15px] font-mono font-bold leading-tight mt-0.5 truncate"
        style={{ color: color ?? colors.text }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[8px] font-mono mt-0.5 truncate" style={{ color: "#666" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** One line of the CAPITAL ledger: label left, figure right. */
function LedgerRow({
  label,
  hint,
  value,
  color,
  strong,
  rule,
  title,
  colors,
}: {
  label: string;
  hint?: string;
  value: React.ReactNode;
  color?: string;
  strong?: boolean;
  rule?: boolean;
  title?: string;
  colors: Colors;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 py-[3px] ${rule ? "border-t mt-1 pt-1.5" : ""}`}
      style={{ borderColor: "#222" }}
      title={title}
    >
      <span
        className={`text-[9px] font-mono ${strong ? "font-bold" : ""}`}
        style={{ color: strong ? colors.text : colors.textSecondary }}
      >
        {label}
        {hint && (
          <span className="ml-1 text-[7px] font-normal" style={{ color: "#555" }}>
            {hint}
          </span>
        )}
      </span>
      <span
        className={`font-mono text-right ${strong ? "text-[11px] font-bold" : "text-[10px]"}`}
        style={{ color: color ?? colors.text }}
      >
        {value}
      </span>
    </div>
  );
}

export function AnalyticsTab({
  accountId,
  currency,
  summary,
  colors,
}: { accountId: string; currency: "THB" | "USD"; summary: Summary | null; colors: Colors }) {
  const [analytics, setAnalytics] = useState<{
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    by_sector: any[];
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    by_strategy: any[];
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    by_month: any[];
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    top_symbols: any[];
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    open_by_sector: any[];
    // biome-ignore lint/suspicious/noExplicitAny: untyped API response
    by_subport: any[];
    trade_stats?: TradeStats;
    trade_stats_by_account?: Record<string, TradeStats>;
  } | null>(null);
  const [dividends, setDividends] = useState<Dividend[]>([]);
  const [openPos, setOpenPos] = useState<Trade[]>([]);
  // biome-ignore lint/suspicious/noExplicitAny: untyped API response
  const [navHistory, setNavHistory] = useState<any[]>([]);
  const [divPeriod, setDivPeriod] = useState<"M" | "Q" | "Y">("M");
  const [capm, setCapm] = useState<CapmResponse | null>(null);
  const [rets, setRets] = useState<ReturnsResponse | null>(null);
  const [benchmark, setBenchmark] = useState<"SPY" | "QQQ" | "ACWI">("SPY");
  const [lookback, setLookback] = useState<number>(252);
  const [rfRates, setRfRates] = useState<RfResponse | null>(null);
  const [rfPanel, setRfPanel] = useState(false);
  // Manual rf per report currency. Read in the initializer — an effect fires
  // after the first fetch and would send the live rate once before the override.
  const [rfOverride, setRfOverride] = useState<Record<string, number | null>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(RF_KEY);
      if (raw) return JSON.parse(raw) as Record<string, number | null>;
    } catch {
      /* ignore */
    }
    return {};
  });
  const [rfDraft, setRfDraft] = useState("");
  const [vol, setVol] = useState<VolMetrics | null>(null);
  // VALUE = the money in the book; INDEX = the time-weighted curve, which is
  // the only one of the two that can be laid next to an index.
  const [navMode, setNavMode] = useState<"GROWTH" | "VALUE" | "INDEX">(() => {
    if (typeof window === "undefined") return "GROWTH";
    try {
      const s = localStorage.getItem(NAV_MODE_KEY);
      if (s === "GROWTH" || s === "INDEX" || s === "VALUE") return s;
    } catch {
      /* ignore */
    }
    return "GROWTH";
  });
  const [navRange, setNavRange] = useState<NavRange>(() => {
    if (typeof window === "undefined") return "ALL";
    try {
      const s = localStorage.getItem(NAV_RANGE_KEY);
      if (NAV_RANGES.some(([r]) => r === s)) return s as NavRange;
    } catch {
      /* ignore */
    }
    return "ALL";
  });
  const [monthlyView, setMonthlyView] = useState<"CHART" | "TABLE">(() => {
    if (typeof window === "undefined") return "CHART";
    try {
      if (localStorage.getItem(MONTHLY_VIEW_KEY) === "TABLE") return "TABLE";
    } catch {
      /* ignore */
    }
    return "CHART";
  });
  useEffect(() => {
    try {
      localStorage.setItem(NAV_RANGE_KEY, navRange);
      localStorage.setItem(MONTHLY_VIEW_KEY, monthlyView);
    } catch {
      /* ignore */
    }
  }, [navRange, monthlyView]);
  const [rotGroup, setRotGroup] = useState<RotationGroup>("theme");
  const [rotMode, setRotMode] = useState<RotationMode>("COST");
  const [navIndex, setNavIndex] = useState<NavIndexResponse | null>(null);
  const [navIndexLoading, setNavIndexLoading] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_MODE_KEY, navMode);
    } catch {
      /* ignore */
    }
  }, [navMode]);

  // Only fetched when the curve is on screen — it pulls the benchmark's price
  // history, which the value chart has no use for.
  useEffect(() => {
    if (navMode === "VALUE") return;
    const ac = new AbortController();
    // GROWTH wants the whole snapshot history (its table is year × month) —
    // `days` counts snapshot rows, so a cap here would silently restart Growth
    // at whatever row it cut. ~100 years of daily rows is "no cap".
    const qs = new URLSearchParams({
      base_currency: currency,
      benchmark,
      days: navMode === "GROWTH" ? "36500" : "365",
    });
    if (accountId !== "all") qs.set("account_id", accountId);
    setNavIndexLoading(true);
    fetch(`/api/v2/portfolio/nav-index?${qs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setNavIndex(d && !d.error ? d : null))
      .catch(() => {})
      .finally(() => setNavIndexLoading(false));
    return () => ac.abort();
  }, [navMode, accountId, currency, benchmark]);

  useEffect(() => {
    try {
      localStorage.setItem(RF_KEY, JSON.stringify(rfOverride));
    } catch {
      /* ignore */
    }
  }, [rfOverride]);

  // Daily/annualized sigma of the open book's realized returns — same endpoint
  // RISK's header badge reads, fetched separately so switching CAPM benchmark
  // or lookback doesn't refire it and account/currency changes don't refire CAPM.
  useEffect(() => {
    const ac = new AbortController();
    const qs = new URLSearchParams({
      confidence: "0.95",
      lookback: "252",
      base_currency: currency,
    });
    if (accountId !== "all") qs.set("account_id", accountId);
    fetch(`/api/v2/portfolio/risk/metrics?${qs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setVol(m && !m.error ? m : null))
      .catch(() => {});
    return () => ac.abort();
  }, [accountId, currency]);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/v2/portfolio/risk/risk-free", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.rates && setRfRates(d))
      .catch(() => {});
    return () => ac.abort();
  }, []);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ base_currency: currency });
        if (accountId !== "all") qs.set("account_id", accountId);
        const [ar, dr, op, nv, rt] = await Promise.all([
          fetch(`/api/v2/portfolio/analytics?${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/dividends?${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/open-positions?${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/nav-history?${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/returns?${qs}`, { signal })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        setAnalytics(ar);
        setDividends(Array.isArray(dr) ? dr : []);
        setOpenPos(Array.isArray(op?.positions) ? op.positions : []);
        setNavHistory(Array.isArray(nv) ? nv : []);
        setRets(rt && !rt.error ? rt : null);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [accountId, currency]
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // CAPM fetched separately — benchmark/lookback toggles must not refetch the
  // other five endpoints above.
  useEffect(() => {
    const ac = new AbortController();
    const capmQs = new URLSearchParams({
      benchmark,
      lookback: String(lookback),
      base_currency: currency,
    });
    const manualRf = rfOverride[currency];
    if (manualRf != null) capmQs.set("rf_annual", String(manualRf));
    if (accountId !== "all") capmQs.set("account_id", accountId);
    fetch(`/api/v2/portfolio/risk/capm?${capmQs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((cp) => setCapm(cp && !cp.error ? cp : null))
      .catch(() => {});
    return () => ac.abort();
  }, [accountId, benchmark, lookback, currency, rfOverride]);

  const thb_per_usd = summary?.thb_per_usd ?? 33.5;
  const sym = currency === "THB" ? "฿" : "$";

  // Explicit light text so tooltips stay readable without Dark Reader inverting them.
  const tooltipContentStyle = {
    background: "#111",
    border: "1px solid #333",
    fontSize: 10,
    color: "#e5e5e5",
  };
  const tooltipLabelStyle = { color: "#e5e5e5" };
  const tooltipItemStyle = { color: "#e5e5e5" };
  const economicPnlTitle =
    "Economic realized P&L = (entry cost + native P&L) × exit FX − entry cost × entry FX. Uses stored trade FX when available, otherwise dated market FX estimate. Includes principal FX attribution; broker-style realized P&L excludes it.";

  const monthData = (analytics?.by_month ?? []).map((m) => ({
    month: m.month,
    pnl: m.pnl,
    economic_pnl: m.economic_pnl ?? m.pnl,
    win_rate: m.win_rate,
  }));

  const cumulativeData = useMemo(() => {
    let cum = 0;
    let economicCum = 0;
    return monthData.map((m) => {
      cum += m.pnl;
      economicCum += m.economic_pnl;
      return { month: m.month, cumPnl: cum, economicCumPnl: economicCum };
    });
  }, [monthData]);

  const totalPnl = cumulativeData.at(-1)?.cumPnl ?? 0;
  const totalEconomicPnl = cumulativeData.at(-1)?.economicCumPnl ?? totalPnl;

  const divByMonth = useMemo(() => {
    const map: Record<string, number> = {};
    // biome-ignore lint/complexity/noForEach: pre-existing pattern
    dividends.forEach((d) => {
      const raw = d.pay_date || "";
      if (!raw) return;
      let key: string;
      if (divPeriod === "Y") {
        key = raw.slice(0, 4);
      } else if (divPeriod === "Q") {
        const month = Number.parseInt(raw.slice(5, 7), 10);
        if (!month) return;
        const q = Math.ceil(month / 3);
        key = `${raw.slice(0, 4)}-Q${q}`;
      } else {
        key = raw.slice(0, 7);
      }
      map[key] = (map[key] || 0) + (d.total_received_base ?? d.total_received);
    });
    return Object.entries(map)
      .sort()
      .map(([label, total]) => ({ month: label, total }));
  }, [dividends, divPeriod]);

  const accStats = summary?.accounts ?? [];
  const filteredStats =
    accountId === "all" ? accStats : accStats.filter((a) => a.account.id === accountId);

  // Capital snapshot — backend has already normalized every component to the active report currency.
  const capital = useMemo(() => {
    const realized = filteredStats.reduce((s, a) => s + (a.pnl_base ?? 0), 0);
    const economicRealized = filteredStats.reduce(
      (s, a) => s + (a.pnl_economic_base ?? a.pnl_base ?? 0),
      0
    );
    const invested = filteredStats.reduce(
      (s, a) => s + (a.total_invested_base ?? a.total_invested ?? 0),
      0
    );
    const dividends = filteredStats.reduce(
      (s, a) => s + (a.total_dividends_base ?? a.total_dividends ?? 0),
      0
    );
    let unrealized = 0;
    let openCost = 0;
    for (const p of openPos) {
      unrealized += p.unrealized_pnl_base ?? p.unrealized_pnl_thb ?? 0;
      openCost += p.cost_basis_base ?? p.amount ?? p.price_entry * p.volume;
    }
    // `pnl_base` already includes realized options — the backend folds them in
    // so TOTAL P&L and WIN RATE mean what they say. Adding
    // `options_realized_base` on top here would count every closed option
    // twice; it stays a breakdown field, not another term.
    const optionsOpenCost = filteredStats.reduce((s, a) => s + (a.options_cost_base ?? 0), 0);
    const optionsUnrealized = filteredStats.reduce(
      (s, a) => s + (a.options_unrealized_base ?? 0),
      0
    );
    // Open options are capital still deployed and still moving, so they belong
    // on both the cost and the unrealized side.
    openCost += optionsOpenCost;
    unrealized += optionsUnrealized;
    // The backend computes this from the same inputs; prefer it so ANALYTICS,
    // the header chip and the CASH tab cannot drift apart.
    const cash = summary?.total_cash_base ?? invested + realized + dividends - openCost;
    return {
      realized,
      economicRealized,
      unrealized,
      totalPnl: realized + unrealized,
      economicTotalPnl: economicRealized + unrealized,
      openCost,
      marketValue: openCost + unrealized,
      marketValueWithCash: openCost + unrealized + cash,
      invested,
      dividends,
      cash,
    };
  }, [filteredStats, openPos, summary]);

  // Per-account unrealized P&L + open cost basis (THB base), keyed by account id.
  const perAcctOpen = useMemo(() => {
    const map: Record<string, { unreal: number; openCost: number }> = {};
    for (const p of openPos) {
      const aid = p.account_id;
      if (!map[aid]) map[aid] = { unreal: 0, openCost: 0 };
      map[aid].unreal += p.unrealized_pnl_base ?? p.unrealized_pnl_thb ?? 0;
      map[aid].openCost += p.cost_basis_base ?? p.amount ?? p.price_entry * p.volume;
    }
    return map;
  }, [openPos]);

  // Total-return % per account: (realized + unrealized + dividends) / capital base.
  // Base = net deposits when available, else deployed cost basis. THB throughout.
  const acctReturn = (s: (typeof filteredStats)[number]) => {
    const realized = s.pnl_base ?? 0;
    const dividends = s.total_dividends_base ?? s.total_dividends ?? 0;
    const open = perAcctOpen[s.account.id] ?? { unreal: 0, openCost: 0 };
    const totalPnl = realized + open.unreal + dividends;
    const invested = s.total_invested_base ?? s.total_invested ?? 0;
    const base = invested > 0 ? invested : open.openCost;
    return {
      totalPnl,
      pct: base > 0 ? (totalPnl / base) * 100 : null,
      base,
    };
  };

  // THB base → active display currency
  const toDisp = (thb: number) => (currency === "USD" ? thb / thb_per_usd : thb);

  // Per-account sigma. `/risk/metrics` returns account_breakdown only when
  // fetched unfiltered ("all"); when a single account is selected the top-level
  // figure already IS that account's, so fall back to it instead of showing
  // blank on a single-account view.
  const acctVol = (accountId2: string) => {
    if (!vol) return null;
    if (vol.account_breakdown?.[accountId2]) return vol.account_breakdown[accountId2];
    if (accountId === accountId2) {
      return {
        volatility_daily_pct: vol.volatility_daily_pct,
        volatility_annual_pct: vol.volatility_annual_pct,
        vol_regime: vol.vol_regime,
      };
    }
    return null;
  };

  // NAV includes idle cash: a sale moves value from holdings into cash, so a
  // holdings-only line dipped on every sell and recovered on the next buy.
  const navAll = navHistory.map((r) => ({
    iso: typeof r.snapshot_date === "string" ? r.snapshot_date : "",
    date: typeof r.snapshot_date === "string" ? r.snapshot_date.slice(5) : r.snapshot_date,
    value: toDisp(r.nav_with_cash ?? r.total_value ?? 0),
    holdings: toDisp(r.total_value ?? 0),
    cash: toDisp(r.cash_balance ?? 0),
    cost: toDisp(r.open_cost_basis ?? 0),
  }));
  // Range cut is measured back from the last snapshot, not today — a book that
  // was last opened a week ago still shows a full month.
  const navData = (() => {
    const days = NAV_RANGES.find(([r]) => r === navRange)?.[1] ?? 0;
    const lastIso = navAll.at(-1)?.iso;
    if (!days || !lastIso) return navAll;
    const cutoff = new Date(Date.parse(lastIso) - days * 86_400_000).toISOString().slice(0, 10);
    return navAll.filter((r) => r.iso >= cutoff);
  })();

  // Backend trade_stats already arrives in the active display currency
  // (analytics is refetched with base_currency), so no toDisp() here.
  const ts = analytics?.trade_stats ?? null;

  // HIT RATE widens win rate to every position taken: closed winners plus open
  // positions currently in the money. Unlike WIN RATE it moves with live prices.
  const hitRate = useMemo(() => {
    if (!ts) return null;
    const openWinners = openPos.filter(
      (p) => (p.unrealized_pnl_base ?? p.unrealized_pnl_thb ?? 0) > 0
    ).length;
    const total = ts.closed + openPos.length;
    if (total === 0) return null;
    return { pct: ((ts.wins + openWinners) / total) * 100, hits: ts.wins + openWinners, total };
  }, [ts, openPos]);

  const capitalTiles: Array<{
    label: string;
    value: number;
    tone: "pnl" | "pos" | "neutral";
    hint: string;
    title?: string;
    secondaryLabel?: string;
    secondaryValue?: number;
    secondaryTitle?: string;
  }> = [
    {
      label: "REALIZED P&L",
      value: capital.realized,
      tone: "pnl",
      hint: "closed · broker-style",
      title:
        "Realized trading P&L = native closed-trade P&L × exit-date FX. Excludes principal FX attribution.",
      secondaryLabel: "ECON",
      secondaryValue: capital.economicRealized,
      secondaryTitle: economicPnlTitle,
    },
    { label: "UNREALIZED P&L", value: capital.unrealized, tone: "pnl", hint: "open" },
    {
      label: "TOTAL P&L",
      value: capital.totalPnl,
      tone: "pnl",
      hint: "realized + unrealized",
      secondaryLabel: "ECON TOTAL",
      secondaryValue: capital.economicTotalPnl,
      secondaryTitle: `${economicPnlTitle} Total economic P&L adds current unrealized P&L.`,
    },
    { label: "DIVIDENDS", value: capital.dividends, tone: "pos", hint: "received" },
    {
      label: "OPEN COST BASIS",
      value: capital.openCost,
      tone: "neutral",
      hint: "capital deployed",
    },
    {
      label: "MARKET VALUE",
      value: capital.marketValue,
      tone: "neutral",
      hint: "cost + unrealized",
      secondaryLabel: "+ CASH",
      secondaryValue: capital.marketValueWithCash,
      secondaryTitle: "Market value including estimated idle cash (see CASH tile).",
    },
    {
      label: "CASH",
      value: capital.cash,
      tone: "pnl",
      hint: "calculated · not tracked directly",
      title:
        "Approximate idle cash = invested capital + realized P&L (equities AND options) + dividends − open cost basis (equities AND options). Blind to commissions, taxes and margin interest that were never recorded, so treat as an estimate, not a broker balance.",
    },
    {
      label: "INVESTED CAPITAL",
      value: capital.invested,
      tone: "neutral",
      hint: "deposits",
    },
  ];

  const money = (v: number, signed = false) =>
    `${signed ? (v >= 0 ? "+" : "−") : v < 0 ? "−" : ""}${sym}${fmtK(Math.abs(v))}`;
  const capBase = capital.invested > 0 ? capital.invested : capital.openCost;
  const capBaseLabel = capital.invested > 0 ? "invested" : "cost basis";
  const totalReturnAmt = capital.totalPnl + capital.dividends;
  const totalReturnPct = capBase > 0 ? (totalReturnAmt / capBase) * 100 : null;
  const realizedPct = capBase > 0 ? (capital.realized / capBase) * 100 : null;
  const regimeColor = (r: VolRegime | undefined) =>
    r === "STRESSED" ? "#f87171" : r === "ELEVATED" ? "#fbbf24" : r === "CALM" ? "#4ade80" : "#555";
  const th = (label: string, align: "left" | "right" = "right", title?: string) => (
    <th
      key={label}
      className={`py-1 px-1.5 font-normal sticky top-0 text-${align}`}
      style={{ color: colors.textSecondary, background: "#050505" }}
      title={title}
    >
      {label}
    </th>
  );
  const rowStyle = { borderBottom: "1px solid #151515" };
  const hasCapital = openPos.length > 0 || filteredStats.length > 0;
  const breakdowns = [
    {
      title: "BY SECTOR",
      col: "SECTOR",
      rows: analytics?.by_sector ?? [],
      key: "sector",
      mid: "win_rate",
      limit: 8,
    },
    {
      title: "TOP SYMBOLS",
      col: "SYMBOL",
      rows: analytics?.top_symbols ?? [],
      key: "symbol",
      mid: "cnt",
      limit: 10,
    },
    {
      title: "BY SUB-PORT",
      col: "SUB-PORT",
      rows: analytics?.by_subport ?? [],
      key: "subport",
      mid: "win_rate",
      limit: 10,
    },
  ] as const;

  return (
    <div
      className="overflow-y-auto overflow-x-hidden p-2 flex flex-col gap-2"
      style={{ maxHeight: "calc(100vh - 220px)" }}
    >
      {/* ── KPI strip — the eight numbers a book is judged on ─────────────── */}
      {hasCapital && (
        <div
          className="grid gap-px grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 border"
          style={{ borderColor: colors.border, background: colors.border }}
        >
          <Kpi
            colors={colors}
            label="NAV"
            value={money(capital.marketValueWithCash)}
            sub={`MV ${money(capital.marketValue)} + cash ${money(capital.cash)}`}
            title="Market value of open positions (equities + options) plus estimated idle cash"
          />
          <Kpi
            colors={colors}
            label="TOTAL RETURN"
            value={sgnPct(totalReturnPct, 2)}
            color={pnlColor(totalReturnAmt)}
            sub={`${money(totalReturnAmt, true)} / ${capBaseLabel}`}
            title="(realized + unrealized + dividends) ÷ invested capital (cost basis when no deposits are recorded)"
          />
          <Kpi
            colors={colors}
            label="UNREALIZED"
            value={money(capital.unrealized, true)}
            color={pnlColor(capital.unrealized)}
            sub={`on ${money(capital.openCost)} open cost`}
          />
          <Kpi
            colors={colors}
            label="REALIZED"
            value={money(capital.realized, true)}
            color={pnlColor(capital.realized)}
            sub={`ECON ${money(capital.economicRealized, true)}`}
            title={`Broker-style realized P&L (closed trades, exit-date FX). ECON: ${economicPnlTitle}`}
          />
          <Kpi
            colors={colors}
            label="DIVIDENDS"
            value={money(capital.dividends)}
            color="#4ade80"
            sub="received"
          />
          <Kpi
            colors={colors}
            label="XIRR"
            value={sgnPct(rets?.total?.xirr_pct)}
            color={rets?.total?.xirr_pct == null ? "#555" : pnlColor(rets.total.xirr_pct)}
            sub={`CAGR ${sgnPct(rets?.total?.cagr_pct)} · ${rets?.total?.holding_days ?? "—"}d`}
            title="Money-weighted IRR from dated cashflows, annualized. CAGR = cost-based time growth of deployed capital."
          />
          <Kpi
            colors={colors}
            label="WIN RATE"
            value={ts?.win_rate == null ? "—" : `${ts.win_rate.toFixed(1)}%`}
            color={ts?.win_rate == null ? "#555" : ts.win_rate >= 50 ? "#4ade80" : "#f87171"}
            sub={
              ts
                ? `${ts.wins}W / ${ts.losses}L · payoff ${ts.payoff == null ? "—" : `${ts.payoff.toFixed(2)}×`}`
                : "no closed trades"
            }
            title="Winning closed trades ÷ closed trades; payoff = avg win ÷ |avg loss|"
          />
          <Kpi
            colors={colors}
            label="VOLATILITY"
            value={vol ? `${vol.volatility_annual_pct.toFixed(1)}%` : "—"}
            color={vol ? regimeColor(vol.vol_regime) : "#555"}
            sub={
              vol
                ? `σ ann · ${vol.volatility_daily_pct.toFixed(2)}%/d${vol.vol_regime !== "UNKNOWN" ? ` · ${vol.vol_regime}` : ""}`
                : "σ unavailable"
            }
            title="Standard deviation of the open book's daily log returns, 252d lookback"
          />
        </div>
      )}

      {/* ── NAV + CAPITAL ledger ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
        {navAll.length > 0 && (
          <Card
            colors={colors}
            className="xl:col-span-2"
            title={
              navMode === "GROWTH"
                ? "PORTFOLIO GROWTH"
                : navMode === "VALUE"
                  ? "PORTFOLIO VALUE (NAV)"
                  : `EQUITY CURVE vs ${benchmark}`
            }
            sub={
              navAll.length < 2
                ? "เก็บข้อมูลรายวัน — กราฟจะสมบูรณ์ขึ้นเมื่อมีหลายวัน"
                : navMode === "GROWTH"
                  ? "time-weighted growth · ▲ deposit ▼ withdrawal · monthly table"
                  : navMode === "VALUE"
                    ? "daily snapshot · money in the book"
                    : "time-weighted · flows removed · rebased 100"
            }
            right={
              <>
                {navMode === "VALUE" && (
                  <>
                    <Seg
                      colors={colors}
                      options={NAV_RANGES.map(([r]) => [r, r] as const)}
                      value={navRange}
                      onChange={setNavRange}
                    />
                    <span style={{ color: "#333" }}>│</span>
                  </>
                )}
                <Seg
                  colors={colors}
                  options={[
                    ["GROWTH", "GROWTH"],
                    ["VALUE", "VALUE"],
                    ["INDEX", "INDEX"],
                  ]}
                  value={navMode}
                  onChange={setNavMode}
                />
              </>
            }
            note={
              navMode === "GROWTH" ? (
                <>
                  Growth = ผลตอบแทนแบบ time-weighted: r = (NAV − flow − NAV₋₁) / NAV₋₁ ต่อวัน แล้วคูณทบ
                  — ฝาก/ถอนเงินไม่ทำให้เส้นขยับ (▲ เขียว = ฝาก, ▼ แดง = ถอน). เส้นเทา = เส้นแนวโน้ม
                  least-squares. ตาราง = ผลตอบแทนทบรายเดือน / รายปี. Average =
                  ค่าเฉลี่ยของผลตอบแทนรายเดือน. ข้อมูลเริ่มจาก snapshot NAV รายวันวันแรก (เก็บตอนเปิดหน้า) —
                  เดือนแรกไม่เต็มเดือน (*). วันที่ NAV ขยับเกิน 50% ถูกนับว่าน่าสงสัย (มักเป็นเงินฝาก/ถอนที่ยังไม่บันทึก)
                </>
              ) : navMode === "VALUE" ? (
                <>
                  NAV = HOLDINGS + CASH — ขายของแล้วเงินย้ายจากเส้นม่วงไปเส้นเหลือง NAV ไม่ขยับ. เส้นประคือต้นทุน
                  ช่องว่างระหว่าง HOLDINGS กับ COST = กำไร/ขาดทุนที่ยังไม่ขาย. คลิกชื่อเส้นเพื่อซ่อน. VALUE
                  ขยับตามเงินฝาก/ถอน จึงเทียบกับดัชนีตรงๆ ไม่ได้ — ใช้ INDEX.
                </>
              ) : (
                <>
                  Time-weighted: r = (NAV − flow − NAV₋₁) / NAV₋₁ ต่อวัน แล้วคูณทบ —
                  เงินฝาก/ถอนถูกหักออกก่อน จึงเทียบกับดัชนีได้ตรงๆ (ต่างจาก XIRR ซึ่งเป็น money-weighted).
                  ดัชนีแปลงเป็น {navIndex?.base_currency ?? currency} ก่อน rebase แล้ว
                </>
              )
            }
          >
            {navMode === "GROWTH" ? (
              <NavGrowthChart
                data={navIndex}
                loading={navIndexLoading}
                colors={colors}
                height={230}
              />
            ) : navMode === "INDEX" ? (
              <NavIndexChart
                data={navIndex}
                loading={navIndexLoading}
                colors={colors}
                benchmark={benchmark}
                tooltipContentStyle={tooltipContentStyle}
                tooltipLabelStyle={tooltipLabelStyle}
                tooltipItemStyle={tooltipItemStyle}
                height={260}
              />
            ) : (
              <NavValueChart
                data={navData}
                colors={colors}
                sym={sym}
                tooltipContentStyle={tooltipContentStyle}
                height={260}
              />
            )}
          </Card>
        )}

        {hasCapital && (
          <Card
            colors={colors}
            className={navAll.length > 0 ? "" : "xl:col-span-3"}
            title="CAPITAL"
            sub={`${currency} · report currency`}
            note="Approximate idle cash = invested capital + realized P&L (equities AND options) + dividends − open cost basis (equities AND options). Blind to commissions, taxes and margin interest that were never recorded, so treat as an estimate, not a broker balance. Realized P&L already includes closed options."
          >
            <LedgerRow
              colors={colors}
              label="INVESTED CAPITAL"
              hint="deposits"
              value={money(capital.invested)}
            />
            <LedgerRow
              colors={colors}
              label="OPEN COST BASIS"
              hint="deployed"
              value={money(capital.openCost)}
            />
            <LedgerRow
              colors={colors}
              label="+ UNREALIZED"
              value={money(capital.unrealized, true)}
              color={pnlColor(capital.unrealized)}
            />
            <LedgerRow
              colors={colors}
              label="= MARKET VALUE"
              value={money(capital.marketValue)}
              strong
            />
            <LedgerRow
              colors={colors}
              label="+ CASH"
              hint="estimated"
              value={money(capital.cash)}
              color={pnlColor(capital.cash)}
            />
            <LedgerRow
              colors={colors}
              label="= NAV"
              value={money(capital.marketValueWithCash)}
              strong
            />

            <LedgerRow
              colors={colors}
              rule
              label="REALIZED P&L"
              hint={`ECON ${money(capital.economicRealized, true)}`}
              value={money(capital.realized, true)}
              color={pnlColor(capital.realized)}
              title={economicPnlTitle}
            />
            <LedgerRow
              colors={colors}
              label="+ UNREALIZED"
              value={money(capital.unrealized, true)}
              color={pnlColor(capital.unrealized)}
            />
            <LedgerRow
              colors={colors}
              label="+ DIVIDENDS"
              value={money(capital.dividends, true)}
              color="#4ade80"
            />
            <LedgerRow
              colors={colors}
              label="= TOTAL RETURN"
              hint={`÷ ${capBaseLabel}`}
              value={
                <>
                  {sgnPct(totalReturnPct, 2)}{" "}
                  <span className="text-[9px] font-normal" style={{ color: colors.textSecondary }}>
                    {money(totalReturnAmt, true)}
                  </span>
                </>
              }
              color={pnlColor(totalReturnAmt)}
              strong
            />

            <LedgerRow
              colors={colors}
              rule
              label="REALIZED RETURN"
              hint="trading skill"
              value={sgnPct(realizedPct, 2)}
              color={pnlColor(capital.realized)}
              title="Realized P&L ÷ invested — closed-trade skill only, excludes unrealized"
            />
            {summary?.total_ytd_realized_base != null && accountId === "all" && (
              <LedgerRow
                colors={colors}
                label="YTD REALIZED"
                hint={`${summary.ytd_year ?? "this year"}${
                  summary.total_ytd_economic_realized_base != null
                    ? ` · ECON ${money(summary.total_ytd_economic_realized_base, true)}`
                    : ""
                }`}
                value={money(summary.total_ytd_realized_base, true)}
                color={pnlColor(summary.total_ytd_realized_base)}
                title={economicPnlTitle}
              />
            )}
            {rets?.total && (
              <LedgerRow
                colors={colors}
                label="CAGR / XIRR"
                hint={`${rets.total.holding_days}d since ${rets.total.first_date ?? "—"}`}
                value={`${sgnPct(rets.total.cagr_pct, 2)} / ${sgnPct(rets.total.xirr_pct, 2)}`}
                color={rets.total.xirr_pct == null ? "#555" : pnlColor(rets.total.xirr_pct)}
                title="CAGR: time-weighted growth of deployed cost. XIRR: money-weighted IRR from dated cashflows. Both annualized."
              />
            )}
          </Card>
        )}
      </div>

      {/* ── Accounts side by side ─────────────────────────────────────────── */}
      {filteredStats.length > 0 && (
        <Card
          colors={colors}
          title="ACCOUNTS"
          sub={`${filteredStats.length} account${filteredStats.length > 1 ? "s" : ""} · P&L / DIV / YTD in account currency`}
          note="TOT RET = (realized + unrealized + dividends) ÷ invested (cost basis when no deposits). REAL RET = realized ÷ same base. CAGR = time-weighted growth of deployed cost; XIRR = money-weighted IRR from dated cashflows. σ = daily log-return stdev, 252d."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[9px] font-mono whitespace-nowrap">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {th("ACCOUNT", "left")}
                  {th("TRADES")}
                  {th("WIN%")}
                  {th("W / L")}
                  {th("OPEN")}
                  {th("P&L")}
                  {th("DIV")}
                  {th("TOT RET", "right", "(realized + unrealized + div) ÷ invested")}
                  {th("REAL RET", "right", "Realized P&L ÷ invested — excludes unrealized")}
                  {th("YTD REAL", "right", "Realized trading P&L closed this year")}
                  {th("CAGR", "right", "Time-weighted growth of deployed cost, annualized")}
                  {th("XIRR", "right", "Money-weighted IRR from dated cashflows, annualized")}
                  {th("σ D / ANN", "right", "Stdev of daily log returns, 252d lookback")}
                </tr>
              </thead>
              <tbody>
                {filteredStats.map((s) => {
                  const ccy = s.account.currency === "USD" ? "$" : "฿";
                  const r = acctReturn(s);
                  const realized = s.pnl_base ?? 0;
                  const rp = r.base > 0 ? (realized / r.base) * 100 : null;
                  const rr = rets?.accounts?.[s.account.id];
                  const av = acctVol(s.account.id);
                  const td = "py-1 px-1.5 text-right";
                  return (
                    <tr key={s.account.id} style={rowStyle}>
                      <td className="py-1 px-1.5">
                        <AccBadge account={s.account} small />
                      </td>
                      <td className={td} style={{ color: colors.text }}>
                        {s.total_trades}
                      </td>
                      <td
                        className={td}
                        style={{ color: s.win_rate >= 50 ? "#4ade80" : "#f87171" }}
                      >
                        {s.win_rate.toFixed(1)}%
                      </td>
                      <td className={td} style={{ color: colors.textSecondary }}>
                        {s.wins} / {s.losses}
                      </td>
                      <td className={td} style={{ color: "#ff9900" }}>
                        {s.open_count}
                      </td>
                      <td className={`${td} font-bold`} style={{ color: pnlColor(s.pnl_native) }}>
                        {s.pnl_native >= 0 ? "+" : "−"}
                        {ccy}
                        {fmtK(Math.abs(s.pnl_native))}
                      </td>
                      <td className={td} style={{ color: "#4ade80" }}>
                        {ccy}
                        {fmtK(s.total_dividends)}
                      </td>
                      <td className={`${td} font-bold`} style={{ color: pnlColor(r.totalPnl) }}>
                        {sgnPct(r.pct)}
                      </td>
                      <td
                        className={td}
                        style={{ color: rp == null ? "#555" : pnlColor(realized) }}
                      >
                        {sgnPct(rp)}
                      </td>
                      <td
                        className={td}
                        style={{
                          color:
                            s.ytd_realized_native == null
                              ? "#555"
                              : pnlColor(s.ytd_realized_native),
                        }}
                        title={`${s.ytd_closed ?? 0} trades closed in ${summary?.ytd_year ?? "this year"}`}
                      >
                        {s.ytd_realized_native == null
                          ? "—"
                          : `${s.ytd_realized_native >= 0 ? "+" : "−"}${ccy}${fmtK(Math.abs(s.ytd_realized_native))}`}
                      </td>
                      <td
                        className={td}
                        style={{ color: rr?.cagr_pct == null ? "#555" : pnlColor(rr.cagr_pct) }}
                      >
                        {sgnPct(rr?.cagr_pct)}
                      </td>
                      <td
                        className={td}
                        style={{ color: rr?.xirr_pct == null ? "#555" : pnlColor(rr.xirr_pct) }}
                      >
                        {sgnPct(rr?.xirr_pct)}
                      </td>
                      <td className={td} style={{ color: colors.text }}>
                        {av ? (
                          <>
                            {av.volatility_daily_pct.toFixed(2)}% /{" "}
                            {av.volatility_annual_pct.toFixed(1)}%
                            {av.vol_regime !== "UNKNOWN" && (
                              <span className="ml-1" style={{ color: regimeColor(av.vol_regime) }}>
                                {av.vol_regime}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── The book's own rotation map ──────────────────────────────────── */}
      <Card
        colors={colors}
        title="PORTFOLIO ROTATION"
        sub={`open-lot cost at week end · ${currency} · by ${rotGroup}`}
        right={
          <>
            <Seg
              colors={colors}
              options={[
                ["THEME", "theme"],
                ["SECTOR", "sector"],
                ["ACCOUNT", "account"],
              ]}
              value={rotGroup}
              onChange={setRotGroup}
            />
            <span style={{ color: "#333" }}>│</span>
            <Seg
              colors={colors}
              options={[
                [sym, "COST"],
                ["%", "SHARE"],
              ]}
              value={rotMode}
              onChange={setRotMode}
            />
          </>
        }
        note={
          <>
            ต้นทุนของล็อตที่ยังเปิดอยู่ ณ สิ้นแต่ละสัปดาห์ (FX วันเข้า) ไม่ใช่มูลค่าตลาด — แถบหนาขึ้น = เงินย้ายเข้า, บางลง =
            เงินออก; ราคาหุ้นขยับไม่ทำให้แถบเปลี่ยน. % = สัดส่วนของต้นทุนที่เปิดอยู่ สัปดาห์นั้น. เส้นแดง = ต้นทุนรวมลด ≥20%
            ในสัปดาห์เดียว. THEME: MEMORY (MU SNDK SKHU) · COMPUTE (AMD AVGO TSM INTC NBIS) · PLATFORM
            (GOOGL GOOG MSFT ORCL NFLX) · POWER (GRID SMR DELTA RKLB) · DEFENSIVE (KO COST UNH ABBV
            BH) · HEDGE (GC=F SGOV VT) · CRYPTO · หุ้นไทยอื่น = TH LEGACY · ที่เหลือ = OTHER (แก้ใน
            backend/portfolio_rotation.py). ไม่รวม options.
          </>
        }
      >
        <PortfolioRotationChart
          accountId={accountId}
          currency={currency}
          group={rotGroup}
          mode={rotMode}
          colors={colors}
        />
      </Card>

      {/* ── Monthly P&L + trade stats ─────────────────────────────────────── */}
      {(monthData.length > 0 || (ts && ts.closed > 0)) && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
          {monthData.length > 0 && (
            <Card
              colors={colors}
              className={ts && ts.closed > 0 ? "xl:col-span-2" : "xl:col-span-3"}
              title="MONTHLY P&L"
              sub={
                <>
                  total <span style={{ color: pnlColor(totalPnl) }}>{money(totalPnl, true)}</span> ·
                  ECON{" "}
                  <span style={{ color: pnlColor(totalEconomicPnl) }}>
                    {money(totalEconomicPnl, true)}
                  </span>
                </>
              }
              right={
                <Seg
                  colors={colors}
                  options={[
                    ["CHART", "CHART"],
                    ["TABLE", "TABLE"],
                  ]}
                  value={monthlyView}
                  onChange={setMonthlyView}
                />
              }
              note={`Bars = realized P&L closed in the month (left axis); blue line = running total (right axis). ${economicPnlTitle}`}
            >
              {monthlyView === "CHART" ? (
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart
                    data={monthData.map((m, i) => ({
                      ...m,
                      cumPnl: cumulativeData[i]?.cumPnl ?? 0,
                    }))}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: "#666", fontSize: 8 }} tickLine={false} />
                    <YAxis
                      yAxisId="m"
                      tick={{ fill: "#666", fontSize: 8 }}
                      tickLine={false}
                      axisLine={false}
                      // Always include the zero baseline so bar heights stay proportional
                      domain={[
                        (min: number) => Math.min(0, min),
                        (max: number) => Math.max(0, max),
                      ]}
                      tickFormatter={(v) => fmtK(v)}
                    />
                    <YAxis
                      yAxisId="c"
                      orientation="right"
                      tick={{ fill: "#60a5fa", fontSize: 8 }}
                      tickLine={false}
                      axisLine={false}
                      domain={[
                        (min: number) => Math.min(0, min),
                        (max: number) => Math.max(0, max),
                      ]}
                      tickFormatter={(v) => fmtK(v)}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        const row = payload?.[0]?.payload as
                          | {
                              pnl?: number;
                              economic_pnl?: number;
                              cumPnl?: number;
                              win_rate?: number | null;
                            }
                          | undefined;
                        if (!active || !row) return null;
                        const pnl = row.pnl ?? 0;
                        const economicPnl = row.economic_pnl ?? pnl;
                        return (
                          <div style={{ ...tooltipContentStyle, padding: 6 }}>
                            <div style={tooltipLabelStyle}>{label}</div>
                            <div style={{ color: pnlColor(pnl) }}>P&L {money(pnl, true)}</div>
                            <div style={{ color: pnlColor(economicPnl) }}>
                              ECON {money(economicPnl, true)}
                            </div>
                            <div style={{ color: pnlColor(row.cumPnl ?? 0) }}>
                              Cumulative {money(row.cumPnl ?? 0, true)}
                            </div>
                            {row.win_rate != null && (
                              <div style={{ color: "#aaa" }}>Win {row.win_rate.toFixed(0)}%</div>
                            )}
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine yAxisId="m" y={0} stroke="#444" />
                    <Bar
                      yAxisId="m"
                      dataKey="pnl"
                      radius={[2, 2, 0, 0]}
                      maxBarSize={36}
                      isAnimationActive={false}
                    >
                      {monthData.map((m, i) => (
                        <Cell
                          // biome-ignore lint/suspicious/noArrayIndexKey: stable month order
                          key={i}
                          fill={m.pnl >= 0 ? "#22c55e" : "#ef4444"}
                          fillOpacity={0.8}
                        />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="c"
                      dataKey="cumPnl"
                      stroke="#60a5fa"
                      strokeWidth={1.6}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                        {th("MONTH", "left")}
                        {th("P&L")}
                        {th("ECON", "right", economicPnlTitle)}
                        {th("WIN%")}
                        {th("CUMULATIVE")}
                      </tr>
                    </thead>
                    <tbody>
                      {monthData.map((m, i) => (
                        <tr key={m.month} style={rowStyle}>
                          <td className="py-0.5 px-1.5" style={{ color: colors.text }}>
                            {m.month}
                          </td>
                          <td
                            className="text-right py-0.5 px-1.5 font-bold"
                            style={{ color: pnlColor(m.pnl) }}
                          >
                            {money(m.pnl, true)}
                          </td>
                          <td
                            className="text-right py-0.5 px-1.5"
                            style={{ color: pnlColor(m.economic_pnl) }}
                          >
                            {money(m.economic_pnl, true)}
                          </td>
                          <td
                            className="text-right py-0.5 px-1.5"
                            style={{ color: m.win_rate >= 50 ? "#4ade80" : "#f87171" }}
                          >
                            {m.win_rate != null ? `${m.win_rate.toFixed(0)}%` : "—"}
                          </td>
                          <td
                            className="text-right py-0.5 px-1.5"
                            style={{ color: pnlColor(cumulativeData[i]?.cumPnl ?? 0) }}
                          >
                            {money(cumulativeData[i]?.cumPnl ?? 0, true)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                        <td
                          className="py-1 px-1.5 font-bold"
                          style={{ color: colors.textSecondary }}
                        >
                          TOTAL
                        </td>
                        <td
                          className="text-right py-1 px-1.5 font-bold"
                          style={{ color: pnlColor(totalPnl) }}
                        >
                          {money(totalPnl, true)}
                        </td>
                        <td
                          className="text-right py-1 px-1.5 font-bold"
                          style={{ color: pnlColor(totalEconomicPnl) }}
                        >
                          {money(totalEconomicPnl, true)}
                        </td>
                        <td />
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Card>
          )}

          {ts && ts.closed > 0 && (
            <Card
              colors={colors}
              className={monthData.length > 0 ? "" : "xl:col-span-3"}
              title="TRADE STATS"
              sub={`${ts.closed} closed${openPos.length > 0 ? ` · ${openPos.length} open` : ""}`}
              note="WIN RATE excludes open positions; HIT RATE adds open positions currently in profit and moves with live prices. AVG WIN/LOSS are in the display currency; the small % is the mean return on cost in each trade's own currency. Expectancy = win rate × avg win + loss rate × avg loss — the average P&L a new trade is worth at this win rate and payoff."
            >
              <div className="grid grid-cols-3 gap-px" style={{ background: "#151515" }}>
                {[
                  {
                    label: "WIN RATE",
                    value: ts.win_rate == null ? "—" : `${ts.win_rate.toFixed(1)}%`,
                    pct: null as string | null,
                    color: ts.win_rate == null ? "#555" : ts.win_rate >= 50 ? "#4ade80" : "#f87171",
                    hint: `${ts.wins}W / ${ts.losses}L`,
                  },
                  {
                    label: "HIT RATE",
                    value: hitRate == null ? "—" : `${hitRate.pct.toFixed(1)}%`,
                    pct: null,
                    color: hitRate == null ? "#555" : hitRate.pct >= 50 ? "#4ade80" : "#f87171",
                    hint: hitRate == null ? "—" : `${hitRate.hits} / ${hitRate.total} incl. open`,
                  },
                  {
                    label: "W/L RATIO",
                    value: ts.wl_ratio == null ? "—" : `${ts.wl_ratio.toFixed(2)}×`,
                    pct: null,
                    color: ts.wl_ratio == null ? "#555" : ts.wl_ratio >= 1 ? "#4ade80" : "#f87171",
                    hint: "count",
                  },
                  {
                    label: "AVG WIN",
                    value: ts.avg_win == null ? "—" : money(Math.abs(ts.avg_win)),
                    pct: fmtPct(ts.avg_win_pct),
                    color: ts.avg_win == null ? "#555" : "#4ade80",
                    hint: "per winner",
                  },
                  {
                    label: "AVG LOSS",
                    value: ts.avg_loss == null ? "—" : money(Math.abs(ts.avg_loss)),
                    pct: fmtPct(ts.avg_loss_pct),
                    color: ts.avg_loss == null ? "#555" : "#f87171",
                    hint: "per loser",
                  },
                  {
                    label: "PAYOFF",
                    value: ts.payoff == null ? "—" : `${ts.payoff.toFixed(2)}×`,
                    pct: null,
                    color: ts.payoff == null ? "#555" : ts.payoff >= 1 ? "#4ade80" : "#f87171",
                    hint: "avg win ÷ avg loss",
                  },
                ].map((t) => (
                  <div key={t.label} className="p-2" style={{ background: "#080808" }}>
                    <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                      {t.label}
                    </div>
                    <div className="flex items-baseline gap-1 mt-0.5" style={{ color: t.color }}>
                      <span className="text-[12px] font-mono font-bold">{t.value}</span>
                      {t.pct && <span className="text-[8px] font-mono opacity-70">{t.pct}</span>}
                    </div>
                    <div className="text-[7px] font-mono mt-0.5" style={{ color: "#555" }}>
                      {t.hint}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-1 border-t" style={{ borderColor: "#1a1a1a" }}>
                <LedgerRow
                  colors={colors}
                  label="EXPECTANCY / TRADE"
                  value={
                    <>
                      {ts.expectancy == null ? "—" : money(ts.expectancy, true)}
                      {fmtPct(ts.expectancy_pct) && (
                        <span className="ml-1 text-[9px] opacity-70">
                          {fmtPct(ts.expectancy_pct)}
                        </span>
                      )}
                    </>
                  }
                  color={ts.expectancy == null ? "#555" : pnlColor(ts.expectancy)}
                  strong
                />
                <LedgerRow
                  colors={colors}
                  label="WON / LOST"
                  value={
                    <>
                      <span style={{ color: "#4ade80" }}>{money(Math.abs(ts.total_win))}</span>
                      {" / "}
                      <span style={{ color: "#f87171" }}>{money(Math.abs(ts.total_loss))}</span>
                    </>
                  }
                />
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── CAPM ──────────────────────────────────────────────────────────── */}
      {capm && (
        <Card
          colors={colors}
          title="RISK-ADJUSTED (CAPM)"
          sub={
            <>
              vs {capm.benchmark} · β for hedging · α = RET − EXPECT
              {capm.rf_annual != null && (
                <button
                  type="button"
                  onClick={() => {
                    setRfDraft(
                      rfOverride[currency] != null
                        ? String((rfOverride[currency] as number) * 100)
                        : ((capm.rf_annual ?? 0) * 100).toFixed(2)
                    );
                    setRfPanel((v) => !v);
                  }}
                  className="ml-1 underline decoration-dotted"
                  style={{
                    color: rfOverride[currency] != null ? colors.accent : colors.textSecondary,
                  }}
                  title={`Risk-free rate used in the CAPM expectation. Quoted in ${
                    capm.rf_currency ?? "the report currency"
                  } to match the returns, and at a short horizon to match the daily interval. Source: ${
                    capm.rf_source ?? "—"
                  }${capm.rf_as_of ? ` · as of ${capm.rf_as_of}` : ""}. Click to override.`}
                >
                  · rf {(capm.rf_annual * 100).toFixed(2)}% {capm.rf_currency ?? ""} (
                  {capm.rf_series ?? capm.rf_source ?? "—"}
                  {capm.rf_as_of ? `, ${String(capm.rf_as_of).slice(0, 10)}` : ""}) ✎
                </button>
              )}
            </>
          }
          right={
            <>
              <Seg
                colors={colors}
                options={[
                  ["1M", 21],
                  ["3M", 63],
                  ["6M", 126],
                  ["1Y", 252],
                ]}
                value={lookback}
                onChange={setLookback}
              />
              <span style={{ color: "#333" }}>│</span>
              <Seg
                colors={colors}
                options={[
                  ["SPY", "SPY"],
                  ["QQQ", "QQQ"],
                  ["ACWI", "ACWI"],
                ]}
                value={benchmark}
                onChange={setBenchmark}
              />
            </>
          }
          note={
            <>
              <b>α = RET − EXPECT</b> where EXPECT = rf + β × (IDX − rf) — every number on the row
              is on screen, so the arithmetic checks by hand. RET is the money-weighted XIRR over
              each account&apos;s own span and IDX covers that same span (hover for XIRR and the
              cumulative index move). β is the book held today, in {currency}, which is also what
              sizes the HEDGE column: β × market value = the {capm.benchmark} notional that offsets
              the book. Nothing here reads the trade log&apos;s DATES — they carry bulk-import
              placeholders, and a date-driven version of this table reported +96% alpha for an
              account that returned 3.3%/yr. Greyed α = R² &lt; 0.10 ⚠, i.e. the wrong benchmark for
              this book, not low risk. rf = {capm.rf_source ?? "—"}
              {capm.rf_as_of ? ` (${String(capm.rf_as_of).slice(0, 10)})` : ""}, quoted in{" "}
              {capm.rf_currency ?? "the report currency"} to match the returns. Benchmark data
              through {capm.benchmark_last_date ?? "—"}.
            </>
          }
        >
          {rfPanel && (
            <div
              className="mb-2 border p-2 text-[8px]"
              style={{ borderColor: colors.accent, background: "#0a0a0a" }}
            >
              <div className="font-bold tracking-widest mb-1" style={{ color: colors.accent }}>
                RISK-FREE RATE — {currency}
              </div>
              <div className="mb-2" style={{ color: colors.textSecondary }}>
                Must be quoted in the currency the returns are in, at a short horizon to match the
                daily interval. A US Treasury yield against a THB series books the THB–USD rate
                differential as negative alpha; a 10-year yield charges the book for duration it
                does not hold.
              </div>
              <div className="grid gap-px mb-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {Object.entries(rfRates?.rates ?? {}).map(([ccy, r]) => (
                  <div
                    key={ccy}
                    className="px-1.5 py-1"
                    style={{
                      background: "#050505",
                      border: `1px solid ${ccy === currency ? colors.accent : "transparent"}`,
                    }}
                  >
                    <div style={{ color: ccy === currency ? colors.accent : colors.textSecondary }}>
                      {ccy} {ccy === currency ? "(active)" : "(reference)"}
                    </div>
                    <div className="font-bold font-mono" style={{ color: colors.text }}>
                      {(r.rate * 100).toFixed(2)}%
                    </div>
                    <div style={{ color: "#555" }}>
                      {r.source}
                      {r.as_of ? ` · ${String(r.as_of).slice(0, 10)}` : ""}
                    </div>
                  </div>
                ))}
              </div>
              {(rfRates?.alternatives ?? []).length > 1 && (
                <div className="mb-2" style={{ color: colors.textSecondary }}>
                  other sources for USD:{" "}
                  {(rfRates?.alternatives ?? []).map((a) => (
                    <button
                      type="button"
                      key={a.series ?? a.source}
                      onClick={() => setRfDraft((a.rate * 100).toFixed(2))}
                      className="mr-2 underline decoration-dotted"
                      style={{ color: colors.accent }}
                      title={`${a.source}${a.as_of ? ` · ${a.as_of}` : ""} — click to load into the override box`}
                    >
                      {a.series ?? a.source} {(a.rate * 100).toFixed(2)}%
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1">
                <span style={{ color: colors.textSecondary }}>Override {currency} rf:</span>
                <input
                  value={rfDraft}
                  onChange={(e) => setRfDraft(e.target.value)}
                  placeholder={((rfRates?.rates?.[currency]?.rate ?? 0) * 100).toFixed(2)}
                  className="w-14 border px-1 py-0.5 text-right font-mono outline-none"
                  style={{ borderColor: colors.border, color: colors.text, background: "#050505" }}
                />
                <span style={{ color: colors.textSecondary }}>% / yr</span>
                <button
                  type="button"
                  onClick={() => {
                    const v = Number.parseFloat(rfDraft);
                    if (!Number.isFinite(v)) return;
                    setRfOverride((o) => ({ ...o, [currency]: v / 100 }));
                    setRfPanel(false);
                  }}
                  className="px-1.5 py-0.5 border font-bold"
                  style={{ borderColor: colors.accent, color: colors.accent }}
                >
                  APPLY
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRfOverride((o) => ({ ...o, [currency]: null }));
                    setRfPanel(false);
                  }}
                  className="px-1.5 py-0.5 border font-bold"
                  style={{ borderColor: colors.border, color: colors.textSecondary }}
                  title="Go back to the live rate for this currency"
                >
                  USE LIVE
                </button>
                {rfOverride[currency] != null && (
                  <span style={{ color: colors.accent }}>
                    manual override active — live is{" "}
                    {((rfRates?.rates?.[currency]?.rate ?? 0) * 100).toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          )}
          {!capm.benchmark_available ? (
            <div className="text-[8px] py-2 text-center" style={{ color: colors.textSecondary }}>
              Benchmark data unavailable
            </div>
          ) : (
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {[
                    ["PORT", "left", ""],
                    [
                      "β HEDGE",
                      "right",
                      `Beta of the book you hold TODAY — the one to size a hedge with. Both sides in ${currency}, so a foreign holding's currency move counts as risk (β ${capm.benchmark_currency ?? "LOC"} in the tooltip leaves them native)`,
                    ],
                    [
                      "HEDGE",
                      "right",
                      `Index notional that offsets the book: β × market value. Short this much ${capm.benchmark} to run market-neutral`,
                    ],
                    [
                      "RET",
                      "right",
                      "Money-weighted annualized return (XIRR) over this account's own span — the rate your actual cashflows earned. Hover for the cost-based CAGR, which divides by every buy ever made and so understates any account that recycles capital",
                    ],
                    [
                      "IDX",
                      "right",
                      `${capm.benchmark} annualized over the SAME span — an index number from a different window is not a comparison`,
                    ],
                    [
                      "EXPECT",
                      "right",
                      "What CAPM says the risk taken should have paid: rf + β × (IDX − rf). α is simply RET − EXPECT, so the row checks by hand",
                    ],
                    ["α", "right", "RET − EXPECT: return beyond what the risk was owed"],
                    [
                      "R²",
                      "right",
                      "Share of the book's variance the benchmark explains. Below 0.10 the benchmark is the wrong market and β — so also α — means nothing",
                    ],
                  ].map(([h, align, tip]) => (
                    <th
                      key={h}
                      className={`py-0.5 text-${align}`}
                      style={{ color: colors.textSecondary }}
                      title={tip || undefined}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ...Object.entries(capm.accounts ?? {}).map(([id, row]) => ({
                    id,
                    label: row.name ?? id,
                    row,
                    bold: false,
                  })),
                  { id: "__total__", label: "TOTAL", row: capm.portfolio, bold: true },
                ].map(({ id, label, row, bold }) => (
                  <tr key={id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td
                      className="py-0.5"
                      style={{
                        color: bold ? colors.accent : colors.text,
                        fontWeight: bold ? 700 : 400,
                      }}
                    >
                      {label}
                    </td>
                    <td
                      className="text-right py-0.5 font-bold"
                      style={{ color: colors.text }}
                      title={
                        row.beta_local == null
                          ? undefined
                          : `β ${capm.benchmark_currency ?? "LOC"} (both sides native): ${row.beta_local.toFixed(2)}`
                      }
                    >
                      {row.beta == null ? "—" : row.beta.toFixed(2)}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: colors.textSecondary }}
                      title={
                        row.market_value
                          ? `${sym}${fmtK(row.market_value)} market value × β`
                          : undefined
                      }
                    >
                      {row.hedge_notional == null ? "—" : `${sym}${fmtK(row.hedge_notional)}`}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{
                        color:
                          row.return_annual_pct == null ? "#555" : pnlColor(row.return_annual_pct),
                      }}
                      title={`XIRR (shown) over ${row.holding_days ?? "—"}d from ${
                        row.first_date ?? "—"
                      }. Cost-based CAGR: ${row.return_cagr_pct ?? "—"}% — that one divides by ${
                        row.invested_gross
                          ? `${sym}${fmtK(row.invested_gross)} of gross buys`
                          : "every buy ever made"
                      }, so it understates an account that recycles capital.`}
                    >
                      {row.return_annual_pct == null
                        ? "—"
                        : `${row.return_annual_pct >= 0 ? "+" : ""}${row.return_annual_pct.toFixed(1)}%`}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: colors.textSecondary }}
                      title={
                        row.index_cumulative_pct == null
                          ? undefined
                          : `${capm.benchmark} cumulative over the same span: ${row.index_cumulative_pct}%`
                      }
                    >
                      {row.index_annual_pct == null
                        ? "—"
                        : `${row.index_annual_pct >= 0 ? "+" : ""}${row.index_annual_pct.toFixed(1)}%`}
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                      {row.expected_annual_pct == null
                        ? "—"
                        : `${row.expected_annual_pct >= 0 ? "+" : ""}${row.expected_annual_pct.toFixed(1)}%`}
                    </td>
                    <td
                      className="text-right py-0.5 font-bold"
                      style={{
                        color:
                          row.alpha_annual_pct == null
                            ? "#555"
                            : row.benchmark_fit === "WEAK"
                              ? "#555"
                              : pnlColor(row.alpha_annual_pct),
                      }}
                      title={
                        row.benchmark_fit === "WEAK"
                          ? "Greyed out: with R² this low, beta collapses toward 0 and everything above the risk-free rate lands in alpha. Not a measurement."
                          : `${row.return_annual_pct ?? "—"}% − ${row.expected_annual_pct ?? "—"}% = ${row.alpha_annual_pct}%. On the cost-based CAGR instead: ${row.alpha_cagr_annual_pct ?? "—"}%`
                      }
                    >
                      {row.alpha_annual_pct == null
                        ? "—"
                        : `${row.alpha_annual_pct >= 0 ? "+" : ""}${row.alpha_annual_pct.toFixed(1)}%`}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{
                        color: row.benchmark_fit === "WEAK" ? "#f87171" : colors.textSecondary,
                      }}
                      title={
                        row.benchmark_fit === "WEAK"
                          ? `${capm.benchmark} explains almost none of this book's moves — β and α here are artefacts, not measurements. Use a benchmark from the market it trades in.`
                          : undefined
                      }
                    >
                      {row.r_squared == null ? "—" : row.r_squared.toFixed(2)}
                      {row.benchmark_fit === "WEAK" && " ⚠"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(() => {
            const dropped = new Map<string, { bars: number; weight_pct: number }>();
            for (const r of [capm.portfolio, ...Object.values(capm.accounts ?? {})])
              for (const e of r.excluded_symbols ?? []) dropped.set(e.symbol, e);
            if (dropped.size === 0) return null;
            return (
              <div className="text-[7px] mt-1" style={{ color: "#ff9900" }}>
                Excluded (too little price history to regress, weight redistributed):{" "}
                {[...dropped.entries()].map(([sym, e]) => `${sym} (${e.bars}d)`).join(", ")}
              </div>
            );
          })()}
        </Card>
      )}

      {/* ── Dividends + breakdowns ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
        {divByMonth.length > 0 && (
          <Card
            colors={colors}
            title="DIVIDENDS"
            sub={`per ${divPeriod === "M" ? "month" : divPeriod === "Q" ? "quarter" : "year"}`}
            right={
              <Seg
                colors={colors}
                options={[
                  ["M", "M"],
                  ["Q", "Q"],
                  ["Y", "Y"],
                ]}
                value={divPeriod}
                onChange={setDivPeriod}
              />
            }
          >
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={divByMonth} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#666", fontSize: 7 }} tickLine={false} />
                <YAxis
                  tick={{ fill: "#666", fontSize: 7 }}
                  tickLine={false}
                  axisLine={false}
                  // Dividends are always positive — pin the axis to zero so bars are honest
                  domain={[0, "auto"]}
                  tickFormatter={(v) => fmtK(v)}
                />
                <Tooltip
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                  formatter={(v: any) => [`${sym}${fmtK(v)}`, "Dividend"]}
                />
                <Bar dataKey="total" fill="#4ade80" radius={[2, 2, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
        {breakdowns.map((b) =>
          b.rows.length === 0 ? null : (
            <Card
              key={b.title}
              colors={colors}
              title={b.title}
              sub={`realized · top ${Math.min(b.limit, b.rows.length)}`}
            >
              <div className="overflow-y-auto" style={{ maxHeight: 190 }}>
                <table className="w-full text-[9px] font-mono">
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                      {th(b.col, "left")}
                      {th(b.mid === "cnt" ? "TRADES" : "WIN%")}
                      {th("P&L")}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(0, b.limit).map((r) => (
                      <tr key={r[b.key]} style={rowStyle}>
                        <td
                          className={`py-0.5 px-1.5 truncate max-w-[140px] ${b.key === "symbol" ? "font-bold" : ""}`}
                          style={{ color: b.key === "symbol" ? colors.accent : colors.text }}
                          title={r[b.key]}
                        >
                          {r[b.key]}
                        </td>
                        <td
                          className="text-right py-0.5 px-1.5"
                          style={{
                            color:
                              b.mid === "cnt"
                                ? colors.textSecondary
                                : r.win_rate >= 50
                                  ? "#4ade80"
                                  : "#f87171",
                          }}
                        >
                          {b.mid === "cnt" ? r.cnt : `${r.win_rate.toFixed(0)}%`}
                        </td>
                        <td
                          className="text-right py-0.5 px-1.5 font-bold"
                          style={{ color: pnlColor(r.pnl) }}
                        >
                          {r.pnl >= 0 ? "+" : "−"}
                          {fmtK(Math.abs(r.pnl))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        )}
      </div>

      <AllocationBasisCard accountId={accountId} currency={currency} colors={colors} />

      <OptionAttributionCard accountId={accountId} colors={colors} />

      {loading && (
        <div className="py-4 text-center">
          <Loader2 className="h-4 w-4 animate-spin mx-auto" style={{ color: colors.accent }} />
        </div>
      )}
    </div>
  );
}
