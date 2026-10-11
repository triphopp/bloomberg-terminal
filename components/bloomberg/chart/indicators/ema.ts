/**
 * EMA (Exponential Moving Average) Indicator
 *
 * Overlay indicator that draws a smoothed price line.
 * Configurable period (default 20).
 */

import { boxed, ema } from "../kernels.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

// ── Pure EMA calculation ─────────────────────────────────────────────────────

/** Boxed form of `ema()` (kernels.ts): `null` during warm-up. */
export function calcEMA(values: number[], period: number): (number | null)[] {
  return boxed(ema(values, period), emaStart(values.length, period));
}

/** First index an EMA of `period` has a value at; `n` when it never does. */
export function emaStart(n: number, period: number, start = 0): number {
  return period >= 1 && n - start >= period ? start + period - 1 : n;
}

// ── Default colors per period ────────────────────────────────────────────────

const PERIOD_COLORS: Record<number, string> = {
  9: "#e91e63",
  12: "#ff5722",
  20: "#ffc107",
  21: "#ffc107",
  26: "#ff9800",
  50: "#2196f3",
  100: "#9c27b0",
  200: "#f44336",
};

function getColor(period: number): string {
  return PERIOD_COLORS[period] ?? "#ffc107";
}

// ── Factory ──────────────────────────────────────────────────────────────────

export const createEMA: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const color = (overrides.color as string) ?? getColor(period);

  const indicator: ChartIndicator = {
    id: `ema-${period}`,
    name: `EMA ${period}`,
    category: "trend",
    type: "overlay",
    description: `${period}-period Exponential Moving Average`,
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
          { value: "#ffc107", label: "Gold" },
          { value: "#2196f3", label: "Blue" },
          { value: "#e91e63", label: "Pink" },
          { value: "#9c27b0", label: "Purple" },
          { value: "#4caf50", label: "Green" },
          { value: "#ff5722", label: "Orange" },
          { value: "#f44336", label: "Red" },
        ],
      },
    ],
    config: { period, color },

    ...columnar((bars, config) => {
      const p = config.period as number;
      const c = config.color as string;
      return [
        {
          id: `ema-${p}-line`,
          label: `EMA ${p}`,
          type: "line",
          color: c,
          lineWidth: 1,
          values: ema(bars.close, p),
          from: emaStart(bars.length, p),
          emit: "all",
        },
      ];
    }),
    causal: true,
  };

  return indicator;
};
