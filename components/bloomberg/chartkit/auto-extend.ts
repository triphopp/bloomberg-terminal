/**
 * chartkit — "the user zoomed out past the data" detector.
 *
 * Pure: it reads a viewport sample and answers whether more history is wanted,
 * and which window would supply it. Fetching, debouncing and anything that
 * touches a chart instance lives outside (see `adapters/`).
 */

import { type LadderStep, buildLadder, nextWider } from "./range-ladder.ts";
import type { ViewportSample } from "./types.ts";

/**
 * How close to the first loaded bar the viewport's left edge may come before
 * more history is requested, in bars.
 *
 * Two rather than zero: waiting for the edge to be exactly reached means the
 * gap is already visible when the fetch starts. A couple of bars of lead time
 * is usually enough for a cached response to land before the user sees a wall.
 */
export const DEFAULT_EXTEND_MARGIN_BARS = 2;

/** Is the viewport's left edge at (or past) the oldest loaded bar? */
export function needsExtend(
  sample: ViewportSample,
  marginBars: number = DEFAULT_EXTEND_MARGIN_BARS
): boolean {
  if (sample.barCount <= 0) return false;
  return sample.range.from <= marginBars;
}

export interface ExtendPlanInput<P extends string> {
  sample: ViewportSample;
  /** The window currently loaded. */
  current: P;
  /** Windows the current bar interval can legally cover, with spans. */
  steps: LadderStep<P>[];
  marginBars?: number;
}

/**
 * How much history the viewport is asking for, as a multiple of what is loaded.
 *
 * `from` running negative is empty space to the left of the oldest bar measured
 * in bars, so the viewport wants `barCount + |from|` of them. Returns 1 when
 * the edge has merely been reached (nothing missing yet).
 */
export function requestedBarRatio(sample: ViewportSample): number {
  if (sample.barCount <= 0) return 1;
  const missing = Math.max(0, -sample.range.from);
  return (sample.barCount + missing) / sample.barCount;
}

/**
 * The window to load next, or null to leave the chart where it is.
 *
 * Picks the NARROWEST rung that actually covers what the viewport is asking
 * for, which for a slow scroll is the next one up and for a fast one may be
 * several rungs at once. Climbing strictly one at a time meant a single flick
 * of the wheel fired a refetch per rung, and every refetch rebuilds the chart —
 * the user saw it flash and re-settle three times on the way to one answer.
 *
 * Null covers both "not near the edge yet" and "already showing the widest
 * window this interval supports" — the caller treats them the same way (do
 * nothing), and only the second is worth surfacing to the user, which it can
 * tell from `nextWider` returning null on its own.
 */
export function planExtend<P extends string>(input: ExtendPlanInput<P>): P | null {
  if (!needsExtend(input.sample, input.marginBars)) return null;

  const ladder = buildLadder(input.steps);
  const next = nextWider(ladder, input.current);
  if (!next) return null;

  const spanOf = new Map(input.steps.map((s) => [s.period, s.spanDays]));
  const currentSpan = spanOf.get(input.current);
  if (currentSpan === undefined || !Number.isFinite(currentSpan)) return next;

  // Bars are assumed evenly spaced, so N times the bars is N times the span.
  // Only an estimate — trading days are not calendar days — but it only has to
  // land on the right rung, and the rungs are far apart.
  const wantedSpan = currentSpan * requestedBarRatio(input.sample);

  for (let i = ladder.indexOf(next); i < ladder.length; i++) {
    if ((spanOf.get(ladder[i]) ?? Number.POSITIVE_INFINITY) >= wantedSpan) return ladder[i];
  }
  // Asking for more than even the widest window holds — give them that.
  return ladder[ladder.length - 1];
}
