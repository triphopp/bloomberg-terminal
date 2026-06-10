/**
 * Bollinger %B Indicator
 *
 * Pane indicator. %B = (Close - Lower) / (Upper - Lower)
 * 1.0 = price at upper band, 0.0 = price at lower band, 0.5 = middle band.
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

export const createBollingerB: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;

  const indicator: ChartIndicator = {
    id: `bb-b-${period}-${stdDev}`,
    name: `%B (${period}, ${stdDev}σ)`,
    category: "volatility",
    type: "pane",
    description: `Bollinger %B: price position within ${period}-period ±${stdDev}σ bands`,
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

      const scaleId = `bb-b-${p}-${sd}`;
      const bValues: { time: string | number; value: number }[] = [];
      const midLine: { time: string | number; value: number }[] = [];
      const upperLine: { time: string | number; value: number }[] = [];
      const lowerLine: { time: string | number; value: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        if (sma[i] == null || stdDevValues[i] == null) continue;
        const t = data[i].time;
        const dev = stdDevValues[i]! * sd;
        const upper = sma[i]! + dev;
        const lower = sma[i]! - dev;
        const bandwidth = upper - lower;
        const b = bandwidth === 0 ? 0.5 : (closes[i] - lower) / bandwidth;

        bValues.push({ time: t, value: b });
        midLine.push({ time: t, value: 0.5 });
        upperLine.push({ time: t, value: 1.0 });
        lowerLine.push({ time: t, value: 0.0 });
      }

      return [
        {
          id: `bb-b-${p}-${sd}-line`,
          label: `%B`,
          type: "line",
          color: "#26c6da",
          lineWidth: 1,
          data: bValues,
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-mid`,
          label: "0.5",
          type: "line",
          color: "#555",
          lineWidth: 1,
          data: midLine,
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-upper`,
          label: "1.0",
          type: "line",
          color: "#444",
          lineWidth: 1,
          data: upperLine,
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-lower`,
          label: "0.0",
          type: "line",
          color: "#444",
          lineWidth: 1,
          data: lowerLine,
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
