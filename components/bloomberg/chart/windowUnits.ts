/**
 * Indicator window unit conversion.
 *
 * Every indicator counts its lookback in BARS, but a bar is not a unit of
 * economic time: RSI(14) spans 70 minutes on a 5m chart and three weeks on a
 * daily one. Switching timeframe therefore silently changes what the indicator
 * measures, and readings cannot be compared across timeframes at all.
 *
 * When the user opts into "days" mode, the window they type is interpreted as
 * calendar/session time and converted to a bar count for the interval actually
 * on screen, so the indicator keeps looking at the same slice of history.
 *
 * Minutes are the common unit because interval durations are exact. The one
 * approximation is how many minutes a "day" of bars covers: a 24h market
 * (crypto) trades 1440 minutes a day, while an equity regular session is ~390.
 * Non-US equity sessions differ (SET ~300, Xetra ~510), so treat the converted
 * bar count as close-enough rather than exact.
 */

import type { BarInterval, IndicatorParam } from "./types";

/** Minutes of market time each interval covers. Daily/weekly resolve per-session. */
const INTRADAY_MINUTES: Partial<Record<BarInterval, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
};

/** Minutes traded per day: 24h for crypto, one US regular session otherwise. */
export function sessionMinutesFor(isCrypto: boolean): number {
  return isCrypto ? 1440 : 390;
}

/** How many bars of `interval` fit in one trading day. */
export function barsPerDay(interval: BarInterval, isCrypto: boolean): number {
  const session = sessionMinutesFor(isCrypto);
  const mins = INTRADAY_MINUTES[interval];
  if (mins != null) return session / mins;
  if (interval === "1wk") return 1 / 5;
  return 1; // "1d"
}

/**
 * Convert a window expressed in days into a bar count for `interval`.
 * Rounds to the nearest bar and never returns fewer than 2 — a 1-bar window
 * makes every rolling statistic degenerate.
 */
export function barsForDays(days: number, interval: BarInterval, isCrypto: boolean): number {
  if (!Number.isFinite(days) || days <= 0) return 2;
  return Math.max(2, Math.round(days * barsPerDay(interval, isCrypto)));
}

export type WindowUnit = "bars" | "days";

/**
 * Rewrite the time-measured params of an indicator spec into bar counts.
 *
 * Returns the input untouched in "bars" mode or when the entry declares no
 * scalable params, so non-temporal params (stdDev, thresholds) never move.
 *
 * Registry defaults are filled in for scalable params the user never touched —
 * otherwise a stock RSI would keep its raw 14-bar default while an edited one
 * got converted. Those defaults are calibrated for daily charts, so reading
 * them as days leaves the daily interval behaving exactly as before.
 */
export function scaleParamsToBars(
  params: Record<string, number | boolean | string> | undefined,
  timeScalableParams: string[] | undefined,
  defaultParams: IndicatorParam[],
  unit: WindowUnit,
  interval: BarInterval,
  isCrypto: boolean
): Record<string, number | boolean | string> | undefined {
  if (unit !== "days" || !timeScalableParams?.length) return params;

  const out = { ...(params ?? {}) };
  let changed = false;
  for (const key of timeScalableParams) {
    const v = out[key] ?? defaultParams.find((p) => p.key === key)?.default;
    if (typeof v !== "number") continue;
    out[key] = barsForDays(v, interval, isCrypto);
    changed = true;
  }
  return changed ? out : params;
}
