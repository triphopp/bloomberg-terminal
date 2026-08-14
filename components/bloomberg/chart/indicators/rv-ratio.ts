/**
 * RV Term-Structure Ratio — Pane indicator
 *
 * RV(fast) / RV(slow), default 5 / 21. The realized analogue of a VIX term
 * structure, and cheaper to read than two RV lines because the whole signal is
 * one number against 1.0:
 *
 *   ratio ≫ 1  short-term vol above the regime — a shock is in progress; late
 *              to chase, and short-vol positions are already hurting
 *   ratio ≈ 1  vol is where it has been
 *   ratio ≪ 1  short-term vol collapsed below the regime — coiled; the classic
 *              precondition for an expansion, direction unknown
 *
 * Bars are coloured against the two thresholds and a flat 1.0 reference line is
 * drawn. Because both legs use the same estimator and the same annualisation,
 * the ratio is unit-free — comparable across symbols and timeframes.
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
} from "./rv-core";

function normEstimator(v: unknown): RvEstimator {
  const s = String(v ?? "yz") as RvEstimator;
  return RV_ESTIMATOR_SHORT[s] ? s : "yz";
}

export const createRVRatio: IndicatorFactory = (overrides = {}) => {
  const fast = (overrides.fast as number) ?? 5;
  const slow = (overrides.slow as number) ?? 21;
  const expansion = (overrides.expansion as number) ?? 1.3;
  const compression = (overrides.compression as number) ?? 0.7;
  const estimator = normEstimator(overrides.estimator);

  const indicator: ChartIndicator = {
    id: `rv-ratio-${estimator}-${fast}-${slow}`,
    name: `RV Ratio ${fast}/${slow}`,
    category: "volatility",
    type: "pane",
    description: `RV(${fast})/RV(${slow}) realized term structure — orange ≥ expansion, cyan ≤ compression`,
    minBars: Math.max(fast, slow),
    params: [
      { key: "fast", label: "Fast", type: "number", default: fast, min: 2, max: 250, step: 1 },
      { key: "slow", label: "Slow", type: "number", default: slow, min: 2, max: 500, step: 1 },
      {
        key: "expansion",
        label: "Expansion ≥",
        type: "number",
        default: expansion,
        min: 1,
        max: 4,
        step: 0.1,
      },
      {
        key: "compression",
        label: "Compression ≤",
        type: "number",
        default: compression,
        min: 0.1,
        max: 1,
        step: 0.05,
      },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: estimator,
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    config: { fast, slow, expansion, compression, estimator },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const f = Math.round(config.fast as number);
      const s = Math.round(config.slow as number);
      const hi = config.expansion as number;
      const lo = config.compression as number;
      const est = normEstimator(config.estimator);
      const scaleId = `rv-ratio-${est}-${f}-${s}`;

      const ppy = inferPeriodsPerYear(data);
      const rvFast = calcRealizedVol(data, f, est, ppy);
      const rvSlow = calcRealizedVol(data, s, est, ppy);

      const bars: HistogramDataPoint[] = [];
      const refLine: SeriesDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const a = rvFast[i];
        const b = rvSlow[i];
        if (a == null || b == null || b === 0) continue;
        const ratio = a / b;
        const color = ratio >= hi ? "#ff9800" : ratio <= lo ? "#26c6da" : "rgba(120,144,156,0.45)";
        bars.push({ time: data[i].time, value: ratio, color });
        refLine.push({ time: data[i].time, value: 1 });
      }

      return [
        {
          id: `${scaleId}-hist`,
          label: `RV ${f}/${s}`,
          type: "histogram",
          data: bars,
          priceScaleId: scaleId,
        },
        {
          id: `${scaleId}-ref`,
          label: "1.0",
          type: "line",
          color: "rgba(158,158,158,0.5)",
          lineWidth: 1,
          data: refLine,
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
