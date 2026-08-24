"use client";

import { useCallback, useState } from "react";
import type { BarInterval, TimePeriod } from "./types";
import { INTERVAL_DEFAULT_RANGE, INTERVAL_VALID_RANGES } from "./types";

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

/** Interval picked → the legal (period, interval) pair. Mirror of applyPeriod. */
export function applyInterval(
  iv: BarInterval,
  timePeriod: TimePeriod
): { timePeriod: TimePeriod; barInterval: BarInterval } {
  return {
    barInterval: iv,
    timePeriod: INTERVAL_VALID_RANGES[iv].includes(timePeriod)
      ? timePeriod
      : INTERVAL_DEFAULT_RANGE[iv],
  };
}

export function useChartTimeframe(options?: ChartTimeframeOptions) {
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(options?.defaultPeriod ?? "1y");
  const [barInterval, setBarInterval] = useState<BarInterval>(options?.defaultInterval ?? "1d");

  const handlePeriodChange = useCallback(
    (p: TimePeriod, chartType: "area" | "candle" = "candle") => {
      setTimePeriod(p);
      setBarInterval((prev) => applyPeriod(p, prev, chartType).barInterval);
    },
    []
  );

  const handleIntervalChange = useCallback((iv: BarInterval) => {
    setBarInterval(iv);
    setTimePeriod((prev) => applyInterval(iv, prev).timePeriod);
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
