"use client";

import { useMarketQueryResults } from "./useMarketQueryResults";

import {
  type StockQuote,
  fetchQuoteFirstPaint,
  marketRetry,
  marketRetryDelay,
  quoteQueryOptions,
  sparklineBatcher,
} from "@/lib/market-data-client";
import { type QueryObserverResult, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import { patchQuote } from "../lib/live-quotes";
import { isOpenMarketState } from "../lib/stream-cadence";
import { reviveQuote } from "../lib/watchlist-snapshot";
import { type QuoteTick, useQuoteStream, useStreamPollInterval } from "./useQuoteStream";
import { cachedRows, useSnapshotSave, useSnapshotSeed } from "./useWatchlistSnapshot";

const quoteKey = (symbol: string) => quoteQueryOptions(symbol).queryKey;

export function useWatchlistQuotes(symbols: string[], enabled = true) {
  const live = useAtomValue(isRealTimeEnabledAtom);
  const client = useQueryClient();
  const key = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const options = useMemo(
    () =>
      unique.map((symbol) => ({
        ...quoteQueryOptions(symbol),
        // Price first, fundamentals behind (fetchQuoteFirstPaint): a cold
        // backend answers lite quotes in one batched call.
        queryFn: ({ signal }: { signal: AbortSignal }) => {
          const key = quoteKey(symbol);
          return fetchQuoteFirstPaint(
            symbol,
            signal,
            client.getQueryData<StockQuote>(key),
            (full) =>
              client.setQueryData<StockQuote>(key, (old) => (old ? { ...old, ...full } : full))
          );
        },
        enabled,
        refetchInterval: false as const,
        refetchOnWindowFocus: true,
      })),
    [unique, enabled, client]
  );
  // Last session's rows paint at once; each is refetched immediately (stale).
  const seeded = useSnapshotSeed<StockQuote>(client, "quotes", unique, quoteKey, enabled, {
    revive: reviveQuote,
    alwaysRefetch: true,
  });
  const combine = useCallback(
    (queries: QueryObserverResult<StockQuote>[]) => ({
      quotes: Object.fromEntries(queries.flatMap((q, i) => (q.data ? [[unique[i], q.data]] : []))),
      errors: Object.fromEntries(
        queries.flatMap((q, i) => (q.error ? [[unique[i], q.error.message]] : []))
      ),
      loading: queries.some((q) => q.isFetching),
      loaded: queries.filter((q) => q.data).length,
      ...cachedRows(unique, queries, seeded, Date.now()),
    }),
    [unique, seeded]
  );
  // Symbols that should be ticking, from the cached quotes: open session, or
  // not loaded yet (conservative). All ticking on the stream → poll backs off.
  const openSymbols = unique.filter((s) => {
    const q = client.getQueryData<StockQuote>(quoteQueryOptions(s).queryKey);
    return !q || q.marketState == null || isOpenMarketState(q.marketState);
  });
  const pollMs = useStreamPollInterval(openSymbols, enabled ? (live ? 60_000 : 300_000) : false);
  const results = useMarketQueryResults(options, pollMs);
  const combined = useMemo(() => combine(results), [combine, results]);
  useSnapshotSave("quotes", unique, results, seeded);

  // Live LAST/CHG between polls — one tick moves both, so they never disagree.
  const onTicks = useCallback(
    (ticks: Record<string, QuoteTick>) => {
      for (const [sym, t] of Object.entries(ticks)) {
        client.setQueryData<StockQuote>(quoteQueryOptions(sym).queryKey, (prev) =>
          patchQuote(prev, t)
        );
      }
    },
    [client]
  );
  useQuoteStream(unique, onTicks, enabled);
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
