/**
 * Realized Volatility (RV) — Pane indicator
 *
 * Three annualised RV lines at once (default 5 / 21 / 63 bars ≈ 1 week, 1
 * month, 1 quarter of sessions). Reading them together is the point: the
 * short window is what the market is doing NOW, the long one is the regime,
 * and the gap between them is the term structure.
 *
 *   fast above slow   → vol expansion, realized term structure inverted
 *   fast below slow   → vol compression, the usual state
 *
 * Values are in annualised percent, directly comparable with an option's
 * implied vol: RV(21) = 18 means the last month of moves, annualised, was 18%.
 * Set a window to 0 to hide that line.
 *
 * Estimator is selectable (see rv-core.ts for what each one does). Default is
 * Yang-Zhang because daily equity bars gap overnight, and every estimator
 * except cc and yz ignores gaps entirely.
 */

import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory, SeriesColumns } from "../types";
import {
  RV_ESTIMATOR_OPTIONS,
  RV_ESTIMATOR_SHORT,
  type RvEstimator,
  periodsPerYear,
  realizedVol,
} from "./rv-core.ts";

const LINE_COLORS = ["#26c6da", "#ffa726", "#ab47bc"]; // fast, slow, long

function normEstimator(v: unknown): RvEstimator {
  const s = String(v ?? "yz") as RvEstimator;
  return RV_ESTIMATOR_SHORT[s] ? s : "yz";
}

export const createRealizedVol: IndicatorFactory = (overrides = {}) => {
  const fast = (overrides.fast as number) ?? 5;
  const slow = (overrides.slow as number) ?? 21;
  const long = (overrides.long as number) ?? 63;
  const estimator = normEstimator(overrides.estimator);

  const windowLabel = [fast, slow, long].filter((w) => w >= 2).join("/");

  const indicator: ChartIndicator = {
    id: `realized-vol-${estimator}-${fast}-${slow}-${long}`,
    name: `RV ${windowLabel} ${RV_ESTIMATOR_SHORT[estimator]}`,
    category: "volatility",
    type: "pane",
    description: `Annualised realized volatility, ${RV_ESTIMATOR_SHORT[estimator]} estimator`,
    minBars: Math.max(2, fast),
    params: [
      { key: "fast", label: "Fast", type: "number", default: fast, min: 0, max: 250, step: 1 },
      { key: "slow", label: "Slow", type: "number", default: slow, min: 0, max: 250, step: 1 },
      { key: "long", label: "Long", type: "number", default: long, min: 0, max: 500, step: 1 },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: estimator,
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    config: { fast, slow, long, estimator },

    ...columnar((bars, config) => {
      const est = normEstimator(config.estimator);
      const windows = [config.fast as number, config.slow as number, config.long as number];
      const ppy = periodsPerYear(bars);
      const scaleId = `realized-vol-${est}`;

      const series: SeriesColumns[] = [];
      windows.forEach((period, idx) => {
        if (!Number.isFinite(period) || period < 2) return; // 0 = line disabled
        series.push({
          id: `${scaleId}-${Math.round(period)}`,
          label: `RV ${Math.round(period)}`,
          type: "line",
          color: LINE_COLORS[idx],
          lineWidth: idx === 0 ? 1 : 2,
          values: realizedVol(bars, Math.round(period), est, ppy),
          from: 0,
          emit: "valued",
          priceScaleId: scaleId,
        });
      });

      return series;
    }),
    // Not `causal`: the annualisation factor is inferred from the first 200
    // bar gaps, so on a short history a new bar can rescale every point.
  };

  return indicator;
};
