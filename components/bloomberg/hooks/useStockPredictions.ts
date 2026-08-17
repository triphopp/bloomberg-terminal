"use client";

/**
 * useStockPredictions — Polymarket single-name equity markets as a live implied
 * distribution (price ladders + "close above ___" CDFs).
 *
 * Backend: `/api/polymarket/stock/{symbol}` (full ladders) and
 * `/api/polymarket/stocks?symbols=` (summary per symbol). Both are cached 90s
 * server-side, so polling here at the same cadence keeps the panel live without
 * hammering Gamma.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export type StrikeBasis = "close" | "touch";

export interface PredictionStrike {
  label: string;
  strike: number;
  direction: "up" | "down";
  prob: number;
  volume: number;
  slug: string;
  /** Present on summary strikes: which instrument priced it. */
  basis?: StrikeBasis;
}

export type PredictionEventType = "ladder" | "above" | "updown" | "earnings" | "other";

export interface PredictionEvent {
  slug: string;
  title: string;
  type: PredictionEventType;
  end_date: string;
  days_left: number | null;
  volume: number;
  liquidity: number;
  strikes: PredictionStrike[];
  prob_up: number | null;
  url: string;
}

export interface PredictionSummary {
  spot: number | null;
  prob_up: number | null;
  prob_up_source: "updown" | "cdf" | "close" | "touch" | "ladder" | null;
  prob_above_spot: number | null;
  nearest_up: PredictionStrike | null;
  nearest_down: PredictionStrike | null;
  implied_high: number | null;
  implied_low: number | null;
  skew: number | null;
  horizon_days: number | null;
  event_slug: string | null;
  event_title: string | null;
  url: string | null;
  event_count?: number;
}

export interface StockPrediction {
  symbol: string;
  spot: number | null;
  as_of: string;
  events: PredictionEvent[];
  summary: PredictionSummary;
  error?: string;
}

const POLL_MS = 90_000;

/** Full ladders for one ticker — used by the NEWS Polymarket column. */
export function useStockPrediction(symbol: string | null, company = "", enabled = true) {
  return useQuery<StockPrediction>({
    queryKey: ["pm-stock", symbol, company],
    enabled: enabled && !!symbol,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    retry: 1,
    queryFn: async () => {
      const qs = company ? `?company=${encodeURIComponent(company)}` : "";
      const res = await fetch(`/api/polymarket/stock/${encodeURIComponent(symbol as string)}${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

/** Summary per symbol — used by the MKT watchlist rows. */
export function useStockPredictionSummaries(symbols: string[], enabled = true) {
  const key = useMemo(() => [...new Set(symbols)].sort().join(","), [symbols]);

  const query = useQuery<{ summaries: Record<string, PredictionSummary>; as_of?: string }>({
    queryKey: ["pm-stocks", key],
    enabled: enabled && key.length > 0,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS * 2,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(`/api/polymarket/stocks?symbols=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return {
    summaries: query.data?.summaries ?? {},
    isLoading: query.isLoading,
    asOf: query.data?.as_of ?? "",
  };
}

/** Shared colour rule: above 55% reads long, below 45% reads short. */
export function probColor(prob: number | null | undefined): string {
  if (prob == null) return "#6b7280";
  if (prob >= 0.55) return "#22c55e";
  if (prob <= 0.45) return "#ef4444";
  return "#eab308";
}
