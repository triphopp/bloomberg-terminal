"use client";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ALLOC_COLORS } from "../constants";
import { type Colors, fmtK, pnlColor } from "../helpers";

// ALLOCATION (OPEN) on two bases at once. The old card weighted sectors by COST
// alone, which is frozen at entry — a position that doubled still showed the
// slice you originally bought, so there was no way to see how far a winner had
// grown into the book or how much to trim.

export interface AllocRow {
  symbol?: string;
  sector?: string;
  cost_base: number;
  market_value: number | null;
  unrealized: number | null;
  growth_pct: number | null;
  weight_cost_pct: number;
  weight_mv_pct: number;
  drift_pp: number;
  contrib_growth_pct: number;
  share_of_gain_pct: number;
  target_pct: number;
  target_source: "explicit" | "cost_weight";
  band_pct: number;
  target_value: number;
  delta_value: number;
  in_band: boolean;
  action: "BUY" | "SELL" | "HOLD";
  delta_shares?: number | null;
  lot_size?: number;
  est_realized?: number | null;
  est_value?: number | null;
  price?: number | null;
  volume?: number;
  priced?: boolean;
  has_override?: boolean;
  symbols?: AllocRow[];
}

interface AllocDetail {
  base_currency: string;
  totals: {
    cost_base: number;
    market_value: number;
    unrealized: number;
    growth_pct: number | null;
    gain_concentration_pct: number;
    gain_concentration_symbol: string | null;
    positions: number;
  };
  sectors: AllocRow[];
  symbols: AllocRow[];
}

type Mode = "COST" | "VALUE" | "DRIFT";

const growthColor = (v: number | null | undefined) =>
  v == null ? "#666" : v > 0 ? "#4ade80" : v < 0 ? "#f87171" : "#888";

export function AllocationBasisCard({
  accountId,
  currency,
  colors,
}: { accountId: string; currency: "THB" | "USD"; colors: Colors }) {
  const [data, setData] = useState<AllocDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("VALUE");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Edited-but-unsaved targets, keyed "scope:key". Kept separate from `data` so
  // a background refetch cannot silently discard what is being typed.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const sym = currency === "THB" ? "฿" : "$";

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ base_currency: currency });
        if (accountId !== "all") qs.set("account_id", accountId);
        const r = await fetch(`/api/v2/portfolio/allocation-detail?${qs}`, { signal });
        if (!r.ok) throw new Error("fetch failed");
        setData(await r.json());
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") setData(null);
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

  const sectors = data?.sectors ?? [];
  const totals = data?.totals;

  const pieData = useMemo(
    () =>
      sectors.map((s) => ({
        sector: s.sector ?? "Other",
        value: mode === "COST" ? s.cost_base : (s.market_value ?? s.cost_base),
      })),
    [sectors, mode]
  );

  const maxDrift = useMemo(
    () => Math.max(1, ...sectors.map((s) => Math.abs(s.drift_pp))),
    [sectors]
  );

  const saveTargets = async () => {
    const body = Object.entries(draft).map(([k, v]) => {
      const [scope, ...rest] = k.split(":");
      return {
        account_id: accountId === "all" ? "all" : accountId,
        scope,
        key: rest.join(":"),
        target_pct: Number.parseFloat(v) || 0,
        band_pct: 5,
      };
    });
    setSaving(true);
    try {
      const r = await fetch("/api/v2/portfolio/allocation-targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        window.alert(err.detail ?? "Save failed");
        return;
      }
      setDraft({});
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const targetValue = (row: AllocRow, scope: "sector" | "symbol") => {
    const key = `${scope}:${row.sector ?? row.symbol}`;
    return draft[key] ?? (row.target_source === "explicit" ? String(row.target_pct) : "");
  };

  const setTarget = (row: AllocRow, scope: "sector" | "symbol", v: string) =>
    setDraft((d) => ({ ...d, [`${scope}:${row.sector ?? row.symbol}`]: v }));

  const actionCell = (row: AllocRow, scope: "sector" | "symbol") => {
    if (row.action === "HOLD") {
      return <span style={{ color: "#666" }}>— in band</span>;
    }
    const isSell = row.action === "SELL";
    const color = isSell ? "#f87171" : "#4ade80";
    if (scope === "symbol" && row.delta_shares) {
      return (
        <span style={{ color }}>
          {row.action} {Math.abs(row.delta_shares).toLocaleString()}
          {row.est_value != null && ` ≈ ${sym}${fmtK(row.est_value)}`}
          {isSell && row.est_realized != null && (
            <span style={{ color: pnlColor(row.est_realized) }}>
              {" "}
              (realize {sym}
              {fmtK(Math.abs(row.est_realized))})
            </span>
          )}
        </span>
      );
    }
    return (
      <span style={{ color }}>
        {row.action} {sym}
        {fmtK(Math.abs(row.delta_value))}
      </span>
    );
  };

  const numCell = (v: number | null | undefined, color?: string) => (
    <td className="text-right py-0.5 tabular-nums" style={{ color: color ?? colors.text }}>
      {v == null ? "—" : `${sym}${fmtK(v)}`}
    </td>
  );

  const row = (r: AllocRow, scope: "sector" | "symbol", idx: number) => {
    const label = scope === "sector" ? (r.sector ?? "Other") : (r.symbol ?? "");
    const key = `${scope}:${label}`;
    const isOpen = expanded.has(key);
    return (
      <tr
        key={key}
        style={{
          borderBottom: "1px solid #1a1a1a",
          background: scope === "symbol" ? "#0a0a0a" : "transparent",
        }}
      >
        <td className="py-0.5">
          <div className="flex items-center gap-1">
            {scope === "sector" ? (
              <button
                type="button"
                onClick={() => toggle(key)}
                className="flex items-center gap-1 hover:opacity-80"
              >
                {isOpen ? (
                  <ChevronDown className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
                ) : (
                  <ChevronRight className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
                )}
                <span
                  className="w-2 h-2 rounded-sm flex-shrink-0"
                  style={{ background: ALLOC_COLORS[idx % ALLOC_COLORS.length] }}
                />
                <span style={{ color: colors.text }}>{label}</span>
              </button>
            ) : (
              <span className="pl-6 font-bold" style={{ color: colors.accent }}>
                {label}
                {r.has_override && (
                  <span
                    className="ml-1 text-[7px]"
                    style={{ color: "#ff9900" }}
                    title="manual average-cost override"
                  >
                    ovr
                  </span>
                )}
                {r.priced === false && (
                  <span
                    className="ml-1 text-[7px]"
                    style={{ color: "#ff9900" }}
                    title="a lot has no live quote"
                  >
                    ?
                  </span>
                )}
              </span>
            )}
          </div>
        </td>
        {numCell(r.cost_base, colors.textSecondary)}
        {numCell(r.market_value)}
        <td className="text-right py-0.5 tabular-nums" style={{ color: growthColor(r.growth_pct) }}>
          {r.growth_pct == null
            ? "—"
            : `${r.growth_pct >= 0 ? "+" : ""}${r.growth_pct.toFixed(1)}%`}
        </td>
        <td className="text-right py-0.5 tabular-nums" style={{ color: colors.textSecondary }}>
          {r.weight_cost_pct.toFixed(1)}%
        </td>
        <td className="text-right py-0.5 tabular-nums font-bold" style={{ color: colors.text }}>
          {r.weight_mv_pct.toFixed(1)}%
        </td>
        <td className="text-right py-0.5 tabular-nums" style={{ color: growthColor(r.drift_pp) }}>
          {r.drift_pp >= 0 ? "+" : ""}
          {r.drift_pp.toFixed(1)}
        </td>
        <td className="text-right py-0.5">
          <input
            value={targetValue(r, scope)}
            onChange={(e) => setTarget(r, scope, e.target.value)}
            placeholder={r.weight_cost_pct.toFixed(1)}
            className="w-10 text-right bg-transparent border px-0.5 tabular-nums outline-none"
            style={{
              borderColor: draft[`${scope}:${label}`] != null ? colors.accent : "#222",
              color: r.target_source === "explicit" ? colors.accent : colors.textSecondary,
            }}
          />
        </td>
        <td className="text-right py-0.5 pl-2 whitespace-nowrap">{actionCell(r, scope)}</td>
      </tr>
    );
  };

  return (
    <div className="border p-2 mx-2 mb-2" style={{ borderColor: colors.border }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
          ALLOCATION (OPEN) — BASIS vs MARKET
        </div>
        <div className="flex items-center gap-1">
          {Object.keys(draft).length > 0 && (
            <button
              type="button"
              onClick={saveTargets}
              disabled={saving}
              className="text-[7px] px-1.5 py-0.5 border font-bold disabled:opacity-40"
              style={{ borderColor: colors.accent, color: colors.accent, background: "#ff990015" }}
            >
              {saving ? "SAVING…" : "SAVE TARGETS"}
            </button>
          )}
          {(["COST", "VALUE", "DRIFT"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className="text-[7px] px-1.5 py-0.5 border font-bold"
              style={{
                borderColor: mode === m ? colors.accent : colors.border,
                color: mode === m ? colors.accent : colors.textSecondary,
                background: mode === m ? "#ff990015" : "transparent",
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div className="p-4 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
        </div>
      )}

      {totals && (
        <>
          {/* Summary strip — the four numbers the rebalance decision hangs on */}
          <div className="grid grid-cols-4 gap-px mb-2">
            {[
              { label: "COST BASIS", value: `${sym}${fmtK(totals.cost_base)}`, color: colors.text },
              {
                label: "MARKET VALUE",
                value: `${sym}${fmtK(totals.market_value)}`,
                color: colors.text,
              },
              {
                label: "GROWTH vs BASIS",
                value:
                  totals.growth_pct == null
                    ? "—"
                    : `${totals.growth_pct >= 0 ? "+" : ""}${totals.growth_pct.toFixed(2)}%  (${sym}${fmtK(totals.unrealized)})`,
                color: growthColor(totals.growth_pct),
              },
              {
                label: "GAIN CONCENTRATION",
                value: totals.gain_concentration_symbol
                  ? `${totals.gain_concentration_symbol} ${totals.gain_concentration_pct.toFixed(0)}%`
                  : "—",
                color: colors.accent,
              },
            ].map((t) => (
              <div key={t.label} className="px-2 py-1" style={{ background: "#0a0a0a" }}>
                <div className="text-[7px] tracking-widest" style={{ color: colors.textSecondary }}>
                  {t.label}
                </div>
                <div className="text-[10px] font-bold font-mono" style={{ color: t.color }}>
                  {t.value}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <div className="flex-shrink-0" style={{ width: 150 }}>
              {mode === "DRIFT" ? (
                // Drift is signed — a pie cannot show it. Diverging bars around
                // a zero axis: right of centre = grown past its cost weight.
                <div className="space-y-0.5">
                  {sectors.map((s, i) => (
                    <div key={s.sector} className="text-[7px] font-mono">
                      <div className="flex justify-between">
                        <span className="truncate" style={{ color: colors.textSecondary }}>
                          {s.sector}
                        </span>
                        <span style={{ color: growthColor(s.drift_pp) }}>
                          {s.drift_pp >= 0 ? "+" : ""}
                          {s.drift_pp.toFixed(1)}
                        </span>
                      </div>
                      <div className="relative h-1.5" style={{ background: "#141414" }}>
                        <div
                          className="absolute inset-y-0 left-1/2 w-px"
                          style={{ background: "#333" }}
                        />
                        <div
                          className="absolute inset-y-0"
                          style={{
                            background: ALLOC_COLORS[i % ALLOC_COLORS.length],
                            left: s.drift_pp >= 0 ? "50%" : undefined,
                            right: s.drift_pp < 0 ? "50%" : undefined,
                            width: `${(Math.abs(s.drift_pp) / maxDrift) * 50}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="sector"
                        cx="50%"
                        cy="50%"
                        innerRadius="42%"
                        outerRadius="72%"
                        stroke="#0a0a0a"
                        strokeWidth={1}
                      >
                        {pieData.map((d, i) => (
                          <Cell key={d.sector} fill={ALLOC_COLORS[i % ALLOC_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "#111",
                          border: "1px solid #333",
                          fontSize: 9,
                          color: "#e5e5e5",
                        }}
                        labelStyle={{ color: "#e5e5e5" }}
                        itemStyle={{ color: "#e5e5e5" }}
                        // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
                        formatter={(v: any, _n: any, p: any) => [
                          `${sym}${fmtK(v)}`,
                          `${p.payload.sector} (${mode.toLowerCase()})`,
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 overflow-x-auto">
              <table className="w-full text-[8px] font-mono">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                    {[
                      ["SECTOR / SYMBOL", "left"],
                      ["COST", "right"],
                      ["MKT VALUE", "right"],
                      ["GROW%", "right"],
                      ["W cost", "right"],
                      ["W mkt", "right"],
                      ["Δpp", "right"],
                      ["TGT%", "right"],
                      ["REBALANCE", "right"],
                    ].map(([label, align]) => (
                      <th
                        key={label}
                        className={`py-0.5 text-${align} whitespace-nowrap`}
                        style={{ color: colors.textSecondary }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sectors.map((s, i) => {
                    const rows = [row(s, "sector", i)];
                    if (expanded.has(`sector:${s.sector ?? "Other"}`)) {
                      for (const sub of s.symbols ?? []) rows.push(row(sub, "symbol", i));
                    }
                    return rows;
                  })}
                </tbody>
              </table>
              <div className="mt-1 text-[7px]" style={{ color: colors.textSecondary }}>
                TGT% blank = target defaults to the cost weight, i.e. trim what the run-up inflated
                back to the slice originally deployed. Δpp = market weight − cost weight.
              </div>
            </div>
          </div>
        </>
      )}

      {!loading && data && sectors.length === 0 && (
        <div className="p-3 text-[9px]" style={{ color: colors.textSecondary }}>
          No open positions
        </div>
      )}
    </div>
  );
}
