/**
 * RV Percentile Rank — Pane indicator
 *
 * Where today's realized vol sits inside its own trailing distribution, as a
 * 0–100 percentile over `lookback` bars (default 252 ≈ one year).
 *
 * RV in raw percent is not comparable across symbols — 20% annualised is a
 * sleepy day for a small cap and a crisis for a utility. The rank normalises
 * that away: 5 means "calmer than almost all of the past year", 95 means the
 * opposite, for any symbol.
 *
 * Colour zones: cyan ≤20 (compressed — expansion risk), grey mid, orange ≥80,
 * red ≥95 (stretched — mean-reversion risk). Like a Bollinger squeeze, a low
 * rank says a move is coming, not which way.
 */

import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
  SeriesDataPoint,
} from "../types";
import {
  RV_ESTIMATOR_OPTIONS,
  RV_ESTIMATOR_SHORT,
  type RvEstimator,
  calcRealizedVol,
  inferPeriodsPerYear,
  rollingPercentRank,
} from "./rv-core";

/** Below this many prior observations a percentile is meaningless, so plot nothing. */
const MIN_RANK_OBS = 30;

const LOW_ZONE = 20;
const HIGH_ZONE = 80;
const EXTREME_ZONE = 95;

function normEstimator(v: unknown): RvEstimator {
  const s = String(v ?? "yz") as RvEstimator;
  return RV_ESTIMATOR_SHORT[s] ? s : "yz";
}

function zoneColor(rank: number): string {
  if (rank >= EXTREME_ZONE) return "#ef5350";
  if (rank >= HIGH_ZONE) return "#ff9800";
  if (rank <= LOW_ZONE) return "#26c6da";
  return "rgba(120,144,156,0.45)";
}

export const createRVRank: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 21;
  const lookback = (overrides.lookback as number) ?? 252;
  const estimator = normEstimator(overrides.estimator);

  const indicator: ChartIndicator = {
    id: `rv-rank-${estimator}-${period}-${lookback}`,
    name: `RV Rank ${period}/${lookback}`,
    category: "volatility",
    type: "pane",
    description: `Percentile of RV(${period}) within its trailing ${lookback} bars — cyan ≤${LOW_ZONE} compressed, red ≥${EXTREME_ZONE} stretched`,
    minBars: period + MIN_RANK_OBS,
    params: [
      { key: "period", label: "RV window", type: "number", default: period, min: 2, max: 250 },
      {
        key: "lookback",
        label: "Rank lookback",
        type: "number",
        default: lookback,
        min: 30,
        max: 1250,
        step: 10,
      },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: estimator,
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    config: { period, lookback, estimator },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = Math.round(config.period as number);
      const lb = Math.round(config.lookback as number);
      const est = normEstimator(config.estimator);
      const scaleId = `rv-rank-${est}-${p}`;

      const rv = calcRealizedVol(data, p, est, inferPeriodsPerYear(data));
      const ranks = rollingPercentRank(rv, lb, MIN_RANK_OBS);

      const bars: HistogramDataPoint[] = [];
      const midline: SeriesDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const r = ranks[i];
        if (r == null) continue;
        bars.push({ time: data[i].time, value: r, color: zoneColor(r) });
        midline.push({ time: data[i].time, value: 50 });
      }

      return [
        {
          id: `${scaleId}-hist`,
          label: `RV Rank ${p}`,
          type: "histogram",
          data: bars,
          priceScaleId: scaleId,
        },
        {
          id: `${scaleId}-mid`,
          label: "Median",
          type: "line",
          color: "rgba(158,158,158,0.5)",
          lineWidth: 1,
          data: midline,
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
