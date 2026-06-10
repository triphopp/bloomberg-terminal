"use client";

import { useQuery } from "@tanstack/react-query";
import type { FootprintData } from "../chart/indicators/order-footprint";

async function fetchFootprint(symbol: string, interval: string, limit: number, buckets: number): Promise<FootprintData> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
    buckets: String(buckets),
  });
  const res = await fetch(`/api/crypto/footprint?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useFootprintData(
  symbol: string | null,
  interval: string,
  enabled: boolean,
  limit = 20,
  buckets = 12,
) {
  return useQuery<FootprintData>({
    queryKey: ["footprint", symbol, interval, limit, buckets],
    queryFn: () => fetchFootprint(symbol!, interval, limit, buckets),
    enabled: !!symbol && enabled,
    staleTime: 20_000,
    refetchInterval: enabled ? 30_000 : false,
  });
}
