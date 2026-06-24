"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SECTOR_COLORS } from "../constants";
import { type Colors, fmt, fmtK, fmtPct, pnlColor, wlColor } from "../helpers";
import type { BacktestMetrics, ChartPoint } from "../types";

type BtSubTab = "equity" | "holdings" | "distribution" | "attribution";
type GroupBy = "sector" | "account" | "symbol";

interface HoldingDetail {
  key: string;
  cost_value: number;
  symbols: string[];
  count: number;
}
interface TimelineRow {
  month: string;
  total_cost: number;
  _detail?: HoldingDetail[];
  [k: string]: unknown;
}
interface DistBucket {
  range: string;
  lo: number;
  hi: number;
  count: number;
  pnl_sum: number;
}
interface DistTrade {
  symbol: string;
  pnl_amount: number;
  pnl_percent: number;
  holding_days: number;
  win_loss: string;
  sector: string;
}

export function BacktestTab({
  colors,
  accountId,
  currency,
}: {
  colors: Colors;
  accountId: string;
  currency: "THB" | "USD";
}) {
  const [subTab, setSubTab] = useState<BtSubTab>("equity");
  const [bench, setBench] = useState("^SET.BK");
  const [loading, setLoading] = useState(false);

  const [eqData, setEqData] = useState<{
    daily: ChartPoint[];
    metrics: BacktestMetrics | null;
  } | null>(null);
  const [hlData, setHlData] = useState<{ timeline: TimelineRow[]; all_keys: string[] } | null>(
    null
  );
  const [groupBy, setGroupBy] = useState<GroupBy>("sector");
  const [hlLoading, setHlLoading] = useState(false);
  const [distData, setDistData] = useState<{ buckets: DistBucket[]; trades: DistTrade[] } | null>(
    null
  );
  const [distMetric, setDistMetric] = useState<"pnl_percent" | "pnl_amount" | "holding_days">(
    "pnl_percent"
  );
  const [distLoading, setDistLoading] = useState(false);

  const qs = `account_id=${accountId}&base_currency=${currency}`;

  const loadEquity = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const r = await fetch(`/api/v2/portfolio/backtest/equity?${qs}&benchmark=${bench}`, {
          signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setEqData(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [qs, bench]
  );

  const loadHoldings = useCallback(
    async (signal?: AbortSignal) => {
      setHlLoading(true);
      try {
        const r = await fetch(
          `/api/v2/portfolio/backtest/holdings-timeline?${qs}&group_by=${groupBy}`,
          { signal }
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setHlData(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setHlLoading(false);
      }
    },
    [qs, groupBy]
  );

  const loadDist = useCallback(
    async (signal?: AbortSignal) => {
      setDistLoading(true);
      try {
        const r = await fetch(
          `/api/v2/portfolio/backtest/distribution?${qs}&metric=${distMetric}`,
          { signal }
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setDistData(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setDistLoading(false);
      }
    },
    [qs, distMetric]
  );

  useEffect(() => {
    const ac = new AbortController();
    loadEquity(ac.signal);
    return () => ac.abort();
  }, [loadEquity]);
  useEffect(() => {
    if (subTab !== "holdings") return;
    const ac = new AbortController();
    loadHoldings(ac.signal);
    return () => ac.abort();
  }, [subTab, loadHoldings]);
  useEffect(() => {
    if (subTab !== "distribution" && subTab !== "attribution") return;
    const ac = new AbortController();
    loadDist(ac.signal);
    return () => ac.abort();
  }, [subTab, loadDist]);

  const m = eqData?.metrics;
  const csym = currency === "THB" ? "฿" : "$";
  const iCls = "text-[8px] px-2 py-0.5 font-bold border cursor-pointer transition-all";

  return (
    <div className="p-2 space-y-2">
      {/* Controls bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
          BACKTEST v2
        </span>
        <input
          className="text-[9px] px-1 py-0.5 border outline-none font-mono w-20"
          style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
          value={bench}
          onChange={(e) => setBench(e.target.value.toUpperCase())}
          placeholder="^SET.BK"
        />
        <button
          type="button"
          onClick={() => loadEquity()}
          disabled={loading}
          className="text-[9px] px-2 py-0.5 border font-bold hover:opacity-80 flex items-center gap-1"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          {loading ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" />
          )}
          RUN
        </button>
        {m && (
          <span className="text-[8px] font-mono ml-auto" style={{ color: colors.textSecondary }}>
            {m.total_trades} trades | {csym}
            {fmtK(m.total_invested ?? 0)} invested
          </span>
        )}
      </div>

      {/* Metrics grid */}
      {m && (
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              ["Total P&L", `${csym}${fmtK(m.total_pnl ?? 0)}`, pnlColor(m.total_pnl)],
              ["Return", fmtPct(m.total_return), pnlColor(m.total_return)],
              ["Benchmark", fmtPct(m.benchmark_total_return), pnlColor(m.benchmark_total_return)],
              ["CAGR", fmtPct(m.cagr), pnlColor(m.cagr)],
              ["Sharpe", m.sharpe_ratio.toFixed(2), m.sharpe_ratio >= 1 ? "#4ade80" : "#f87171"],
              ["Max DD", fmtPct(m.max_drawdown), "#f87171"],
              ["Win Rate", `${m.win_rate ?? 0}%`, (m.win_rate ?? 0) >= 50 ? "#4ade80" : "#f87171"],
              [
                "P.Factor",
                (m.profit_factor ?? 0) >= 999 ? "∞" : (m.profit_factor ?? 0).toFixed(2),
                (m.profit_factor ?? 0) >= 1.5 ? "#4ade80" : "#f87171",
              ],
              ["Alpha", fmtPct(m.alpha), pnlColor(m.alpha)],
              ["Beta", m.beta.toFixed(2), "#888"],
              ["Avg Win", `${csym}${fmtK(m.avg_win ?? 0)}`, "#4ade80"],
              ["Avg Loss", `${csym}${fmtK(Math.abs(m.avg_loss ?? 0))}`, "#f87171"],
            ] as [string, string, string][]
          ).map(([label, val, color]) => (
            <div
              key={label}
              className="border p-1.5"
              style={{ borderColor: colors.border, background: "#0a0a0a" }}
            >
              <div
                className="text-[7px] uppercase tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                {label}
              </div>
              <div className="text-[11px] font-bold font-mono" style={{ color }}>
                {val}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b pb-1" style={{ borderColor: colors.border }}>
        {(["equity", "holdings", "distribution", "attribution"] as BtSubTab[]).map((t) => (
          <button
            type="button"
            key={t}
            className={iCls}
            style={{
              borderColor: subTab === t ? colors.accent : colors.border,
              color: subTab === t ? colors.accent : colors.textSecondary,
              background: subTab === t ? `${colors.accent}22` : "transparent",
            }}
            onClick={() => setSubTab(t)}
          >
            {t === "equity"
              ? "EQUITY CURVE"
              : t === "holdings"
                ? "HOLDINGS STACK"
                : t === "distribution"
                  ? "DISTRIBUTION"
                  : "ATTRIBUTION"}
          </button>
        ))}
      </div>

      {/* ── EQUITY CURVE ── */}
      {subTab === "equity" &&
        (eqData?.daily && eqData.daily.length > 0 ? (
          <div className="border p-2" style={{ borderColor: colors.border }}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={eqData.daily} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="btPortGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ff9900" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ff9900" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#666", fontSize: 8 }}
                  tickLine={false}
                  tickFormatter={(v: string) => v.slice(2, 7)}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: "#666", fontSize: 8 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                />
                <Tooltip
                  contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 10 }}
                  formatter={(v: number, n: string) => [
                    `${fmt(v)}%`,
                    n === "portfolio_return" ? "Portfolio" : bench,
                  ]}
                  labelFormatter={(l: string) => l}
                />
                <ReferenceLine y={0} stroke="#444" />
                <Area
                  type="monotone"
                  dataKey="portfolio_return"
                  stroke="#ff9900"
                  fill="url(#btPortGrad)"
                  strokeWidth={1.5}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="benchmark_return"
                  stroke="#3b82f6"
                  fill="none"
                  strokeWidth={1}
                  dot={false}
                  strokeDasharray="4 2"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : !loading ? (
          <div className="py-6 text-center text-[10px]" style={{ color: colors.textSecondary }}>
            No closed trades found. Equity curve is built from realized P&L.
          </div>
        ) : null)}

      {/* ── HOLDINGS STACK ── */}
      {subTab === "holdings" && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-[8px]" style={{ color: colors.textSecondary }}>
              Group:
            </span>
            {(["sector", "account", "symbol"] as GroupBy[]).map((g) => (
              <button
                type="button"
                key={g}
                className={iCls}
                style={{
                  borderColor: groupBy === g ? colors.accent : colors.border,
                  color: groupBy === g ? colors.accent : colors.textSecondary,
                  background: groupBy === g ? `${colors.accent}22` : "transparent",
                }}
                onClick={() => setGroupBy(g)}
              >
                {g.toUpperCase()}
              </button>
            ))}
            {hlLoading && (
              <Loader2 className="h-2.5 w-2.5 animate-spin ml-2" style={{ color: colors.accent }} />
            )}
          </div>
          {hlData?.timeline && hlData.timeline.length > 0 ? (
            <div className="border p-2" style={{ borderColor: colors.border }}>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={hlData.timeline} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: "#666", fontSize: 8 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: "#666", fontSize: 8 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${csym}${(v / 1000).toFixed(0)}K`}
                    width={55}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#111",
                      border: "1px solid #333",
                      fontSize: 9,
                      maxHeight: 200,
                      overflow: "auto",
                    }}
                    formatter={(v: number, name: string) => [`${csym}${v.toLocaleString()}`, name]}
                    labelFormatter={(l: string) => `Month: ${l}`}
                  />
                  {hlData.all_keys.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="1"
                      stroke={SECTOR_COLORS[key] ?? "#555"}
                      fill={SECTOR_COLORS[key] ?? "#555"}
                      fillOpacity={0.75}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 px-1">
                {hlData.all_keys.map((k) => (
                  <span
                    key={k}
                    className="flex items-center gap-1 text-[7px] font-mono"
                    style={{ color: colors.textSecondary }}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-sm"
                      style={{ background: SECTOR_COLORS[k] ?? "#555" }}
                    />
                    {k}
                  </span>
                ))}
              </div>
            </div>
          ) : !hlLoading ? (
            <div className="py-6 text-center text-[10px]" style={{ color: colors.textSecondary }}>
              No holdings data
            </div>
          ) : null}
        </>
      )}

      {/* ── DISTRIBUTION ── */}
      {subTab === "distribution" && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-[8px]" style={{ color: colors.textSecondary }}>
              Metric:
            </span>
            {(["pnl_percent", "pnl_amount", "holding_days"] as const).map((dm) => (
              <button
                type="button"
                key={dm}
                className={iCls}
                style={{
                  borderColor: distMetric === dm ? colors.accent : colors.border,
                  color: distMetric === dm ? colors.accent : colors.textSecondary,
                  background: distMetric === dm ? `${colors.accent}22` : "transparent",
                }}
                onClick={() => setDistMetric(dm)}
              >
                {dm === "pnl_percent"
                  ? "% RETURN"
                  : dm === "pnl_amount"
                    ? "P&L AMOUNT"
                    : "HOLD DAYS"}
              </button>
            ))}
            {distLoading && (
              <Loader2 className="h-2.5 w-2.5 animate-spin ml-2" style={{ color: colors.accent }} />
            )}
          </div>
          {distData?.buckets && distData.buckets.length > 0 ? (
            <div className="border p-2" style={{ borderColor: colors.border }}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={distData.buckets} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                  <XAxis
                    dataKey="range"
                    tick={{ fill: "#666", fontSize: 7 }}
                    tickLine={false}
                    interval={0}
                    angle={-30}
                    textAnchor="end"
                    height={40}
                  />
                  <YAxis tick={{ fill: "#666", fontSize: 8 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 10 }}
                    formatter={(v: number) => [v, "Trades"]}
                  />
                  <ReferenceLine y={0} stroke="#444" />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {distData.buckets.map((b, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable bucket order
                      <Cell key={i} fill={b.lo >= 0 ? "#4ade80" : "#f87171"} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : !distLoading ? (
            <div className="py-6 text-center text-[10px]" style={{ color: colors.textSecondary }}>
              No closed trades for distribution
            </div>
          ) : null}
        </>
      )}

      {/* ── ATTRIBUTION ── */}
      {subTab === "attribution" &&
        (distData?.trades && distData.trades.length > 0 ? (
          <div className="overflow-x-auto border" style={{ borderColor: colors.border }}>
            <table className="w-full text-[9px] font-mono" style={{ color: colors.text }}>
              <thead>
                <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                  {["#", "SYMBOL", "SECTOR", "P&L", "% RTN", "DAYS", "W/L"].map((h) => (
                    <th
                      key={h}
                      className="px-2 py-1 text-left text-[8px] font-bold tracking-wider"
                      style={{ color: colors.textSecondary }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...distData.trades]
                  .sort((a, b) => b.pnl_amount - a.pnl_amount)
                  .map((t, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sorted trade list, index is stable
                    <tr key={i} className="border-b" style={{ borderColor: colors.border }}>
                      <td className="px-2 py-0.5" style={{ color: colors.textSecondary }}>
                        {i + 1}
                      </td>
                      <td className="px-2 py-0.5 font-bold">{t.symbol}</td>
                      <td className="px-2 py-0.5" style={{ color: colors.textSecondary }}>
                        {t.sector}
                      </td>
                      <td
                        className="px-2 py-0.5 font-bold"
                        style={{ color: pnlColor(t.pnl_amount) }}
                      >
                        {csym}
                        {fmtK(Math.abs(t.pnl_amount))} {t.pnl_amount >= 0 ? "▲" : "▼"}
                      </td>
                      <td className="px-2 py-0.5" style={{ color: pnlColor(t.pnl_percent) }}>
                        {fmtPct(t.pnl_percent)}
                      </td>
                      <td className="px-2 py-0.5" style={{ color: colors.textSecondary }}>
                        {t.holding_days}d
                      </td>
                      <td className="px-2 py-0.5 font-bold" style={{ color: wlColor(t.win_loss) }}>
                        {t.win_loss}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : !distLoading ? (
          <div className="py-6 text-center text-[10px]" style={{ color: colors.textSecondary }}>
            No closed trades for attribution
          </div>
        ) : null)}

      {loading && !eqData && (
        <div className="py-8 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
        </div>
      )}
    </div>
  );
}
