"use client";

import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import { patchRowGroups } from "../lib/live-quotes";
import { marketData as staticData } from "../lib/marketData";
import { openSymbolsOf } from "../lib/stream-cadence";
import { type QuoteTick, useQuoteStream, useStreamPollInterval } from "./useQuoteStream";

export const MARKET_DATA_KEY = "marketData";

async function fetchMarketData() {
  const res = await fetch("/api/market-data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const REGIONS = ["americas", "emea", "asiaPacific"] as const;

type Row = { symbol?: string; marketState?: string | null };

export function useMarketDataQuery() {
  const isRealTime = useAtomValue(isRealTimeEnabledAtom);
  const qc = useQueryClient();
  // Rows whose market is open, from the last payload — the poll slows to the
  // stream's pace only while every one of them is ticking on the stream.
  const cached = qc.getQueryData<Record<string, unknown>>([MARKET_DATA_KEY]);
  const openSymbols = useMemo(() => {
    const rows = REGIONS.flatMap((r) => (cached?.[r] ?? []) as Row[]);
    return rows.length ? openSymbolsOf(rows) : null; // no rows yet = unknown, not closed
  }, [cached]);
  const pollMs = useStreamPollInterval(openSymbols, isRealTime ? 60_000 : 300_000);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [MARKET_DATA_KEY],
    queryFn: fetchMarketData,
    staleTime: 55_000,
    // Was `false`: the index rows only refreshed when something happened to
    // remount them, which read as a random 20s–3min lag on the TICK DATA board.
    // Same cadence as every other live panel now; the stream below fills in
    // between polls.
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
    gcTime: 5 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });

  const symbols = useMemo(
    () =>
      REGIONS.flatMap((r) =>
        ((data?.[r] ?? []) as { symbol?: string }[]).map((x) => x.symbol ?? "")
      ).filter(Boolean),
    [data]
  );
  const onTicks = useCallback(
    (ticks: Record<string, QuoteTick>) => {
      qc.setQueryData<Record<string, unknown>>([MARKET_DATA_KEY], (prev) =>
        patchRowGroups(prev, REGIONS, ticks)
      );
    },
    [qc]
  );
  useQuoteStream(symbols, onTicks);

  const refreshData = useCallback(() => {
    refetch();
  }, [refetch]);

  return {
    marketData: data ?? staticData,
    isLoading,
    error,
    lastUpdated: data?.lastUpdated ? new Date(data.lastUpdated) : null,
    dataSource: data?.dataSource ?? "static",
    dataUpdatedAt: new Date(),
    updatedCells: {} as Record<string, boolean>,
    updatedSparklines: {} as Record<string, boolean>,
    isRealTimeEnabled: false,
    isFromRedis: false,
    toggleRealTimeUpdates: () => {},
    refreshData,
  };
}
