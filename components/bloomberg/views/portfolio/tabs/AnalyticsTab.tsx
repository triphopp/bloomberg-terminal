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
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ALLOC_COLORS } from "../constants";
import { type Colors, fmtK, pnlColor } from "../helpers";
import type { Dividend, Summary } from "../types";
import { AccBadge } from "../ui/AccBadge";

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
  } | null>(null);
  const [dividends, setDividends] = useState<Dividend[]>([]);
  const [divPeriod, setDivPeriod] = useState<"M" | "Q" | "Y">("M");
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
        const [ar, dr] = await Promise.all([
          fetch(`/api/v2/portfolio/analytics${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/dividends${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
        ]);
        setAnalytics(ar);
        setDividends(Array.isArray(dr) ? dr : []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

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

  const monthData = (analytics?.by_month ?? []).map((m) => ({
    month: m.month,
    pnl: m.pnl,
    win_rate: m.win_rate,
  }));

  const cumulativeData = useMemo(() => {
    let cum = 0;
    return monthData.map((m) => {
      cum += m.pnl;
      return { month: m.month, cumPnl: cum };
    });
  }, [monthData]);

  const totalPnl = cumulativeData.at(-1)?.cumPnl ?? 0;

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
      map[key] = (map[key] || 0) + d.total_received;
    });
    return Object.entries(map)
      .sort()
      .map(([label, total]) => ({ month: label, total }));
  }, [dividends, divPeriod]);

  const allocationData = analytics?.open_by_sector ?? [];
  const [selectedSector, setSelectedSector] = useState<string | null>(null);

  const accStats = summary?.accounts ?? [];
  const filteredStats =
    accountId === "all" ? accStats : accStats.filter((a) => a.account.id === accountId);

  return (
    <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
      {/* Per-account summary */}
      <div className="grid gap-px p-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
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
              <span style={{ color: "#4ade80" }}>฿{fmtK(s.total_dividends)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Monthly + Cumulative P&L side by side for a tighter aspect ratio */}
      {monthData.length > 0 && (
        <div className="grid gap-2 mx-2 mb-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                  formatter={(v: any) => [`${sym}${fmtK(v)}`, "P&L"]}
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
                      {sym}
                      {fmtK(Math.abs(m.pnl))} {m.pnl >= 0 ? "▲" : "▼"}
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
                    {sym}
                    {fmtK(Math.abs(totalPnl))} {totalPnl >= 0 ? "▲" : "▼"}
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
      <div className="grid gap-2 mx-2 mb-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
                  formatter={(v: any) => [`฿${fmtK(v)}`, "Dividend"]}
                />
                <Bar dataKey="total" fill="#4ade80" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {allocationData.length > 0 &&
          (() => {
            // biome-ignore lint/suspicious/noExplicitAny: untyped API response
            const total = allocationData.reduce((s: number, d: any) => s + d.value, 0);
            const sel = selectedSector
              ? // biome-ignore lint/suspicious/noExplicitAny: untyped API response
                allocationData.find((d: any) => d.sector === selectedSector)
              : null;
            const selTotal = sel?.value ?? 0;
            return (
              <div className="border p-2" style={{ borderColor: colors.border }}>
                <div
                  className="text-[9px] font-bold tracking-widest mb-2"
                  style={{ color: colors.accent }}
                >
                  ALLOCATION (OPEN)
                </div>
                <div className="flex gap-3">
                  <div className="flex-shrink-0" style={{ width: 130, height: 130 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={allocationData}
                          dataKey="value"
                          nameKey="sector"
                          cx="50%"
                          cy="50%"
                          innerRadius="42%"
                          outerRadius="72%"
                          paddingAngle={0}
                          stroke="#0a0a0a"
                          strokeWidth={1}
                          // biome-ignore lint/suspicious/noExplicitAny: recharts event payload
                          onClick={(d: any) =>
                            setSelectedSector((s) => (s === d.sector ? null : d.sector))
                          }
                          style={{ cursor: "pointer" }}
                        >
                          {/* biome-ignore lint/suspicious/noExplicitAny: untyped API response */}
                          {allocationData.map((d: any, i: number) => (
                            <Cell
                              key={d.sector ?? i}
                              fill={ALLOC_COLORS[i % ALLOC_COLORS.length]}
                              opacity={selectedSector && selectedSector !== d.sector ? 0.25 : 1}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ ...tooltipContentStyle, fontSize: 9 }}
                          labelStyle={tooltipLabelStyle}
                          itemStyle={tooltipItemStyle}
                          // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                          formatter={(v: any, _: any, p: any) => [
                            `฿${fmtK(v)} (${total > 0 ? ((v / total) * 100).toFixed(1) : 0}%)`,
                            p.payload.sector,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="space-y-0.5 mb-1">
                      {/* biome-ignore lint/suspicious/noExplicitAny: untyped API response */}
                      {allocationData.map((d: any, i: number) => {
                        const isSelected = selectedSector === d.sector;
                        return (
                          <button
                            type="button"
                            key={d.sector}
                            onClick={() =>
                              setSelectedSector((s) => (s === d.sector ? null : d.sector))
                            }
                            className="w-full flex items-center gap-1.5 text-[8px] font-mono px-1 py-0.5 rounded hover:opacity-90 transition-opacity"
                            style={{
                              background: isSelected
                                ? `${ALLOC_COLORS[i % ALLOC_COLORS.length]}22`
                                : "transparent",
                              border: `1px solid ${isSelected ? `${ALLOC_COLORS[i % ALLOC_COLORS.length]}66` : "transparent"}`,
                            }}
                          >
                            <span
                              className="w-2 h-2 rounded-sm flex-shrink-0"
                              style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
                            />
                            <span
                              className="truncate"
                              style={{ color: isSelected ? colors.text : colors.textSecondary }}
                            >
                              {d.sector}
                            </span>
                            <span
                              className="ml-auto flex-shrink-0 font-bold"
                              style={{ color: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
                            >
                              {total > 0 ? ((d.value / total) * 100).toFixed(1) : 0}%
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {sel && (
                  <div className="mt-2 pt-2 border-t" style={{ borderColor: colors.border }}>
                    <div
                      className="text-[8px] font-bold tracking-widest mb-1"
                      style={{ color: colors.accent }}
                    >
                      {sel.sector} — {((sel.value / total) * 100).toFixed(1)}% of port
                    </div>
                    <div
                      className="grid gap-px"
                      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}
                    >
                      {/* biome-ignore lint/suspicious/noExplicitAny: untyped API response */}
                      {(sel.symbols ?? []).map((s: any) => (
                        <div
                          key={s.symbol}
                          className="flex items-center justify-between px-1.5 py-0.5 text-[8px] font-mono"
                          style={{ background: "#0a0a0a" }}
                        >
                          <span className="font-bold" style={{ color: colors.accent }}>
                            {s.symbol}
                          </span>
                          <span style={{ color: colors.textSecondary }}>
                            {selTotal > 0 ? ((s.value / selTotal) * 100).toFixed(0) : 0}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>

      <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
      </div>

      {loading && (
        <div className="py-8 text-center">
          <Loader2 className="h-4 w-4 animate-spin mx-auto" style={{ color: colors.accent }} />
        </div>
      )}
    </div>
  );
}
