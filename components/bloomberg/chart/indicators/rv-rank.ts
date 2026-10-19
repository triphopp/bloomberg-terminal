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

import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";
import {
  RV_ESTIMATOR_OPTIONS,
  RV_ESTIMATOR_SHORT,
  type RvEstimator,
  percentRank,
  periodsPerYear,
  realizedVol,
} from "./rv-core.ts";

/** Below this many prior observations a percentile is meaningless, so plot nothing. */
const MIN_RANK_OBS = 30;

const LOW_ZONE = 20;
const HIGH_ZONE = 80;
const EXTREME_ZONE = 95;

function normEstimator(v: unknown): RvEstimator {
  const s = String(v ?? "yz") as RvEstimator;
  return RV_ESTIMATOR_SHORT[s] ? s : "yz";
}

const ZONE_PALETTE = ["rgba(120,144,156,0.45)", "#26c6da", "#ff9800", "#ef5350"] as const;

/** Index into `ZONE_PALETTE`: mid · compressed · high · extreme. */
function zone(rank: number): number {
  if (rank >= EXTREME_ZONE) return 3;
  if (rank >= HIGH_ZONE) return 2;
  if (rank <= LOW_ZONE) return 1;
  return 0;
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

    ...columnar((bars, config) => {
      const p = Math.round(config.period as number);
      const lb = Math.round(config.lookback as number);
      const est = normEstimator(config.estimator);
      const scaleId = `rv-rank-${est}-${p}`;
      const n = bars.length;

      const rv = realizedVol(bars, p, est, periodsPerYear(bars));
      const ranks = percentRank(rv, lb, MIN_RANK_OBS);

      const zones = new Uint8Array(n);
      const midline = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const r = ranks[i];
        if (Number.isNaN(r)) {
          midline[i] = Number.NaN;
          continue;
        }
        zones[i] = zone(r);
        midline[i] = 50;
      }

      return [
        {
          id: `${scaleId}-hist`,
          label: `RV Rank ${p}`,
          type: "histogram",
          values: ranks,
          from: 0,
          emit: "valued",
          colors: zones,
          palette: ZONE_PALETTE,
          priceScaleId: scaleId,
        },
        {
          id: `${scaleId}-mid`,
          label: "Median",
          type: "line",
          color: "rgba(158,158,158,0.5)",
          lineWidth: 1,
          values: midline,
          from: 0,
          emit: "valued",
          priceScaleId: scaleId,
        },
      ];
    }),
    // Not `causal` — see realized-vol.ts.
  };

  return indicator;
};
