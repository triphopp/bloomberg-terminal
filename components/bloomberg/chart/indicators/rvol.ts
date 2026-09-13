/**
 * RVOL (Relative Volume) — Pane indicator
 *
 * Answers "is today's participation abnormal?" — the context filter that
 * every other volume-based read (VP, POC, breakouts) should be weighted by.
 *
 * All of the statistics live in lib/volume-stats.ts, which documents why the
 * baseline is a median of ln(volume) rather than a mean of volume, how intraday
 * bars are slotted against the same point in prior sessions, and what the
 * cumulative mode fixes. Three params pick between the readings:
 *
 *   baseline  median (default) | mean
 *             Only affects the ratio. A mean baseline is what the classic RVOL
 *             uses and it is the reason the pane felt uninformative: one
 *             earnings spike raises the baseline for the whole lookback, so the
 *             next spike reads as ordinary. "mean" is kept because a stored
 *             alert rule may have been calibrated against it.
 *
 *   scale     ratio (default) | z
 *             ratio keeps the familiar unit ("2× normal") but is NOT comparable
 *             across symbols — RVOL 2 on a mega-cap and on an illiquid small
 *             cap are different events, because their volume variance differs.
 *             z is a robust log z-score, which is comparable across symbols and
 *             timeframes, and which has a meaningful negative half: a dry-up is
 *             as much an event as a spike, and the ratio squashes it into
 *             0.0-1.0 where the eye cannot see it.
 *
 *   mode      bar (default) | cum
 *             Intraday only. In bar mode the live last bar is partial, so it
 *             reads as quiet until the bar closes. cum compares the session's
 *             volume so far against the same point in prior sessions, so an
 *             open session reads honestly.
 *
 * Histogram colouring, ratio: <1 dim, 1-2 normal, ≥2 highlighted.
 * z: ≥2.5 abnormal, 1.5-2.5 notable, ≤-1 dry-up (its own colour, since a
 * sustained dry-up is the setup a squeeze comes out of), otherwise dim.
 */

import { type VolBaseline, type VolMode, volumeRatio, volumeZ } from "../../lib/volume-stats.ts";
import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "../types";

export const RVOL_BASELINES: { value: VolBaseline; label: string }[] = [
  { value: "median", label: "Median (robust)" },
  { value: "mean", label: "Mean (classic)" },
];

export const RVOL_SCALES: { value: "ratio" | "z"; label: string }[] = [
  { value: "ratio", label: "Ratio (×normal)" },
  { value: "z", label: "Z-score (log)" },
];

export const RVOL_MODES: { value: VolMode; label: string }[] = [
  { value: "bar", label: "Per bar" },
  { value: "cum", label: "Session cumulative" },
];

const DIM = "rgba(120,120,120,0.45)";
const NOTABLE = "#2196f3";
const ABNORMAL = "#ff9800";
/** Dry-up gets its own colour: it is a setup, not a weaker version of a spike. */
const DRY_UP = "#7e57c2";

function ratioColor(v: number): string {
  if (v >= 2) return ABNORMAL;
  if (v >= 1) return NOTABLE;
  return DIM;
}

function zColor(v: number): string {
  if (v >= 2.5) return ABNORMAL;
  if (v >= 1.5) return NOTABLE;
  if (v <= -1) return DRY_UP;
  return DIM;
}

export const createRVOL: IndicatorFactory = (overrides = {}) => {
  const lookback = (overrides.lookback as number) ?? 20;
  const baseline = (overrides.baseline as VolBaseline) ?? "median";
  const scale = (overrides.scale as "ratio" | "z") ?? "ratio";
  const mode = (overrides.mode as VolMode) ?? "bar";

  const indicator: ChartIndicator = {
    // The id carries the scale so switching it re-keys the pane; baseline and
    // mode change the values inside the same reading, not what is being read.
    id: scale === "z" ? `rvol-z-${lookback}` : `rvol-${lookback}`,
    name: scale === "z" ? `VOL Z ${lookback}` : `RVOL ${lookback}`,
    category: "volume",
    type: "pane",
    description:
      scale === "z"
        ? "Robust log-volume z-score vs the same bar in prior sessions (≥2 = abnormal, ≤−1 = dry-up)"
        : "Relative Volume vs same time-of-day baseline (≥2 = abnormal participation)",
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
      { key: "scale", label: "Scale", type: "select", default: scale, options: RVOL_SCALES },
      {
        key: "baseline",
        label: "Baseline",
        type: "select",
        default: baseline,
        options: RVOL_BASELINES,
      },
      { key: "mode", label: "Intraday", type: "select", default: mode, options: RVOL_MODES },
    ],
    config: { lookback, baseline, scale, mode },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const opts = {
        lookback: config.lookback as number,
        baseline: (config.baseline as VolBaseline) ?? "median",
        mode: (config.mode as VolMode) ?? "bar",
      };
      const asZ = ((config.scale as string) ?? "ratio") === "z";
      const series = asZ ? volumeZ(data, opts) : volumeRatio(data, opts);
      const color = asZ ? zColor : ratioColor;

      const points: HistogramDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = series[i];
        if (v == null) continue;
        points.push({ time: data[i].time, value: v, color: color(v) });
      }

      return [
        {
          id: asZ ? "rvol-z-hist" : "rvol-hist",
          label: asZ ? "VOL Z" : "RVOL",
          type: "histogram",
          data: points,
        },
      ];
    },
  };

  return indicator;
};
