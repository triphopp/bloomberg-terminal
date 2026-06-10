/**
 * Bollinger Bands Indicator
 *
 * Overlay indicator: middle band (SMA), upper band (+2σ), lower band (-2σ).
 * Default: period=20, stdDev=2
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";
import { calcSMA } from "./sma";

function calcStdDev(values: number[], period: number, sma: (number | null)[]): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1 || sma[i] == null) {
      result.push(null);
    } else {
      const slice = values.slice(i - period + 1, i + 1);
      const mean = sma[i]!;
      const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
      result.push(Math.sqrt(variance));
    }
  }
  return result;
}

export const createBollingerBands: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;

  const indicator: ChartIndicator = {
    id: `bb-${period}-${stdDev}`,
    name: `BB (${period}, ${stdDev}σ)`,
    category: "volatility",
    type: "overlay",
    description: `Bollinger Bands: ${period} SMA ± ${stdDev} standard deviations`,
    minBars: period,
    params: [
      { key: "period", label: "Period", type: "number", default: period, min: 5, max: 200, step: 1 },
      { key: "stdDev", label: "Std Dev", type: "number", default: stdDev, min: 0.5, max: 4, step: 0.5 },
    ],
    config: { period, stdDev },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const sd = config.stdDev as number;

      const closes = data.map(d => d.close);
      const sma = calcSMA(closes, p);
      const stdDevValues = calcStdDev(closes, p, sma);

      const upper: { time: string | number; value: number }[] = [];
      const middle: { time: string | number; value: number }[] = [];
      const lower: { time: string | number; value: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        if (sma[i] == null || stdDevValues[i] == null) continue;
        const t = data[i].time;
        const m = sma[i]!;
        const dev = stdDevValues[i]! * sd;
        upper.push({ time: t, value: m + dev });
        middle.push({ time: t, value: m });
        lower.push({ time: t, value: m - dev });
      }

      return [
        { id: "bb-upper", label: "Upper Band", type: "line", color: "#78909c", lineWidth: 1, data: upper, opacity: 0.6 },
        { id: "bb-middle", label: "Middle Band", type: "line", color: "#78909c", lineWidth: 1, data: middle },
        { id: "bb-lower", label: "Lower Band", type: "line", color: "#78909c", lineWidth: 1, data: lower, opacity: 0.6 },
      ];
    },
  };

  return indicator;
};
