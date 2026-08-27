/**
 * chartkit — this repo's own charting library.
 *
 * Today it holds the viewport/history logic that lightweight-charts does not
 * provide; the engine itself is still lightweight-charts. Read `README.md`
 * before adding to it — the split between the pure core and `adapters/` is the
 * whole point of the folder.
 */

export {
  DEFAULT_EXTEND_MARGIN_BARS,
  type ExtendPlanInput,
  needsExtend,
  planExtend,
  requestedBarRatio,
} from "./auto-extend.ts";
export {
  DEFAULT_PREFETCH_LEAD_RATIO,
  type PrefetchPlanInput,
  isApproachingEdge,
  planPrefetch,
} from "./prefetch.ts";
export { type LadderStep, buildLadder, nextWider } from "./range-ladder.ts";
export type { LogicalRange, TimeRange, ViewportSample } from "./types.ts";
