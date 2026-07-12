/**
 * RVOL (Relative Volume) — Pane indicator
 *
 * Answers "is today's participation abnormal?" — the context filter that
 * every other volume-based read (VP, POC, breakouts) should be weighted by.
 *
 * Daily bars:    RVOL = volume / SMA(volume, lookback) of the PRIOR bars
 *                (current bar excluded so it can't dilute its own baseline).
 * Intraday bars: RVOL = volume / mean volume of bars at the SAME time-of-day
 *                over the prior `lookback` sessions. Comparing 10:05 to other
 *                10:05s matters because intraday volume is U-shaped — a raw
 *                rolling average would flag every open as "abnormal".
 *
 * Histogram coloring: <1 dim, 1–2 normal, ≥2 highlighted (abnormal).
 */

import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "../types";

function timeOfDayKey(unixSec: number): number {
  return unixSec % 86_400;
}

function calcRVOL(data: OhlcvBar[], lookback: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length === 0) return result;

  const isIntraday = typeof data[0].time === "number";

  if (!isIntraday) {
    // Daily/weekly: trailing mean of prior `lookback` volumes
    for (let i = 0; i < data.length; i++) {
      const vol = data[i].volume ?? 0;
      if (vol <= 0) continue;
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        const v = data[j].volume ?? 0;
        if (v > 0) {
          sum += v;
          n++;
        }
      }
      if (n >= Math.min(5, lookback)) result[i] = vol / (sum / n);
    }
    return result;
  }

  // Intraday: baseline = mean volume at the same time-of-day over prior sessions.
  // Track per-slot history; only the most recent `lookback` entries count.
  const history = new Map<number, number[]>();
  for (let i = 0; i < data.length; i++) {
    const t = data[i].time as number;
    const key = timeOfDayKey(t);
    const vol = data[i].volume ?? 0;
    const hist = history.get(key);
    if (hist && hist.length >= 3 && vol > 0) {
      const window = hist.slice(-lookback);
      const mean = window.reduce((s, v) => s + v, 0) / window.length;
      if (mean > 0) result[i] = vol / mean;
    }
    if (vol > 0) {
      if (hist) hist.push(vol);
      else history.set(key, [vol]);
    }
  }
  return result;
}

export const createRVOL: IndicatorFactory = (overrides = {}) => {
  const lookback = (overrides.lookback as number) ?? 20;

  const indicator: ChartIndicator = {
    id: `rvol-${lookback}`,
    name: `RVOL ${lookback}`,
    category: "volume",
    type: "pane",
    description: "Relative Volume vs same time-of-day baseline (≥2 = abnormal participation)",
    minBars: 10,
    params: [
      {
        key: "lookback",
        label: "Lookback",
        type: "number",
        default: lookback,
        min: 5,
        max: 60,
        step: 1,
      },
    ],
    config: { lookback },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const lb = config.lookback as number;
      const rvol = calcRVOL(data, lb);

      const points: HistogramDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = rvol[i];
        if (v == null) continue;
        let color: string;
        if (v >= 2)
          color = "#ff9800"; // abnormal — pay attention
        else if (v >= 1)
          color = "#2196f3"; // above average
        else color = "rgba(120,120,120,0.45)"; // quiet
        points.push({ time: data[i].time, value: v, color });
      }

      return [
        {
          id: "rvol-hist",
          label: "RVOL",
          type: "histogram",
          data: points,
        },
      ];
    },
  };

  return indicator;
};
