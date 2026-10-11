/**
 * MACD (Moving Average Convergence Divergence) Indicator
 *
 * Pane indicator with 3 outputs: MACD line, Signal line, Histogram.
 * Default: fast=12, slow=26, signal=9
 */

import { difference, ema } from "../kernels.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";
import { emaStart } from "./ema.ts";

const HIST_PALETTE = ["#4caf5088", "#ef535088"] as const;

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
      {
        key: "fast",
        label: "Fast Period",
        type: "number",
        default: fast,
        min: 2,
        max: 100,
        step: 1,
      },
      {
        key: "slow",
        label: "Slow Period",
        type: "number",
        default: slow,
        min: 2,
        max: 200,
        step: 1,
      },
      {
        key: "signal",
        label: "Signal Period",
        type: "number",
        default: signal,
        min: 2,
        max: 50,
        step: 1,
      },
    ],
    config: { fast, slow, signal },

    ...columnar((bars, config) => {
      const f = config.fast as number;
      const s = config.slow as number;
      const sig = config.signal as number;
      const n = bars.length;

      // MACD line = fastEMA - slowEMA, from the first bar both exist
      const macdFrom = Math.max(emaStart(n, f), emaStart(n, s));
      const macd = difference(ema(bars.close, f), ema(bars.close, s), macdFrom);

      // Signal line = EMA of the MACD line, which begins after its warm-up
      const signal = ema(macd, sig, macdFrom);
      const signalFrom = emaStart(n, sig, macdFrom);

      // Histogram = MACD - Signal
      const hist = difference(macd, signal, signalFrom);
      const sign = new Uint8Array(n);
      for (let i = signalFrom; i < n; i++) sign[i] = hist[i] >= 0 ? 0 : 1;

      return [
        {
          id: "macd-histogram",
          label: "Histogram",
          type: "histogram",
          values: hist,
          from: signalFrom,
          emit: "all",
          colors: sign,
          palette: HIST_PALETTE,
          priceScaleId: "macd",
        },
        {
          id: "macd-line",
          label: "MACD",
          type: "line",
          color: "#2196f3",
          lineWidth: 1,
          values: macd,
          from: macdFrom,
          emit: "all",
          priceScaleId: "macd",
        },
        {
          id: "macd-signal",
          label: "Signal",
          type: "line",
          color: "#ff9800",
          lineWidth: 1,
          values: signal,
          from: signalFrom,
          emit: "all",
          priceScaleId: "macd",
        },
      ];
    }),
    causal: true,
  };

  return indicator;
};
