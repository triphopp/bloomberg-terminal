/**
 * SMA (Simple Moving Average) Indicator
 */

import { boxed } from "../kernels.ts";
import { rollingMean } from "../rolling.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

/** Null during warm-up; NaN where the window holds a NaN (as the plain loop gave). */
export function calcSMA(values: number[], period: number): (number | null)[] {
  return boxed(rollingMean(values, period), period - 1);
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

    ...columnar((bars, config) => {
      const p = config.period as number;
      const c = config.color as string;
      return [
        {
          id: `sma-${p}-line`,
          label: `SMA ${p}`,
          type: "line",
          color: c,
          lineWidth: 1,
          values: rollingMean(bars.close, p),
          // Every bar from the first full window on — a window holding a NaN
          // sends a NaN point, as the boxed version did.
          from: p - 1,
          emit: "all",
        },
      ];
    }),
    causal: true,
  };

  return indicator;
};
