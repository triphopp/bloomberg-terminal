/**
 * Absorption / Churn Detector — Pane indicator
 *
 * Flags bars where heavy volume produced almost no price progress: one side
 * committed aggressively and was quietly absorbed by resting orders (the
 * bar-level signature of Kyle-model hidden accumulation/distribution).
 *
 * Per bar, against a rolling median baseline of the prior `window` bars:
 *   volX  = volume / median(volume)          — effort
 *   comp  = median(range) / range            — lack of result (compression)
 *   score = volX × comp
 *
 * A bar is flagged as absorption when volX ≥ 1.5 AND range ≤ 0.9 × median
 * range. Direction from close position within the bar: closing in the upper
 * half ⇒ sellers were absorbed (bullish, teal); lower half ⇒ buyers absorbed
 * (bearish, red). Unflagged bars render dim so spikes stand out.
 *
 * Read it at a location that matters (VWAP band, nPOC, prior day H/L) — churn
 * in the middle of nowhere is usually just noise.
 */

import type { BarColumns } from "../columns.ts";
import { SortedWindow } from "../rolling.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

const VOL_MULT = 1.5; // volume ≥ 1.5× median = abnormal effort
const RANGE_MULT = 0.9; // range ≤ 0.9× median = compressed result
const COMP_CAP = 5; // cap compression so zero-range bars don't explode the scale

interface AbsorptionColumns {
  score: Float64Array;
  /** 1 where the bar has a score. */
  scored: Uint8Array;
  /** Index into `PALETTE`: unflagged · selling absorbed · buying absorbed. */
  kind: Uint8Array;
}

/** Unflagged bars render dim; a flagged one by which side was absorbed. */
const PALETTE = ["rgba(120,120,120,0.30)", "#26a69a", "#ef5350"] as const;

function calcAbsorption(bars: BarColumns, window: number): AbsorptionColumns {
  const n = bars.length;
  const { high, low, close, volume } = bars;
  const score = new Float64Array(n).fill(Number.NaN);
  const scored = new Uint8Array(n);
  const kind = new Uint8Array(n);

  // Positive volumes / ranges of bars [i - window, i), kept sorted as the
  // window slides — the median is a lookup, not a sort per bar.
  const vols = new SortedWindow(window);
  const ranges = new SortedWindow(window);
  const rangeAt = (j: number) => high[j] - low[j];
  for (let j = 0; j < Math.min(window, n); j++) {
    if (volume[j] > 0) vols.insert(volume[j]);
    if (rangeAt(j) > 0) ranges.insert(rangeAt(j));
  }

  for (let i = window; i < n; i++) {
    if (i > window) {
      // Slide: bar i-1 enters, bar i-1-window leaves.
      const inV = volume[i - 1];
      const inR = rangeAt(i - 1);
      const outV = volume[i - 1 - window];
      const outR = rangeAt(i - 1 - window);
      if (outV > 0) vols.remove(outV);
      if (outR > 0) ranges.remove(outR);
      if (inV > 0) vols.insert(inV);
      if (inR > 0) ranges.insert(inR);
    }
    const vol = volume[i];
    if (vol <= 0) continue;

    if (vols.size < window / 2 || ranges.size < window / 2) continue;

    const medVol = vols.median();
    const medRange = ranges.median();
    if (medVol <= 0 || medRange <= 0) continue;

    const range = rangeAt(i);
    const volX = vol / medVol;
    const comp = range > 0 ? Math.min(COMP_CAP, medRange / range) : COMP_CAP;

    const flagged = volX >= VOL_MULT && range <= medRange * RANGE_MULT;
    // Close in the upper half → selling absorbed (bullish).
    const closePos = range > 0 ? (close[i] - low[i]) / range : 0.5;

    score[i] = volX * comp;
    scored[i] = 1;
    kind[i] = flagged ? (closePos >= 0.5 ? 1 : 2) : 0;
  }

  return { score, scored, kind };
}

export const createAbsorption: IndicatorFactory = (overrides = {}) => {
  const window = (overrides.window as number) ?? 20;

  const indicator: ChartIndicator = {
    id: `absorption-${window}`,
    name: `Absorption ${window}`,
    category: "volume",
    type: "pane",
    description:
      "Effort-vs-result churn score: high volume + no progress = one side being absorbed",
    minBars: window + 1,
    params: [
      {
        key: "window",
        label: "Baseline window",
        type: "number",
        default: window,
        min: 10,
        max: 100,
        step: 5,
      },
    ],
    config: { window },

    ...columnar((bars, config) => {
      const w = config.window as number;
      const { score, scored, kind } = calcAbsorption(bars, w);

      return [
        {
          id: "absorption-hist",
          label: "Absorption",
          type: "histogram",
          values: score,
          from: 0,
          emit: scored,
          colors: kind,
          palette: PALETTE,
        },
      ];
    }),
  };

  return indicator;
};
