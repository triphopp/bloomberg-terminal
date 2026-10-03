"use client";

/**
 * MARGIN level in the shared status row, next to GUARD. Hidden while no PORT
 * account has margin enabled. Shows the WORST account; click → PORT → RISK,
 * where the MARGIN · REG T card breaks it down. Paper accounts the backend
 * still returns are skipped — the PAPER tab was removed 2026-10-02.
 * Backend: GET /api/v2/portfolio/margin/overview (backend/routers/margin.py).
 */

import { useSetAtom } from "jotai";
import { startTransition } from "react";

import { currentViewAtom, portfolioTabRequestAtom } from "../atoms";
import { LEVEL_COLOR, LEVEL_TEXT, pct1, useMarginOverview } from "../views/portfolio/ui/margin";

export function MarginRibbon() {
  const setView = useSetAtom(currentViewAtom);
  const requestTab = useSetAtom(portfolioTabRequestAtom);
  const { data, isError } = useMarginOverview();

  const accounts = (data?.accounts ?? []).filter((a) => a.scope !== "paper");
  if (!accounts.length) return null;
  const worst = accounts.find((a) => a.level) ?? accounts[0];
  const level = worst.level;
  const color = level ? LEVEL_COLOR[level] : "#555";
  const label = worst.name ?? worst.account_id;

  return (
    <button
      type="button"
      className="flex h-full shrink-0 items-center gap-1.5 border-r border-[#242424] px-2 font-mono select-none"
      title={accounts
        .map(
          (a) =>
            `${a.name ?? a.account_id}: ${a.level ?? "ERROR"} · cushion ${pct1(a.cushion)} · EL ${a.excess_liquidity?.toFixed(2) ?? "—"}${a.drop_to_call != null ? ` · call at −${pct1(a.drop_to_call)}` : ""}`
        )
        .join("\n")}
      aria-label={`MARGIN ${level ?? "unknown"} — open margin detail`}
      onClick={() => {
        startTransition(() => {
          requestTab("risk");
          setView("portfolio");
        });
      }}
    >
      <span className="font-bold tracking-wide" style={{ color: "#888", fontSize: 9 }}>
        MGN
      </span>
      <span
        className={`font-bold ${level === "LIQUIDATION" || level === "DANGER" ? "animate-pulse" : ""}`}
        style={{ color, fontSize: 9 }}
      >
        ● {isError ? "NO DATA" : (level ?? "…")}
      </span>
      {level && level !== "SAFE" && (
        <span className="text-[8.5px]" style={{ color }} title={LEVEL_TEXT[level]}>
          {label} · cushion {pct1(worst.cushion)}
          {worst.drop_to_call != null ? ` · call −${pct1(worst.drop_to_call)}` : ""}
        </span>
      )}
    </button>
  );
}
