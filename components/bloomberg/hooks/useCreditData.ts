"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { currentViewAtom } from "../atoms";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CreditSeries = { date: string; value: number }[];

export type CreditSignal = {
  label:     string;
  unit:      string;
  category:  "spreads" | "stress" | "consumer";
  value:     number;
  prev:      number;
  date:      string;
  threshold: number | null;
  triggered: boolean;
  series:    CreditSeries;
} | null;

export type CrisisLevel = 0 | 1 | 2 | 3;

export type CreditData = {
  level:     CrisisLevel;
  triggered: string[];
  signals: {
    hy_spread:       CreditSignal;
    ig_spread:       CreditSignal;
    em_hy_spread:    CreditSignal;
    ted_spread:      CreditSignal;
    stl_fsi:         CreditSignal;
    nfci:            CreditSignal;
    vix:             CreditSignal;
    yield_10y2y:     CreditSignal;
    yield_10y3m:     CreditSignal;
    breakeven_5y:    CreditSignal;
    breakeven_10y:   CreditSignal;
    mortgage_30y:    CreditSignal;
    cc_delinquency:  CreditSignal;
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

export function useCreditData() {
  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "credit";

  return useQuery<CreditData>({
    queryKey: ["crisis"],
    queryFn:  fetchCredit,
    enabled:  isActive,
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
