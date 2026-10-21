"use client";

import type { QueryClient, QueryKey, QueryObserverResult } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  type Snapshot,
  type SnapshotKind,
  readSnapshot,
  writeSnapshot,
} from "../lib/watchlist-snapshot";

const storage = (): Storage | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** How often fresh values are written back (stream ticks change them every second). */
const FLUSH_MS = 10_000;

/**
 * Seeds the query cache from the stored snapshot before the observers
 * subscribe (layout effects run before the subscribe effect), with each
 * value's real fetch time and only where the cache holds nothing yet. Returns
 * symbol → the `at` it was seeded with: a row whose dataUpdatedAt still equals
 * it is showing the cached value.
 *
 * `alwaysRefetch`: mark every seeded entry invalidated, so the first observer
 * fetches it however young it is. Quotes need it — a stream tick patches the
 * seeded row (fresh dataUpdatedAt, no refetch) and computes CHG from the
 * stored previousClose, which on a snapshot from an earlier day is the wrong
 * day's close; only the fetched quote brings today's session fields.
 */
export function useSnapshotSeed<T>(
  client: QueryClient,
  kind: SnapshotKind,
  symbols: string[],
  keyOf: (symbol: string) => QueryKey,
  enabled: boolean,
  opts: { revive?: (data: T, now: number) => T; alwaysRefetch?: boolean } = {}
): Map<string, number> {
  const { revive, alwaysRefetch = false } = opts;
  const seeded = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (!enabled || symbols.length === 0) return;
    const now = Date.now();
    const snap = readSnapshot<T>(storage(), kind, now);
    for (const symbol of symbols) {
      const item = snap[symbol];
      if (!item) continue;
      const key = keyOf(symbol);
      if (client.getQueryState(key)?.dataUpdatedAt) continue; // real data already here
      client.setQueryData(key, revive ? revive(item.data, now) : item.data, {
        updatedAt: item.at,
      });
      seeded.current.set(symbol, item.at);
      if (alwaysRefetch) {
        void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
      }
    }
  }, [client, kind, symbols, keyOf, enabled, revive, alwaysRefetch]);
  return seeded.current;
}

/** Writes values fetched in this page back to the snapshot, throttled. */
export function useSnapshotSave<T>(
  kind: SnapshotKind,
  symbols: string[],
  results: QueryObserverResult<T>[],
  seeded: Map<string, number>
): void {
  const pending = useRef<Snapshot<T>>({});
  useEffect(() => {
    results.forEach((q, i) => {
      const symbol = symbols[i];
      if (!symbol || q.data === undefined || !q.dataUpdatedAt) return;
      if (seeded.get(symbol) === q.dataUpdatedAt) return; // still the stored value
      pending.current[symbol] = { at: q.dataUpdatedAt, data: q.data };
    });
  }, [symbols, results, seeded]);
  useEffect(() => {
    const flush = () => {
      if (Object.keys(pending.current).length === 0) return;
      writeSnapshot(storage(), kind, pending.current, Date.now());
      pending.current = {};
    };
    const timer = setInterval(flush, FLUSH_MS);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [kind]);
}

/** Rows still showing a stored value, and the age of the oldest one. */
export function cachedRows<T>(
  symbols: string[],
  results: QueryObserverResult<T>[],
  seeded: Map<string, number>,
  now: number
): { cached: number; cachedAgeMs: number } {
  let cached = 0;
  let oldest = now;
  results.forEach((q, i) => {
    const at = seeded.get(symbols[i]);
    if (at !== undefined && q.data !== undefined && q.dataUpdatedAt === at) {
      cached++;
      oldest = Math.min(oldest, at);
    }
  });
  return { cached, cachedAgeMs: cached ? now - oldest : 0 };
}
