"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { QUERY_RETRY_ONCE } from "@/lib/constants";
import { marketData as staticData } from "../lib/marketData";

export const MARKET_DATA_KEY = "marketData";

async function fetchMarketData() {
  const res = await fetch("/api/market-data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMarketDataQuery() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [MARKET_DATA_KEY],
    queryFn: fetchMarketData,
    staleTime: 60_000,          // treat data as fresh for 60 s
    refetchInterval: false,     // no background polling
    refetchOnWindowFocus: false,
    gcTime: 5 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });

  const refreshData = useCallback(() => { refetch(); }, [refetch]);

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
