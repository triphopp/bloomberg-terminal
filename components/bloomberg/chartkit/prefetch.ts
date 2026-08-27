/**
 * chartkit — "warm the next window before it is asked for".
 *
 * Borrowed from how a game streams the next LOD: the moment the current level
 * is on screen, the next one starts loading, so crossing the boundary costs a
 * buffer swap instead of a load. Here the levels are history windows — by the
 * time the viewport reaches the oldest bar, the wider window is already in the
 * query cache and the extend is a re-render, not a round trip.
 *
 * Pure: it only says WHICH window to warm. Who does the warming (React Query,
 * a service worker, anything) is the caller's business.
 */

import { planExtend } from "./auto-extend.ts";
import { type LadderStep, buildLadder, nextWider } from "./range-ladder.ts";
import type { ViewportSample } from "./types.ts";

/**
 * How close to the oldest bar the viewport must come before the next window is
 * warmed, as a fraction of the visible span.
 *
 * 0.5 = start loading when the left edge is within half a screen of the data's
 * left edge. Early enough that a slow scroll never touches the wall, late
 * enough that idly looking at recent bars does not pull years of history.
 */
export const DEFAULT_PREFETCH_LEAD_RATIO = 0.5;

/** Is the viewport within the lead distance of the oldest loaded bar? */
export function isApproachingEdge(
  sample: ViewportSample,
  leadRatio: number = DEFAULT_PREFETCH_LEAD_RATIO
): boolean {
  if (sample.barCount <= 0) return false;
  const visibleSpan = sample.range.to - sample.range.from;
  if (visibleSpan <= 0) return false;
  return sample.range.from <= visibleSpan * leadRatio;
}

export interface PrefetchPlanInput<P extends string> {
  /** Omit to ask "what is one rung ahead", ignoring where the viewport is. */
  sample?: ViewportSample;
  current: P;
  steps: LadderStep<P>[];
  leadRatio?: number;
}

/**
 * The window worth warming, or null if there is nothing to warm.
 *
 * Only ever ONE window at a time, never the whole ladder: warming everything
 * wider would pull a MAX request for a chart nobody is looking past, and MAX is
 * the most expensive response the backend serves.
 *
 * With a sample it warms the window that gesture would actually land on —
 * asked the same way `planExtend` asks, just from further out (the lead
 * distance stands in for the extend margin). Warming the next rung instead
 * would be wrong for exactly the case that needs it most: a hard flick skips
 * rungs, and the one it skipped to is the one worth having ready. Without a
 * sample the question is "what is next", and the answer is the next rung.
 */
export function planPrefetch<P extends string>(input: PrefetchPlanInput<P>): P | null {
  if (!input.sample) return nextWider(buildLadder(input.steps), input.current);
  if (!isApproachingEdge(input.sample, input.leadRatio)) return null;

  const visibleSpan = input.sample.range.to - input.sample.range.from;
  return planExtend({
    sample: input.sample,
    current: input.current,
    steps: input.steps,
    marginBars: visibleSpan * (input.leadRatio ?? DEFAULT_PREFETCH_LEAD_RATIO),
  });
}
