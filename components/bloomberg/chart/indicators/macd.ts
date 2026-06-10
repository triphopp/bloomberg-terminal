/**
 * MACD (Moving Average Convergence Divergence) Indicator
 *
 * Pane indicator with 3 outputs: MACD line, Signal line, Histogram.
 * Default: fast=12, slow=26, signal=9
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput, HistogramDataPoint } from "../types";
import { calcEMA } from "./ema";

export const createMACD: IndicatorFactory = (overrides = {}) => {
  const fast = (overrides.fast as number) ?? 12;
  const slow = (overrides.slow as number) ?? 26;
  const signal = (overrides.signal as number) ?? 9;

  const indicator: ChartIndicator = {
    id: `macd-${fast}-${slow}-${signal}`,
    name: `MACD (${fast},${slow},${signal})`,
    category: "momentum",
    type: "pane",
    description: `MACD with ${fast}/${slow} EMA and ${signal}-period signal`,
    minBars: slow + signal,
    params: [
      { key: "fast", label: "Fast Period", type: "number", default: fast, min: 2, max: 100, step: 1 },
      { key: "slow", label: "Slow Period", type: "number", default: slow, min: 2, max: 200, step: 1 },
      { key: "signal", label: "Signal Period", type: "number", default: signal, min: 2, max: 50, step: 1 },
    ],
    config: { fast, slow, signal },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const f = config.fast as number;
      const s = config.slow as number;
      const sig = config.signal as number;

      const closes = data.map(d => d.close);
      const fastEMA = calcEMA(closes, f);
      const slowEMA = calcEMA(closes, s);

      // MACD line = fastEMA - slowEMA
      const macdLine: (number | null)[] = data.map((_, i) => {
        if (fastEMA[i] == null || slowEMA[i] == null) return null;
        return fastEMA[i]! - slowEMA[i]!;
      });

      // Signal line = EMA of MACD line (ignore nulls at the start)
      const macdValues = macdLine.filter(v => v != null) as number[];
      const signalEMA = calcEMA(macdValues, sig);

      // Align signal back to full array
      const signalLine: (number | null)[] = new Array(data.length).fill(null);
      let signalIdx = 0;
      for (let i = 0; i < data.length; i++) {
        if (macdLine[i] != null) {
          signalLine[i] = signalEMA[signalIdx] ?? null;
          signalIdx++;
        }
      }

      // Histogram = MACD - Signal
      const histogram: HistogramDataPoint[] = [];
      const macdPoints: { time: string | number; value: number }[] = [];
      const signalPoints: { time: string | number; value: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        if (macdLine[i] != null) {
          macdPoints.push({ time: data[i].time, value: macdLine[i]! });
        }
        if (signalLine[i] != null) {
          signalPoints.push({ time: data[i].time, value: signalLine[i]! });
        }
        if (macdLine[i] != null && signalLine[i] != null) {
          const diff = macdLine[i]! - signalLine[i]!;
          histogram.push({
            time: data[i].time,
            value: diff,
            color: diff >= 0 ? "#4caf5088" : "#ef535088",
          });
        }
      }

      return [
        {
          id: "macd-histogram",
          label: "Histogram",
          type: "histogram",
          data: histogram,
          priceScaleId: "macd",
        },
        {
          id: "macd-line",
          label: "MACD",
          type: "line",
          color: "#2196f3",
          lineWidth: 1,
          data: macdPoints,
          priceScaleId: "macd",
        },
        {
          id: "macd-signal",
          label: "Signal",
          type: "line",
          color: "#ff9800",
          lineWidth: 1,
          data: signalPoints,
          priceScaleId: "macd",
        },
      ];
    },
  };

  return indicator;
};
