"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { currentViewAtom } from "../atoms";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RotationLayer = {
  score: number;
  momentum_12m_1m?: number;
  momentum_6m?: number;
  momentum_3m?: number;
  gdp_growth_3y_ma?: number;
  current_account?: number;
  dividend_yield?: number;
};

export type RotationEntry = {
  rank: number;
  ticker: string;
  country: string;
  region: string;
  type: "single" | "regional";
  rotation_score: number;
  classification: string;
  layers: {
    M: RotationLayer;
    Q: RotationLayer;
    C: RotationLayer;
  };
};

export type RotationScores = {
  timestamp: string;
  rankings: RotationEntry[];
  universe_stats: {
    n_countries: number;
    mean_momentum_composite: number;
    std_momentum_composite: number;
    data_freshness: {
      prices: string;
      macro: string;
      carry: string;
    };
  };
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchRotation(): Promise<RotationScores> {
  const res = await fetch("/api/country-rotation/scores", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCountryRotation() {
  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "macro";

  return useQuery<RotationScores>({
    queryKey: ["country-rotation", "scores"],
    queryFn: fetchRotation,
    enabled: isActive,
    staleTime: 300_000,
    refetchInterval: isActive ? 300_000 : false,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useCountryRotationRefresh() {
  const qc = useQueryClient();
  return async () => {
    qc.invalidateQueries({ queryKey: ["country-rotation"] });
  };
}
