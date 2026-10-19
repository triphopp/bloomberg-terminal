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

import { rollingMean, rollingVariance } from "../rolling.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

// Squeeze flagging needs enough BBW history to be meaningful; below this the
// trailing low is too easy to touch and every early bar would light up.
const MIN_SQUEEZE_OBS = 30;

// "Within 5% of the trailing low" counts as squeezed — exact-equality would
// only ever mark the single lowest bar.
const SQUEEZE_TOL = 1.05;

const WIDTH_PALETTE = [
  "rgba(120,144,156,0.45)", // normal width — muted blue-grey
  "#ff9800", // squeeze
] as const;

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

    ...columnar((bars, config) => {
      const p = config.period as number;
      const sd = config.stdDev as number;
      const lb = config.lookback as number;
      const n = bars.length;

      // The mean from its own running sum and σ from the variance pass — two
      // passes, as before: their means differ in the last bits.
      const sma = rollingMean(bars.close, p);
      const { variance } = rollingVariance(bars.close, p, 0);

      const scaleId = `bb-width-${p}-${sd}`;
      // A bar has a width from the first full window on, unless the mean is
      // exactly zero. Masks rather than NaN: a window holding a broken print
      // has a NaN width, and that bar was always sent.
      const from = Math.max(0, Math.ceil(p - 1));
      const width = new Float64Array(n).fill(Number.NaN);
      const hasWidth = new Uint8Array(n);
      const squeezed = new Uint8Array(n);
      const floors = new Float64Array(n).fill(Number.NaN);
      const hasFloor = new Uint8Array(n);

      // Trailing low of the last `lb` widths: monotone deque of their values
      // (non-decreasing head→tail) and their ordinal among the bars that have
      // one, so each value enters and leaves once — O(1) per bar.
      const dqVal = new Float64Array(n);
      const dqOrd = new Int32Array(n);
      let head = 0;
      let tail = 0;
      let seen = 0;
      for (let i = from; i < n; i++) {
        const m = sma[i];
        if (m === 0) continue;
        const w = (2 * sd * Math.sqrt(variance[i])) / Math.abs(m);
        while (tail > head && dqVal[tail - 1] >= w) tail--;
        dqVal[tail] = w;
        dqOrd[tail++] = seen;
        seen++;
        while (dqOrd[head] <= seen - 1 - lb) head++;
        const filled = Math.min(seen, lb);

        if (filled >= Math.min(lb, MIN_SQUEEZE_OBS)) {
          const floor = dqVal[head];
          floors[i] = floor;
          hasFloor[i] = 1;
          if (w <= floor * SQUEEZE_TOL) squeezed[i] = 1;
        }
        width[i] = w;
        hasWidth[i] = 1;
      }

      return [
        {
          id: `${scaleId}-hist`,
          label: "BB Width",
          type: "histogram",
          values: width,
          from,
          emit: hasWidth,
          colors: squeezed,
          palette: WIDTH_PALETTE,
          priceScaleId: scaleId,
        },
        {
          id: `${scaleId}-floor`,
          label: "Squeeze floor",
          type: "line",
          color: "#26c6da",
          lineWidth: 1,
          values: floors,
          from,
          emit: hasFloor,
          priceScaleId: scaleId,
        },
      ];
    }),
    // Width, floor and squeeze colour of a bar all look back only.
    causal: true,
  };

  return indicator;
};
