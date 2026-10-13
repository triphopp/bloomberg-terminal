import { rollingVariance } from "../../rolling.ts";
import type { OhlcvBar } from "../../types";

export interface BollingerStats {
  middle: (number | null)[];
  deviation: (number | null)[];
}

/** Population standard deviation, matching the existing chart's BB definition. */
export function calcBollingerStats(data: readonly OhlcvBar[], period: number): BollingerStats {
  const middle: (number | null)[] = Array(data.length).fill(null);
  const deviation: (number | null)[] = Array(data.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return { middle, deviation };
  // O(1) per bar: the Sharpe fit calls this for every period on the grid.
  const closes = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) closes[i] = data[i].close;
  const { mean, variance } = rollingVariance(closes, period, 0);
  for (let i = period - 1; i < data.length; i++) {
    middle[i] = mean[i];
    deviation[i] = Math.sqrt(variance[i]);
  }
  return { middle, deviation };
}
