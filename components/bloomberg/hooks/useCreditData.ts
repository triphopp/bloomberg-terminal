"use client";

import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { useQuery, useQueryClient } from "@tanstack/react-query";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CreditSeries = { date: string; value: number }[];

export type CreditSignal = {
  label: string;
  unit: string;
  category: "spreads" | "stress" | "consumer";
  value: number;
  prev: number;
  date: string;
  threshold: number | null;
  triggered: boolean;
  series: CreditSeries;
} | null;

export type CrisisLevel = 0 | 1 | 2 | 3;

export type CreditData = {
  level: CrisisLevel;
  triggered: string[];
  signals: {
    hy_spread: CreditSignal;
    ig_spread: CreditSignal;
    ted_spread: CreditSignal;
    stl_fsi: CreditSignal;
    nfci: CreditSignal;
    vix: CreditSignal;
    yield_10y2y: CreditSignal;
    yield_10y3m: CreditSignal;
    breakeven_5y: CreditSignal;
    breakeven_10y: CreditSignal;
    mortgage_30y: CreditSignal;
    cc_delinquency: CreditSignal;
    mtg_delinquency: CreditSignal;
  };
  as_of: string;
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCredit(): Promise<CreditData> {
  const res = await fetch("/api/crisis", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/** `/api/crisis` — read by BOND (status-bar level + CONDITIONS tab; was the CRDT
 *  view until 2026-09-25). Fetched once on mount for the level badge; `isActive`
 *  gates the 5-minute poll so it only runs while CONDITIONS is open. */
export function useCreditData(isActive: boolean) {
  return useQuery<CreditData>({
    queryKey: ["crisis"],
    queryFn: fetchCredit,
    staleTime: 5 * 60_000,
    refetchInterval: isActive ? 5 * 60_000 : false,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useCreditRefresh() {
  const qc = useQueryClient();
  return async () => {
    await fetch("/api/crisis", { method: "DELETE" }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["crisis"] });
  };
}
