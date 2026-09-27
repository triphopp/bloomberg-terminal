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

import { SortedWindow } from "../rolling.ts";
import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "../types";

const VOL_MULT = 1.5; // volume ≥ 1.5× median = abnormal effort
const RANGE_MULT = 0.9; // range ≤ 0.9× median = compressed result
const COMP_CAP = 5; // cap compression so zero-range bars don't explode the scale

interface AbsorptionPoint {
  score: number;
  flagged: boolean;
  bullish: boolean; // close in upper half → selling absorbed
}

function calcAbsorption(data: OhlcvBar[], window: number): (AbsorptionPoint | null)[] {
  const result: (AbsorptionPoint | null)[] = new Array(data.length).fill(null);

  // Positive volumes / ranges of bars [i - window, i), kept sorted as the
  // window slides — the median is a lookup, not a sort per bar.
  const vols = new SortedWindow(window);
  const ranges = new SortedWindow(window);
  const volAt = (j: number) => data[j].volume ?? 0;
  const rangeAt = (j: number) => data[j].high - data[j].low;
  for (let j = 0; j < Math.min(window, data.length); j++) {
    if (volAt(j) > 0) vols.insert(volAt(j));
    if (rangeAt(j) > 0) ranges.insert(rangeAt(j));
  }

  for (let i = window; i < data.length; i++) {
    if (i > window) {
      // Slide: bar i-1 enters, bar i-1-window leaves.
      const inV = volAt(i - 1);
      const inR = rangeAt(i - 1);
      const outV = volAt(i - 1 - window);
      const outR = rangeAt(i - 1 - window);
      if (outV > 0) vols.remove(outV);
      if (outR > 0) ranges.remove(outR);
      if (inV > 0) vols.insert(inV);
      if (inR > 0) ranges.insert(inR);
    }
    const bar = data[i];
    const vol = bar.volume ?? 0;
    if (vol <= 0) continue;

    if (vols.size < window / 2 || ranges.size < window / 2) continue;

    const medVol = vols.median();
    const medRange = ranges.median();
    if (medVol <= 0 || medRange <= 0) continue;

    const range = bar.high - bar.low;
    const volX = vol / medVol;
    const comp = range > 0 ? Math.min(COMP_CAP, medRange / range) : COMP_CAP;
    const score = volX * comp;

    const flagged = volX >= VOL_MULT && range <= medRange * RANGE_MULT;
    const closePos = range > 0 ? (bar.close - bar.low) / range : 0.5;

    result[i] = { score, flagged, bullish: closePos >= 0.5 };
  }

  return result;
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

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const w = config.window as number;
      const values = calcAbsorption(data, w);

      const points: HistogramDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = values[i];
        if (v == null) continue;
        let color: string;
        if (v.flagged) color = v.bullish ? "#26a69a" : "#ef5350";
        else color = "rgba(120,120,120,0.30)";
        points.push({ time: data[i].time, value: v.score, color });
      }

      return [
        {
          id: "absorption-hist",
          label: "Absorption",
          type: "histogram",
          data: points,
        },
      ];
    },
  };

  return indicator;
};
