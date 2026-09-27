/**
 * SMA (Simple Moving Average) Indicator
 */

import { rollingMean } from "../rolling.ts";
import type { ChartIndicator, IndicatorFactory, IndicatorSeriesOutput, OhlcvBar } from "../types";

/** Null during warm-up; NaN where the window holds a NaN (as the plain loop gave). */
export function calcSMA(values: number[], period: number): (number | null)[] {
  const mean = rollingMean(values, period);
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = i < period - 1 ? null : mean[i];
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
      {
        key: "period",
        label: "Period",
        type: "number",
        default: period,
        min: 2,
        max: 500,
        step: 1,
      },
      {
        key: "color",
        label: "Color",
        type: "select",
        default: color,
        options: [
          { value: "#00bcd4", label: "Cyan" },
          { value: "#ffc107", label: "Gold" },
          { value: "#2196f3", label: "Blue" },
          { value: "#e91e63", label: "Pink" },
          { value: "#4caf50", label: "Green" },
        ],
      },
    ],
    config: { period, color },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const c = config.color as string;
      const closes = data.map((d) => d.close);
      const smaValues = calcSMA(closes, p);

      return [
        {
          id: `sma-${p}-line`,
          label: `SMA ${p}`,
          type: "line",
          color: c,
          lineWidth: 1,
          data: data.flatMap((d, i) => {
            const v = smaValues[i];
            return v == null ? [] : [{ time: d.time, value: v }];
          }),
        },
      ];
    },
  };

  return indicator;
};
