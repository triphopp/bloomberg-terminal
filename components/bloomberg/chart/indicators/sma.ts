/**
 * SMA (Simple Moving Average) Indicator
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";

export function calcSMA(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const slice = values.slice(i - period + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return result;
}

export const createSMA: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const color = (overrides.color as string) ?? "#00bcd4";

  const indicator: ChartIndicator = {
    id: `sma-${period}`,
    name: `SMA ${period}`,
    category: "trend",
    type: "overlay",
    description: `${period}-period Simple Moving Average`,
    minBars: period,
    params: [
      { key: "period", label: "Period", type: "number", default: period, min: 2, max: 500, step: 1 },
      { key: "color", label: "Color", type: "select", default: color, options: [
        { value: "#00bcd4", label: "Cyan" },
        { value: "#ffc107", label: "Gold" },
        { value: "#2196f3", label: "Blue" },
        { value: "#e91e63", label: "Pink" },
        { value: "#4caf50", label: "Green" },
      ]},
    ],
    config: { period, color },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const c = config.color as string;
      const closes = data.map(d => d.close);
      const smaValues = calcSMA(closes, p);

      return [{
        id: `sma-${p}-line`,
        label: `SMA ${p}`,
        type: "line",
        color: c,
        lineWidth: 1,
        data: data
          .map((d, i) => ({ time: d.time, value: smaValues[i]! }))
          .filter(d => d.value != null),
      }];
    },
  };

  return indicator;
};
