"use client";

import { useQuery } from "@tanstack/react-query";
import { QUERY_RETRY_ONCE } from "@/lib/constants";

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

export function useStockQuote(symbol: string | null) {
  return useQuery({
    queryKey: ["stock", "quote", symbol],
    queryFn: () => stockFetch({ symbol: symbol!, type: "quote" }),
    enabled: !!symbol,
    staleTime: 5 * 60_000,
    refetchInterval: false,   // Fetch only when user searches, no background polling
  });
}

export function useStockHistory(symbol: string | null, period: string, interval = "") {
  return useQuery({
    queryKey: ["stock", "history", symbol, period, interval],
    queryFn: () => stockFetch({
      symbol: symbol!,
      type:   "history",
      period,
      ...(interval ? { interval } : {}),
    }),
    enabled:   !!symbol,
    staleTime: interval && !["1d", "1wk", ""].includes(interval) ? 120_000 : 300_000,
  });
}

export function useStockFinancials(symbol: string | null) {
  return useQuery({
    queryKey: ["stock", "financials", symbol],
    queryFn: () => stockFetch({ symbol: symbol!, type: "financials" }),
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
      const params: Record<string, string> = { symbol: symbol! };
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
    queryFn: () => optionsFetch(`options/surface`, { symbol: symbol! }),
    enabled: !!symbol && enabled,
    staleTime: 10 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}
