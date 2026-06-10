"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QUERY_RETRY_ONCE } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GlobalYieldRow {
  code:            string;
  name:            string;
  "10y":           number;
  "2y"?:           number | null;
  "30y"?:          number | null;
  chg_1d?:         number | null;
  spread_10y_2y?:  number | null;
}

export interface GlobalYieldCurve {
  "2y"?:  number | null;
  "5y"?:  number | null;
  "10y"?: number | null;
  "30y"?: number | null;
}

export interface GlobalYieldsData {
  table:   GlobalYieldRow[];
  curves:  Record<string, GlobalYieldCurve>;
  series:  Record<string, { date: string; value: number }[]>;
  as_of:   string;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

async function fetchGlobalYields(): Promise<GlobalYieldsData> {
  const res = await fetch("/api/macro/global-yields", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useGlobalYields(enabled = true) {
  return useQuery<GlobalYieldsData>({
    queryKey:    ["globalYields"],
    queryFn:     fetchGlobalYields,
    enabled,
    staleTime:   4 * 60 * 60 * 1000,  // 4 hours — matches backend TTL
    gcTime:      5 * 60 * 60 * 1000,
    retry:       QUERY_RETRY_ONCE,
  });
}

export function useGlobalYieldsRefresh() {
  const qc = useQueryClient();
  return () => {
    fetch("/api/macro/global-yields", { method: "DELETE" }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["globalYields"] });
  };
}
