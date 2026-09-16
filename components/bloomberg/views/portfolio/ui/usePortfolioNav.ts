"use client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { portfolioQueries } from "../queries";
import type { Summary, Trade } from "../types";
import { type NavBreakdown, navBreakdown, weightPct } from "../weights";

/** Market value of an equity lot in the display currency, or null if unpriced. */
export function equityMarketValue(p: Trade): number | null {
  if (p.market_value_base != null) return p.market_value_base;
  if (p.cost_basis_base != null && p.unrealized_pnl_base != null) {
    return p.cost_basis_base + p.unrealized_pnl_base;
  }
  return null;
}

/**
 * NAV (equity + options + cash) for the selected account scope, in the display
 * currency. Reads the same React Query caches the POSITIONS tab and the header
 * already fill, so it adds no requests of its own when those have loaded.
 */
export function usePortfolioNav(accountId: string, currency: "THB" | "USD") {
  const { data: open } = useQuery(portfolioQueries.openPositions(currency, accountId));
  const { data: summaryRaw } = useQuery(portfolioQueries.summary(currency));
  const summary = (summaryRaw as Summary | undefined) ?? null;

  return useMemo(() => {
    const cash =
      summary == null
        ? null
        : accountId === "all"
          ? summary.total_cash_base
          : summary.accounts.find((a) => a.account.id === accountId)?.cash_base;
    const breakdown: NavBreakdown | null = open
      ? navBreakdown({
          equityValues: open.positions.map(equityMarketValue),
          optionValues: (open.options ?? []).map((o) => o.market_value_base),
          cash,
        })
      : null;
    const nav = breakdown?.nav ?? 0;
    return {
      breakdown,
      /** value ÷ NAV × 100, null until NAV is known. */
      pct: (value: number | null | undefined) => weightPct(value, nav),
    };
  }, [open, summary, accountId]);
}
