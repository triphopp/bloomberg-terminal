"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import { patchFxPairs } from "../lib/live-quotes";
import { type QuoteTick, useQuoteStream, useStreamPollInterval } from "./useQuoteStream";

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
  const qc = useQueryClient();
  // FX carries no session flag: every pair counts as open, so the poll slows
  // only while all of them are ticking on the stream (weekdays, in practice).
  const cached = qc.getQueryData<{ pairs: FxPair[] }>(["fx", "overview"]);
  const pairSymbols = useMemo(
    () => (cached?.pairs?.length ? cached.pairs.map((p) => p.symbol) : null),
    [cached]
  );
  const pollMs = useStreamPollInterval(pairSymbols, isRealTime ? 60_000 : 300_000);
  const query = useQuery<{ pairs: FxPair[] }>({
    queryKey: ["fx", "overview"],
    queryFn: async () => {
      const res = await fetch("/api/fx?type=overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 55_000, // backend caches 60s
    // Was never polled — the FX rows sat on whatever loaded first.
    refetchInterval: pollMs,
  });

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
