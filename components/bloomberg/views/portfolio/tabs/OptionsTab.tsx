"use client";
import { Clock, Loader2, Pencil, Plus, RefreshCw, X } from "lucide-react";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { Colors } from "../helpers";
import { fmt, fmtAmt, fmtPx, fmtQty, pnlColor } from "../helpers";
import { OptionTradeEditModal } from "../modals/OptionTradeEditModal";
import { PayoffModal } from "../modals/PayoffModal";
import type { OptionEntryPrefill } from "../ui/OptionEntryForm";
import { type OptionTrade, OptionTradeLog } from "../ui/OptionTradeLog";
import { PayoffChart } from "../ui/PayoffChart";
import { type PayoffLeg, usePayoff } from "../ui/usePayoff";
import { usePortfolioNav } from "../ui/usePortfolioNav";
import { fmtWeight } from "../weights";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One open option lot, already valued by the backend.
 *
 * Every money figure here comes from `/api/v2/portfolio/open-positions`, which
 * is the same code path `/summary`, `/allocation-detail` and `/returns` use.
 * This tab used to compute P&L itself at a hardcoded ×100 in USD, which meant
 * the number here could disagree with the account totals one tab over — and
 * quietly did, for every non-USD account and every non-100 multiplier. */
export interface OptionLot {
  id: string;
  account_id: string;
  acc_name?: string | null;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  quantity: number;
  entry_price: number;
  entry_date: string;
  notes: string;
  /** A lot IS an OPEN trade; `id` is that trade's id. How much of it has been
   *  closed is derived from the matches, never stored twice. */
  lot_id?: string;
  quantity_opened?: number;
  quantity_closed?: number;
  direction?: number;
  occ_symbol?: string;
  /** Market state captured at the moment this lot was opened. `unavailable`
   *  means it was never captured (a migrated lot) — the chain only reports
   *  now, so it cannot be filled in later. */
  entry_spot?: number | null;
  entry_iv?: number | null;
  entry_delta?: number | null;
  entry_gamma?: number | null;
  entry_theta?: number | null;
  entry_vega?: number | null;
  entry_rho?: number | null;
  entry_greeks_source?: "live" | "manual" | "unavailable" | null;
  symbol: string;
  currency: string;
  multiplier: number;
  spot: number | null;
  mark: number;
  mark_source: "last" | "mid" | "ask" | "entry_cost" | "intrinsic_expired";
  mark_stale: boolean;
  expired: boolean;
  implied_volatility: number | null;
  /** Raw per-contract greeks in `greeks.py`'s own units: theta per calendar
   *  day, vega per 1pp of IV, gamma per $1 of spot. `null` (not 0) when the
   *  chain gave no IV — a lot with no greeks must be skipped, not counted. */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** Position-scaled dollar greeks, always USD.
   *  delta_exp = Δ×qty×mult×S · gamma_exp = Γ×qty×mult×S²×0.01 (dollar delta
   *  gained per 1% move, the desk convention — not the true derivative)
   *  theta_exp = Θ×qty×mult per calendar day · vega_exp = ν×qty×mult per 1pp */
  delta_exp_usd: number | null;
  gamma_exp_usd: number | null;
  theta_exp_usd: number | null;
  vega_exp_usd: number | null;
  cost_basis_usd: number;
  market_value_usd: number;
  unrealized_pnl_usd: number;
  unrealized_pct_usd: number | null;
  cost_basis_native: number;
  market_value_native: number;
  unrealized_pnl: number;
  unrealized_pct: number | null;
  cost_basis_base: number;
  market_value_base: number;
  unrealized_pnl_base: number;
  /** Return on the base-currency cost basis. Differs from `unrealized_pct`
   *  whenever FX moved between the entry date and now. */
  unrealized_pct_base: number | null;
  delta_notional_native: number | null;
  delta_notional_base: number | null;
}

const MARK_LABEL: Record<OptionLot["mark_source"], string> = {
  last: "last",
  mid: "bid/ask mid",
  ask: "ask",
  entry_cost: "no quote — held at cost",
  intrinsic_expired: "expired — intrinsic",
};

function Greek({
  value,
  digits,
  colors,
  signed = false,
}: { value: number | null; digits: number; colors: Colors; signed?: boolean }) {
  if (value === null) {
    return (
      <td
        className="px-2 py-1.5 text-right"
        style={{ color: "#444" }}
        title="No IV — greek undefined"
      >
        —
      </td>
    );
  }
  return (
    <td
      className="px-2 py-1.5 text-right"
      style={{ color: signed ? pnlColor(value) : colors.textSecondary }}
    >
      {fmt(value, digits)}
    </td>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({
  lot,
  colors,
  pct,
  onClose,
  onEdit,
  onPayoff,
  onDelete,
}: {
  lot: OptionLot;
  colors: Colors;
  pct: (v: number | null | undefined) => number | null;
  onClose: () => void;
  onEdit: () => void;
  onPayoff: () => void;
  onDelete: () => void;
}) {
  const isCall = lot.option_type === "call";
  const typeColor = isCall ? "#00FF00" : "#FF4444";
  const nativeSym = lot.currency === "USD" ? "$" : "";
  const dte = Math.round((new Date(lot.expiry).getTime() - Date.now()) / 86_400_000);
  const expiryColor =
    lot.expired || dte <= 7 ? "#FF4444" : dte <= 21 ? "#f59e0b" : colors.textSecondary;

  return (
    <tr className="border-b text-[10px] font-mono" style={{ borderColor: colors.border }}>
      <td className="px-2 py-1.5">
        <span className="font-bold" style={{ color: colors.text }}>
          {lot.underlying}
        </span>
        {lot.spot !== null && (
          <span className="ml-1 text-[8px]" style={{ color: colors.textSecondary }}>
            @{fmt(lot.spot, 2)}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <span
          className="font-bold text-[9px] px-1 rounded"
          style={{ color: typeColor, border: `1px solid ${typeColor}` }}
        >
          {lot.option_type.toUpperCase()}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>
        {nativeSym}
        {fmtPx(lot.strike)}
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: expiryColor }}>
        {lot.expiry}
        <span className="ml-1 text-[8px]">{lot.expired ? "EXP" : `${dte}d`}</span>
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>
        {fmtQty(lot.quantity)}
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.textSecondary }}>
        {nativeSym}
        {fmtPx(lot.entry_price)}
      </td>
      <td className="px-2 py-1.5 text-right">
        <span
          style={{ color: lot.mark_stale ? "#f59e0b" : colors.text }}
          title={MARK_LABEL[lot.mark_source]}
        >
          {nativeSym}
          {fmtPx(lot.mark)}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>
        {fmtAmt(lot.market_value_usd)}
      </td>
      <td className="px-2 py-1.5 text-right">
        <span style={{ color: pnlColor(lot.unrealized_pnl_usd) }}>
          {lot.unrealized_pnl_usd >= 0 ? "+" : "-"}
          {fmtAmt(Math.abs(lot.unrealized_pnl_usd))}
          {lot.unrealized_pct_usd !== null && (
            <span className="text-[9px] ml-1">
              ({lot.unrealized_pct_usd >= 0 ? "+" : ""}
              {fmt(lot.unrealized_pct_usd, 1)}%)
            </span>
          )}
        </span>
      </td>
      <Greek value={lot.delta} digits={3} colors={colors} />
      <Greek value={lot.gamma} digits={4} colors={colors} />
      <Greek value={lot.theta} digits={3} colors={colors} signed />
      <td className="px-2 py-1.5 text-right">
        {lot.delta_exp_usd === null ? (
          <span
            style={{ color: colors.textSecondary }}
            title="No IV from the chain — greeks are undefined for this lot, not zero"
          >
            —
          </span>
        ) : (
          <span style={{ color: colors.textSecondary }}>{fmtAmt(lot.delta_exp_usd)}</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        {lot.theta_exp_usd === null ? (
          <span style={{ color: colors.textSecondary }}>—</span>
        ) : (
          <span style={{ color: pnlColor(lot.theta_exp_usd) }}>{fmt(lot.theta_exp_usd, 1)}</span>
        )}
      </td>
      <td
        className="px-2 py-1.5 text-right font-bold"
        style={{ color: colors.text }}
        title="Premium market value ÷ NAV (equities + options + cash) of the selected account"
      >
        {fmtWeight(pct(lot.market_value_base))}
      </td>
      <td
        className="px-2 py-1.5 text-right"
        style={{
          color: lot.delta_notional_base == null ? "#444" : pnlColor(lot.delta_notional_base),
        }}
        title={
          lot.delta_notional_base == null
            ? "No IV — delta undefined, exposure unknown (not zero)"
            : "Delta notional ÷ NAV — the stock-equivalent exposure this lot carries, signed"
        }
      >
        {fmtWeight(pct(lot.delta_notional_base))}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClose}
            className="text-[8px] px-1 border rounded opacity-60 hover:opacity-100"
            style={{ borderColor: colors.textSecondary, color: colors.textSecondary }}
            title="Close position"
          >
            CLOSE
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="text-[8px] px-1 border rounded opacity-60 hover:opacity-100 flex items-center gap-0.5"
            style={{ borderColor: colors.textSecondary, color: colors.textSecondary }}
            title="Correct a mis-entered value on this lot"
          >
            <Pencil className="w-2 h-2" />
            EDIT
          </button>
          <button
            type="button"
            onClick={onPayoff}
            className="text-[8px] px-1 border rounded opacity-60 hover:opacity-100"
            style={{ borderColor: colors.accent, color: colors.accent }}
            title="Payoff at expiry and today, breakeven, max profit/loss"
          >
            PAYOFF
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-0.5 opacity-40 hover:opacity-100 hover:text-red-400"
          >
            <X className="w-2.5 h-2.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export function OptionsTab({
  accountId,
  currency = "THB",
  colors,
  onOpenEntry,
}: {
  accountId: string;
  currency?: string;
  colors: Colors;
  /** ADD and CLOSE are entered in PORTFOLIO → ENTRY, the one place fills are typed. */
  onOpenEntry: (p: OptionEntryPrefill) => void;
}) {
  const [lots, setLots] = useState<OptionLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // A lot IS its OPEN trade, so editing the lot edits that trade. The modal
  // wants the full trade row (greeks, action/side), which the lot view does not
  // carry — fetch it on click rather than half-building one here.
  const [editingTrade, setEditingTrade] = useState<OptionTrade | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [payoffLot, setPayoffLot] = useState<OptionLot | null>(null);
  // LOTS is what you hold; TRADES is what you did. A lot is derived from its
  // trades, so the two views cannot disagree.
  const [view, setView] = useState<"lots" | "trades">("lots");
  const { breakdown: navParts, pct: navPct } = usePortfolioNav(
    accountId,
    currency === "USD" ? "USD" : "THB"
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // One request for the whole book. The per-position quote endpoint pulled
      // a full option chain per row, re-downloading the same chain for every
      // strike that shares an expiry.
      const qs = new URLSearchParams({ base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/open-positions?${qs}`);
      const d = await r.json();
      setLots(Array.isArray(d?.options) ? d.options : []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [accountId, currency]);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = async (lotId: string) => {
    setEditLoading(true);
    try {
      const qs = new URLSearchParams();
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/options/trades?${qs}`);
      const all: OptionTrade[] = await r.json();
      const found = Array.isArray(all) ? all.find((t) => t.trade_id === lotId) : null;
      if (found) setEditingTrade(found);
    } catch {
      /* ignore */
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/options/positions/${id}`, { method: "DELETE" });
    load();
  };

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      await fetch("/api/options/positions/seed-demo", { method: "POST" });
      load();
    } catch {
      /* ignore */
    } finally {
      setSeeding(false);
    }
  };

  const handleClearDemo = async () => {
    await fetch("/api/options/positions/demo/clear", { method: "DELETE" });
    load();
  };

  const calls = lots.filter((p) => p.option_type === "call");
  const puts = lots.filter((p) => p.option_type === "put");
  const sum = (pick: (l: OptionLot) => number | null) =>
    lots.reduce((acc, l) => acc + (pick(l) ?? 0), 0);
  const totalCost = sum((l) => l.cost_basis_usd);
  const totalMv = sum((l) => l.market_value_usd);
  const totalUnreal = sum((l) => l.unrealized_pnl_usd);
  const totalDeltaExp = sum((l) => l.delta_exp_usd);
  const totalGammaExp = sum((l) => l.gamma_exp_usd);
  const totalThetaExp = sum((l) => l.theta_exp_usd);
  const totalVegaExp = sum((l) => l.vega_exp_usd);
  const unpriced = lots.filter((l) => l.mark_stale).length;
  // Lots with no IV contribute nothing to the greek totals. Say how many, or
  // the exposure silently reads lower than the book actually carries.
  const noGreeks = lots.filter((l) => l.delta_exp_usd === null).length;

  return (
    <div className="p-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-bold" style={{ color: colors.accent }}>
          DERIVATIVES · OPTIONS
          {lots.length > 0 && (
            <span className="ml-2 text-[9px] font-normal" style={{ color: colors.textSecondary }}>
              {calls.length}C / {puts.length}P open · all figures USD
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["lots", "trades"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className="px-2 py-0.5 text-[8px] font-bold border rounded"
              style={{
                borderColor: view === v ? colors.accent : colors.border,
                color: view === v ? colors.accent : colors.textSecondary,
              }}
            >
              {v === "lots" ? "LOTS" : "TRADES"}
            </button>
          ))}
          <button type="button" onClick={load} className="p-0.5 opacity-60 hover:opacity-100">
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: colors.textSecondary }} />
            ) : (
              <RefreshCw className="w-3 h-3" style={{ color: colors.textSecondary }} />
            )}
          </button>
          <button
            type="button"
            onClick={handleSeedDemo}
            disabled={seeding}
            className="flex items-center gap-1 px-2 py-0.5 text-[8px] font-bold border rounded opacity-60 hover:opacity-100"
            style={{ borderColor: "#555", color: "#888" }}
            title="Insert 6 demo positions for testing"
          >
            {seeding ? <Loader2 className="w-2 h-2 animate-spin" /> : null}
            DEMO
          </button>
          <button
            type="button"
            onClick={handleClearDemo}
            className="px-2 py-0.5 text-[8px] font-bold border rounded opacity-50 hover:opacity-100"
            style={{ borderColor: "#FF4444", color: "#FF4444" }}
            title="Remove all demo positions (notes starting with 'demo')"
          >
            CLEAR DEMO
          </button>
          <button
            type="button"
            onClick={() =>
              onOpenEntry({
                account_id: accountId !== "all" ? accountId : "",
                action: "OPEN",
                side: "BUY",
              })
            }
            className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold border rounded"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            <Plus className="w-2.5 h-2.5" />
            ADD
          </button>
        </div>
      </div>

      {view === "trades" && <OptionTradeLog accountId={accountId} colors={colors} />}

      {editLoading && (
        <div className="text-[9px] px-2 py-1" style={{ color: colors.textSecondary }}>
          <Loader2 className="w-2.5 h-2.5 animate-spin inline mr-1" />
          loading trade…
        </div>
      )}

      {payoffLot && (
        <PayoffModal
          lot={payoffLot}
          allLots={lots}
          colors={colors}
          onClose={() => setPayoffLot(null)}
        />
      )}

      {editingTrade && (
        <OptionTradeEditModal
          trade={editingTrade}
          colors={colors}
          onClose={() => setEditingTrade(null)}
          onSaved={load}
        />
      )}

      {/* Book totals — the same figures the account rollup in PORT now counts */}
      {view === "lots" && lots.length > 0 && (
        <div
          className="grid grid-cols-3 md:grid-cols-9 gap-2 mb-2 border rounded px-2 py-1.5 text-[10px] font-mono"
          style={{ borderColor: colors.border }}
        >
          {[
            { label: "COST", value: `$${fmtAmt(totalCost)}`, color: colors.text, title: undefined },
            {
              label: "MARKET VALUE",
              value: `$${fmtAmt(totalMv)}`,
              color: colors.text,
              title: undefined,
            },
            {
              label: "UNREALIZED",
              value: `${totalUnreal >= 0 ? "+" : "-"}$${fmtAmt(Math.abs(totalUnreal))}`,
              color: pnlColor(totalUnreal),
              title: undefined,
            },
            {
              label: "% OF NAV",
              value: fmtWeight(navPct(navParts?.options)),
              color: colors.text,
              title:
                "Option premium market value ÷ NAV (equities + options + cash) of the selected account",
            },
            {
              label: "Δ EXP % NAV",
              value: fmtWeight(navPct(sum((l) => l.delta_notional_base))),
              color: colors.textSecondary,
              title:
                noGreeks > 0
                  ? `Delta notional ÷ NAV — stock-equivalent exposure. ${noGreeks} lot(s) without IV are not counted.`
                  : "Delta notional ÷ NAV — stock-equivalent exposure, signed",
            },
            {
              label: "DELTA EXP",
              value: `$${fmtAmt(totalDeltaExp)}`,
              color: colors.textSecondary,
              title:
                "Δ × qty × 100 × spot — dollars this book moves for a 100% move in the underlying",
            },
            {
              label: "GAMMA EXP / 1%",
              value: `$${fmtAmt(totalGammaExp)}`,
              color: colors.textSecondary,
              title:
                "Γ × qty × 100 × spot² × 1% — dollar delta gained per 1% move in the underlying (desk convention, not the exact derivative)",
            },
            {
              label: "THETA EXP / DAY",
              value: `${totalThetaExp >= 0 ? "+" : "-"}$${fmt(Math.abs(totalThetaExp), 0)}`,
              color: pnlColor(totalThetaExp),
              title:
                "Θ × qty × 100 — dollars per calendar day. Negative for long options (time decay), positive when short",
            },
            {
              label: "VEGA EXP / 1PP",
              value: `${totalVegaExp >= 0 ? "+" : "-"}$${fmt(Math.abs(totalVegaExp), 0)}`,
              color: colors.textSecondary,
              title: "ν × qty × 100 — dollars per 1 percentage point move in implied volatility",
            },
          ].map((c) => (
            <div key={c.label} title={c.title}>
              <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                {c.label}
              </div>
              <div className="font-bold" style={{ color: c.color }}>
                {c.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delay disclaimer. Conditionally rendered rather than `hidden`: the
          element's own `display:flex` class outranks the UA rule that `hidden`
          relies on, so it stayed visible in the TRADES view. */}
      {view === "lots" && (
        <div
          className="flex items-center gap-1.5 text-[9px] px-2 py-1 rounded mb-2 border"
          style={{ borderColor: "#f59e0b44", background: "#f59e0b11", color: "#f59e0b" }}
        >
          <Clock className="w-3 h-3 flex-shrink-0" />
          Market data via Yahoo Finance · ~15 min delay · Greeks computed from chain IV · For
          position tracking only, not active trading decisions
          {unpriced > 0 && (
            <span className="ml-1 font-bold">
              · {unpriced} lot{unpriced > 1 ? "s" : ""} without a quote, held at cost
            </span>
          )}
          {noGreeks > 0 && (
            <span className="ml-1 font-bold">
              · {noGreeks} lot{noGreeks > 1 ? "s" : ""} with no IV — excluded from the greek totals
            </span>
          )}
        </div>
      )}

      {view === "lots" && lots.length === 0 && !loading ? (
        <div className="text-center py-8 text-[10px]" style={{ color: colors.textSecondary }}>
          No open option positions
        </div>
      ) : view !== "lots" ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-left border-b" style={{ borderColor: colors.border }}>
                {[
                  "Underlying",
                  "Type",
                  "Strike",
                  "Expiry",
                  "Qty",
                  "Entry",
                  "Mark",
                  "Value",
                  "Unrealized",
                  "Δ",
                  "Γ",
                  "Θ/day",
                  "Δ exp",
                  "Θ exp",
                  "% PORT",
                  "Δ % NAV",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 font-bold text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <React.Fragment key={lot.id}>
                  <PositionRow
                    lot={lot}
                    colors={colors}
                    pct={navPct}
                    onClose={() =>
                      onOpenEntry({
                        account_id: lot.account_id,
                        underlying: lot.underlying,
                        expiry: lot.expiry,
                        strike: lot.strike,
                        option_type: lot.option_type,
                        multiplier: lot.multiplier,
                        action: "CLOSE",
                        side: lot.quantity > 0 ? "SELL" : "BUY",
                        lot_id: lot.id,
                        quantity: Math.abs(lot.quantity),
                        price: lot.expired ? null : lot.mark,
                      })
                    }
                    onEdit={() => openEditor(lot.id)}
                    onPayoff={() => setPayoffLot(lot)}
                    onDelete={() => handleDelete(lot.id)}
                  />
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
