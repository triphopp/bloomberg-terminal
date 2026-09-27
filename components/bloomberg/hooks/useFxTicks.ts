"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import { patchFxPairs } from "../lib/live-quotes";
import { type QuoteTick, useQuoteStream } from "./useQuoteStream";

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
  const isRealTime = useAtomValue(isRealTimeEnabledAtom);
  const query = useQuery<{ pairs: FxPair[] }>({
    queryKey: ["fx", "overview"],
    queryFn: async () => {
      const res = await fetch("/api/fx?type=overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 55_000, // backend caches 60s
    // Was never polled — the FX rows sat on whatever loaded first.
    refetchInterval: isRealTime ? 60_000 : 300_000,
  });

  const qc = useQueryClient();
  const symbols = useMemo(() => (query.data?.pairs ?? []).map((p) => p.symbol), [query.data]);
  const onTicks = useCallback(
    (ticks: Record<string, QuoteTick>) => {
      qc.setQueryData<{ pairs: FxPair[] }>(["fx", "overview"], (prev) => patchFxPairs(prev, ticks));
    },
    [qc]
  );
  useQuoteStream(symbols, onTicks);

  return query;
}
