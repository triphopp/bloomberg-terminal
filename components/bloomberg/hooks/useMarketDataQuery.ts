"use client";

import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import { patchRowGroups } from "../lib/live-quotes";
import { marketData as staticData } from "../lib/marketData";
import { type QuoteTick, useQuoteStream } from "./useQuoteStream";

export const MARKET_DATA_KEY = "marketData";

async function fetchMarketData() {
  const res = await fetch("/api/market-data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const REGIONS = ["americas", "emea", "asiaPacific"] as const;

export function useMarketDataQuery() {
  const isRealTime = useAtomValue(isRealTimeEnabledAtom);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [MARKET_DATA_KEY],
    queryFn: fetchMarketData,
    staleTime: 55_000,
    // Was `false`: the index rows only refreshed when something happened to
    // remount them, which read as a random 20s–3min lag on the TICK DATA board.
    // Same cadence as every other live panel now; the stream below fills in
    // between polls.
    refetchInterval: isRealTime ? 60_000 : 300_000,
    refetchOnWindowFocus: true,
    gcTime: 5 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });

  const qc = useQueryClient();
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
