"use client";

import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { isRealTimeEnabledAtom } from "../atoms";

async function stockFetch(params: Record<string, string>) {
  const res = await fetch(`/api/stock?${new URLSearchParams(params)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useStockSearch(query: string) {
  return useQuery({
    queryKey: ["stock", "search", query],
    queryFn: () => stockFetch({ symbol: query, type: "search" }),
    enabled: query.length >= 1,
    staleTime: 30_000,
  });
}

/**
 * The quote behind the chart header: last price, change, and the pre/after-hours
 * fields.
 *
 * This used to be fetch-once (`refetchInterval: false`), which left the header
 * frozen at whatever the price was when the symbol was selected — most visibly
 * before the open, where the pre-market change sat unchanged for hours while
 * the watchlist right next to it kept moving. Polls on the same cadence as the
 * rest of the terminal now, and follows the realtime toggle in the header.
 */
export function useStockQuote(symbol: string | null) {
  const isRealTimeEnabled = useAtomValue(isRealTimeEnabledAtom);
  return useQuery({
    queryKey: ["stock", "quote", symbol],
    queryFn: () => stockFetch({ symbol: symbol as string, type: "quote" }),
    enabled: !!symbol,
    staleTime: 30_000,
    refetchInterval: isRealTimeEnabled ? 60_000 : 300_000,
    refetchOnWindowFocus: true,
  });
}

export function useStockHistory(symbol: string | null, period: string, interval = "") {
  return useQuery({
    queryKey: ["stock", "history", symbol, period, interval],
    queryFn: () =>
      stockFetch({
        symbol: symbol as string,
        type: "history",
        period,
        ...(interval ? { interval } : {}),
      }),
    enabled: !!symbol,
    staleTime: interval && !["1d", "1wk", ""].includes(interval) ? 120_000 : 300_000,
    // Widening the window is a new query key, and without this the hook would
    // report "no data" for a beat — long enough for the chart's caller to swap
    // in a loading spinner, unmounting a perfectly good chart and remounting it
    // fitted back to the start. Holding the previous bars keeps the chart on
    // screen; it swaps to the wider set the moment that lands.
    //
    // Same SYMBOL only: showing one company's bars under another's name is a
    // different, and much worse, bug than a spinner.
    placeholderData: (prev: unknown, prevQuery?: { queryKey: readonly unknown[] }) =>
      prevQuery?.queryKey[2] === symbol ? prev : undefined,
  });
}

/**
 * Warm a history window into the cache without rendering it.
 *
 * Same key and fetcher as `useStockHistory`, so when a component later asks for
 * that window it is served from cache and the chart swaps data instead of
 * waiting on the network. Used by the chart's auto-extend to keep one window
 * ahead of the user at all times.
 */
export function usePrefetchStockHistory() {
  const queryClient = useQueryClient();
  return useCallback(
    (symbol: string | null, period: string, interval = "") => {
      if (!symbol) return;
      void queryClient.prefetchQuery({
        queryKey: ["stock", "history", symbol, period, interval],
        queryFn: () =>
          stockFetch({
            symbol,
            type: "history",
            period,
            ...(interval ? { interval } : {}),
          }),
        staleTime: interval && !["1d", "1wk", ""].includes(interval) ? 120_000 : 300_000,
      });
    },
    [queryClient]
  );
}

export function useStockFinancials(symbol: string | null) {
  return useQuery({
    queryKey: ["stock", "financials", symbol],
    queryFn: () => stockFetch({ symbol: symbol as string, type: "financials" }),
    enabled: !!symbol,
    staleTime: 3_600_000,
  });
}

// ── Options hooks ──────────────────────────────────────────────────────────────

async function optionsFetch(path: string, params: Record<string, string> = {}) {
  const url = `/api/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useOptions(symbol: string | null, expiry?: string) {
  return useQuery({
    queryKey: ["options", "chain", symbol, expiry ?? "default"],
    queryFn: () => {
      const params: Record<string, string> = { symbol: symbol as string };
      if (expiry) params.expiry = expiry;
      return optionsFetch("options", params);
    },
    enabled: !!symbol,
    staleTime: 5 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useOptionsSurface(symbol: string | null, enabled = false) {
  return useQuery({
    queryKey: ["options", "surface", symbol],
    queryFn: () => optionsFetch("options/surface", { symbol: symbol as string }),
    enabled: !!symbol && enabled,
    staleTime: 10 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}
