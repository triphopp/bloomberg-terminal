/**
 * EMA (Exponential Moving Average) Indicator
 *
 * Overlay indicator that draws a smoothed price line.
 * Configurable period (default 20).
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";

// ── Pure EMA calculation ─────────────────────────────────────────────────────

export function calcEMA(values: number[], period: number): (number | null)[] {
  if (values.length < period) return new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(period - 1).fill(null);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ── Default colors per period ────────────────────────────────────────────────

const PERIOD_COLORS: Record<number, string> = {
  9:   "#e91e63",
  12:  "#ff5722",
  20:  "#ffc107",
  21:  "#ffc107",
  26:  "#ff9800",
  50:  "#2196f3",
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
      { key: "period", label: "Period", type: "number", default: period, min: 2, max: 500, step: 1 },
      { key: "color", label: "Color", type: "select", default: color, options: [
        { value: "#ffc107", label: "Gold" },
        { value: "#2196f3", label: "Blue" },
        { value: "#e91e63", label: "Pink" },
        { value: "#9c27b0", label: "Purple" },
        { value: "#4caf50", label: "Green" },
        { value: "#ff5722", label: "Orange" },
        { value: "#f44336", label: "Red" },
      ]},
    ],
    config: { period, color },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const c = config.color as string;
      const closes = data.map(d => d.close);
      const emaValues = calcEMA(closes, p);

      return [{
        id: `ema-${p}-line`,
        label: `EMA ${p}`,
        type: "line",
        color: c,
        lineWidth: 1,
        data: data
          .map((d, i) => ({ time: d.time, value: emaValues[i]! }))
          .filter(d => d.value != null),
      }];
    },
  };

  return indicator;
};
