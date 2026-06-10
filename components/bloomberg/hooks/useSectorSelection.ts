"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { currentViewAtom } from "../atoms";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SectorLayerData {
  z_score: number;
  [key: string]: unknown;
}

export interface SectorEntry {
  ticker: string;
  name: string;
  rank: number;
  sector_score: number;
  classification:
    | "STRONG_OVERWEIGHT"
    | "OVERWEIGHT"
    | "NEUTRAL"
    | "UNDERWEIGHT"
    | "STRONG_UNDERWEIGHT";
  layers: {
    BC: SectorLayerData;
    MOM: SectorLayerData;
    VAL: SectorLayerData;
    F: SectorLayerData;
  };
}

export interface CycleIndicators {
  z_slope:  number;   // T10Y2Y spread z-score (NOT the yield level — spread = 10Y minus 2Y)
  z_pmi:    number;   // CFNAI z-score vs 3Y history
  z_spread: number;   // inverted HY credit spread z-score
  z_dpmi:   number;   // CFNAI 3-month momentum z-score
}

export interface SectorSignal {
  version: string;
  timestamp: string;
  cycle_phase: string;
  cycle_score: number;
  cycle_probabilities: Record<string, number>;
  indicators?: CycleIndicators;   // raw z-scores — shows WHAT drives the phase
  breadth?: number;               // fraction of sectors above MA200
  vix: number | null;
  volatility_brake_active: boolean;
  weights_used: Record<string, number>;
  sectors: SectorEntry[];
  macro_factors: Record<string, number>;
  conflicts: {
    mom_val_divergence: boolean;
    top_momentum_sector: string;
    top_valuation_sector: string;
    bc_mom_conflicts: string[];
  };
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchSectorSignal(): Promise<SectorSignal> {
  const res = await fetch("/api/sector/signal", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSectorSelection() {
  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "macro";

  return useQuery<SectorSignal>({
    queryKey: ["sector-signal"],
    queryFn: fetchSectorSignal,
    enabled: isActive,
    staleTime: 5 * 60_000,
    refetchInterval: isActive ? 5 * 60_000 : false,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useSectorSelectionRefresh() {
  const qc = useQueryClient();
  return async () => {
    qc.invalidateQueries({ queryKey: ["sector-signal"] });
  };
}
