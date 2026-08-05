/**
 * Running RSI backwards: which close on the next bar lands the indicator on a
 * given level.
 *
 * RSI reduces to `100 · avgGain / (avgGain + avgLoss)` — a share, not a size.
 * It therefore carries no price level (only differences feed it) and no
 * magnitude (scaling every move leaves the share untouched). That is why every
 * function here takes the Wilder state explicitly: the plotted series cannot
 * supply it.
 *
 * Everything is one bar ahead only. Two bars out the answer is a path, not a
 * price, and there are infinitely many of them.
 */

/** RSI at a bar together with the smoothing state behind it. */
export type RsiState = {
  rsi: number;
  avgGain: number;
  avgLoss: number;
};

/** A projected close, and which way the bar has to go to get there. */
export type RsiProjection = {
  price: number;
  direction: "up" | "down" | "flat";
};

/**
 * RSI after one more bar closing at `nextClose`.
 *
 * Uses the `100·a/(a+b)` form rather than `100 − 100/(1+RS)` so that a window
 * with no down bars returns 100 instead of dividing by zero. That matches the
 * smoothed branch of `calcRSIState` but not its seed bar, which substitutes a
 * finite sentinel for RS and lands on 99.0099 — see the risk report in
 * `memory/sessions/reports/rsi-seed-divergence-risk-report.md`.
 */
export function rsiForPrice(
  close: number,
  state: RsiState,
  period: number,
  nextClose: number
): number | null {
  if (period < 2) return null;
  if (!Number.isFinite(close) || !Number.isFinite(nextClose)) return null;

  const k = period - 1;
  const delta = nextClose - close;
  const gain = delta > 0 ? delta : 0;
  const loss = delta < 0 ? -delta : 0;

  const a = (state.avgGain * k + gain) / period;
  const b = (state.avgLoss * k + loss) / period;
  if (a + b <= 0) return null;

  return (100 * a) / (a + b);
}

/**
 * Lowest RSI reachable on the next bar.
 *
 * A down bar can only add as much loss as there is price to give up, so the
 * floor is set by `nextClose → 0`. Levels below it are unreachable however far
 * the bar falls, and asking for one is a display problem, not a rounding one.
 */
export function rsiFloor(close: number, state: RsiState, period: number): number | null {
  if (period < 2) return null;
  if (!Number.isFinite(close) || close <= 0) return null;

  const k = period - 1;
  const ka = state.avgGain * k;
  const kb = state.avgLoss * k;
  const denom = ka + kb + close;
  if (denom <= 0) return null;

  return (100 * ka) / denom;
}

/**
 * Close on the next bar that puts RSI at `targetRsi`.
 *
 * Two branches, because a bar feeds exactly one of the two averages: an up bar
 * adds to avgGain while avgLoss merely decays, and vice versa. Which branch
 * applies is not a guess — solving the up case first and testing the sign of
 * the required gain decides it, and the two agree exactly at the current RSI,
 * where both return zero.
 *
 * Returns null when the question has no answer: a flat window (RSI undefined),
 * a target outside `(0, 100)`, or a target under the floor.
 */
export function priceForRsi(
  close: number,
  state: RsiState,
  period: number,
  targetRsi: number
): RsiProjection | null {
  if (period < 2) return null;
  if (!Number.isFinite(close) || close <= 0) return null;
  if (!Number.isFinite(targetRsi) || targetRsi <= 0 || targetRsi >= 100) return null;

  const { avgGain, avgLoss } = state;
  if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return null;
  if (avgGain < 0 || avgLoss < 0) return null;
  // Nothing moved for a whole window: RSI is 0/0 and every target is vacuous.
  if (avgGain === 0 && avgLoss === 0) return null;

  const k = period - 1;
  const ka = avgGain * k;
  const kb = avgLoss * k;
  const rs = targetRsi / (100 - targetRsi);

  // Up bar. avgLoss only decays, so the whole adjustment falls on the gain.
  const gain = rs * kb - ka;
  if (gain > 0) return { price: close + gain, direction: "up" };
  if (gain === 0) return { price: close, direction: "flat" };

  // Down bar. `rs` is strictly positive here, so the division is safe.
  const loss = ka / rs - kb;
  const price = close - loss;
  if (!Number.isFinite(price) || price <= 0) return null;

  return { price, direction: "down" };
}
