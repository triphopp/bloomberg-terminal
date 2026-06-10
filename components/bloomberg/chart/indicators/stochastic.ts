/**
 * Stochastic Oscillator Indicator
 *
 * Pane indicator. %K and %D lines, bounded 0–100.
 * Default: kPeriod=14, dPeriod=3, smooth=3
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";
import { calcSMA } from "./sma";

function calcStochastic(
  data: OhlcvBar[],
  kPeriod: number,
  dPeriod: number,
  smooth: number
): { k: (number | null)[]; d: (number | null)[] } {
  const rawK: (number | null)[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < kPeriod - 1) {
      rawK.push(null);
      continue;
    }
    const slice = data.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(d => d.high));
    const low = Math.min(...slice.map(d => d.low));
    const range = high - low;
    rawK.push(range === 0 ? 50 : ((data[i].close - low) / range) * 100);
  }

  // Smooth %K with SMA
  const rawKValues = rawK.filter(v => v != null) as number[];
  const smoothedK = calcSMA(rawKValues, smooth);

  // Align smoothed K back
  const kLine: (number | null)[] = new Array(data.length).fill(null);
  let ki = 0;
  for (let i = 0; i < data.length; i++) {
    if (rawK[i] != null) {
      kLine[i] = smoothedK[ki] ?? null;
      ki++;
    }
  }

  // %D = SMA of %K
  const kValues = kLine.filter(v => v != null) as number[];
  const dValues = calcSMA(kValues, dPeriod);

  const dLine: (number | null)[] = new Array(data.length).fill(null);
  let di = 0;
  for (let i = 0; i < data.length; i++) {
    if (kLine[i] != null) {
      dLine[i] = dValues[di] ?? null;
      di++;
    }
  }

  return { k: kLine, d: dLine };
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
      { key: "kPeriod", label: "%K Period", type: "number", default: kPeriod, min: 2, max: 100, step: 1 },
      { key: "dPeriod", label: "%D Period", type: "number", default: dPeriod, min: 2, max: 50, step: 1 },
      { key: "smooth", label: "Smooth", type: "number", default: smooth, min: 1, max: 10, step: 1 },
    ],
    config: { kPeriod, dPeriod, smooth },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const kp = config.kPeriod as number;
      const dp = config.dPeriod as number;
      const sm = config.smooth as number;

      const { k, d } = calcStochastic(data, kp, dp, sm);

      return [
        {
          id: "stoch-k",
          label: "%K",
          type: "line",
          color: "#2196f3",
          lineWidth: 1,
          data: data
            .map((bar, i) => ({ time: bar.time, value: k[i]! }))
            .filter(pt => pt.value != null),
          priceScaleId: "stoch",
        },
        {
          id: "stoch-d",
          label: "%D",
          type: "line",
          color: "#ff9800",
          lineWidth: 1,
          data: data
            .map((bar, i) => ({ time: bar.time, value: d[i]! }))
            .filter(pt => pt.value != null),
          priceScaleId: "stoch",
        },
      ];
    },
  };

  return indicator;
};
