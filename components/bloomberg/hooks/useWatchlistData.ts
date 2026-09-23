"use client";

import { useMarketQueryResults } from "./useMarketQueryResults";

import {
  type StockQuote,
  marketRetry,
  marketRetryDelay,
  quoteQueryOptions,
  sparklineBatcher,
} from "@/lib/market-data-client";
import { type QueryObserverResult, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";

export function useWatchlistQuotes(symbols: string[], enabled = true) {
  const live = useAtomValue(isRealTimeEnabledAtom);
  const client = useQueryClient();
  const key = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const options = useMemo(
    () =>
      unique.map((symbol) => ({
        ...quoteQueryOptions(symbol),
        enabled,
        refetchInterval: false as const,
        refetchOnWindowFocus: true,
      })),
    [unique, enabled]
  );
  const combine = useCallback(
    (queries: QueryObserverResult<StockQuote>[]) => ({
      quotes: Object.fromEntries(queries.flatMap((q, i) => (q.data ? [[unique[i], q.data]] : []))),
      errors: Object.fromEntries(
        queries.flatMap((q, i) => (q.error ? [[unique[i], q.error.message]] : []))
      ),
      loading: queries.some((q) => q.isFetching),
      loaded: queries.filter((q) => q.data).length,
    }),
    [unique]
  );
  const results = useMarketQueryResults(options, enabled ? (live ? 60_000 : 300_000) : false);
  const combined = useMemo(() => combine(results), [combine, results]);
  return {
    ...combined,
    total: unique.length,
    refresh: () =>
      client.refetchQueries(
        {
          predicate: (query) =>
            query.queryKey[0] === "stock" &&
            query.queryKey[1] === "quote" &&
            unique.includes(String(query.queryKey[2])),
        },
        { cancelRefetch: false }
      ),
  };
}

export function useWatchlistSparklines(symbols: string[], enabled: boolean) {
  const key = [...new Set(symbols)].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const options = useMemo(
    () =>
      unique.map((symbol) => ({
        queryKey: ["watchlist-sparkline", symbol],
        queryFn: ({ signal }: { signal: AbortSignal }) => sparklineBatcher.request(symbol, signal),
        enabled,
        staleTime: 300_000,
        gcTime: 30 * 60_000,
        retry: marketRetry,
        retryDelay: marketRetryDelay,
      })),
    [unique, enabled]
  );
  const combine = useCallback(
    (queries: QueryObserverResult<number[]>[]) =>
      Object.fromEntries(queries.flatMap((q, i) => (q.data ? [[unique[i], q.data]] : []))),
    [unique]
  );
  const results = useMarketQueryResults(options);
  return useMemo(() => combine(results), [combine, results]);
}
