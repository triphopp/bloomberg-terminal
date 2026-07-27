"use client";

/**
 * useWatchlistSignals — batch daily technical scan for every watchlist symbol.
 *
 * One request covers the whole list (the backend does a single yfinance batch
 * download and caches it for 15 min), so adding symbols costs nothing extra.
 *
 *   const { signals, isLoading } = useWatchlistSignals(["AAPL", "NVDA"]);
 *   signals["AAPL"]?.trend.state // "UP"
 */

import { useQuery } from "@tanstack/react-query";

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

const EMPTY: Record<string, WatchlistSignal> = {};

export function useWatchlistSignals(symbols: string[], enabled = true) {
  // Sorted + deduped so reordering the watchlist doesn't refetch.
  const key = [...new Set(symbols)].sort().join(",");

  const query = useQuery<WatchlistSignalsResponse>({
    queryKey: ["watchlist-signals", key],
    queryFn: () =>
      fetch(`/api/watchlist/signals?symbols=${encodeURIComponent(key)}`).then((r) => r.json()),
    enabled: enabled && key.length > 0,
    // Matches the backend's 15 min cache — polling faster only burns requests.
    staleTime: 15 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  return {
    signals: query.data?.signals ?? EMPTY,
    errors: query.data?.errors ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
