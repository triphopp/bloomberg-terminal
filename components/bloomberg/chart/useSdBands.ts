"use client";

/**
 * Data side of the IV SD Heatmap pane: fetch the σ-bands and, on a symbol with no
 * usable IV on file, record one snapshot so the pane has something to draw.
 *
 * The self-healing part is not a nicety. Yahoo publishes only the CURRENT implied
 * vol of a chain, so there is no IV history to back-fill — the series exists only
 * because something wrote it down each day. Before this, a user who turned the
 * indicator on saw "No IV snapshots yet" and had no way to know that the fix was
 * to go open a different tab. Now opening the pane IS the trigger.
 *
 * Shared by stock-view and market-view: both need the identical
 * query-key/params/injection wiring, and the third copy of it would have been the
 * one that drifted.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { SD_HEATMAP_DEFAULT_MODE, type SdBandsPayload } from "./indicators/sd-heatmap";
import type { ChartIndicator } from "./types";

export interface UseSdBandsOptions {
  /** The chart's active indicators — the hook is inert unless sd-heatmap is on. */
  indicators: ChartIndicator[];
  symbol: string | null | undefined;
  /** Price-history window forwarded to the backend. */
  period: string;
  /** `updateIndicatorConfig` from useChartIndicators. */
  updateIndicatorConfig: (id: string, config: Record<string, unknown>) => void;
}

const INDICATOR_ID = "sd-heatmap";

/** Symbols the snapshot self-heal has already POSTed for, app-wide. */
const attemptedSnapshots = new Set<string>();

export function useSdBands({
  indicators,
  symbol,
  period,
  updateIndicatorConfig,
}: UseSdBandsOptions) {
  const queryClient = useQueryClient();
  const indicator = indicators.find((i) => i.id === INDICATOR_ID);
  // Effects below depend on this boolean, never on `indicator` itself: writing
  // preloadedData replaces that object, so depending on it would make an effect
  // retrigger its own cause.
  const active = !!indicator;

  const mode = (indicator?.config.mode as string) ?? SD_HEATMAP_DEFAULT_MODE;
  const horizonDays = (indicator?.config.horizonDays as number) ?? 30;
  const rvWindow = (indicator?.config.rvWindow as number) ?? 21;
  const occWindow = (indicator?.config.occWindow as number) ?? 63;

  const query = useQuery<SdBandsPayload>({
    queryKey: ["sd-bands", symbol, period, mode, horizonDays, rvWindow, occWindow],
    queryFn: () =>
      fetch(
        `/api/options/sd-bands?symbol=${encodeURIComponent(symbol ?? "")}` +
          `&period=${period}&mode=${mode}&horizonDays=${horizonDays}` +
          `&rvWindow=${rvWindow}&occWindow=${occWindow}`
      ).then((r) => r.json()),
    enabled: active && !!symbol,
    staleTime: 10 * 60 * 1000,
  });

  // Symbols already attempted this session. Without it a symbol with no options
  // chain (an index, most ETFs) would be retried on every render forever, since
  // its snapshot count stays 0 no matter how often the POST 404s.
  //
  // Module-level rather than per-hook: several charts can be mounted on the same
  // symbol at once (the MKT panel plus any number of floating chart windows),
  // and a per-instance guard let each of them fire its own POST for it.
  const record = useMutation({
    mutationFn: (sym: string) =>
      fetch(`/api/options/iv-snapshot?symbol=${encodeURIComponent(sym)}&targetDte=${horizonDays}`, {
        method: "POST",
      }),
    onSettled: () => {
      // Refetch either way: on success there is new data, and on failure the
      // backend's `note` explains why there never will be.
      queryClient.invalidateQueries({ queryKey: ["sd-bands"] });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `record` is a fresh object each render; the module-level guard is what makes this fire once per symbol
  useEffect(() => {
    if (!active || !symbol) return;
    if (query.data?.snapshotCount !== 0) return;
    if (attemptedSnapshots.has(symbol)) return;
    attemptedSnapshots.add(symbol);
    record.mutate(symbol);
  }, [active, symbol, query.data?.snapshotCount]);

  useEffect(() => {
    if (active && query.data?.levels) {
      updateIndicatorConfig(INDICATOR_ID, { preloadedData: query.data });
    }
  }, [active, query.data, updateIndicatorConfig]);

  return {
    payload: query.data,
    isLoading: query.isLoading,
    isRecording: record.isPending,
  };
}
