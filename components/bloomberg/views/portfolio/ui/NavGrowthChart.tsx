"use client";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Colors, fmtK, pnlColor } from "../helpers";

// Signals-style growth view of the book: cumulative time-weighted growth (a
// deposit does not move it), deposit ▲ / withdrawal ▼ marks (cash EDIT offsets ◆
// apart — a correction is not money moved), a least-squares
// trend line, and a year × month table of compounded monthly returns.
// Data: /api/v2/portfolio/nav-index — the same daily TWR as the INDEX mode.

export interface NavGrowthPoint {
  date: string;
  nav: number;
  flow: number;
  /** Deposits/withdrawals only (cash_ledger). Absent from older backends. */
  capital_flow?: number;
  /** Cash EDIT / reconcile offsets — a correction, not money moved. */
  adjustment_flow?: number;
  return_pct: number;
  port_index: number;
  suspect: boolean;
  /** Rebuilt from closing prices after the fact (scripts/backfill_nav.py). */
  estimated?: boolean;
}

export interface NavGrowthData {
  points: NavGrowthPoint[];
  base_currency: string;
  suspect_days: number;
  port_twr_pct: number | null;
  /** Last date of the rebuilt span; null when every point was captured live. */
  estimated_until?: string | null;
  note?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UP = "#4ade80";
const DOWN = "#f87171";
const ADJ = "#9ca3af";

/** Year rows visible before the table scrolls — the rest stay one scroll away. */
const TABLE_ROWS_VISIBLE = 5;

/** Flows smaller than this share of NAV are rounding in the ledger, not a deposit. */
const FLOW_MIN_SHARE = 0.001;

const pct = (v: number | null | undefined, d = 2) =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;

export function NavGrowthChart({
  data,
  loading,
  colors,
  height = 260,
}: {
  data: NavGrowthData | null;
  loading: boolean;
  colors: Colors;
  height?: number;
}) {
  const pts = data?.points ?? [];
  const sym = data?.base_currency === "USD" ? "$" : "฿";

  const model = useMemo(() => {
    if (pts.length < 2) return null;
    const rows = pts.map((p, i) => ({
      i,
      date: p.date,
      growth: p.port_index - 100,
      nav: p.nav,
      flow: p.capital_flow ?? p.flow,
      adj: p.adjustment_flow ?? 0,
      ret: p.return_pct,
      suspect: p.suspect,
    }));

    // Least-squares line through the growth curve, by day index.
    const n = rows.length;
    const mx = (n - 1) / 2;
    const my = rows.reduce((a, r) => a + r.growth, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const r of rows) {
      sxy += (r.i - mx) * (r.growth - my);
      sxx += (r.i - mx) ** 2;
    }
    const slope = sxx ? sxy / sxx : 0;
    for (const r of rows) (r as typeof r & { trend: number }).trend = my + slope * (r.i - mx);

    // Compounded return per calendar month, then per year.
    const byMonth = new Map<string, number>();
    for (const r of rows.slice(1)) {
      const k = r.date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 1) * (1 + r.ret / 100));
    }
    const years = [...new Set([...byMonth.keys()].map((k) => k.slice(0, 4)))].sort();
    // Net deposits − withdrawals per month, so the table shows WHEN money came
    // in or went out next to how the money already there performed.
    const flowByMonth = new Map<string, number>();
    for (const r of rows.slice(1)) {
      if (Math.abs(r.flow) <= 0.5) continue;
      const k = r.date.slice(0, 7);
      flowByMonth.set(k, (flowByMonth.get(k) ?? 0) + r.flow);
    }
    const table = years.map((y) => {
      const cells = MONTHS.map((_, m) => {
        const g = byMonth.get(`${y}-${String(m + 1).padStart(2, "0")}`);
        return g == null ? null : (g - 1) * 100;
      });
      const yearG = cells.reduce<number>((a, c) => (c == null ? a : a * (1 + c / 100)), 1);
      const flows = MONTHS.map(
        (_, m) => flowByMonth.get(`${y}-${String(m + 1).padStart(2, "0")}`) ?? null
      );
      const flowTotal = flows.reduce<number>((a, f) => a + (f ?? 0), 0);
      return { year: y, cells, total: (yearG - 1) * 100, flows, flowTotal };
    });
    // Newest year on top: once the table outgrows its box, the year you are
    // living in is the one that stays visible.
    table.reverse();
    const monthly = [...byMonth.values()].map((g) => (g - 1) * 100);
    const avgMonthly = monthly.length ? monthly.reduce((a, b) => a + b, 0) / monthly.length : null;

    const flows = rows.filter(
      (r) => r.i > 0 && Math.abs(r.flow) > Math.max(1, FLOW_MIN_SHARE * r.nav)
    );
    const deposits = flows.filter((r) => r.flow > 0).reduce((a, r) => a + r.flow, 0);
    const withdrawals = flows.filter((r) => r.flow < 0).reduce((a, r) => a - r.flow, 0);
    const adjustments = rows.filter(
      (r) => r.i > 0 && Math.abs(r.adj) > Math.max(1, FLOW_MIN_SHARE * r.nav)
    );
    const adjTotal = adjustments.reduce((a, r) => a + r.adj, 0);

    const vals = rows.flatMap((r) => [r.growth, (r as typeof r & { trend: number }).trend]);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const pad = Math.max(1, (hi - lo) * 0.12);
    return {
      rows: rows as ((typeof rows)[number] & { trend: number })[],
      table,
      avgMonthly,
      flows,
      deposits,
      withdrawals,
      adjustments,
      adjTotal,
      domain: [lo - pad, hi + pad] as [number, number],
      // Partial only when data starts after the month's first few days (a
      // series starting on the 1st–3rd has missed at most a holiday).
      firstMonth: Number(rows[0].date.slice(8, 10)) > 3 ? rows[0].date.slice(0, 7) : null,
      multiYear: rows[0].date.slice(0, 4) !== rows[rows.length - 1].date.slice(0, 4),
    };
  }, [pts]);

  if (loading && pts.length === 0)
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  if (!model)
    return (
      <div
        className="flex items-center justify-center text-[9px] text-center px-4"
        style={{ height, color: colors.textSecondary }}
      >
        {data?.note ?? "ยังไม่มี snapshot พอจะสร้างเส้น Growth — NAV ถูกเก็บวันละครั้งตอนเปิดหน้า"}
      </div>
    );

  const growth = data?.port_twr_pct ?? model.rows.at(-1)?.growth ?? null;
  const stat = (label: string, value: string, color: string, dot: string, title?: string) => (
    <div className="min-w-0" title={title}>
      <div className="text-[14px] font-mono font-bold leading-tight" style={{ color }}>
        {value}
      </div>
      <div
        className="text-[8px] font-mono flex items-center gap-1"
        style={{ color: colors.textSecondary }}
      >
        <span
          data-frame
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: dot }}
        />
        {label}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
        {stat(
          "Growth",
          pct(growth),
          pnlColor(growth ?? 0),
          "#60a5fa",
          "Time-weighted: each day's return net of that day's deposit/withdrawal, compounded"
        )}
        {stat(
          "Average / month",
          pct(model.avgMonthly),
          pnlColor(model.avgMonthly ?? 0),
          "#9ca3af",
          "Mean of the compounded monthly returns below (partial first month included)"
        )}
        {stat(
          "Deposits",
          `${sym}${fmtK(model.deposits)}`,
          colors.text,
          UP,
          "External inflows in the chart span"
        )}
        {stat(
          "Withdrawals",
          `${sym}${fmtK(model.withdrawals)}`,
          colors.text,
          DOWN,
          "External outflows in the chart span"
        )}
        {model.adjustments.length > 0 &&
          stat(
            "Cash adj.",
            `${model.adjTotal < 0 ? "−" : ""}${sym}${fmtK(Math.abs(model.adjTotal))}`,
            colors.text,
            ADJ,
            "Cash EDIT / reconcile offsets (◆) — corrections to the cash figure, not deposits. Netted out of growth like a flow."
          )}
        <span className="text-[8px] font-mono ml-auto" style={{ color: "#666" }}>
          {model.rows[0].date} → {model.rows.at(-1)?.date} · {model.rows.length}d
          {data?.estimated_until && (
            <span
              title="Before this date NAV was not captured on the day; it was rebuilt from trade history and daily closes (validated against the live span: median error 0.4%)"
              style={{ color: "#9ca3af" }}
            >
              {" "}
              · est. ≤ {data.estimated_until}
            </span>
          )}
          {(data?.suspect_days ?? 0) > 0 && (
            <span
              style={{ color: DOWN }}
              title="Days where NAV moved more than 50% — usually an unrecorded deposit/withdrawal"
            >
              {" "}
              · ⚠ {data?.suspect_days} suspect
            </span>
          )}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={model.rows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#777", fontSize: 8 }}
            tickLine={false}
            // One year: "07-04". Across years a bare MM-DD is ambiguous → "Jul 26".
            tickFormatter={(d: string) =>
              model.multiYear ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}` : d.slice(5)
            }
            minTickGap={28}
          />
          <YAxis
            orientation="right"
            tick={{ fill: "#777", fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            domain={model.domain}
            allowDataOverflow
            tickFormatter={(v: number) => `${Number(v.toFixed(1))}%`}
            width={44}
          />
          {/* Days nobody opened the terminal, rebuilt from closing prices. */}
          {data?.estimated_until && model.rows[0].date <= data.estimated_until && (
            <ReferenceArea
              x1={model.rows[0].date}
              x2={data.estimated_until}
              fill="#9ca3af"
              fillOpacity={0.06}
              stroke="none"
              ifOverflow="hidden"
              label={{
                value: "EST. — rebuilt from closes",
                position: "insideTopLeft",
                fill: "#6b7280",
                fontSize: 8,
              }}
            />
          )}
          <ReferenceLine y={0} stroke="#444" />
          <Tooltip
            content={({ active, payload }) => {
              const r = payload?.[0]?.payload as (typeof model.rows)[number] | undefined;
              if (!active || !r) return null;
              return (
                <div
                  className="font-mono"
                  style={{
                    background: "#0d0d0d",
                    border: "1px solid #333",
                    padding: 6,
                    fontSize: 10,
                    color: "#e5e5e5",
                  }}
                >
                  <div>{r.date}</div>
                  <div style={{ color: pnlColor(r.growth) }}>Growth {pct(r.growth)}</div>
                  <div style={{ color: pnlColor(r.ret) }}>Day {pct(r.ret)}</div>
                  <div style={{ color: "#aaa" }}>
                    NAV {sym}
                    {fmtK(r.nav)}
                  </div>
                  {Math.abs(r.flow) > 0.5 && (
                    <div style={{ color: r.flow > 0 ? UP : DOWN }}>
                      {r.flow > 0 ? "Deposit" : "Withdrawal"} {sym}
                      {fmtK(Math.abs(r.flow))}
                    </div>
                  )}
                  {Math.abs(r.adj) > 0.5 && (
                    <div style={{ color: ADJ }}>
                      Cash adj. {r.adj < 0 ? "−" : "+"}
                      {sym}
                      {fmtK(Math.abs(r.adj))}
                    </div>
                  )}
                  {r.suspect && <div style={{ color: DOWN }}>⚠ suspect day</div>}
                </div>
              );
            }}
          />
          <Line
            dataKey="trend"
            stroke="#6b7280"
            strokeWidth={1.2}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="growth"
            stroke="#60a5fa"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {model.flows.map((f) => (
            <ReferenceDot
              key={f.date}
              x={f.date}
              y={f.flow > 0 ? model.domain[0] : model.domain[1]}
              r={0}
              ifOverflow="visible"
              shape={(p: { cx?: number; cy?: number }) => {
                const cx = p.cx ?? 0;
                const cy = p.cy ?? 0;
                const up = f.flow > 0;
                const d = up
                  ? `M${cx},${cy - 9} L${cx - 5},${cy - 1} L${cx + 5},${cy - 1} Z`
                  : `M${cx},${cy + 9} L${cx - 5},${cy + 1} L${cx + 5},${cy + 1} Z`;
                return <path d={d} fill={up ? UP : DOWN} opacity={0.75} />;
              }}
            />
          ))}
          {model.adjustments.map((f) => (
            <ReferenceDot
              key={`adj-${f.date}`}
              x={f.date}
              y={model.domain[1]}
              r={0}
              ifOverflow="visible"
              shape={(p: { cx?: number; cy?: number }) => {
                const cx = p.cx ?? 0;
                const cy = (p.cy ?? 0) + 4;
                return (
                  <path
                    d={`M${cx},${cy - 4} L${cx + 4},${cy} L${cx},${cy + 4} L${cx - 4},${cy} Z`}
                    fill={ADJ}
                    opacity={0.7}
                  />
                );
              }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      <div
        className="overflow-x-auto overflow-y-auto"
        // header + N year rows + footer; beyond that the table scrolls instead of growing
        style={{ maxHeight: 24 * (TABLE_ROWS_VISIBLE + 2) }}
      >
        <table className="w-full text-[9px] font-mono whitespace-nowrap">
          <thead className="sticky top-0" style={{ background: "#050505" }}>
            <tr style={{ color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left py-1 px-1.5 font-normal" />
              {MONTHS.map((m) => (
                <th key={m} className="text-right py-1 px-1.5 font-normal">
                  {m}
                </th>
              ))}
              <th className="text-right py-1 px-1.5 font-normal">Year</th>
            </tr>
          </thead>
          <tbody>
            {model.table.map((row) => [
              <tr key={row.year} style={{ borderBottom: "1px solid #151515" }}>
                <td className="py-1 px-1.5" style={{ color: colors.text }}>
                  {row.year}
                </td>
                {row.cells.map((v, m) => {
                  const partial =
                    `${row.year}-${String(m + 1).padStart(2, "0")}` === model.firstMonth;
                  return (
                    <td
                      key={MONTHS[m]}
                      className="text-right py-1 px-1.5"
                      style={{ color: v == null ? "#333" : v >= 0 ? UP : DOWN }}
                      title={partial ? "Partial month — data starts mid-month" : undefined}
                    >
                      {v == null ? "" : `${v.toFixed(2)}${partial ? "*" : ""}`}
                    </td>
                  );
                })}
                <td
                  className="text-right py-1 px-1.5 font-bold"
                  style={{ color: row.total >= 0 ? UP : DOWN }}
                >
                  {pct(row.total)}
                </td>
              </tr>,
              row.flows.some((f) => f != null) && (
                <tr
                  key={`${row.year}-flow`}
                  style={{ borderBottom: "1px solid #151515" }}
                  title="Net deposits − withdrawals recorded in CASH, per month"
                >
                  <td className="py-0.5 px-1.5 text-[8px]" style={{ color: "#666" }}>
                    flow
                  </td>
                  {row.flows.map((f, m) => (
                    <td
                      key={MONTHS[m]}
                      className="text-right py-0.5 px-1.5 text-[8px]"
                      style={{ color: f == null ? "#333" : f > 0 ? UP : DOWN }}
                    >
                      {f == null ? "" : `${f > 0 ? "▲" : "▼"}${fmtK(Math.abs(f))}`}
                    </td>
                  ))}
                  <td
                    className="text-right py-0.5 px-1.5 text-[8px]"
                    style={{ color: row.flowTotal >= 0 ? UP : DOWN }}
                  >
                    {row.flowTotal >= 0 ? "▲" : "▼"}
                    {sym}
                    {fmtK(Math.abs(row.flowTotal))}
                  </td>
                </tr>
              ),
            ])}
          </tbody>
          <tfoot className="sticky bottom-0" style={{ background: "#050505" }}>
            <tr>
              <td colSpan={13} className="pt-1 px-1.5 text-[8px]" style={{ color: "#666" }}>
                % per month, compounded from daily time-weighted returns · * partial month · flow =
                net deposits − withdrawals
              </td>
              <td
                className="pt-1 px-1.5 text-right font-bold"
                style={{ color: pnlColor(growth ?? 0) }}
              >
                Total {pct(growth)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
