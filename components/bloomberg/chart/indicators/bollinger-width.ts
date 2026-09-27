/**
 * Bollinger BandWidth (BBW) — Pane indicator
 *
 * Measures how tightly the Bollinger Bands are squeezed:
 *   BBW = (Upper − Lower) / Middle = 2·k·σ / SMA
 *
 * Normalising by the middle band makes the width comparable across
 * instruments and price levels — a 5-point band spread means nothing on its
 * own; 4% of price does.
 *
 * Squeeze detection follows John Bollinger's own rule: a squeeze is when BBW
 * sets an N-bar low (he used 125 daily bars ≈ 6 months). The cyan line plots
 * the trailing N-bar low of BBW ("squeeze floor"); histogram bars within 5%
 * of that floor are highlighted orange. The gap between histogram and line
 * shows how far current width is from maximum squeeze.
 *
 * A squeeze signals that a volatility expansion is likely coming — it says
 * NOTHING about direction. Breakout direction must come from other evidence
 * (e.g. flow, %B, price structure).
 */

import { rollingVariance } from "../rolling.ts";
import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
  SeriesDataPoint,
} from "../types";
import { calcSMA } from "./sma.ts";

// Squeeze flagging needs enough BBW history to be meaningful; below this the
// trailing low is too easy to touch and every early bar would light up.
const MIN_SQUEEZE_OBS = 30;

// "Within 5% of the trailing low" counts as squeezed — exact-equality would
// only ever mark the single lowest bar.
const SQUEEZE_TOL = 1.05;

/** Population σ about the window mean, null during warm-up. */
function calcStdDev(values: number[], period: number): (number | null)[] {
  const { variance } = rollingVariance(values, period, 0);
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++)
    result[i] = i < period - 1 ? null : Math.sqrt(variance[i]);
  return result;
}

export const createBollingerWidth: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 20;
  const stdDev = (overrides.stdDev as number) ?? 2;
  const lookback = (overrides.lookback as number) ?? 125;

  const indicator: ChartIndicator = {
    id: `bb-width-${period}-${stdDev}`,
    name: `BB Width (${period}, ${stdDev}σ)`,
    category: "volatility",
    type: "pane",
    description: `Bollinger BandWidth (Upper−Lower)/Middle — orange = squeeze (${lookback}-bar low)`,
    minBars: period,
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
        step: 0.5,
      },
      {
        key: "lookback",
        label: "Squeeze lookback",
        type: "number",
        default: lookback,
        min: 20,
        max: 250,
        step: 5,
      },
    ],
    config: { period, stdDev, lookback },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const sd = config.stdDev as number;
      const lb = config.lookback as number;

      const closes = data.map((d) => d.close);
      const sma = calcSMA(closes, p);
      const stdDevValues = calcStdDev(closes, p);

      // BBW aligned to data indices (null during warm-up).
      const bbw: (number | null)[] = new Array(data.length).fill(null);
      for (let i = 0; i < data.length; i++) {
        const m = sma[i];
        const s = stdDevValues[i];
        if (m == null || s == null || m === 0) continue;
        bbw[i] = (2 * sd * s) / Math.abs(m);
      }

      const scaleId = `bb-width-${p}-${sd}`;
      const widthPoints: HistogramDataPoint[] = [];
      const floorPoints: SeriesDataPoint[] = [];

      // Trailing low of the last `lb` non-null BBW values: monotone deque of
      // their values (non-decreasing head→tail) and their ordinal among the
      // non-null ones, so each value enters and leaves once — O(1) per bar.
      const dqVal = new Float64Array(data.length);
      const dqOrd = new Int32Array(data.length);
      let head = 0;
      let tail = 0;
      let seen = 0;
      for (let i = 0; i < data.length; i++) {
        const w = bbw[i];
        if (w == null) continue;
        while (tail > head && dqVal[tail - 1] >= w) tail--;
        dqVal[tail] = w;
        dqOrd[tail++] = seen;
        seen++;
        while (dqOrd[head] <= seen - 1 - lb) head++;
        const filled = Math.min(seen, lb);

        let color = "rgba(120,144,156,0.45)"; // normal width — muted blue-grey
        if (filled >= Math.min(lb, MIN_SQUEEZE_OBS)) {
          const floor = dqVal[head];
          floorPoints.push({ time: data[i].time, value: floor });
          if (w <= floor * SQUEEZE_TOL) color = "#ff9800"; // squeeze
        }
        widthPoints.push({ time: data[i].time, value: w, color });
      }

      return [
        {
          id: `${scaleId}-hist`,
          label: "BB Width",
          type: "histogram",
          data: widthPoints,
          priceScaleId: scaleId,
        },
        {
          id: `${scaleId}-floor`,
          label: "Squeeze floor",
          type: "line",
          color: "#26c6da",
          lineWidth: 1,
          data: floorPoints,
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
