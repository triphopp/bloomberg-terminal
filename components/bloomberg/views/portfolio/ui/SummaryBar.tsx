"use client";
import { type Colors, fmtK, pnlColor } from "../helpers";
import type { Summary } from "../types";

export function SummaryBar({
  summary,
  currency,
  colors,
}: { summary: Summary | null; currency: "THB" | "USD"; colors: Colors }) {
  if (!summary) return null;

  const totalPnl =
    currency === "THB"
      ? summary.total_pnl_base
      : summary.total_pnl_base / (summary.thb_per_usd || 33.5);
  const sym = currency === "THB" ? "฿" : "$";
  const openCount = summary.accounts.reduce((a, s) => a + s.open_count, 0);

  return (
    <div
      className="flex flex-wrap items-center gap-4 px-3 py-1.5 border-b text-[10px] font-mono"
      style={{ background: "#080808", borderColor: colors.border }}
    >
      <div>
        <span style={{ color: colors.textSecondary }}>TOTAL P&L </span>
        <span className="font-bold text-xs" style={{ color: pnlColor(totalPnl) }}>
          {sym}
          {fmtK(Math.abs(totalPnl))} {totalPnl >= 0 ? "▲" : "▼"}
        </span>
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
      <div style={{ color: colors.textSecondary }}>
        FX: <span style={{ color: colors.text }}>1 USD = ฿{summary.thb_per_usd.toFixed(2)}</span>
      </div>
      <div
        className="ml-auto text-[8px] px-2 py-0.5 border font-bold animate-pulse"
        style={{ borderColor: "#ff990044", color: "#ff9900" }}
      >
        Y = {currency === "THB" ? "→ USD" : "→ THB"}
      </div>
    </div>
  );
}
