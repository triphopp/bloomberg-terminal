"use client";
import { AlertTriangle, ChevronDown, ChevronRight, Clock, Loader2, RefreshCw } from "lucide-react";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  ALL_COLS,
  type ColName,
  DEFAULT_COLS,
  DENSE_COLS,
  GROUP_COLORS,
  SUBPORT_COLORS,
} from "../constants";
import { type Colors, fmt, fmtK, fmtPct, groupKey, pnlColor, subPortLabel } from "../helpers";
import { AvgCostModal } from "../modals/AvgCostModal";
import { SellModal } from "../modals/SellModal";
import { TradeEditModal } from "../modals/TradeEditModal";
import type { Trade } from "../types";
import { AccBadge } from "../ui/AccBadge";

// ── Inline derivatives summary (read-only, no form) ──────────────────────────

interface OptionPos {
  id: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  quantity: number;
  entry_price: number;
}

interface OptionQuote {
  last_price: number | null;
  freshness: { is_realtime: boolean; delay_minutes: number; warning: string; fetched_at: string };
}

// Columns actually rendered = user's showCols plus the auto PRE/POST column
// injected while a live session is active. PRE/POST is intentionally NOT a
// ColName so it can't be added/removed via the COLS picker.
type DisplayCol = ColName | "PRE/POST";

// Pre-/post-market session quote (from /api/v2/portfolio/premarket)
interface SessionQuote {
  market_state: string | null;
  regular_price: number | null;
  pre_price: number | null;
  pre_change: number | null;
  pre_change_pct: number | null;
  post_price: number | null;
  post_change: number | null;
  post_change_pct: number | null;
  /** Exchange-local dates of each extended-hours quote. The backend nulls the
   *  price when its date isn't today's; these stay so the UI can explain why. */
  pre_date?: string | null;
  post_date?: string | null;
}

/** The live extended-hours side of a session quote, or null when neither is on. */
function activeSession(
  s: SessionQuote | undefined
): { label: "PRE" | "POST"; change: number; pct: number | null } | null {
  if (!s) return null;
  const st = (s.market_state || "").toUpperCase();
  // Prices are already freshness-filtered server-side; marketState just picks
  // which side is the one currently running.
  if (st.startsWith("PRE") && s.pre_price != null && s.pre_change != null) {
    return { label: "PRE", change: s.pre_change, pct: s.pre_change_pct };
  }
  if ((st.startsWith("POST") || st === "CLOSED") && s.post_price != null && s.post_change != null) {
    return { label: "POST", change: s.post_change, pct: s.post_change_pct };
  }
  return null;
}

function DerivativesSection({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [positions, setPositions] = useState<OptionPos[]>([]);
  const [quotes, setQuotes] = useState<Record<string, OptionQuote>>({});
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const qs = new URLSearchParams({ status: "open" });
    if (accountId !== "all") qs.set("account_id", accountId);
    fetch(`/api/options/positions/list?${qs}`)
      .then((r) => r.json())
      .then(setPositions)
      .catch(() => {});
  }, [accountId]);

  useEffect(() => {
    for (const p of positions) {
      fetch(`/api/options/positions/${p.id}/quote`)
        .then((r) => (r.ok ? r.json() : null))
        .then((q) => q && setQuotes((prev) => ({ ...prev, [p.id]: q })))
        .catch(() => {});
    }
  }, [positions]);

  if (positions.length === 0) return null;

  return (
    <div className="border-t mt-1" style={{ borderColor: "#f59e0b44" }}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1 text-[9px] font-bold"
        style={{ background: "#f59e0b0a", color: "#f59e0b" }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span>{collapsed ? "▶" : "▼"}</span>
        DERIVATIVES · OPTIONS
        <span className="font-normal text-[8px] opacity-60">{positions.length} open</span>
        <span className="ml-auto flex items-center gap-0.5 font-normal opacity-60">
          <Clock className="w-2.5 h-2.5" /> ~15m delay
        </span>
      </button>

      {!collapsed && (
        <table className="w-full text-[9px] font-mono">
          <thead>
            <tr style={{ color: colors.textSecondary }}>
              {[
                "Underlying",
                "Type",
                "Strike",
                "Expiry",
                "Qty",
                "Entry",
                "Last",
                "P&L",
                "Data",
              ].map((h) => (
                <th key={h} className="px-2 py-0.5 text-left font-bold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const q = quotes[p.id];
              const last = q?.last_price ?? null;
              const pnl = last !== null ? (last - p.entry_price) * p.quantity * 100 : null;
              const pnlPct =
                pnl !== null && p.entry_price > 0
                  ? (((last ?? 0) - p.entry_price) / p.entry_price) * 100
                  : null;
              const typeColor = p.option_type === "call" ? "#00FF00" : "#FF4444";
              const fresh = q?.freshness;
              return (
                <tr key={p.id} className="border-b" style={{ borderColor: "#1a1a1a" }}>
                  <td className="px-2 py-1 font-bold" style={{ color: colors.text }}>
                    {p.underlying}
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className="text-[8px] px-0.5 rounded"
                      style={{ color: typeColor, border: `1px solid ${typeColor}` }}
                    >
                      {p.option_type.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: colors.text }}>
                    ${fmt(p.strike)}
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: colors.textSecondary }}>
                    {p.expiry}
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: colors.text }}>
                    {p.quantity}
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: colors.textSecondary }}>
                    ${fmt(p.entry_price, 2)}
                  </td>
                  <td className="px-2 py-1 text-right" style={{ color: colors.text }}>
                    {last !== null ? `$${fmt(last, 2)}` : <span style={{ color: "#444" }}>—</span>}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {pnl !== null ? (
                      <span style={{ color: pnlColor(pnl) }}>
                        {pnl >= 0 ? "+" : ""}${fmt(Math.abs(pnl), 0)}
                        {pnlPct !== null && (
                          <span className="text-[8px] ml-0.5">
                            ({pnlPct >= 0 ? "+" : ""}
                            {fmt(pnlPct, 1)}%)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "#444" }}>—</span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    {fresh && !fresh.is_realtime && (
                      <DelayBadge warning={fresh.warning} delay={fresh.delay_minutes} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DelayBadge({ warning, delay }: { warning: string; delay: number }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative inline-flex items-center gap-0.5 cursor-help text-[8px]"
      style={{ color: "#f59e0b" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <Clock className="w-2 h-2" />~{delay}m
      {show && (
        <span
          className="absolute bottom-full left-0 mb-1 z-50 w-52 rounded px-2 py-1.5 text-[9px] leading-snug shadow-lg border"
          style={{ background: "#1a1a1a", borderColor: "#f59e0b", color: "#f59e0b" }}
        >
          <AlertTriangle className="inline w-2.5 h-2.5 mr-1" />
          {warning}
        </span>
      )}
    </span>
  );
}

interface MergedPosition extends Trade {
  lots: Trade[];
  total_volume: number;
  avg_entry: number;
  rowKey: string; // stable per rendered row — same symbol across sub-ports must differ
}

function mergePositions(positions: Trade[]): MergedPosition[] {
  const map = new Map<string, Trade[]>();
  for (const p of positions) {
    // Keep Finansia sub-ports separate so lots from different sub-accounts
    // (e.g. DCON held in both 6065151 and 6065157) never merge into one row.
    const subKey = p.note?.startsWith("Finansia") ? p.note : "";
    const key = `${p.account_id}::${p.symbol}::${subKey}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)?.push(p);
  }
  const result: MergedPosition[] = [];
  for (const [rowKey, lots] of map.entries()) {
    if (lots.length === 1) {
      result.push({
        ...lots[0],
        lots,
        total_volume: lots[0].volume,
        avg_entry: lots[0].price_entry,
        rowKey,
      });
      continue;
    }
    const totalVol = lots.reduce((s, l) => s + l.volume, 0);
    const avgEntry = lots.reduce((s, l) => s + l.price_entry * l.volume, 0) / totalVol;
    const base = lots[0];
    const unrealPnl = lots.reduce((s, l) => s + (l.unrealized_pnl ?? 0), 0);
    const unrealThb = lots.reduce((s, l) => s + (l.unrealized_pnl_thb ?? 0), 0);
    const unrealBase = lots.reduce((s, l) => s + (l.unrealized_pnl_base ?? 0), 0);
    const costBase = lots.reduce((s, l) => s + (l.cost_basis_base ?? 0), 0);
    const marketBase = lots.reduce((s, l) => s + (l.market_value_base ?? 0), 0);
    const dayPnl = lots.reduce((s, l) => s + (l.day_pnl ?? 0), 0);
    const dayPnlThb = lots.reduce((s, l) => s + (l.day_pnl_thb ?? 0), 0);
    const dayPnlBase = lots.reduce((s, l) => s + (l.day_pnl_base ?? 0), 0);
    const curPrice = base.current_price ?? null;
    result.push({
      ...base,
      lots,
      total_volume: totalVol,
      avg_entry: avgEntry,
      volume: totalVol,
      price_entry: avgEntry,
      unrealized_pnl: unrealPnl || null,
      unrealized_pnl_thb: unrealThb || null,
      unrealized_pnl_base: unrealBase || null,
      cost_basis_base: costBase || null,
      market_value_base: marketBase || null,
      unrealized_pct: curPrice && avgEntry > 0 ? ((curPrice - avgEntry) / avgEntry) * 100 : null,
      day_pnl: dayPnl || null,
      day_pnl_thb: dayPnlThb || null,
      day_pnl_base: dayPnlBase || null,
      day_pct: base.day_pct ?? null,
      rowKey,
    } as MergedPosition);
  }
  return result;
}

export function OpenPositionsTab({
  accountId,
  currency,
  colors,
}: { accountId: string; currency: "THB" | "USD"; colors: Colors }) {
  const [data, setData] = useState<{ positions: Trade[]; thb_per_usd: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedLots, setExpandedLots] = useState<Record<string, boolean>>({});
  const [dense, setDense] = useState(false);
  const [showCols, setShowCols] = useState<ColName[]>(() => {
    if (typeof window === "undefined") return DEFAULT_COLS;
    try {
      const saved = localStorage.getItem("bloomberg_portfolio_cols");
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        const valid = parsed.filter((c): c is ColName =>
          (ALL_COLS as readonly string[]).includes(c)
        );
        if (valid.length > 0) return valid;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_COLS;
  });
  const [showColPicker, setShowColPicker] = useState(false);
  const [filter, setFilter] = useState("");
  const [sellCtx, setSellCtx] = useState<{
    target: Trade;
    avgEntry?: number;
    allLots?: Trade[];
  } | null>(null);
  const [editTarget, setEditTarget] = useState<Trade | null>(null);
  const [editMeta, setEditMeta] = useState<{
    mergedAvg: number;
    volume: number;
    costOverride?: number;
  } | null>(null);
  const [costOverrides, setCostOverrides] = useState<Record<string, number>>({});

  const [session, setSession] = useState<Record<string, SessionQuote>>({});

  const [stopData, setStopData] = useState<{
    regime_label: string;
    vix_percentile: number;
    stops: Record<
      string,
      | { stop_dynamic: number; dist_pct: number; dynamic_mult: number; n_bars_trigger: number }
      | { error: string }
    >;
  } | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ base_currency: currency });
        if (accountId !== "all") qs.set("account_id", accountId);
        const r = await fetch(`/api/v2/portfolio/open-positions?${qs}`, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
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

  // Fetch dynamic stop data after positions load
  useEffect(() => {
    const positions = data?.positions;
    if (!positions?.length) return;
    const ac = new AbortController();
    const syms = [...new Set(positions.map((p) => p.symbol))].join(",");
    const acc = accountId === "all" ? "dime" : accountId;
    fetch(`/api/stoploss/compute?symbols=${encodeURIComponent(syms)}&account_id=${acc}`, {
      signal: ac.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStopData(d))
      .catch((e) => {
        if (e?.name === "AbortError") return;
      });
    return () => ac.abort();
  }, [data, accountId]);

  // Fetch pre-/post-market session quotes in background (heavier .info fetch —
  // kept off the positions load path so the table never blocks on it).
  useEffect(() => {
    const positions = data?.positions;
    if (!positions?.length) return;
    const ac = new AbortController();
    const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
    fetch(`/api/v2/portfolio/premarket${qs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.quotes && setSession(d.quotes))
      .catch((e) => {
        if (e?.name === "AbortError") return;
      });
    return () => ac.abort();
  }, [data, accountId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setCostOverrides is stable setter
  useEffect(() => {
    // Fetch cost overrides
    const ac = new AbortController();
    const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
    fetch(`/api/v2/portfolio/cost-overrides${qs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { symbol: string; avg_cost: number }[]) => {
        const map: Record<string, number> = {};
        for (const row of rows) map[row.symbol] = row.avg_cost;
        setCostOverrides(map);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
      });
    return () => ac.abort();
  }, [accountId, data]);

  // Persist cols to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem("bloomberg_portfolio_cols", JSON.stringify(showCols));
    } catch {
      /* ignore */
    }
  }, [showCols]);

  const positions = data?.positions ?? [];
  const thb_per_usd = data?.thb_per_usd ?? 33.5;
  const csym = currency === "THB" ? "฿" : "$";

  // Auto PRE/POST column: appears only while ≥1 position is in a live pre- or
  // post-market session, collapses on its own once the session ends. Not a
  // user-toggled col — never enters showCols / the COLS picker.
  const sessionActive = useMemo(
    () => positions.some((p) => activeSession(session[p.symbol]) != null),
    [positions, session]
  );

  const displayCols = useMemo<DisplayCol[]>(() => {
    if (!sessionActive) return showCols;
    const cols = [...showCols] as DisplayCol[];
    const i = cols.indexOf("CURRENT");
    cols.splice(i >= 0 ? i + 1 : cols.length, 0, "PRE/POST");
    return cols;
  }, [showCols, sessionActive]);

  const merged = useMemo(() => mergePositions(positions), [positions]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return merged;
    const q = filter.trim().toUpperCase();
    return merged.filter(
      (p) => p.symbol.toUpperCase().includes(q) || (p.sector || "").toUpperCase().includes(q)
    );
  }, [merged, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, MergedPosition[]>();
    for (const p of filtered) {
      const key = groupKey(p);
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(p);
    }
    return Array.from(map.entries());
  }, [filtered]);

  type NativeCurrency = "USD" | "USDT" | "THB";
  const toBase = (v: number, acc: NativeCurrency) => {
    if ((acc === "USD" || acc === "USDT") && currency === "THB") return v * thb_per_usd;
    if (acc === "THB" && currency === "USD") return v / thb_per_usd;
    return v;
  };

  // Native currency is per-instrument (pos_currency), not per-account — a .BK
  // position inside a USD account is THB. Fall back to acc_currency for rows
  // served before the backend added pos_currency.
  const posCcy = (p: Trade): NativeCurrency =>
    (p.currency ?? p.pos_currency ?? p.acc_currency ?? "THB") as NativeCurrency;

  const totalUnreal = positions.reduce((a, p) => {
    if (p.unrealized_pnl_base != null) return a + p.unrealized_pnl_base;
    if (currency === "THB") return a + (p.unrealized_pnl_thb ?? 0);
    if (posCcy(p) === "USD" || posCcy(p) === "USDT") return a + (p.unrealized_pnl ?? 0);
    return a + (p.unrealized_pnl ?? 0) / thb_per_usd;
  }, 0);
  const totalDayPnl = positions.reduce((a, p) => {
    if (p.day_pnl_base != null) return a + p.day_pnl_base;
    if (currency === "THB") return a + (p.day_pnl_thb ?? 0);
    if (posCcy(p) === "USD" || posCcy(p) === "USDT") return a + (p.day_pnl ?? 0);
    return a + (p.day_pnl ?? 0) / thb_per_usd;
  }, 0);
  const hasDayData = positions.some((p) => p.day_pnl != null);
  // Positions whose market has not traded today. Their day P&L is deliberately
  // absent, so the "Today" total covers only part of the book — say how much.
  const stalePositions = positions.filter((p) => p.day_stale).length;
  const totalCost = positions.reduce((a, p) => {
    if (p.cost_basis_base != null) return a + p.cost_basis_base;
    return a + toBase(p.price_entry * p.volume, posCcy(p));
  }, 0);

  const py = dense ? "py-0.5" : "py-1";
  const rowH = dense ? "18px" : undefined;

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {/* Fixed toolbar */}
      <div
        className="flex-shrink-0 border-b"
        style={{ borderColor: colors.border, background: "#080808" }}
      >
        {/* Summary bar */}
        <div
          className="flex items-center gap-4 px-3 py-1 border-b text-[9px] font-mono"
          style={{ borderColor: colors.border }}
        >
          <span className="font-bold tracking-widest" style={{ color: colors.accent }}>
            POSITIONS
          </span>
          <span style={{ color: colors.textSecondary }}>
            {filtered.length}
            {filter ? `/${merged.length}` : ""} symbols · {positions.length} lots · {groups.length}{" "}
            accounts
          </span>
          <span style={{ color: colors.textSecondary }}>
            Cost{" "}
            <span className="font-bold" style={{ color: colors.text }}>
              {csym}
              {fmtK(totalCost)}
            </span>
          </span>
          {hasDayData && (
            <span>
              Today{" "}
              <span className="font-bold" style={{ color: pnlColor(totalDayPnl) }}>
                {totalDayPnl >= 0 ? "+" : "-"}
                {csym}
                {fmtK(Math.abs(totalDayPnl))}
              </span>
              {stalePositions > 0 && (
                <span
                  className="text-[8px] ml-0.5"
                  style={{ color: colors.textSecondary }}
                  title={`${stalePositions} position(s) sit on markets that have not opened today. Their regular-session move does not exist yet, so they are excluded here — any pre-market move is shown per row instead.`}
                >
                  ({stalePositions} pending)
                </span>
              )}
            </span>
          )}
          {totalUnreal !== 0 && (
            <span>
              Unreal{" "}
              <span className="font-bold" style={{ color: pnlColor(totalUnreal) }}>
                {csym}
                {fmtK(Math.abs(totalUnreal))} {totalUnreal >= 0 ? "▲" : "▼"}
              </span>
            </span>
          )}
          <div className="flex gap-1 ml-auto">
            {groups.map(([gk]: [string, Trade[]]) => (
              <span
                key={gk}
                className="text-[7px] px-1 border"
                style={{
                  borderColor: GROUP_COLORS[gk] ?? "#555",
                  color: GROUP_COLORS[gk] ?? "#555",
                }}
              >
                {gk.replace("Finansia ", "F")}
              </span>
            ))}
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 px-3 py-1">
          <button
            type="button"
            onClick={() =>
              setDense((d) => {
                const next = !d;
                setShowCols(next ? DENSE_COLS : DEFAULT_COLS);
                return next;
              })
            }
            className="text-[8px] px-1.5 py-0.5 border font-bold"
            style={{
              borderColor: dense ? colors.accent : colors.border,
              color: dense ? colors.accent : colors.textSecondary,
              background: dense ? `${colors.accent}22` : "transparent",
            }}
          >
            DENSE
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColPicker((v) => !v)}
              className="text-[8px] px-1.5 py-0.5 border font-bold"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              COLS ▾
            </button>
            {showColPicker && (
              <div
                className="absolute top-full left-0 z-50 mt-0.5 border p-2 flex flex-col gap-0.5"
                style={{ background: "#0a0a0a", borderColor: colors.border, minWidth: 130 }}
              >
                {ALL_COLS.map((col) => (
                  <label
                    key={col}
                    className="flex items-center gap-1.5 cursor-pointer text-[8px] font-mono hover:opacity-80"
                    style={{ color: showCols.includes(col) ? colors.text : colors.textSecondary }}
                  >
                    <input
                      type="checkbox"
                      className="w-2.5 h-2.5"
                      checked={showCols.includes(col)}
                      onChange={(e) =>
                        setShowCols((prev) => {
                          return e.target.checked ? [...prev, col] : prev.filter((c) => c !== col);
                        })
                      }
                    />
                    {col}
                  </label>
                ))}
              </div>
            )}
          </div>

          <input
            className="text-[8px] px-1.5 py-0.5 border outline-none font-mono flex-1 max-w-[120px]"
            style={{ background: "transparent", borderColor: colors.border, color: colors.text }}
            placeholder="Filter symbol / sector"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="ml-auto p-0.5 hover:opacity-70"
          >
            {loading ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.accent }} />
            ) : (
              <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
            )}
          </button>
        </div>
      </div>

      {/* Scrollable positions zone */}
      {positions.length === 0 && !loading ? (
        <div className="py-8 text-center text-[10px]" style={{ color: colors.textSecondary }}>
          No open positions{accountId !== "all" ? " for this account" : ""}
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto overflow-x-auto"
          onClick={() => setShowColPicker(false)}
          onKeyDown={() => setShowColPicker(false)}
          role="presentation"
        >
          <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
            {groups.map(([gk, groupPositions]: [string, MergedPosition[]]) => {
              const groupColor = GROUP_COLORS[gk] ?? colors.accent;
              const isCollapsed = !!collapsed[gk];
              const groupPnl = groupPositions.reduce(
                (a: number, p: MergedPosition) =>
                  a +
                  (p.unrealized_pnl_base ??
                    (currency === "THB"
                      ? (p.unrealized_pnl_thb ?? 0)
                      : toBase(p.unrealized_pnl ?? 0, posCcy(p)))),
                0
              );
              const groupCost = groupPositions.reduce((a: number, p: MergedPosition) => {
                return a + (p.cost_basis_base ?? toBase(p.price_entry * p.volume, posCcy(p)));
              }, 0);

              return (
                <tbody key={gk}>
                  {/* Sticky group header */}
                  <tr
                    style={{
                      background: "#060606",
                      cursor: "pointer",
                      position: "sticky",
                      top: 0,
                      zIndex: 10,
                    }}
                    onClick={() => setCollapsed((c) => ({ ...c, [gk]: !isCollapsed }))}
                    onKeyDown={(e) =>
                      e.key === "Enter" && setCollapsed((c) => ({ ...c, [gk]: !isCollapsed }))
                    }
                  >
                    <td
                      colSpan={displayCols.length + 1}
                      className="px-3 border-b border-t"
                      style={{
                        borderColor: `${groupColor}55`,
                        borderLeftWidth: 3,
                        borderLeftColor: groupColor,
                      }}
                    >
                      <div className="flex items-center gap-3 py-1">
                        <span className="text-[8px]" style={{ color: "#555" }}>
                          {isCollapsed ? "▶" : "▼"}
                        </span>
                        <span
                          className="text-[10px] font-bold tracking-wider"
                          style={{ color: groupColor }}
                        >
                          {gk}
                        </span>
                        <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                          {groupPositions.length} pos
                        </span>
                        <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                          Cost {csym}
                          {fmtK(groupCost)}
                        </span>
                        <span
                          className="ml-auto text-[9px] font-bold"
                          style={{ color: pnlColor(groupPnl) }}
                        >
                          {groupPnl !== 0
                            ? `${csym}${fmtK(Math.abs(groupPnl))} ${groupPnl >= 0 ? "▲" : "▼"}`
                            : "—"}
                        </span>
                      </div>
                    </td>
                  </tr>

                  {/* Column header */}
                  {!isCollapsed && (
                    <tr
                      style={{
                        background: "#0a0a0a",
                        borderBottom: `1px solid ${colors.border}`,
                        position: "sticky",
                        top: 28,
                        zIndex: 9,
                      }}
                    >
                      {displayCols.map((h) => (
                        <th
                          key={h}
                          className="px-2 py-0.5 text-left whitespace-nowrap text-[7px] font-bold tracking-wider"
                          style={{ color: colors.textSecondary }}
                        >
                          {h}
                        </th>
                      ))}
                      <th />
                    </tr>
                  )}

                  {/* Position rows */}
                  {!isCollapsed &&
                    groupPositions.map((p: MergedPosition) => {
                      const acc = posCcy(p);
                      const backendPnl = (() => {
                        if (p.unrealized_pnl_base != null) return p.unrealized_pnl_base;
                        if (currency === "THB") return p.unrealized_pnl_thb ?? null;
                        if (acc === "USD" || acc === "USDT") return p.unrealized_pnl ?? null;
                        return p.unrealized_pnl != null ? p.unrealized_pnl / thb_per_usd : null;
                      })();
                      const sym = csym;
                      const overrideRaw = costOverrides[p.symbol];
                      const overrideNative = overrideRaw != null ? toBase(overrideRaw, acc) : null;
                      const entryNative = overrideNative ?? toBase(p.price_entry, acc);
                      const curNative =
                        p.current_price != null ? toBase(p.current_price, acc) : null;
                      const pnl =
                        overrideNative != null && curNative != null
                          ? (curNative - overrideNative) * p.total_volume
                          : backendPnl;
                      const unrealPct =
                        overrideNative != null && curNative != null && overrideNative > 0
                          ? ((curNative - overrideNative) / overrideNative) * 100
                          : p.unrealized_pct;
                      // Use backend's entry-date-FX cost basis (matches badge/ANALYTICS totals);
                      // only fall back to live-FX entryNative when backend didn't supply one
                      // (no live quote) or the user set a manual cost override.
                      const costVal =
                        overrideNative != null
                          ? overrideNative * p.volume
                          : (p.cost_basis_base ?? entryNative * p.volume);
                      const targetNative =
                        p.price_target != null ? toBase(p.price_target, acc) : null;
                      const slNative =
                        p.price_stoploss != null ? toBase(p.price_stoploss, acc) : null;
                      const hasMultiLots = p.lots.length > 1;
                      const lotKey = p.rowKey;
                      const lotsExpanded = !!expandedLots[lotKey];

                      const cellMap: Record<DisplayCol, React.ReactNode> = {
                        SYMBOL: (
                          <div className="flex items-center gap-1">
                            {hasMultiLots && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedLots((x) => ({ ...x, [lotKey]: !lotsExpanded }));
                                }}
                                className="opacity-60 hover:opacity-100"
                              >
                                {lotsExpanded ? (
                                  <ChevronDown
                                    className="h-2.5 w-2.5"
                                    style={{ color: groupColor }}
                                  />
                                ) : (
                                  <ChevronRight
                                    className="h-2.5 w-2.5"
                                    style={{ color: groupColor }}
                                  />
                                )}
                              </button>
                            )}
                            <span className="font-bold" style={{ color: groupColor }}>
                              {p.symbol}
                            </span>
                            <span
                              className="text-[7px] px-1 border font-mono"
                              style={{
                                borderColor: acc === "THB" ? "#22c55e55" : "#38bdf855",
                                color: acc === "THB" ? "#4ade80" : "#7dd3fc",
                              }}
                              title={`Instrument currency: ${acc}`}
                            >
                              {acc === "THB" ? "฿" : "$"} {acc}
                            </span>
                            {hasMultiLots && (
                              <span
                                className="text-[7px] px-0.5 rounded"
                                style={{ background: `${groupColor}22`, color: groupColor }}
                              >
                                {p.lots.length}
                              </span>
                            )}
                            {subPortLabel(p) && (
                              <span
                                className="text-[7px] px-1 rounded font-mono"
                                style={{
                                  background: `${SUBPORT_COLORS[subPortLabel(p) as string] ?? "#555"}22`,
                                  color: SUBPORT_COLORS[subPortLabel(p) as string] ?? "#555",
                                }}
                              >
                                {subPortLabel(p)}
                              </span>
                            )}
                          </div>
                        ),
                        SECTOR: (
                          <span style={{ color: colors.textSecondary }}>{p.sector || "—"}</span>
                        ),
                        ENTRY: (
                          <span className="flex items-center gap-1">
                            {sym}
                            {fmt(entryNative)}
                            {hasMultiLots && !overrideNative && (
                              <span className="text-[7px] opacity-50">avg</span>
                            )}
                            {overrideNative && (
                              <span
                                className="text-[7px] px-0.5 rounded"
                                style={{ background: "#f59e0b22", color: "#f59e0b" }}
                              >
                                override
                              </span>
                            )}
                          </span>
                        ),
                        CURRENT:
                          curNative != null ? (
                            <span
                              className="font-bold"
                              style={{ color: curNative >= entryNative ? "#4ade80" : "#f87171" }}
                            >
                              {sym}
                              {fmt(curNative)}
                            </span>
                          ) : (
                            <Loader2 className="h-2 w-2 animate-spin inline" />
                          ),
                        "PRE/POST": (() => {
                          const s = session[p.symbol];
                          const ext = activeSession(s);
                          if (!s || !ext)
                            return <span style={{ color: colors.textSecondary }}>—</span>;
                          const isPre = ext.label === "PRE";
                          const px = isPre ? s.pre_price : s.post_price;
                          const pct = ext.pct;
                          if (px == null)
                            return <span style={{ color: colors.textSecondary }}>—</span>;
                          const label = ext.label;
                          const labelColor = isPre ? "#f59e0b" : "#38bdf8";
                          const pxNative = toBase(px, acc);
                          return (
                            <span className="flex items-center gap-1">
                              <span
                                className="text-[7px] px-0.5 rounded font-bold"
                                style={{ background: `${labelColor}22`, color: labelColor }}
                                title={`marketState: ${s.market_state ?? "?"}`}
                              >
                                {label}
                              </span>
                              <span
                                className="font-bold"
                                style={{ color: pct != null ? pnlColor(pct) : colors.text }}
                              >
                                {sym}
                                {fmt(pxNative)}
                                {pct != null && (
                                  <span className="text-[8px] ml-0.5 font-normal">
                                    ({pct >= 0 ? "+" : ""}
                                    {pct.toFixed(2)}%)
                                  </span>
                                )}
                              </span>
                            </span>
                          );
                        })(),
                        VOL: <>{p.volume.toLocaleString()}</>,
                        COST: (
                          <span style={{ color: colors.textSecondary }}>
                            {sym}
                            {fmtK(costVal)}
                          </span>
                        ),
                        "DAY P&L": (() => {
                          const dayPnl =
                            p.day_pnl_base != null
                              ? p.day_pnl_base
                              : currency === "THB"
                                ? (p.day_pnl_thb ?? null)
                                : acc === "USD" || acc === "USDT"
                                  ? (p.day_pnl ?? null)
                                  : p.day_pnl != null
                                    ? p.day_pnl / thb_per_usd
                                    : null;
                          if (dayPnl == null) {
                            // The regular session has not traded today. If an
                            // extended-hours session IS running, show that move
                            // instead of a blank — it is the only live number
                            // there is, and it is what the position is actually
                            // doing right now.
                            const ext = p.day_stale ? activeSession(session[p.symbol]) : null;
                            if (ext) {
                              const extPnl = toBase(ext.change * p.volume, acc);
                              const extColor = ext.label === "PRE" ? "#f59e0b" : "#38bdf8";
                              return (
                                <span
                                  className="flex items-center gap-1"
                                  title={`${ext.label}-market move — the regular session has not opened yet (last close ${p.day_session_date ?? "unknown"})`}
                                >
                                  <span
                                    className="text-[7px] px-0.5 rounded font-bold"
                                    style={{ background: `${extColor}22`, color: extColor }}
                                  >
                                    {ext.label}
                                  </span>
                                  <span className="font-bold" style={{ color: pnlColor(extPnl) }}>
                                    {extPnl >= 0 ? "+" : "-"}
                                    {sym}
                                    {fmtK(Math.abs(extPnl))}
                                    {ext.pct != null && (
                                      <span className="text-[8px] ml-0.5 font-normal">
                                        ({ext.pct >= 0 ? "+" : ""}
                                        {ext.pct.toFixed(2)}%)
                                      </span>
                                    )}
                                  </span>
                                </span>
                              );
                            }
                            // Blank because that market has not traded today —
                            // say so, otherwise it reads as missing data.
                            const staleHint = p.day_stale
                              ? `Market has not opened yet — last session ${p.day_session_date ?? "unknown"}`
                              : undefined;
                            return (
                              <span style={{ color: colors.textSecondary }} title={staleHint}>
                                {p.day_stale ? "· ·" : "—"}
                              </span>
                            );
                          }
                          return (
                            <span className="font-bold" style={{ color: pnlColor(dayPnl) }}>
                              {dayPnl >= 0 ? "+" : "-"}
                              {sym}
                              {fmtK(Math.abs(dayPnl))}
                              {p.day_pct != null && (
                                <span className="text-[8px] ml-0.5 font-normal">
                                  ({p.day_pct >= 0 ? "+" : ""}
                                  {p.day_pct.toFixed(2)}%)
                                </span>
                              )}
                            </span>
                          );
                        })(),
                        UNREAL:
                          pnl != null ? (
                            <span className="font-bold" style={{ color: pnlColor(pnl) }}>
                              {sym}
                              {fmtK(Math.abs(pnl))} {pnl >= 0 ? "▲" : "▼"}
                            </span>
                          ) : (
                            <span style={{ color: colors.textSecondary }}>—</span>
                          ),
                        "% RTN":
                          unrealPct != null ? (
                            <span className="font-bold" style={{ color: pnlColor(unrealPct) }}>
                              {fmtPct(unrealPct)}
                            </span>
                          ) : (
                            <span style={{ color: colors.textSecondary }}>—</span>
                          ),
                        TARGET:
                          targetNative != null ? (
                            <span style={{ color: "#4ade80" }}>
                              {sym}
                              {fmt(targetNative)}
                            </span>
                          ) : (
                            <span style={{ color: colors.textSecondary }}>—</span>
                          ),
                        "S/L":
                          slNative != null ? (
                            <span style={{ color: "#f87171" }}>
                              {sym}
                              {fmt(slNative)}
                            </span>
                          ) : (
                            <span style={{ color: colors.textSecondary }}>—</span>
                          ),
                        "DYN SL": (() => {
                          const s = stopData?.stops?.[p.symbol];
                          if (!s || "error" in s)
                            return <span style={{ color: colors.textSecondary }}>—</span>;
                          const stopNative = toBase(s.stop_dynamic, acc);
                          return (
                            <span style={{ color: "#fb923c" }}>
                              {sym}
                              {fmt(stopNative)}
                            </span>
                          );
                        })(),
                        "SL DIST%": (() => {
                          const s = stopData?.stops?.[p.symbol];
                          if (!s || "error" in s)
                            return <span style={{ color: colors.textSecondary }}>—</span>;
                          const dist = s.dist_pct;
                          const color = dist > 5 ? "#4ade80" : dist > 2 ? "#fbbf24" : "#f87171";
                          return (
                            <span className="font-bold" style={{ color }}>
                              {dist.toFixed(1)}%
                            </span>
                          );
                        })(),
                        STRATEGY: (
                          <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                            {p.strategy_name || "—"}
                          </span>
                        ),
                      };

                      return (
                        <React.Fragment key={p.rowKey}>
                          <tr
                            className="hover:bg-[#111]"
                            style={{ borderBottom: "1px solid #141414", height: rowH }}
                          >
                            {displayCols.map((col) => (
                              <td key={col} className={`px-2 ${py} whitespace-nowrap`}>
                                {cellMap[col]}
                              </td>
                            ))}
                            <td className={`px-1 ${py}`}>
                              <div className="flex gap-0.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTarget(p.lots[0]);
                                    setEditMeta({
                                      mergedAvg: p.avg_entry,
                                      volume: p.total_volume,
                                      costOverride: costOverrides[p.symbol],
                                    });
                                  }}
                                  className="text-[7px] px-1 py-0.5 border font-bold hover:opacity-80 whitespace-nowrap"
                                  style={{
                                    borderColor: "#ff990055",
                                    color: "#ff9900",
                                    background: "#ff990010",
                                  }}
                                >
                                  EDIT
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSellCtx({
                                      target: p.lots[0],
                                      avgEntry: costOverrides[p.symbol] ?? p.avg_entry,
                                      allLots: p.lots,
                                    });
                                  }}
                                  className="text-[7px] px-2 py-0.5 border font-bold hover:opacity-80 whitespace-nowrap"
                                  style={{
                                    borderColor: "#ef444466",
                                    color: "#f87171",
                                    background: "#ef444410",
                                  }}
                                >
                                  SELL
                                </button>
                              </div>
                            </td>
                          </tr>
                          {/* Expanded lots */}
                          {hasMultiLots &&
                            lotsExpanded &&
                            p.lots.map((lot, li) => {
                              const lotEntry = toBase(lot.price_entry, acc);
                              const lotPnl =
                                lot.unrealized_pnl_base != null
                                  ? lot.unrealized_pnl_base
                                  : currency === "THB"
                                    ? (lot.unrealized_pnl_thb ?? null)
                                    : toBase(lot.unrealized_pnl ?? 0, posCcy(lot));
                              return (
                                <tr
                                  key={`${lot.id}_lot`}
                                  style={{
                                    background: "#0a0a0a",
                                    borderBottom: "1px solid #0f0f0f",
                                  }}
                                >
                                  <td colSpan={displayCols.length + 1} className="px-4 py-0.5">
                                    <div className="flex items-center gap-4 text-[8px] font-mono">
                                      <span className="opacity-40">└ Lot {li + 1}</span>
                                      <span style={{ color: colors.textSecondary }}>
                                        {lot.date_entry}
                                      </span>
                                      <span>
                                        {sym}
                                        {fmt(lotEntry)} × {lot.volume.toLocaleString()}
                                      </span>
                                      <span style={{ color: colors.textSecondary }}>
                                        Cost {sym}
                                        {fmtK(lotEntry * lot.volume)}
                                      </span>
                                      {lotPnl != null && (
                                        <span style={{ color: pnlColor(lotPnl) }}>
                                          {lotPnl >= 0 ? "+" : ""}
                                          {sym}
                                          {fmtK(Math.abs(lotPnl))}
                                          {lot.unrealized_pct != null &&
                                            ` (${lot.unrealized_pct >= 0 ? "+" : ""}${lot.unrealized_pct.toFixed(2)}%)`}
                                        </span>
                                      )}
                                      <div className="flex gap-0.5 ml-auto">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setEditTarget(lot);
                                          }}
                                          className="text-[7px] px-1 py-0.5 border font-bold hover:opacity-80"
                                          style={{
                                            borderColor: "#ff990055",
                                            color: "#ff9900",
                                            background: "#ff990010",
                                          }}
                                        >
                                          EDIT
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSellCtx({
                                              target: lot,
                                              avgEntry: costOverrides[lot.symbol] ?? undefined,
                                            });
                                          }}
                                          className="text-[7px] px-1 py-0.5 border font-bold hover:opacity-80"
                                          style={{
                                            borderColor: "#ef444466",
                                            color: "#f87171",
                                            background: "#ef444410",
                                          }}
                                        >
                                          SELL
                                        </button>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                        </React.Fragment>
                      );
                    })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}

      {/* Derivatives section — below equities, collapsible */}
      <DerivativesSection accountId={accountId} colors={colors} />

      {sellCtx && (
        <SellModal
          target={sellCtx.target}
          avgEntry={sellCtx.avgEntry}
          allLots={sellCtx.allLots}
          colors={colors}
          onClose={() => setSellCtx(null)}
          onSold={load}
        />
      )}
      {editTarget && (
        <TradeEditModal
          trade={editTarget}
          colors={colors}
          mergedAvg={editMeta?.mergedAvg}
          mergedVolume={editMeta?.volume}
          costOverride={editMeta?.costOverride}
          onClose={() => {
            setEditTarget(null);
            setEditMeta(null);
          }}
          onSaved={load}
        />
      )}
    </div>
  );
}
