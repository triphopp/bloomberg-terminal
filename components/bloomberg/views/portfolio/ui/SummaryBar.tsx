"use client";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { type Colors, fmtK, pnlColor } from "../helpers";
import { CashReconcileModal } from "../modals/CashReconcileModal";
import type { Summary } from "../types";

export function SummaryBar({
  summary,
  currency,
  colors,
  accountId,
  onToggleCurrency,
}: {
  summary: Summary | null;
  currency: "THB" | "USD";
  colors: Colors;
  accountId?: string;
  /** Same flip as the "Y" key — the only way to do it without a keyboard. */
  onToggleCurrency?: () => void;
}) {
  const [editCash, setEditCash] = useState(false);
  if (!summary) return null;

  const totalPnl = summary.total_pnl_base;
  const economicPnl = summary.total_economic_pnl_base;
  const sym = currency === "THB" ? "฿" : "$";
  const openCount = summary.accounts.reduce((a, s) => a + s.open_count, 0);
  const optionCount = summary.accounts.reduce((a, s) => a + (s.options_open_count ?? 0), 0);
  const optionsMv = summary.total_options_mv_base ?? 0;
  const optionsUnrealized = summary.total_options_unrealized_base ?? 0;
  const optionsDelta = summary.total_options_delta_notional_base ?? 0;
  // Always shown: selling turns positions into cash, and without this chip the
  // money looks like it vanished until the next buy.
  const cash = summary.total_cash_base ?? 0;
  const cashAdj = summary.total_cash_adjustment_base ?? 0;
  const cashEstimate = summary.cash_is_estimate !== false;
  const adjText =
    cashAdj !== 0 ? ` + your edits (${cashAdj >= 0 ? "+" : "-"}${fmtK(Math.abs(cashAdj))})` : "";
  const estText = cashEstimate
    ? "Not yet reconciled for every account — commissions, taxes and interest never entered are invisible to it. "
    : "";
  const cashTitle = `Idle cash = invested capital + realized P&L (equities and options) + dividends − open cost basis${adjText}. Recomputed on every trade. ${estText}Click to edit to the broker balance.`;
  const economicPnlTitle =
    "Economic realized P&L = (entry cost + native P&L) × exit FX − entry cost × entry FX. Uses stored trade FX when available, otherwise dated market FX estimate. Includes principal FX attribution; broker-style realized P&L excludes it.";

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 md:gap-x-4 gap-y-1 px-3 py-1.5 border-b text-[10px] font-mono"
      style={{ background: "#080808", borderColor: colors.border }}
    >
      {/* Currency + FX in one chip, first on the bar because it frames every
          number after it. The lit symbol is the display currency (every figure
          on the page carries the same ฿/$), the dim one is where a click — or
          Y — takes you. Replaces the separate "FX: …" label and the orange
          "Y VIEW IN USD" button, which said the same thing in two places. */}
      <button
        type="button"
        onClick={onToggleCurrency}
        title={`Showing ${currency} · 1 USD = ฿${summary.thb_per_usd.toFixed(2)} — click or press Y for ${currency === "THB" ? "USD" : "THB"}`}
        className="flex items-center gap-1 hover:opacity-80"
      >
        <span className="font-bold text-xs">
          <span style={{ color: currency === "THB" ? colors.accent : colors.textSecondary }}>
            ฿
          </span>
          <span style={{ color: colors.textSecondary, opacity: 0.5 }}>/</span>
          <span style={{ color: currency === "USD" ? colors.accent : colors.textSecondary }}>
            $
          </span>
        </span>
        <span style={{ color: colors.text }}>{summary.thb_per_usd.toFixed(2)}</span>
      </button>
      <div>
        <span style={{ color: colors.textSecondary }}>TOTAL P&L </span>
        <span className="font-bold text-xs" style={{ color: pnlColor(totalPnl) }}>
          {sym}
          {fmtK(Math.abs(totalPnl))} {totalPnl >= 0 ? "▲" : "▼"}
        </span>
        {economicPnl != null && (
          <div className="text-[7px] leading-none" style={{ color: colors.textSecondary }}>
            <span title={economicPnlTitle}>
              ECON{" "}
              <span style={{ color: pnlColor(economicPnl) }}>
                {sym}
                {fmtK(Math.abs(economicPnl))} {economicPnl >= 0 ? "▲" : "▼"}
              </span>
            </span>
          </div>
        )}
      </div>
      <div>
        <span style={{ color: colors.textSecondary }}>WIN RATE </span>
        <span style={{ color: summary.global_win_rate >= 50 ? "#4ade80" : "#f87171" }}>
          {summary.global_win_rate.toFixed(1)}%
        </span>
      </div>
      <div>
        <span style={{ color: colors.textSecondary }}>OPEN </span>
        <span style={{ color: "#ff9900" }}>{openCount}</span>
      </div>
      {optionCount > 0 && (
        <div
          title={`Option book market value ${sym}${fmtK(optionsMv)} · delta exposure ${sym}${fmtK(optionsDelta)}. Market value counts toward NAV; delta notional is what the book is exposed to and is what weights allocation.`}
        >
          <span style={{ color: colors.textSecondary }}>OPT </span>
          <span style={{ color: "#ff9900" }}>{optionCount}</span>
          <span style={{ color: colors.textSecondary }}> · </span>
          <span style={{ color: colors.text }}>
            {sym}
            {fmtK(optionsMv)}
          </span>
          <span className="ml-1" style={{ color: pnlColor(optionsUnrealized) }}>
            {optionsUnrealized >= 0 ? "+" : "-"}
            {sym}
            {fmtK(Math.abs(optionsUnrealized))}
          </span>
        </div>
      )}
      <button
        type="button"
        title={cashTitle}
        onClick={() => setEditCash(true)}
        className="flex items-center gap-1 hover:opacity-80"
      >
        <span style={{ color: colors.textSecondary }}>CASH{cashEstimate ? "~" : ""} </span>
        <span className="font-bold text-xs" style={{ color: cash >= 0 ? "#facc15" : "#f87171" }}>
          {cash < 0 ? "-" : ""}
          {sym}
          {fmtK(Math.abs(cash))}
        </span>
        {cashEstimate && (
          <span className="text-[8px]" style={{ color: colors.textSecondary }}>
            est
          </span>
        )}
        <Pencil className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
      </button>
      {editCash && (
        <CashReconcileModal
          summary={summary}
          currency={currency}
          colors={colors}
          accountId={accountId}
          onClose={() => setEditCash(false)}
        />
      )}
    </div>
  );
}
