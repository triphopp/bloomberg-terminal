/**
 * Bollinger Bands Indicator
 *
 * Overlay indicator: middle band (SMA), upper band (+2σ), lower band (-2σ).
 * Default: period=20, stdDev=2
 */

import { BB_VOLUME_PARAMS, readBbVolumeSettings } from "../bb-volume-overlay.ts";
import {
  BOLLINGER_FIT_PARAMS,
  bollingerColumns,
  resolveBollingerParameters,
} from "../bollinger-fit.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

export const createBollingerBands: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;
  const fitMode = overrides.fitMode === "sharpe" ? "sharpe" : "manual";
  const fitCostBps = Number(overrides.fitCostBps ?? 5);
  // Volume drawn inside the band (bb-volume-overlay.ts). Not part of the id:
  // switching the overlay re-edits this BB rather than adding a second one.
  const vol = readBbVolumeSettings(overrides);

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
      ...BB_VOLUME_PARAMS,
    ],
    config: {
      period,
      stdDev,
      fitMode,
      fitCostBps,
      volOverlay: vol.mode,
      volBasis: vol.basis,
      volLayout: vol.layout,
      volSigma: vol.sigma,
      volLookback: vol.lookback,
      volShow: vol.abnormalOnly ? "abnormal" : "all",
      volOpacity: vol.opacity,
      vpPeriod: vol.vpPeriod,
      vpBars: vol.vpBars,
    },

    ...columnar((bars, config) => {
      const { period: p, stdDev: sd } = resolveBollingerParameters(bars.bars, config);
      const { middle, deviation, from } = bollingerColumns(bars.close, p);
      const n = bars.length;
      const upper = new Float64Array(n).fill(Number.NaN, 0, from);
      const lower = new Float64Array(n).fill(Number.NaN, 0, from);
      for (let i = from; i < n; i++) {
        const m = middle[i];
        const dev = deviation[i] * sd;
        upper[i] = m + dev;
        lower[i] = m - dev;
      }

      return [
        {
          id: "bb-upper",
          label: `Upper Band (${p}, ${sd}σ)`,
          type: "line",
          color: "#ef4444",
          lineWidth: 1,
          values: upper,
          from,
          emit: "all",
          opacity: 0.6,
        },
        {
          id: "bb-middle",
          label: `Middle Band (${p})`,
          type: "line",
          color: "#78909c",
          lineWidth: 1,
          values: middle,
          from,
          emit: "all",
        },
        {
          id: "bb-lower",
          label: `Lower Band (${p}, ${sd}σ)`,
          type: "line",
          color: "#22c55e",
          lineWidth: 1,
          values: lower,
          from,
          emit: "all",
          opacity: 0.6,
        },
      ];
    }),
    // A Sharpe fit reads every closed bar: a new bar can move period and σ,
    // and with them every point.
    causal: (config) => config.fitMode !== "sharpe",
  };

  return indicator;
};
