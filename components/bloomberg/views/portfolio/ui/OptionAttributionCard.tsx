"use client";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Colors, fmt, fmtK, pnlColor } from "../helpers";

// Greeks-based P&L attribution for the option book. Every option day is split
// into the four first-order effects plus whatever the linearisation misses:
//
//   ΔP ≈ Δ·ΔS + ½Γ·ΔS² + Θ·Δt + ν·ΔIV + residual
//
// `residual` is DEFINED as the leftover, so the five parts always sum to the
// actual move — that is arithmetic, not evidence. `explained_pct` is the honest
// quality signal: a large residual means the split did not describe what
// happened (a violent move, a stale mark, or an IV jump between snapshots).
//
// Greeks always come from the START of each day. Using end-of-day greeks would
// be explaining a move with information that only existed after it.

interface AttributionBucket {
  delta_pnl: number;
  gamma_pnl: number;
  theta_pnl: number;
  vega_pnl: number;
  residual: number;
  actual: number;
}

interface AttributionRow extends AttributionBucket {
  position_id: string;
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: string;
  quantity: number;
  steps: number;
  spot_from: number | null;
  spot_to: number | null;
  iv_from: number | null;
  iv_to: number | null;
  explained_pct: number | null;
}

export interface OptionAttribution {
  currency: string;
  period: {
    from: string | null;
    to: string | null;
    snapshot_days: number;
    requested_days: number;
  };
  portfolio: AttributionBucket & { explained_pct: number | null };
  positions: AttributionRow[];
  series: (AttributionBucket & { date: string })[];
  steps_skipped: number;
  note: string | null;
}

const LEGS = [
  {
    key: "delta_pnl",
    label: "DELTA",
    color: "#38bdf8",
    hint: "Δ × ΔS — the move in the underlying",
  },
  {
    key: "gamma_pnl",
    label: "GAMMA",
    color: "#a78bfa",
    hint: "½Γ × ΔS² — convexity, always helps a long option",
  },
  { key: "theta_pnl", label: "THETA", color: "#f59e0b", hint: "Θ × days — time decay" },
  {
    key: "vega_pnl",
    label: "VEGA",
    color: "#4ade80",
    hint: "ν × ΔIV — the move in implied volatility",
  },
  {
    key: "residual",
    label: "RESIDUAL",
    color: "#6b7280",
    hint: "What the first-order split does not explain",
  },
] as const;

const money = (v: number) => `${v >= 0 ? "+" : "-"}$${fmtK(Math.abs(v))}`;

export function OptionAttributionCard({
  accountId,
  colors,
}: { accountId: string; colors: Colors }) {
  const [data, setData] = useState<OptionAttribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/options/attribution?${qs}`);
      if (r.ok) setData(await r.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [accountId, days]);

  useEffect(() => {
    load();
  }, [load]);

  // Nothing to attribute and nothing accumulating — stay out of the way.
  if (!loading && data && data.period.snapshot_days === 0) return null;

  const p = data?.portfolio;

  return (
    <div className="border mx-2 mb-2" style={{ borderColor: colors.border }}>
      {/* Two independent controls sitting on one row, NOT nested: the range
          chips used to live inside the collapse button, which is invalid HTML
          (a button cannot contain a button) and forced them to be spans faking
          a button role — losing real keyboard and screen-reader behaviour. */}
      <div
        className="w-full flex items-center gap-2 px-2 py-1 text-[9px] font-bold tracking-widest"
        style={{ color: colors.accent }}
      >
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          style={{ color: colors.accent }}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? (
            <ChevronRight className="w-2.5 h-2.5 shrink-0" />
          ) : (
            <ChevronDown className="w-2.5 h-2.5 shrink-0" />
          )}
          DERIVATIVES · PNL ATTRIBUTION
          <span className="font-normal opacity-60">USD</span>
          {data?.period.from && (
            <span className="font-normal opacity-50">
              {data.period.from} → {data.period.to} · {data.period.snapshot_days}d
            </span>
          )}
          {loading && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
        </button>
        <span className="flex items-center gap-1 shrink-0">
          {[30, 90, 365].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className="px-1 border rounded"
              style={{
                borderColor: days === d ? colors.accent : colors.border,
                color: days === d ? colors.accent : colors.textSecondary,
              }}
            >
              {d === 365 ? "1Y" : `${d}D`}
            </button>
          ))}
        </span>
      </div>

      {!collapsed && (
        <div className="p-2">
          {data?.note && (
            <div
              className="text-[9px] px-2 py-1 mb-2 rounded border"
              style={{ borderColor: "#f59e0b44", background: "#f59e0b11", color: "#f59e0b" }}
            >
              {data.note}
            </div>
          )}

          {/* Portfolio split */}
          {p && (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-2 text-[10px] font-mono">
              {LEGS.map((leg) => {
                const v = p[leg.key] as number;
                return (
                  <div key={leg.key} title={leg.hint}>
                    <div className="text-[8px]" style={{ color: leg.color }}>
                      {leg.label}
                    </div>
                    <div className="font-bold" style={{ color: pnlColor(v) }}>
                      {money(v)}
                    </div>
                  </div>
                );
              })}
              <div title="Share of the actual move the four greeks account for. Low means the first-order split did not describe what happened — read the legs with suspicion.">
                <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                  ACTUAL · EXPLAINED
                </div>
                <div className="font-bold" style={{ color: pnlColor(p.actual) }}>
                  {money(p.actual)}
                  <span
                    className="ml-1 text-[9px]"
                    style={{
                      color:
                        p.explained_pct === null
                          ? colors.textSecondary
                          : p.explained_pct >= 80
                            ? "#4ade80"
                            : p.explained_pct >= 50
                              ? "#f59e0b"
                              : "#FF4444",
                    }}
                  >
                    {p.explained_pct === null ? "—" : `${fmt(p.explained_pct, 0)}%`}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Daily stack */}
          {(data?.series.length ?? 0) > 1 && (
            <div className="h-32 mb-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 2" stroke="#1a1a1a" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 8, fill: colors.textSecondary }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 8, fill: colors.textSecondary }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => fmtK(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0a0a0a",
                      border: `1px solid ${colors.border}`,
                      fontSize: 10,
                    }}
                    labelStyle={{ color: colors.textSecondary, fontSize: 9 }}
                    itemStyle={{ fontSize: 9 }}
                    // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                    formatter={(v: any, name: any) => [`$${fmt(Number(v), 0)}`, name]}
                  />
                  {LEGS.map((leg) => (
                    <Bar
                      key={leg.key}
                      dataKey={leg.key}
                      stackId="a"
                      fill={leg.color}
                      name={leg.label}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Per-option breakdown */}
          {(data?.positions.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[9px] font-mono">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                    {[
                      "CONTRACT",
                      "QTY",
                      "SPOT",
                      "IV",
                      "DELTA",
                      "GAMMA",
                      "THETA",
                      "VEGA",
                      "RESID",
                      "ACTUAL",
                      "EXPL",
                    ].map((h) => (
                      <th
                        key={h}
                        className={h === "CONTRACT" ? "text-left py-0.5" : "text-right py-0.5"}
                        style={{ color: colors.textSecondary }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.positions.map((row) => (
                    <tr key={row.position_id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                      <td className="py-0.5" style={{ color: colors.text }}>
                        {row.symbol}
                      </td>
                      <td className="text-right py-0.5" style={{ color: colors.text }}>
                        {row.quantity}
                      </td>
                      <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                        {row.spot_from === null || row.spot_to === null
                          ? "—"
                          : `${fmt(row.spot_from, 2)}→${fmt(row.spot_to, 2)}`}
                      </td>
                      <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                        {row.iv_from === null || row.iv_to === null
                          ? "—"
                          : `${fmt(row.iv_from * 100, 1)}→${fmt(row.iv_to * 100, 1)}`}
                      </td>
                      {LEGS.map((leg) => (
                        <td
                          key={leg.key}
                          className="text-right py-0.5"
                          style={{ color: pnlColor(row[leg.key] as number) }}
                        >
                          {money(row[leg.key] as number)}
                        </td>
                      ))}
                      <td
                        className="text-right py-0.5 font-bold"
                        style={{ color: pnlColor(row.actual) }}
                      >
                        {money(row.actual)}
                      </td>
                      <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                        {row.explained_pct === null ? "—" : `${fmt(row.explained_pct, 0)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.steps_skipped > 0 && (
            <div className="text-[8px] mt-1" style={{ color: colors.textSecondary }}>
              {data.steps_skipped} day-step{data.steps_skipped > 1 ? "s" : ""} skipped — the earlier
              snapshot had no IV, so its greeks were undefined and the move cannot be attributed
            </div>
          )}
        </div>
      )}
    </div>
  );
}
