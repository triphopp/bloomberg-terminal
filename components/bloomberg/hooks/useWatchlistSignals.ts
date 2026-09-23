"use client";

import { useMarketQueryResults } from "./useMarketQueryResults";

import { SymbolBatcher, marketRetry, marketRetryDelay } from "@/lib/market-data-client";
import { type QueryObserverResult, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

export type TrendState = "UP" | "DOWN" | "FLAT";
export type RsiState = "OB" | "OS" | "NEUTRAL";
export type MacdState = "BULL" | "BEAR" | "NONE";
export type BreakoutState = "UP" | "DOWN" | "NONE";

export interface WatchlistSignal {
  /** Date of the last daily bar — equals today while the session is still open */
  asOf: string;
  trend: {
    state: TrendState;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  rsi: { value: number | null; state: RsiState };
  /** Today's volume ÷ the trailing 20-day average (partial while markets are open) */
  rvol: number | null;
  macd: { state: MacdState; barsSinceCross: number | null; hist: number | null };
  breakout: { state: BreakoutState; high: number | null; low: number | null };
  /** Position inside the 52-week range, 0 = at the low, 1 = at the high */
  range52w: { pct: number | null; high: number; low: number };
  atrPct: number | null;
  /** Composite of every signal above, roughly [-6, +6] */
  score: number;
  flags: string[];
}

export interface WatchlistSignalsResponse {
  signals: Record<string, WatchlistSignal>;
  errors: string[];
  count: number;
}

const batcher = new SymbolBatcher<WatchlistSignal>("/api/watchlist/signals", "signals");

export function useWatchlistSignals(symbols: string[], enabled = true) {
  const client = useQueryClient();
  const key = [...new Set(symbols)].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const options = useMemo(
    () =>
      unique.map((symbol) => ({
        queryKey: ["watchlist-signals", symbol],
        queryFn: ({ signal }: { signal: AbortSignal }) => batcher.request(symbol, signal),
        enabled,
        staleTime: 15 * 60_000,
        gcTime: 30 * 60_000,
        refetchInterval: false as const,
        retry: marketRetry,
        retryDelay: marketRetryDelay,
      })),
    [unique, enabled]
  );
  const combine = useCallback(
    (queries: QueryObserverResult<WatchlistSignal>[]) => ({
      signals: Object.fromEntries(queries.flatMap((q, i) => (q.data ? [[unique[i], q.data]] : []))),
      errors: queries.flatMap((q, i) => (q.error ? [`${unique[i]}: ${q.error.message}`] : [])),
      isLoading: queries.some((q) => q.isFetching),
      error: queries.find((q) => q.error)?.error ?? null,
    }),
    [unique]
  );
  const results = useMarketQueryResults(options, enabled ? 15 * 60_000 : false);
  const combined = useMemo(() => combine(results), [combine, results]);
  return {
    ...combined,
    refetch: () =>
      client.refetchQueries(
        {
          predicate: (q) =>
            q.queryKey[0] === "watchlist-signals" && unique.includes(String(q.queryKey[1])),
        },
        { cancelRefetch: false }
      ),
  };
}
