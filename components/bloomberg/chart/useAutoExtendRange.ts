"use client";

/**
 * Zoom out past the oldest bar and the chart loads more history by itself.
 *
 * The backend serves history by named window (`1m`, `3m`, `1y`, `max`…), not by
 * start/end date, so "more history" means climbing to the next-wider window and
 * refetching. The decision is chartkit's (pure, tested); this hook is the React
 * plumbing around it — which window is live, when to stop, and what identity
 * the viewport should be preserved under.
 *
 * The user's own timeframe pick is never mutated: the parent keeps owning
 * `period`, and this hook layers an auto-widened window on top. Picking a
 * period by hand, or changing symbol/interval, drops back to exactly what was
 * asked for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type LadderStep,
  type LogicalRange,
  buildLadder,
  nextWider,
  planExtend,
  planPrefetch,
} from "../chartkit";
import { type BarInterval, INTERVAL_VALID_RANGES, type TimePeriod } from "./types";

/**
 * Approximate span of each window, in days — used only to ORDER them.
 *
 * `ytd` is the one that moves: in January it is days, in December it is a year.
 * Computed per call so the ladder puts it where it actually belongs today,
 * which is also why it may collapse onto a neighbouring rung (a mid-year `ytd`
 * and `1y`… are close but not equal; an early-April `ytd` and `3m` are).
 */
export function periodSpanDays(period: TimePeriod, now: Date = new Date()): number {
  switch (period) {
    case "1d":
      return 1;
    case "5d":
      return 5;
    case "1m":
      return 30;
    case "3m":
      return 90;
    case "ytd": {
      const start = Date.UTC(now.getUTCFullYear(), 0, 1);
      return Math.max(1, Math.round((now.getTime() - start) / 86_400_000));
    }
    case "1y":
      return 365;
    case "5y":
      return 1825;
    case "max":
      return Number.POSITIVE_INFINITY;
  }
}

/** The windows this bar interval can legally cover, as ladder steps. */
export function ladderSteps(interval: BarInterval, now?: Date): LadderStep<TimePeriod>[] {
  return INTERVAL_VALID_RANGES[interval].map((period) => ({
    period,
    spanDays: periodSpanDays(period, now),
  }));
}

/** How long a requested extend may stay in flight before the lock is dropped. */
const PENDING_TIMEOUT_MS = 8000;

export interface AutoExtendOptions {
  symbol: string | null;
  /** The window the user picked. Never written to. */
  period: TimePeriod;
  interval: BarInterval;
  /** Bars currently on the chart. */
  barCount: number;
  /** A fetch is in flight — hold off asking for anything else. */
  isLoading: boolean;
  /** Set false to pin the chart to the user's window (paused/minimized panels). */
  enabled?: boolean;
  /**
   * Warm a window into the caller's cache without displaying it.
   *
   * Called with the rung above whatever is loaded, once the chart settles and
   * again as the viewport approaches the oldest bar. When the extend finally
   * fires, the data is already there and the chart swaps buffers rather than
   * waiting on a request — the reason zooming out feels instant instead of
   * looking like it stalled.
   */
  onPrefetch?: (period: TimePeriod) => void;
}

export interface AutoExtendState {
  /** The window to actually fetch — the user's, or a wider one. */
  effectivePeriod: TimePeriod;
  /** Feed every viewport reading here; the hook decides whether to widen. */
  onLogicalRange: (range: LogicalRange) => void;
  /** True once the widest window this interval supports is loaded. */
  atMaxHistory: boolean;
  /** True while the chart is showing more than the user asked for. */
  extended: boolean;
  /**
   * Identity of the user's own choice. Unchanged by an auto-extend, so the
   * chart can tell "same view, more bars" (keep the viewport) from "different
   * thing entirely" (fit to content).
   */
  viewportKey: string;
}

export function useAutoExtendRange({
  symbol,
  period,
  interval,
  barCount,
  isLoading,
  enabled = true,
  onPrefetch,
}: AutoExtendOptions): AutoExtendState {
  const [extendedPeriod, setExtendedPeriod] = useState<TimePeriod | null>(null);

  /**
   * An extend that has been asked for but whose bars have not arrived.
   *
   * `isLoading` cannot carry this on its own: it is fed back from the query
   * through an effect, so for a frame or two after the request the hook still
   * believes nothing is in flight — long enough for the rest of one wheel
   * gesture to queue further jumps, each of which refetches and rebuilds the
   * chart. Held until the bar count actually moves.
   */
  const pendingRef = useRef<{ period: TimePeriod; barCountAt: number } | null>(null);

  const prefetchRef = useRef(onPrefetch);
  prefetchRef.current = onPrefetch;
  /** Window already warmed for this (symbol, interval) — never warm it twice. */
  const warmedRef = useRef<string | null>(null);

  // Identity of what the USER asked for. An auto-extend leaves it alone.
  const viewportKey = `${symbol ?? "-"}|${period}|${interval}`;

  // A new symbol, interval or hand-picked period abandons the climb: the user
  // asked for a specific window and should get it, not the widest one they
  // happened to reach on the previous symbol.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the user's choice, deliberately not on the extended window
  useEffect(() => {
    pendingRef.current = null;
    warmedRef.current = null;
    setExtendedPeriod(null);
  }, [viewportKey]);

  // The requested history landed (or the window turned out to hold the same
  // bars, which is just as final) — the next gesture may ask for more.
  useEffect(() => {
    if (pendingRef.current && barCount !== pendingRef.current.barCountAt) {
      pendingRef.current = null;
    }
  }, [barCount]);

  const effectivePeriod = extendedPeriod ?? period;
  const atMaxHistory = nextWider(buildLadder(ladderSteps(interval)), effectivePeriod) === null;

  /**
   * Keep one window ahead, always.
   *
   * Runs when the chart settles on a window rather than when the user
   * approaches the edge, so even the first zoom-out of a session finds its data
   * already cached. Deferred to idle time: the point is to be ready for the
   * next gesture, never to compete with the one in progress.
   */
  useEffect(() => {
    if (!enabled || !symbol || barCount <= 0) return;
    const ahead = planPrefetch({ current: effectivePeriod, steps: ladderSteps(interval) });
    if (!ahead) return;
    const key = `${symbol}|${interval}|${ahead}`;
    if (warmedRef.current === key) return;
    warmedRef.current = key;

    const run = () => prefetchRef.current?.(ahead);
    const idle = typeof requestIdleCallback === "function";
    const handle = idle ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 300);
    return () => {
      if (idle) cancelIdleCallback(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
  }, [enabled, symbol, interval, effectivePeriod, barCount]);

  // Read inside the callback so a stale closure cannot fire a request against
  // last render's window (the callback is handed to a chart subscription that
  // outlives individual renders).
  const stateRef = useRef({ symbol, effectivePeriod, interval, barCount, isLoading, enabled });
  stateRef.current = { symbol, effectivePeriod, interval, barCount, isLoading, enabled };

  const onLogicalRange = useCallback((range: LogicalRange) => {
    const s = stateRef.current;
    if (!s.enabled || s.isLoading || pendingRef.current) return;

    const steps = ladderSteps(s.interval);
    const sample = { range, barCount: s.barCount };

    const next = planExtend({ sample, current: s.effectivePeriod, steps });
    if (!next || next === s.effectivePeriod) {
      // Not extending yet — but if the edge is coming up, start loading what
      // would be needed. This is the case the settle-time prefetch cannot
      // cover: a viewport that has grown far wider than the window it sits in
      // wants a rung further out than "one ahead".
      const warm = planPrefetch({ sample, current: s.effectivePeriod, steps });
      if (warm) {
        const key = `${s.symbol ?? "-"}|${s.interval}|${warm}`;
        if (warmedRef.current !== key) {
          warmedRef.current = key;
          prefetchRef.current?.(warm);
        }
      }
      return;
    }

    // Written through the ref too: the fetch this triggers has not started yet,
    // so `isLoading` is still false and the next range event of the same wheel
    // gesture would otherwise plan the same jump again.
    pendingRef.current = { period: next, barCountAt: s.barCount };
    stateRef.current = { ...s, effectivePeriod: next };
    setExtendedPeriod(next);

    // Safety valve: a failed request never changes the bar count, and without
    // this the chart would be locked out of extending for the rest of the
    // session on one network blip.
    const stale = pendingRef.current;
    setTimeout(() => {
      if (pendingRef.current === stale) pendingRef.current = null;
    }, PENDING_TIMEOUT_MS);
  }, []);

  return {
    effectivePeriod,
    onLogicalRange,
    atMaxHistory,
    extended: extendedPeriod !== null && extendedPeriod !== period,
    viewportKey,
  };
}
