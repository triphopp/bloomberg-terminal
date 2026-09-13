/**
 * Bollinger %B Indicator
 *
 * Pane indicator. %B = (Close - Lower) / (Upper - Lower)
 * 1.0 = price at upper band, 0.0 = price at lower band, 0.5 = middle band.
 * Default: period=20, stdDev=2
 */

import {
  BOLLINGER_FIT_PARAMS,
  calcBollingerStats,
  resolveBollingerParameters,
} from "../bollinger-fit.ts";
import type { ChartIndicator, IndicatorFactory, IndicatorSeriesOutput, OhlcvBar } from "../types";

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

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const { period: p, stdDev: sd } = resolveBollingerParameters(data, config);
      const { middle: sma, deviation: stdDevValues } = calcBollingerStats(data, p);
      const closes = data.map((d) => d.close);

      const scaleId = `bb-b-${p}-${sd}`;
      const bValues: { time: string | number; value: number }[] = [];
      const midLine: { time: string | number; value: number }[] = [];
      const upperLine: { time: string | number; value: number }[] = [];
      const lowerLine: { time: string | number; value: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        const m = sma[i];
        const deviation = stdDevValues[i];
        if (m == null || deviation == null) continue;
        const t = data[i].time;
        const dev = deviation * sd;
        const upper = m + dev;
        const lower = m - dev;
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
          label: `%B (${p}, ${sd}σ)`,
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
