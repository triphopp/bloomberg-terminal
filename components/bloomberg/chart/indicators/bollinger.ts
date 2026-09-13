/**
 * Bollinger Bands Indicator
 *
 * Overlay indicator: middle band (SMA), upper band (+2σ), lower band (-2σ).
 * Default: period=20, stdDev=2
 */

import {
  BOLLINGER_FIT_PARAMS,
  calcBollingerStats,
  resolveBollingerParameters,
} from "../bollinger-fit.ts";
import type { ChartIndicator, IndicatorFactory, IndicatorSeriesOutput, OhlcvBar } from "../types";

export const createBollingerBands: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;
  const fitMode = overrides.fitMode === "sharpe" ? "sharpe" : "manual";
  const fitCostBps = Number(overrides.fitCostBps ?? 5);

  const indicator: ChartIndicator = {
    id: `bb-${period}-${stdDev}`,
    name: `BB (${period}, ${stdDev}σ)`,
    category: "volatility",
    type: "overlay",
    description: `Bollinger Bands: ${period} SMA ± ${stdDev} standard deviations`,
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

      const upper: { time: string | number; value: number }[] = [];
      const middle: { time: string | number; value: number }[] = [];
      const lower: { time: string | number; value: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        const m = sma[i];
        const deviation = stdDevValues[i];
        if (m == null || deviation == null) continue;
        const t = data[i].time;
        const dev = deviation * sd;
        upper.push({ time: t, value: m + dev });
        middle.push({ time: t, value: m });
        lower.push({ time: t, value: m - dev });
      }

      return [
        {
          id: "bb-upper",
          label: `Upper Band (${p}, ${sd}σ)`,
          type: "line",
          color: "#ef4444",
          lineWidth: 1,
          data: upper,
          opacity: 0.6,
        },
        {
          id: "bb-middle",
          label: `Middle Band (${p})`,
          type: "line",
          color: "#78909c",
          lineWidth: 1,
          data: middle,
        },
        {
          id: "bb-lower",
          label: `Lower Band (${p}, ${sd}σ)`,
          type: "line",
          color: "#22c55e",
          lineWidth: 1,
          data: lower,
          opacity: 0.6,
        },
      ];
    },
  };

  return indicator;
};
