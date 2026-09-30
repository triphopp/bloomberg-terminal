"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { type PinnedAsset, pinnedAssetsAtom } from "../../atoms";
import type { WatchlistNewsResponse } from "./types";
import { useFreshFlag } from "./useNewsQueries";

const LS_PINS = "bloomberg_pinned_assets";

/**
 * Watchlist tickers for the NEWS view.
 *
 * `pinnedAssetsAtom` is only hydrated once the MKT view (pinned-assets.tsx) has
 * mounted, and NEWS can be the first view opened in a session — so fall back to
 * the same localStorage key that component persists to.
 */
export function useWatchlistSymbols(): string[] {
  const pins = useAtomValue(pinnedAssetsAtom);

  return useMemo(() => {
    let source: PinnedAsset[] = pins;
    if (source.length === 0 && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(LS_PINS);
        if (raw) source = JSON.parse(raw) as PinnedAsset[];
      } catch {
        /* ignore */
      }
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of source) {
      const sym = (p?.symbol ?? "").trim().toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        out.push(sym);
      }
    }
    return out.slice(0, 30);
  }, [pins]);
}

interface Options {
  symbols: string[];
  sources: string[];
  perSymbol?: number;
  enabled?: boolean;
}

export function useWatchlistNews({ symbols, sources, perSymbol = 6, enabled = true }: Options) {
  // Sorted key so reordering the watchlist doesn't force a refetch.
  const symKey = useMemo(() => [...symbols].sort().join(","), [symbols]);
  const srcKey = useMemo(() => [...sources].sort().join(","), [sources]);
  const fresh = useFreshFlag();

  const query = useQuery<WatchlistNewsResponse>({
    queryKey: ["watchlist-news", symKey, srcKey, perSymbol],
    enabled: enabled && symbols.length > 0 && sources.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: 1,
    // Changing per-symbol / sources / the watchlist keeps the current list on
    // screen until the new one lands. The backend caches per symbol on
    // per_source, not per_symbol, so a per-symbol change is a cache hit there.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({
        symbols: symKey,
        sources: srcKey,
        per_symbol: String(perSymbol),
        polymarket: "1",
      });
      if (fresh.take()) qs.set("fresh", "1");
      const res = await fetch(`/api/news/watchlist?${qs.toString()}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const refresh = useCallback(() => {
    fresh.arm();
    return query.refetch();
  }, [fresh, query.refetch]);
  return { ...query, refresh };
}
