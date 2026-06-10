"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { currentViewAtom } from "../atoms";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LayerDetail = {
  score: number;
  z_score: number;
  freshness: string;
  // Layer A specific
  r_rel_20d?: number;
  r_equity_20d?: number;
  r_bond_20d?: number;
  realized_vol?: number | null;
  // Layer B specific
  flow_ratio?: number;
  equity_flow_20d?: number;
  bond_flow_20d?: number;
  method?: string;
  // Layer C specific
  equity_share?: number;
  mu_C?: number;
  sigma_C?: number;
};

export type AllocationSignal = {
  timestamp: string;
  equal_score: number;
  weighted_score: number;
  regime: string;
  conflict: boolean;
  recommendation: string;
  layers: {
    A: LayerDetail;
    B: LayerDetail;
    C: LayerDetail;
  };
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchAllocation(): Promise<AllocationSignal> {
  const res = await fetch("/api/allocation/signal", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAllocation() {
  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "macro";

  return useQuery<AllocationSignal>({
    queryKey: ["allocation"],
    queryFn: fetchAllocation,
    enabled: isActive,
    staleTime: 5 * 60_000,
    refetchInterval: isActive ? 5 * 60_000 : false,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useAllocationRefresh() {
  const qc = useQueryClient();
  return async () => {
    qc.invalidateQueries({ queryKey: ["allocation"] });
  };
}
