"use client";

import { useQuery } from "@tanstack/react-query";

/** Shape returned by backend/routers/fx.py `fx_overview`. */
export interface FxPair {
  id: string;
  symbol: string; // "EURUSD=X"
  price: number;
  change: number | null;
  pctChange: number | null;
  prevClose: number | null;
}

export function useFxTicks() {
  return useQuery<{ pairs: FxPair[] }>({
    queryKey: ["fx", "overview"],
    queryFn: async () => {
      const res = await fetch("/api/fx?type=overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000, // matches the backend's 60s cache
  });
}
