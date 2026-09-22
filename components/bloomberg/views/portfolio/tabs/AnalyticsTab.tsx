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
import { OptionAttributionCard } from "../ui/OptionAttributionCard";

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
const NAV_MODE_KEY = "bloomberg_nav_chart_mode";

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
}: {
  data: NavRow[];
  colors: Colors;
  sym: string;
  tooltipContentStyle: Record<string, unknown>;
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
      <ResponsiveContainer width="100%" height={160}>
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
      <div className="text-[7px] mt-1" style={{ color: "#666" }}>
        NAV = HOLDINGS + CASH — ขายของแล้วเงินย้ายจากเส้นม่วงไปเส้นเหลือง NAV ไม่ขยับ. เส้นประคือต้นทุน
        ช่องว่างระหว่าง HOLDINGS กับ COST = กำไร/ขาดทุนที่ยังไม่ขาย. คลิกชื่อเส้นเพื่อซ่อน
      </div>
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
}: {
  data: NavIndexResponse | null;
  loading: boolean;
  colors: Colors;
  benchmark: string;
  tooltipContentStyle: Record<string, unknown>;
  tooltipLabelStyle: Record<string, unknown>;
  tooltipItemStyle: Record<string, unknown>;
}) {
  const pts = data?.points ?? [];
  if (loading && pts.length === 0) {
    return (
      <div className="h-[160px] flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  }
  if (pts.length < 2) {
    return (
      <div
        className="h-[160px] flex items-center justify-center text-[8px] text-center px-4"
        style={{ color: colors.textSecondary }}
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
      <ResponsiveContainer width="100%" height={160}>
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
      <div className="text-[7px] mt-1" style={{ color: "#666" }}>
        Time-weighted: r = (NAV − flow − NAV₋₁) / NAV₋₁ ต่อวัน แล้วคูณทบ — เงินฝาก/ถอนถูกหักออกก่อน
        จึงเทียบกับดัชนีได้ตรงๆ (ต่างจาก XIRR ด้านบนซึ่งเป็น money-weighted). ดัชนีแปลงเป็น {data?.base_currency}{" "}
        ก่อน rebase แล้ว
      </div>
    </>
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
  const [navMode, setNavMode] = useState<"VALUE" | "INDEX">(() => {
    if (typeof window === "undefined") return "VALUE";
    try {
      const s = localStorage.getItem(NAV_MODE_KEY);
      if (s === "INDEX" || s === "VALUE") return s;
    } catch {
      /* ignore */
    }
    return "VALUE";
  });
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
    if (navMode !== "INDEX") return;
    const ac = new AbortController();
    const qs = new URLSearchParams({ base_currency: currency, benchmark, days: "365" });
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
  const navData = navHistory.map((r) => ({
    date: typeof r.snapshot_date === "string" ? r.snapshot_date.slice(5) : r.snapshot_date,
    value: toDisp(r.nav_with_cash ?? r.total_value ?? 0),
    holdings: toDisp(r.total_value ?? 0),
    cash: toDisp(r.cash_balance ?? 0),
    cost: toDisp(r.open_cost_basis ?? 0),
  }));

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

  return (
    <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
      {/* Per-account summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px p-2">
        {filteredStats.map((s) => (
          <div
            key={s.account.id}
            className="border p-2"
            style={{ background: "#080808", borderColor: colors.border }}
          >
            <div className="flex items-center gap-1 mb-1">
              <AccBadge account={s.account} small />
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono mt-1">
              <span style={{ color: colors.textSecondary }}>Total trades</span>
              <span style={{ color: colors.text }}>{s.total_trades}</span>
              <span style={{ color: colors.textSecondary }}>Win rate</span>
              <span style={{ color: s.win_rate >= 50 ? "#4ade80" : "#f87171" }}>
                {s.win_rate.toFixed(1)}%
              </span>
              <span style={{ color: colors.textSecondary }}>W/L</span>
              <span style={{ color: colors.text }}>
                {s.wins}/{s.losses}
              </span>
              <span style={{ color: colors.textSecondary }}>Open</span>
              <span style={{ color: "#ff9900" }}>{s.open_count}</span>
              <span style={{ color: colors.textSecondary }}>P&L</span>
              <span className="font-bold" style={{ color: pnlColor(s.pnl_native) }}>
                {s.account.currency === "USD" ? "$" : "฿"}
                {fmtK(Math.abs(s.pnl_native))} {s.pnl_native >= 0 ? "▲" : "▼"}
              </span>
              <span style={{ color: colors.textSecondary }}>Dividends</span>
              <span style={{ color: "#4ade80" }}>
                {s.account.currency === "THB" ? "฿" : "$"}
                {fmtK(s.total_dividends)}
              </span>
              {(() => {
                const r = acctReturn(s);
                const realized = s.pnl_base ?? 0;
                const realizedPct = r.base > 0 ? (realized / r.base) * 100 : null;
                return (
                  <>
                    <span style={{ color: colors.textSecondary }}>Total Return</span>
                    <span className="font-bold" style={{ color: pnlColor(r.totalPnl) }}>
                      {r.pct == null
                        ? "—"
                        : `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}% ${r.pct >= 0 ? "▲" : "▼"}`}
                    </span>
                    <span
                      style={{ color: colors.textSecondary }}
                      title="Realized P&L ÷ invested — closed-trade skill only, excludes unrealized paper P&L"
                    >
                      Realized Ret
                    </span>
                    <span
                      className="font-bold"
                      style={{ color: realizedPct == null ? "#555" : pnlColor(realized) }}
                    >
                      {realizedPct == null
                        ? "—"
                        : `${realizedPct >= 0 ? "+" : ""}${realizedPct.toFixed(1)}%`}
                    </span>
                    {s.ytd_realized_native != null && (
                      <>
                        <span
                          style={{ color: colors.textSecondary }}
                          title={`Realized trading P&L closed in ${summary?.ytd_year ?? "this year"} (${s.ytd_closed ?? 0} trades)`}
                        >
                          YTD Realized
                        </span>
                        <span
                          className="font-bold"
                          style={{ color: pnlColor(s.ytd_realized_native) }}
                        >
                          {s.account.currency === "USD" ? "$" : "฿"}
                          {fmtK(Math.abs(s.ytd_realized_native))}{" "}
                          {s.ytd_realized_native >= 0 ? "▲" : "▼"}
                        </span>
                      </>
                    )}
                  </>
                );
              })()}
              {(() => {
                const rr = rets?.accounts?.[s.account.id];
                if (!rr) return null;
                return (
                  <>
                    <span
                      style={{ color: colors.textSecondary }}
                      title="Time-weighted growth of deployed cost, annualized"
                    >
                      CAGR ann
                    </span>
                    <span
                      className="font-bold"
                      style={{ color: rr.cagr_pct == null ? "#555" : pnlColor(rr.cagr_pct) }}
                    >
                      {rr.cagr_pct == null
                        ? "—"
                        : `${rr.cagr_pct >= 0 ? "+" : ""}${rr.cagr_pct.toFixed(1)}%`}
                    </span>
                    <span
                      style={{ color: colors.textSecondary }}
                      title="Money-weighted IRR from actual dated cashflows (buys/sells/dividends), annualized"
                    >
                      XIRR ann
                    </span>
                    <span
                      className="font-bold"
                      style={{ color: rr.xirr_pct == null ? "#555" : pnlColor(rr.xirr_pct) }}
                    >
                      {rr.xirr_pct == null
                        ? "—"
                        : `${rr.xirr_pct >= 0 ? "+" : ""}${rr.xirr_pct.toFixed(1)}%`}
                    </span>
                  </>
                );
              })()}
              {(() => {
                const av = acctVol(s.account.id);
                if (!av) return null;
                const regimeColor =
                  av.vol_regime === "STRESSED"
                    ? "#f87171"
                    : av.vol_regime === "ELEVATED"
                      ? "#fbbf24"
                      : av.vol_regime === "CALM"
                        ? "#4ade80"
                        : "#555";
                return (
                  <>
                    <span
                      style={{ color: colors.textSecondary }}
                      title="Standard deviation of daily log returns, 252d lookback"
                    >
                      σ daily / ann
                    </span>
                    <span className="font-bold" style={{ color: colors.text }}>
                      {av.volatility_daily_pct.toFixed(2)}% / {av.volatility_annual_pct.toFixed(1)}%
                      {av.vol_regime !== "UNKNOWN" && (
                        <span style={{ color: regimeColor }}> {av.vol_regime}</span>
                      )}
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>

      {/* Trade stats — closed-trade skill: rate, ratio, average size, edge */}
      {ts && ts.closed > 0 && (
        <div className="mx-2 mb-2 border p-2" style={{ borderColor: colors.border }}>
          <div
            className="text-[9px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            TRADE STATS
            <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
              {ts.closed} closed trades{openPos.length > 0 ? ` · ${openPos.length} open` : ""}
            </span>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-px">
            {[
              {
                label: "WIN RATE",
                pct: null as string | null,
                value: ts.win_rate == null ? "—" : `${ts.win_rate.toFixed(1)}%`,
                color: ts.win_rate == null ? "#555" : ts.win_rate >= 50 ? "#4ade80" : "#f87171",
                hint: `${ts.wins}W / ${ts.losses}L · closed`,
                title: "Winning closed trades ÷ closed trades. Excludes open positions.",
              },
              {
                label: "HIT RATE",
                pct: null as string | null,
                value: hitRate == null ? "—" : `${hitRate.pct.toFixed(1)}%`,
                color: hitRate == null ? "#555" : hitRate.pct >= 50 ? "#4ade80" : "#f87171",
                hint: hitRate == null ? "—" : `${hitRate.hits} / ${hitRate.total} · incl. open`,
                title:
                  "Closed winners + open positions currently in profit, ÷ all positions taken. Moves with live prices.",
              },
              {
                label: "W/L RATIO",
                pct: null as string | null,
                value: ts.wl_ratio == null ? "—" : `${ts.wl_ratio.toFixed(2)}×`,
                color: ts.wl_ratio == null ? "#555" : ts.wl_ratio >= 1 ? "#4ade80" : "#f87171",
                hint: "wins ÷ losses (count)",
                title: "Number of winning trades ÷ number of losing trades. — when no losses yet.",
              },
              {
                label: "AVG WIN",
                value: ts.avg_win == null ? "—" : `${sym}${fmtK(Math.abs(ts.avg_win))}`,
                pct: fmtPct(ts.avg_win_pct),
                color: ts.avg_win == null ? "#555" : "#4ade80",
                hint: "per winning trade",
                title:
                  "Mean realized P&L across winning closed trades, in the display currency. The % is the mean return on cost of those same trades, in each trade's own currency.",
              },
              {
                label: "AVG LOSS",
                value: ts.avg_loss == null ? "—" : `${sym}${fmtK(Math.abs(ts.avg_loss))}`,
                pct: fmtPct(ts.avg_loss_pct),
                color: ts.avg_loss == null ? "#555" : "#f87171",
                hint: "per losing trade",
                title:
                  "Mean realized P&L across losing closed trades, in the display currency. The % is the mean return on cost of those same trades, in each trade's own currency.",
              },
              {
                label: "PAYOFF",
                pct: null as string | null,
                value: ts.payoff == null ? "—" : `${ts.payoff.toFixed(2)}×`,
                color: ts.payoff == null ? "#555" : ts.payoff >= 1 ? "#4ade80" : "#f87171",
                hint: "avg win ÷ avg loss",
                title:
                  "Average win ÷ |average loss|. Above 1 means winners are bigger than losers; combine with WIN RATE to read the edge.",
              },
            ].map((t) => (
              <div key={t.label} className="p-2" style={{ background: "#080808" }} title={t.title}>
                <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                  {t.label}
                </div>
                <div
                  className="flex items-baseline justify-between gap-1 mt-0.5"
                  style={{ color: t.color }}
                >
                  <span className="text-[11px] font-mono font-bold">{t.value}</span>
                  {t.pct && <span className="text-[8px] font-mono opacity-70">{t.pct}</span>}
                </div>
                <div className="text-[7px] font-mono mt-0.5" style={{ color: "#555" }}>
                  {t.hint}
                </div>
              </div>
            ))}
          </div>
          <div
            className="flex items-center justify-between mt-2 pt-2 border-t"
            style={{ borderColor: colors.border }}
          >
            <span
              className="text-[8px] font-bold tracking-widest"
              style={{ color: colors.textSecondary }}
              title="Expectancy = win rate × avg win + loss rate × avg loss. The average P&L a new trade is worth at this win rate and payoff."
            >
              EXPECTANCY / TRADE
              <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                (win% × avg win) + (loss% × avg loss)
              </span>
            </span>
            <span
              className="text-[13px] font-mono font-bold"
              style={{ color: ts.expectancy == null ? "#555" : pnlColor(ts.expectancy) }}
            >
              {ts.expectancy == null
                ? "—"
                : `${ts.expectancy >= 0 ? "+" : "−"}${sym}${fmtK(Math.abs(ts.expectancy))} ${
                    ts.expectancy >= 0 ? "▲" : "▼"
                  }`}
              {fmtPct(ts.expectancy_pct) && (
                <span className="ml-1 text-[9px] opacity-70">{fmtPct(ts.expectancy_pct)}</span>
              )}
              <span className="ml-2 text-[9px]" style={{ color: colors.textSecondary }}>
                {sym}
                {fmtK(Math.abs(ts.total_win))} won / {sym}
                {fmtK(Math.abs(ts.total_loss))} lost
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Capital snapshot — realized vs unrealized split, cost basis, invested capital */}
      {(openPos.length > 0 || filteredStats.length > 0) && (
        <div className="mx-2 mb-2 border p-2" style={{ borderColor: colors.border }}>
          <div
            className="text-[9px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            CAPITAL BREAKDOWN
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px">
            {capitalTiles.map((t) => {
              const color =
                t.tone === "pnl" ? pnlColor(t.value) : t.tone === "pos" ? "#4ade80" : "#e5e5e5";
              return (
                <div
                  key={t.label}
                  className="p-2"
                  style={{ background: "#080808" }}
                  title={t.title}
                >
                  <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                    {t.label}
                  </div>
                  <div className="text-[11px] font-mono font-bold mt-0.5" style={{ color }}>
                    {sym}
                    {fmtK(Math.abs(t.value))}
                    {t.tone === "pnl" ? (t.value >= 0 ? " ▲" : " ▼") : ""}
                  </div>
                  <div className="text-[7px] font-mono mt-0.5" style={{ color: "#555" }}>
                    {t.hint}
                  </div>
                  {t.secondaryValue != null && (
                    <div
                      className="text-[7px] font-mono mt-1"
                      style={{ color: colors.textSecondary }}
                      title={t.secondaryTitle}
                    >
                      {t.secondaryLabel}{" "}
                      <span style={{ color: pnlColor(t.secondaryValue) }}>
                        {sym}
                        {fmtK(Math.abs(t.secondaryValue))}
                        {t.secondaryValue >= 0 ? " ▲" : " ▼"}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {(() => {
            const base = capital.invested > 0 ? capital.invested : capital.openCost;
            const totalPnl = capital.totalPnl + capital.dividends;
            const pct = base > 0 ? (totalPnl / base) * 100 : null;
            return (
              <div
                className="flex items-center justify-between mt-2 pt-2 border-t"
                style={{ borderColor: colors.border }}
              >
                <span
                  className="text-[8px] font-bold tracking-widest"
                  style={{ color: colors.textSecondary }}
                >
                  TOTAL RETURN
                  <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                    (realized + unrealized + div) /{" "}
                    {capital.invested > 0 ? "invested" : "cost basis"}
                  </span>
                </span>
                <span
                  className="text-[13px] font-mono font-bold"
                  style={{ color: pnlColor(totalPnl) }}
                >
                  {pct == null
                    ? "—"
                    : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% ${pct >= 0 ? "▲" : "▼"}`}
                  <span className="ml-2 text-[9px]" style={{ color: colors.textSecondary }}>
                    {sym}
                    {fmtK(Math.abs(totalPnl))}
                  </span>
                </span>
              </div>
            );
          })()}
          {(() => {
            const base = capital.invested > 0 ? capital.invested : capital.openCost;
            const realizedPct = base > 0 ? (capital.realized / base) * 100 : null;
            return (
              <div className="flex items-center justify-between mt-1.5">
                <span
                  className="text-[8px] font-bold tracking-widest"
                  style={{ color: colors.textSecondary }}
                  title="Realized P&L ÷ invested — closed-trade skill only, excludes unrealized"
                >
                  REALIZED RETURN
                  <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                    realized / {capital.invested > 0 ? "invested" : "cost basis"} · trading skill
                  </span>
                </span>
                <span
                  className="text-[11px] font-mono font-bold"
                  style={{ color: pnlColor(capital.realized) }}
                >
                  {realizedPct == null
                    ? "—"
                    : `${realizedPct >= 0 ? "+" : ""}${realizedPct.toFixed(2)}%`}
                  <span className="ml-2 text-[9px]" style={{ color: colors.textSecondary }}>
                    {sym}
                    {fmtK(Math.abs(capital.realized))}
                  </span>
                </span>
              </div>
            );
          })()}
          {summary?.total_ytd_realized_base != null && accountId === "all" && (
            <div className="flex items-center justify-between mt-1.5">
              <span
                className="text-[8px] font-bold tracking-widest"
                style={{ color: colors.textSecondary }}
                title="Realized trading P&L booked this year (closed trades)"
              >
                YTD REALIZED P&L
                <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                  closed in {summary.ytd_year ?? "this year"}
                </span>
              </span>
              <span
                className="text-right font-mono"
                style={{ color: pnlColor(summary.total_ytd_realized_base) }}
              >
                <span className="text-[11px] font-bold">
                  {summary.total_ytd_realized_base >= 0 ? "+" : ""}
                  {sym}
                  {fmtK(Math.abs(summary.total_ytd_realized_base))}
                  {summary.total_ytd_realized_base >= 0 ? " ▲" : " ▼"}
                </span>
                {summary.total_ytd_economic_realized_base != null && (
                  <span
                    className="block text-[7px] font-normal"
                    style={{ color: colors.textSecondary }}
                    title={economicPnlTitle}
                  >
                    ECON {sym}
                    {fmtK(Math.abs(summary.total_ytd_economic_realized_base))}
                    {summary.total_ytd_economic_realized_base >= 0 ? " ▲" : " ▼"}
                  </span>
                )}
              </span>
            </div>
          )}
          {rets?.total && (
            <div
              className="flex items-center justify-between mt-1.5 pt-1.5 border-t"
              style={{ borderColor: colors.border }}
            >
              <span
                className="text-[8px] font-bold tracking-widest"
                style={{ color: colors.textSecondary }}
              >
                ANNUALIZED (cost-based)
                <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                  {rets.total.holding_days}d since {rets.total.first_date ?? "—"}
                </span>
              </span>
              <span className="font-mono flex items-center gap-3">
                <span
                  className="text-[11px] font-bold"
                  style={{
                    color: rets.total.cagr_pct == null ? "#555" : pnlColor(rets.total.cagr_pct),
                  }}
                  title="Time-weighted growth of deployed cost, annualized"
                >
                  CAGR{" "}
                  {rets.total.cagr_pct == null
                    ? "—"
                    : `${rets.total.cagr_pct >= 0 ? "+" : ""}${rets.total.cagr_pct.toFixed(2)}%`}
                </span>
                <span
                  className="text-[11px] font-bold"
                  style={{
                    color: rets.total.xirr_pct == null ? "#555" : pnlColor(rets.total.xirr_pct),
                  }}
                  title="Money-weighted IRR from actual dated cashflows, annualized"
                >
                  XIRR{" "}
                  {rets.total.xirr_pct == null
                    ? "—"
                    : `${rets.total.xirr_pct >= 0 ? "+" : ""}${rets.total.xirr_pct.toFixed(2)}%`}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Risk-adjusted performance — CAPM beta + Jensen's alpha vs benchmark */}
      {capm && (
        <div className="mx-2 mb-2 border p-2" style={{ borderColor: colors.border }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              RISK-ADJUSTED (CAPM)
              <span className="ml-1 text-[7px]" style={{ color: "#555" }}>
                β for hedging · α = return − CAPM expectation · vs {capm.benchmark}
              </span>
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
                  className="ml-1 text-[7px] underline decoration-dotted"
                  style={{
                    color: rfOverride[currency] != null ? colors.accent : colors.textSecondary,
                  }}
                  title={`Risk-free rate used in the CAPM expectation. Quoted in ${
                    capm.rf_currency ?? "the report currency"
                  } to match the returns, and at a short horizon to match the daily interval. Source: ${
                    capm.rf_source ?? "—"
                  }${capm.rf_as_of ? ` · as of ${capm.rf_as_of}` : ""}. Click to override.`}
                >
                  {" "}
                  · rf {(capm.rf_annual * 100).toFixed(2)}% {capm.rf_currency ?? ""} (
                  {capm.rf_series ?? capm.rf_source ?? "—"}
                  {capm.rf_as_of ? `, ${String(capm.rf_as_of).slice(0, 10)}` : ""}) ✎
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {(
                  [
                    ["1M", 21],
                    ["3M", 63],
                    ["6M", 126],
                    ["1Y", 252],
                  ] as const
                ).map(([lbl, d]) => (
                  <button
                    type="button"
                    key={lbl}
                    onClick={() => setLookback(d)}
                    className="text-[7px] px-1.5 py-0.5 border font-bold"
                    style={{
                      borderColor: lookback === d ? colors.accent : colors.border,
                      color: lookback === d ? colors.accent : colors.textSecondary,
                      background: lookback === d ? "#ff990015" : "transparent",
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {(["SPY", "QQQ", "ACWI"] as const).map((b) => (
                  <button
                    type="button"
                    key={b}
                    onClick={() => setBenchmark(b)}
                    className="text-[7px] px-1.5 py-0.5 border font-bold"
                    style={{
                      borderColor: benchmark === b ? colors.accent : colors.border,
                      color: benchmark === b ? colors.accent : colors.textSecondary,
                      background: benchmark === b ? "#ff990015" : "transparent",
                    }}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          </div>
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
          <div className="text-[7px] mt-1" style={{ color: "#444" }}>
            <b>α = RET − EXPECT</b> where EXPECT = rf + β × (IDX − rf) — every number on the row is
            on screen, so the arithmetic checks by hand. RET is the money-weighted XIRR over each
            account&apos;s own span and IDX covers that same span (hover for XIRR and the cumulative
            index move). β is the book held today, in {currency}, which is also what sizes the HEDGE
            column: β × market value = the {capm.benchmark} notional that offsets the book. Nothing
            here reads the trade log&apos;s DATES — they carry bulk-import placeholders, and a
            date-driven version of this table reported +96% alpha for an account that returned
            3.3%/yr. Greyed α = R² &lt; 0.10 ⚠, i.e. the wrong benchmark for this book, not low
            risk. rf = {capm.rf_source ?? "—"}
            {capm.rf_as_of ? ` (${String(capm.rf_as_of).slice(0, 10)})` : ""}, quoted in{" "}
            {capm.rf_currency ?? "the report currency"} to match the returns. Benchmark data through{" "}
            {capm.benchmark_last_date ?? "—"}.
          </div>
        </div>
      )}

      {/* Portfolio value (NAV) over time — built from daily capture-on-view snapshots */}
      {navData.length > 0 && (
        <div className="mx-2 mb-2 border p-2" style={{ borderColor: colors.border }}>
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              {navMode === "VALUE" ? "PORTFOLIO VALUE (NAV)" : `EQUITY CURVE vs ${benchmark}`}
            </div>
            <div className="flex items-center gap-1">
              {navData.length < 2 && (
                <div className="text-[7px] font-mono mr-1" style={{ color: "#666" }}>
                  เก็บข้อมูลรายวัน — กราฟจะสมบูรณ์ขึ้นเมื่อมีหลายวัน
                </div>
              )}
              {(["VALUE", "INDEX"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setNavMode(m)}
                  title={
                    m === "VALUE"
                      ? "NAV เป็นเงิน — ฝาก/ถอนทำให้เส้นขยับ จึงเทียบกับดัชนีตรงๆ ไม่ได้"
                      : "Time-weighted: หักกระแสเงินเข้า-ออกออกจากผลตอบแทนรายวัน แล้ว rebase = 100 เทียบกับดัชนีได้"
                  }
                  className="text-[7px] font-bold px-1.5 py-0.5 border"
                  style={{
                    borderColor: navMode === m ? colors.accent : colors.border,
                    color: navMode === m ? colors.accent : colors.textSecondary,
                    background: navMode === m ? "#ff990015" : "transparent",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          {navMode === "INDEX" ? (
            <NavIndexChart
              data={navIndex}
              loading={navIndexLoading}
              colors={colors}
              benchmark={benchmark}
              tooltipContentStyle={tooltipContentStyle}
              tooltipLabelStyle={tooltipLabelStyle}
              tooltipItemStyle={tooltipItemStyle}
            />
          ) : (
            <NavValueChart
              data={navData}
              colors={colors}
              sym={sym}
              tooltipContentStyle={tooltipContentStyle}
            />
          )}
        </div>
      )}

      {/* Monthly + Cumulative P&L side by side for a tighter aspect ratio */}
      {monthData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mx-2 mb-2">
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] font-bold tracking-widest mb-2"
              style={{ color: colors.accent }}
            >
              MONTHLY P&L
            </div>
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={monthData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#666", fontSize: 8 }} tickLine={false} />
                <YAxis
                  tick={{ fill: "#666", fontSize: 8 }}
                  tickLine={false}
                  axisLine={false}
                  // Always include the zero baseline so bar heights stay proportional
                  domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                  tickFormatter={(v) => fmtK(v)}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    const row = payload?.[0]?.payload as
                      | { pnl?: number; economic_pnl?: number }
                      | undefined;
                    if (!active || !row) return null;
                    const pnl = row.pnl ?? 0;
                    const economicPnl = row.economic_pnl ?? pnl;
                    return (
                      <div style={tooltipContentStyle}>
                        <div style={tooltipLabelStyle}>{label}</div>
                        <div style={{ color: pnlColor(pnl) }}>
                          P&L {sym}
                          {fmtK(Math.abs(pnl))} {pnl >= 0 ? "▲" : "▼"}
                        </div>
                        <div style={{ color: pnlColor(economicPnl) }}>
                          ECON {sym}
                          {fmtK(Math.abs(economicPnl))} {economicPnl >= 0 ? "▲" : "▼"}
                        </div>
                        <div style={{ color: "#888", maxWidth: 260 }}>
                          Formula: (entry cost + native P&L) × exit FX − entry cost × entry FX
                        </div>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="#444" />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {monthData.map((m, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable month order
                    <Cell key={i} fill={m.pnl >= 0 ? "#22c55e" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cumulative P&L */}
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] font-bold tracking-widest mb-2"
              style={{ color: colors.accent }}
            >
              CUMULATIVE P&L
            </div>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={cumulativeData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#666", fontSize: 8 }} tickLine={false} />
                <YAxis
                  tick={{ fill: "#666", fontSize: 8 }}
                  tickLine={false}
                  axisLine={false}
                  // Anchor the scale at zero so the filled area reflects true magnitude
                  domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                  tickFormatter={(v) => fmtK(v)}
                />
                <Tooltip
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                  formatter={(v: any) => [`${sym}${fmtK(v)}`, "Cumulative"]}
                />
                <ReferenceLine y={0} stroke="#444" />
                <Area
                  dataKey="cumPnl"
                  stroke="#22c55e"
                  strokeWidth={1.5}
                  fill="url(#cumGrad)"
                  baseValue={0}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Monthly breakdown table — exact figures the outlier-dominated chart can't show */}
      {monthData.length > 0 && (
        <div className="mx-2 mb-2 border p-2" style={{ borderColor: colors.border }}>
          <div
            className="text-[9px] font-bold tracking-widest mb-1"
            style={{ color: colors.accent }}
          >
            MONTHLY BREAKDOWN
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {["MONTH", "P&L", "WIN%", "CUMULATIVE"].map((h, i) => (
                    <th
                      key={h}
                      className={`py-0.5 sticky top-0 ${i === 0 ? "text-left" : "text-right"}`}
                      style={{ color: colors.textSecondary, background: "#0a0a0a" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthData.map((m, i) => (
                  <tr key={m.month} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td className="py-0.5" style={{ color: colors.text }}>
                      {m.month}
                    </td>
                    <td className="text-right py-0.5 font-bold" style={{ color: pnlColor(m.pnl) }}>
                      <div>
                        {sym}
                        {fmtK(Math.abs(m.pnl))} {m.pnl >= 0 ? "▲" : "▼"}
                      </div>
                      <div
                        className="text-[7px] font-normal"
                        style={{ color: pnlColor(m.economic_pnl) }}
                        title={economicPnlTitle}
                      >
                        ECON {sym}
                        {fmtK(Math.abs(m.economic_pnl))} {m.economic_pnl >= 0 ? "▲" : "▼"}
                      </div>
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: m.win_rate >= 50 ? "#4ade80" : "#f87171" }}
                    >
                      {m.win_rate != null ? `${m.win_rate.toFixed(0)}%` : "—"}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: pnlColor(cumulativeData[i]?.cumPnl ?? 0) }}
                    >
                      {sym}
                      {fmtK(cumulativeData[i]?.cumPnl ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td className="py-0.5 font-bold" style={{ color: colors.textSecondary }}>
                    TOTAL
                  </td>
                  <td className="text-right py-0.5 font-bold" style={{ color: pnlColor(totalPnl) }}>
                    <div>
                      {sym}
                      {fmtK(Math.abs(totalPnl))} {totalPnl >= 0 ? "▲" : "▼"}
                    </div>
                    <div
                      className="text-[7px] font-normal"
                      style={{ color: pnlColor(totalEconomicPnl) }}
                      title={economicPnlTitle}
                    >
                      ECON {sym}
                      {fmtK(Math.abs(totalEconomicPnl))} {totalEconomicPnl >= 0 ? "▲" : "▼"}
                    </div>
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Dividend Trend + Allocation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mx-2 mb-2">
        {divByMonth.length > 0 && (
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div className="flex items-center justify-between mb-2">
              <div
                className="text-[9px] font-bold tracking-widest"
                style={{ color: colors.accent }}
              >
                DIVIDEND / {divPeriod === "M" ? "MONTH" : divPeriod === "Q" ? "QUARTER" : "YEAR"}
              </div>
              <div className="flex gap-1">
                {(["M", "Q", "Y"] as const).map((p) => (
                  <button
                    type="button"
                    key={p}
                    onClick={() => setDivPeriod(p)}
                    className="text-[7px] px-1.5 py-0.5 border font-bold"
                    style={{
                      borderColor: divPeriod === p ? colors.accent : colors.border,
                      color: divPeriod === p ? colors.accent : colors.textSecondary,
                      background: divPeriod === p ? "#ff990015" : "transparent",
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={150}>
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
                <Bar dataKey="total" fill="#4ade80" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <AllocationBasisCard accountId={accountId} currency={currency} colors={colors} />

      <OptionAttributionCard accountId={accountId} colors={colors} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 p-2">
        {(analytics?.by_sector ?? []).length > 0 && (
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] font-bold tracking-widest mb-1"
              style={{ color: colors.accent }}
            >
              BY SECTOR
            </div>
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left py-0.5" style={{ color: colors.textSecondary }}>
                    SECTOR
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    W%
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    P&L
                  </th>
                </tr>
              </thead>
              <tbody>
                {analytics?.by_sector.slice(0, 8).map((s) => (
                  <tr key={s.sector} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td className="py-0.5" style={{ color: colors.text }}>
                      {s.sector}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: s.win_rate >= 50 ? "#4ade80" : "#f87171" }}
                    >
                      {s.win_rate.toFixed(0)}%
                    </td>
                    <td className="text-right py-0.5 font-bold" style={{ color: pnlColor(s.pnl) }}>
                      {fmtK(Math.abs(s.pnl))} {s.pnl >= 0 ? "▲" : "▼"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(analytics?.top_symbols ?? []).length > 0 && (
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] font-bold tracking-widest mb-1"
              style={{ color: colors.accent }}
            >
              TOP SYMBOLS
            </div>
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left py-0.5" style={{ color: colors.textSecondary }}>
                    SYMBOL
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    TRADES
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    P&L
                  </th>
                </tr>
              </thead>
              <tbody>
                {analytics?.top_symbols.slice(0, 10).map((s) => (
                  <tr key={s.symbol} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td className="py-0.5 font-bold" style={{ color: colors.accent }}>
                      {s.symbol}
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                      {s.cnt}
                    </td>
                    <td className="text-right py-0.5 font-bold" style={{ color: pnlColor(s.pnl) }}>
                      {fmtK(Math.abs(s.pnl))} {s.pnl >= 0 ? "▲" : "▼"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(analytics?.by_subport ?? []).length > 0 && (
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] font-bold tracking-widest mb-1"
              style={{ color: colors.accent }}
            >
              BY SUB-PORT
            </div>
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left py-0.5" style={{ color: colors.textSecondary }}>
                    SUB-PORT
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    W%
                  </th>
                  <th className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                    P&L
                  </th>
                </tr>
              </thead>
              <tbody>
                {analytics?.by_subport.slice(0, 10).map((s) => (
                  <tr key={s.subport} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td className="py-0.5" style={{ color: colors.text }}>
                      {s.subport}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: s.win_rate >= 50 ? "#4ade80" : "#f87171" }}
                    >
                      {s.win_rate.toFixed(0)}%
                    </td>
                    <td className="text-right py-0.5 font-bold" style={{ color: pnlColor(s.pnl) }}>
                      {fmtK(Math.abs(s.pnl))} {s.pnl >= 0 ? "▲" : "▼"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {loading && (
        <div className="py-8 text-center">
          <Loader2 className="h-4 w-4 animate-spin mx-auto" style={{ color: colors.accent }} />
        </div>
      )}
    </div>
  );
}
