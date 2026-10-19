"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BarInterval, TimePeriod } from "./types";
import { INTERVAL_DEFAULT_RANGE, INTERVAL_VALID_RANGES } from "./types.ts";

export const TIME_PERIODS: TimePeriod[] = ["1d", "5d", "1m", "3m", "ytd", "1y", "5y", "max"];
export const BAR_INTERVALS: BarInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
  "1wk",
];

export const PERIOD_LABEL: Record<TimePeriod, string> = {
  "1d": "1D",
  "5d": "5D",
  "1m": "1M",
  "3m": "3M",
  ytd: "YTD",
  "1y": "1Y",
  "5y": "5Y",
  max: "MAX",
};

export const INTERVAL_LABEL: Record<BarInterval, string> = {
  "1m": "1M",
  "5m": "5M",
  "15m": "15M",
  "30m": "30M",
  "1h": "1H",
  "2h": "2H",
  "4h": "4H",
  "1d": "1D",
  "1wk": "1W",
};

/** yfinance period string for each TimePeriod */
export const PERIOD_TO_YF: Record<TimePeriod, string> = {
  "1d": "1d",
  "5d": "5d",
  "1m": "1mo",
  "3m": "3mo",
  ytd: "ytd",
  "1y": "1y",
  "5y": "5y",
  max: "max",
};

export interface ChartTimeframeOptions {
  defaultPeriod?: TimePeriod;
  defaultInterval?: BarInterval;
  /** localStorage key — when set, the timeframe survives a view switch and a reload. */
  storageKey?: string;
}

interface StoredTimeframe {
  timePeriod: TimePeriod;
  barInterval: BarInterval;
  handPeriod: TimePeriod;
}

function readStoredTimeframe(key: string | undefined): StoredTimeframe | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredTimeframe>;
    const p = v.timePeriod;
    const iv = v.barInterval;
    if (!p || !iv || !TIME_PERIODS.includes(p) || !BAR_INTERVALS.includes(iv)) return null;
    // A stored pair that the rules no longer allow is repaired, not trusted.
    const legal = applyInterval(iv, p);
    const hand =
      v.handPeriod && TIME_PERIODS.includes(v.handPeriod) ? v.handPeriod : legal.timePeriod;
    return { ...legal, handPeriod: hand };
  } catch {
    return null;
  }
}

/**
 * Period picked → the (period, interval) pair that is actually legal.
 *
 * Not every interval covers every range (1-minute bars over MAX would be
 * millions of them), so choosing a period may have to move the interval too.
 * Pure and exported so a component that stores its timeframe outside React
 * state — a chart window persisting it — applies the same rules the hook does.
 */
export function applyPeriod(
  p: TimePeriod,
  barInterval: BarInterval,
  chartType: "area" | "candle" = "candle"
): { timePeriod: TimePeriod; barInterval: BarInterval } {
  if (chartType !== "candle") return { timePeriod: p, barInterval };

  const validIntervals = (Object.entries(INTERVAL_VALID_RANGES) as [BarInterval, TimePeriod[]][])
    .filter(([, ranges]) => ranges.includes(p))
    .map(([iv]) => iv);
  if (validIntervals.includes(barInterval)) return { timePeriod: p, barInterval };

  const fallback: BarInterval =
    p === "max" ? "1wk" : p === "5y" || p === "1y" || p === "ytd" ? "1d" : p === "5d" ? "1h" : "1d";
  return { timePeriod: p, barInterval: fallback };
}

/**
 * Interval picked → the legal (period, interval) pair. Mirror of applyPeriod.
 *
 * `preferred` is the period the user last picked BY HAND. An interval that
 * cannot show the current period forces one (1W → MAX), and without this the
 * forced period stuck: 1D → 1W → 1D left a 3M chart on MAX, pulling decades
 * of daily bars. The hand-picked period comes back as soon as the interval
 * allows it.
 */
export function applyInterval(
  iv: BarInterval,
  timePeriod: TimePeriod,
  preferred?: TimePeriod
): { timePeriod: TimePeriod; barInterval: BarInterval } {
  const valid = INTERVAL_VALID_RANGES[iv];
  return {
    barInterval: iv,
    timePeriod:
      preferred && valid.includes(preferred)
        ? preferred
        : valid.includes(timePeriod)
          ? timePeriod
          : INTERVAL_DEFAULT_RANGE[iv],
  };
}

export function useChartTimeframe(options?: ChartTimeframeOptions) {
  const storageKey = options?.storageKey;
  const [stored] = useState(() => readStoredTimeframe(storageKey));
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(
    stored?.timePeriod ?? options?.defaultPeriod ?? "1y"
  );
  const [barInterval, setBarInterval] = useState<BarInterval>(
    stored?.barInterval ?? options?.defaultInterval ?? "1d"
  );
  // Last period chosen by hand — survives an interval forcing another one.
  const handPeriodRef = useRef<TimePeriod>(stored?.handPeriod ?? options?.defaultPeriod ?? "1y");

  useEffect(() => {
    if (!storageKey) return;
    try {
      const v: StoredTimeframe = { timePeriod, barInterval, handPeriod: handPeriodRef.current };
      localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      /* storage full / blocked — the timeframe just isn't remembered */
    }
  }, [storageKey, timePeriod, barInterval]);

  const handlePeriodChange = useCallback(
    (p: TimePeriod, chartType: "area" | "candle" = "candle") => {
      handPeriodRef.current = p;
      setTimePeriod(p);
      setBarInterval((prev) => applyPeriod(p, prev, chartType).barInterval);
    },
    []
  );

  const handleIntervalChange = useCallback((iv: BarInterval) => {
    setBarInterval(iv);
    setTimePeriod((prev) => applyInterval(iv, prev, handPeriodRef.current).timePeriod);
  }, []);

  const isIntraday = !["1d", "1wk"].includes(barInterval);

  return {
    timePeriod,
    barInterval,
    isIntraday,
    handlePeriodChange,
    handleIntervalChange,
  };
}
