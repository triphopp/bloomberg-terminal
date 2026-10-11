/**
 * Bollinger %B Indicator
 *
 * Pane indicator. %B = (Close - Lower) / (Upper - Lower)
 * 1.0 = price at upper band, 0.0 = price at lower band, 0.5 = middle band.
 * Default: period=20, stdDev=2
 */

import {
  BOLLINGER_FIT_PARAMS,
  bollingerColumns,
  resolveBollingerParameters,
} from "../bollinger-fit.ts";
import { constant } from "../kernels.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

export const createBollingerB: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;
  const fitMode = overrides.fitMode === "sharpe" ? "sharpe" : "manual";
  const fitCostBps = Number(overrides.fitCostBps ?? 5);

  const indicator: ChartIndicator = {
    id: `bb-b-${period}-${stdDev}`,
    name: `%B (${period}, ${stdDev}σ)`,
    category: "volatility",
    type: "pane",
    description: `Bollinger %B: price position within ${period}-period ±${stdDev}σ bands`,
    minBars: fitMode === "sharpe" ? 5 : period,
    params: [
      {
        key: "period",
        label: "Period",
        type: "number",
        default: period,
        min: 5,
        max: 200,
        step: 1,
      },
      {
        key: "stdDev",
        label: "Std Dev",
        type: "number",
        default: stdDev,
        min: 0.5,
        max: 4,
        step: 0.25,
      },
      ...BOLLINGER_FIT_PARAMS,
    ],
    config: { period, stdDev, fitMode, fitCostBps },

    ...columnar((bars, config) => {
      const { period: p, stdDev: sd } = resolveBollingerParameters(bars.bars, config);
      const { middle, deviation, from } = bollingerColumns(bars.close, p);
      const n = bars.length;
      const closes = bars.close;

      const scaleId = `bb-b-${p}-${sd}`;
      const b = new Float64Array(n).fill(Number.NaN, 0, from);
      for (let i = from; i < n; i++) {
        const m = middle[i];
        const dev = deviation[i] * sd;
        const upper = m + dev;
        const lower = m - dev;
        const bandwidth = upper - lower;
        b[i] = bandwidth === 0 ? 0.5 : (closes[i] - lower) / bandwidth;
      }

      return [
        {
          id: `bb-b-${p}-${sd}-line`,
          label: `%B (${p}, ${sd}σ)`,
          type: "line",
          color: "#26c6da",
          lineWidth: 1,
          values: b,
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-mid`,
          label: "0.5",
          type: "line",
          color: "#555",
          lineWidth: 1,
          values: constant(n, 0.5, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-upper`,
          label: "1.0",
          type: "line",
          color: "#444",
          lineWidth: 1,
          values: constant(n, 1.0, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `bb-b-${p}-${sd}-lower`,
          label: "0.0",
          type: "line",
          color: "#444",
          lineWidth: 1,
          values: constant(n, 0.0, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
      ];
    }),
    // A Sharpe fit reads every closed bar (see bollinger.ts).
    causal: (config) => config.fitMode !== "sharpe",
  };

  return indicator;
};
