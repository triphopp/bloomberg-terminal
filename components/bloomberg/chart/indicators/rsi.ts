/**
 * RSI (Relative Strength Index) Indicator
 *
 * Pane indicator. Oscillator bounded 0–100.
 * Default period: 14
 */

import { constant } from "../kernels.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";
import type { RsiState } from "./rsiInverse";

export interface RsiColumns {
  /** NaN before `from`. */
  rsi: Float64Array;
  /** Wilder's averages behind each value — filled only when asked for. */
  avgGain: Float64Array;
  avgLoss: Float64Array;
  /** First index with a value (`period`); the length when there is none. */
  from: number;
}

const NO_STATE = new Float64Array(0);

/**
 * RSI plus, on request, the smoothing state that produced it.
 *
 * The value alone is not enough for anything that has to run the indicator
 * backwards: RSI is `100 · avgGain / (avgGain + avgLoss)`, so the series
 * preserves the ratio and discards the magnitude. Recovering "what close would
 * put RSI at 70 tomorrow" needs `avgLoss` on its own, not just the ratio, so
 * the state comes out of the same pass rather than being recomputed later — a
 * second pass would have to reproduce this exact seed and data window to agree.
 */
export function rsiColumns(
  closes: ArrayLike<number>,
  period: number,
  withState = false
): RsiColumns {
  const n = closes.length;
  const from = n < period + 1 ? n : period;
  const rsi = new Float64Array(n).fill(Number.NaN, 0, from);
  const gains = withState ? new Float64Array(n).fill(Number.NaN, 0, from) : NO_STATE;
  const losses = withState ? new Float64Array(n).fill(Number.NaN, 0, from) : NO_STATE;
  if (from === n) return { rsi, avgGain: gains, avgLoss: losses, from };

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // A window with no down bars pins RSI at 100. The old seed substituted a
  // finite RS of 100 and pushed it through the formula, landing on 99.0099 —
  // one bar reading a whole point below what every later bar in the same state
  // reports. Short-circuit here the way the smoothed loop below does.
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  if (withState) {
    gains[period] = avgGain;
    losses[period] = avgLoss;
  }

  // Smoothed
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    if (withState) {
      gains[i] = avgGain;
      losses[i] = avgLoss;
    }
  }

  return { rsi, avgGain: gains, avgLoss: losses, from };
}

/** `rsiColumns` with its state, one object per bar: `null` during warm-up. */
function calcRSIState(closes: number[], period: number): (RsiState | null)[] {
  const c = rsiColumns(closes, period, true);
  const result: (RsiState | null)[] = new Array(closes.length).fill(null);
  for (let i = c.from; i < closes.length; i++) {
    result[i] = { rsi: c.rsi[i], avgGain: c.avgGain[i], avgLoss: c.avgLoss[i] };
  }
  return result;
}

export { calcRSIState };

/**
 * RSI line colours by zone. The line itself carries the reading: red while it
 * sits above overbought, green below oversold, a quiet violet in between — so
 * "is it stretched?" is answered by colour before the axis is read. The
 * reference lines stay dim and broken so they never compete with the line.
 */
export const RSI_COLORS = {
  neutral: "#b39ddb",
  overbought: "#ff5252",
  oversold: "#00e676",
  obLevel: "#ff525299",
  osLevel: "#00e67699",
  mid: "#666666",
} as const;

const ZONE_PALETTE = [RSI_COLORS.neutral, RSI_COLORS.overbought, RSI_COLORS.oversold] as const;

/** Index into `ZONE_PALETTE`: at or beyond a level takes that level's colour. */
function rsiZone(value: number, overbought: number, oversold: number): number {
  if (value >= overbought) return 1;
  if (value <= oversold) return 2;
  return 0;
}

export function rsiZoneColor(value: number, overbought: number, oversold: number): string {
  return ZONE_PALETTE[rsiZone(value, overbought, oversold)];
}

export const createRSI: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 14;

  const indicator: ChartIndicator = {
    id: `rsi-${period}`,
    name: `RSI (${period})`,
    category: "momentum",
    type: "pane",
    description: `${period}-period Relative Strength Index`,
    minBars: period + 1,
    params: [
      {
        key: "period",
        label: "Period",
        type: "number",
        default: period,
        min: 2,
        max: 100,
        step: 1,
      },
      {
        key: "overbought",
        label: "Overbought",
        type: "number",
        default: 70,
        min: 50,
        max: 95,
        step: 5,
      },
      { key: "oversold", label: "Oversold", type: "number", default: 30, min: 5, max: 50, step: 5 },
    ],
    config: { period, overbought: 70, oversold: 30 },

    ...columnar((bars, config) => {
      const p = config.period as number;
      const ob = config.overbought as number;
      const os = config.oversold as number;
      const n = bars.length;
      const { rsi, from } = rsiColumns(bars.close, p);
      const scaleId = `rsi-${p}`;

      const zones = new Uint8Array(n);
      for (let i = from; i < n; i++) zones[i] = rsiZone(rsi[i], ob, os);

      // Reference levels first: later series paint on top, and the RSI line is
      // the thing to read. Refills match series by position, so this order is
      // fixed for every compute.
      return [
        {
          id: `rsi-${p}-mid`,
          label: "50",
          type: "line",
          color: RSI_COLORS.mid,
          lineWidth: 1,
          lineStyle: "dotted",
          values: constant(n, 50, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-ob`,
          label: `OB ${ob}`,
          type: "line",
          color: RSI_COLORS.obLevel,
          lineWidth: 1,
          lineStyle: "dashed",
          values: constant(n, ob, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-os`,
          label: `OS ${os}`,
          type: "line",
          color: RSI_COLORS.osLevel,
          lineWidth: 1,
          lineStyle: "dashed",
          values: constant(n, os, from),
          from,
          emit: "all",
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-line`,
          label: `RSI ${p}`,
          type: "line",
          color: RSI_COLORS.neutral,
          lineWidth: 2,
          lastValueVisible: true,
          values: rsi,
          from,
          emit: "all",
          colors: zones,
          palette: ZONE_PALETTE,
          priceScaleId: scaleId,
        },
      ];
    }),
    // The zone colour of a point is a function of that point's own value.
    causal: true,
  };

  return indicator;
};
