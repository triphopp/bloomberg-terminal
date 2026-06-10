"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { currentViewAtom } from "../atoms";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MacroSeries = { date: string; value: number }[];

export type MacroIndicator = {
  value: number;
  prev:  number;
  date:  string;
  series: MacroSeries;
} | null;

export type MacroYieldCurve = {
  "3m":  number | null;
  "2y":  number | null;
  "5y":  number | null;
  "10y": number | null;
  "30y": number | null;
  spread_10y_2y:    number | null;
  spread_10y_3m:    number | null;
  is_inverted:      boolean;
  yield_2y_series:  MacroSeries;
  yield_5y_series:  MacroSeries;
};

export type MacroFed = {
  current_rate: number | null;
  stance:       "HIKING" | "CUTTING" | "HOLD";
  series:       MacroSeries;
  next_fomc:    { date: string; days_until: number | null };
};

export type MacroData = {
  indicators: {
    cpi:                MacroIndicator;
    gdp:                MacroIndicator;
    unemployment:       MacroIndicator;
    nfp:                MacroIndicator;
    fed_rate:           MacroIndicator;
    retail_sales:       MacroIndicator;
    consumer_sentiment: MacroIndicator;
  };
  yield_curve: MacroYieldCurve;
  fed:         MacroFed;
  has_av_key:  boolean;
  as_of:       string;
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchMacro(): Promise<MacroData> {
  const res = await fetch("/api/macro", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMacroData() {
  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "macro";

  return useQuery<MacroData>({
    queryKey: ["macro"],
    queryFn:  fetchMacro,
    enabled:  isActive,
    staleTime: 5 * 60_000,   // treat as fresh for 5 min (backend caches 6h)
    refetchInterval: isActive ? 5 * 60_000 : false,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useMacroRefresh() {
  const qc = useQueryClient();
  return async () => {
    await fetch("/api/macro", { method: "DELETE" }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["macro"] });
  };
}
