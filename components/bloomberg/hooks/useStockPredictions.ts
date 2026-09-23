"use client";

import { useMarketQueryResults } from "./useMarketQueryResults";

/**
 * useStockPredictions — Polymarket single-name equity markets as a live implied
 * distribution (price ladders + "close above ___" CDFs).
 *
 * Backend: `/api/polymarket/stock/{symbol}` (full ladders) and
 * `/api/polymarket/stocks?symbols=` (summary per symbol). Both are cached 90s
 * server-side, so polling here at the same cadence keeps the panel live without
 * hammering Gamma.
 */

import { SymbolBatcher, marketRetry, marketRetryDelay } from "@/lib/market-data-client";
import { type QueryObserverResult, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

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

const summaryBatcher = new SymbolBatcher<PredictionSummary | null>(
  "/api/polymarket/stocks",
  "summaries",
  10,
  null
);

/** All symbols are accounted for; null means a successful search found no markets. */
export function useStockPredictionSummaries(symbols: string[], enabled = true) {
  const key = [...new Set(symbols)].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const options = useMemo(
    () =>
      unique.map((symbol) => ({
        queryKey: ["pm-stocks", symbol],
        enabled,
        queryFn: ({ signal }: { signal: AbortSignal }) => summaryBatcher.request(symbol, signal),
        staleTime: POLL_MS,
        gcTime: 30 * 60_000,
        refetchInterval: false as const,
        retry: marketRetry,
        retryDelay: marketRetryDelay,
      })),
    [unique, enabled]
  );
  const combine = useCallback(
    (queries: QueryObserverResult<PredictionSummary | null>[]) => ({
      summaries: Object.fromEntries(
        queries.flatMap((q, i) => (q.data ? [[unique[i], q.data]] : []))
      ),
      errors: queries.flatMap((q, i) => (q.error ? [`${unique[i]}: ${q.error.message}`] : [])),
      isLoading: queries.some((q) => q.isFetching),
      asOf: "",
    }),
    [unique]
  );
  const results = useMarketQueryResults(options, enabled ? POLL_MS * 2 : false);
  return useMemo(() => combine(results), [combine, results]);
}

/** Shared colour rule: above 55% reads long, below 45% reads short. */
export function probColor(prob: number | null | undefined): string {
  if (prob == null) return "#6b7280";
  if (prob >= 0.55) return "#22c55e";
  if (prob <= 0.45) return "#ef4444";
  return "#eab308";
}
