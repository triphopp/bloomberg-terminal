/**
 * chartkit — the ladder of history windows a chart can climb.
 *
 * Generic over the window name (this repo's `TimePeriod`, but the library does
 * not know that): a caller hands over the steps it considers legal for the
 * current bar interval, each with an approximate span, and gets back an ordered
 * ladder plus the rung above whichever one is showing.
 *
 * Spans are approximate on purpose — the ladder only has to ORDER the windows,
 * not measure them. "5y" being 1825 days rather than 1826 changes nothing.
 */

export interface LadderStep<P extends string> {
  period: P;
  /** Approximate calendar span in days. `Infinity` is legal ("max"). */
  spanDays: number;
}

/**
 * Steps → an ordered ladder, narrowest first.
 *
 * Ties are dropped rather than ordered arbitrarily: two windows of the same
 * span are the same rung, and keeping both would let auto-extend "widen" into
 * a window holding the same bars, then immediately try again.
 */
export function buildLadder<P extends string>(steps: LadderStep<P>[]): P[] {
  const sorted = [...steps].sort((a, b) => a.spanDays - b.spanDays);
  const out: P[] = [];
  let lastSpan = Number.NEGATIVE_INFINITY;
  for (const step of sorted) {
    if (step.spanDays === lastSpan) continue;
    out.push(step.period);
    lastSpan = step.spanDays;
  }
  return out;
}

/**
 * The rung above `current`, or null at the top.
 *
 * A `current` that is not on the ladder at all returns null rather than
 * guessing: off-ladder means the caller decided this window is not on the auto
 * path, and picking some other rung could just as easily NARROW the chart.
 */
export function nextWider<P extends string>(ladder: P[], current: P): P | null {
  const idx = ladder.indexOf(current);
  if (idx === -1) return null;
  return idx + 1 < ladder.length ? ladder[idx + 1] : null;
}
