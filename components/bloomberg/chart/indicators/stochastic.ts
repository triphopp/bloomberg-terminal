/**
 * Stochastic Oscillator Indicator
 *
 * Pane indicator. %K and %D lines, bounded 0–100.
 * Default: kPeriod=14, dPeriod=3, smooth=3
 */

import type { BarColumns } from "../columns.ts";
import { rollingMax, rollingMean, rollingMin } from "../rolling.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

interface StochasticColumns {
  k: Float64Array;
  d: Float64Array;
  /** First index %K / %D has a value at. */
  kFrom: number;
  dFrom: number;
}

function calcStochastic(
  bars: BarColumns,
  kPeriod: number,
  dPeriod: number,
  smooth: number
): StochasticColumns {
  const n = bars.length;
  const { low, close } = bars;
  const hh = rollingMax(bars.high, kPeriod);
  const ll = rollingMin(low, kPeriod);

  const rawFrom = kPeriod - 1;
  const rawK = new Float64Array(n).fill(Number.NaN, 0, Math.min(Math.max(0, rawFrom), n));
  for (let i = Math.max(0, rawFrom); i < n; i++) {
    const range = hh[i] - ll[i];
    rawK[i] = range === 0 ? 50 : ((close[i] - ll[i]) / range) * 100;
  }

  // Smooth %K with SMA — of the raw line, which begins after its own warm-up
  const kFrom = rawFrom + smooth - 1;
  const k = rollingMean(rawK, smooth, rawFrom);

  // %D = SMA of %K
  const dFrom = kFrom + dPeriod - 1;
  const d = rollingMean(k, dPeriod, kFrom);

  return { k, d, kFrom, dFrom };
}

export const createStochastic: IndicatorFactory = (overrides = {}) => {
  const kPeriod = (overrides.kPeriod as number) ?? 14;
  const dPeriod = (overrides.dPeriod as number) ?? 3;
  const smooth = (overrides.smooth as number) ?? 3;

  const indicator: ChartIndicator = {
    id: `stoch-${kPeriod}-${dPeriod}-${smooth}`,
    name: `Stoch (${kPeriod},${dPeriod},${smooth})`,
    category: "momentum",
    type: "pane",
    description: `Stochastic Oscillator %K(${kPeriod}) %D(${dPeriod})`,
    minBars: kPeriod + dPeriod + smooth,
    params: [
      {
        key: "kPeriod",
        label: "%K Period",
        type: "number",
        default: kPeriod,
        min: 2,
        max: 100,
        step: 1,
      },
      {
        key: "dPeriod",
        label: "%D Period",
        type: "number",
        default: dPeriod,
        min: 2,
        max: 50,
        step: 1,
      },
      { key: "smooth", label: "Smooth", type: "number", default: smooth, min: 1, max: 10, step: 1 },
    ],
    config: { kPeriod, dPeriod, smooth },

    ...columnar((bars, config) => {
      const kp = config.kPeriod as number;
      const dp = config.dPeriod as number;
      const sm = config.smooth as number;

      const { k, d, kFrom, dFrom } = calcStochastic(bars, kp, dp, sm);

      return [
        {
          id: "stoch-k",
          label: "%K",
          type: "line",
          color: "#2196f3",
          lineWidth: 1,
          values: k,
          from: kFrom,
          emit: "all",
          priceScaleId: "stoch",
        },
        {
          id: "stoch-d",
          label: "%D",
          type: "line",
          color: "#ff9800",
          lineWidth: 1,
          values: d,
          from: dFrom,
          emit: "all",
          priceScaleId: "stoch",
        },
      ];
    }),
    causal: true,
  };

  return indicator;
};
