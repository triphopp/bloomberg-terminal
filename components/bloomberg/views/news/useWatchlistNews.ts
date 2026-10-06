"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef } from "react";
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

// The backend keeps one pull per (symbol, source). The first request holds at
// most FIRST_WAIT_S for sources it has nothing from and answers with what has
// arrived, counting the rest in `pending`; follow-ups (`settle=1`) hold until
// those land. A slow source (Nasdaq: ~3 s on a new connection) no longer keeps
// the headlines that are already here off the screen.
const FIRST_WAIT_S = "1.5";
const SETTLE_WAIT_S = "4";
const SETTLE_GAP_MS = 200;
const MAX_SETTLE_POLLS = 8;

export function useWatchlistNews({ symbols, sources, perSymbol = 6, enabled = true }: Options) {
  // Sorted key so reordering the watchlist doesn't force a refetch.
  const symKey = useMemo(() => [...symbols].sort().join(","), [symbols]);
  const srcKey = useMemo(() => [...sources].sort().join(","), [sources]);
  const fresh = useFreshFlag();
  // Which symbol/source set still has pulls running, and how often we asked.
  const settling = useRef<{ key: string; polls: number } | null>(null);
  const pullKey = `${symKey}|${srcKey}`;

  const query = useQuery<WatchlistNewsResponse>({
    queryKey: ["watchlist-news", symKey, srcKey, perSymbol],
    enabled: enabled && symbols.length > 0 && sources.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: 1,
    // Changing per-symbol / sources / the watchlist keeps the current list on
    // screen until the new one lands. The backend caches per symbol and source,
    // so a per-symbol change or a source switched off is a cache hit there.
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      (q.state.data?.pending ?? 0) > 0 && settling.current?.key === pullKey ? SETTLE_GAP_MS : false,
    queryFn: async ({ signal }) => {
      const following = settling.current?.key === pullKey ? settling.current : null;
      const qs = new URLSearchParams({
        symbols: symKey,
        sources: srcKey,
        per_symbol: String(perSymbol),
        polymarket: "1",
        wait: following ? SETTLE_WAIT_S : FIRST_WAIT_S,
      });
      if (following) qs.set("settle", "1");
      if (fresh.take()) qs.set("fresh", "1");
      const res = await fetch(`/api/news/watchlist?${qs.toString()}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WatchlistNewsResponse;
      const polls = following ? following.polls + 1 : 0;
      settling.current =
        (data.pending ?? 0) > 0 && polls < MAX_SETTLE_POLLS ? { key: pullKey, polls } : null;
      return data;
    },
  });

  const refresh = useCallback(() => {
    fresh.arm();
    settling.current = null;
    return query.refetch();
  }, [fresh, query.refetch]);
  /** Sources are still answering behind the list on screen. */
  const isUpdating = (query.data?.pending ?? 0) > 0 && settling.current?.key === pullKey;
  return { ...query, refresh, isUpdating };
}
