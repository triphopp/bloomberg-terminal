/**
 * chartkit — lightweight-charts adapter.
 *
 * The ONLY file in chartkit that knows which rendering engine is in use.
 * Everything the library decides is decided in the pure modules; this file
 * turns engine events into `LogicalRange` readings and pushes a saved viewport
 * back onto a chart. Swapping engines means writing a sibling of this file.
 */

import type { IChartApi, Time } from "lightweight-charts";
import type { LogicalRange, TimeRange } from "../types.ts";

/**
 * Call `onRange` whenever the visible bar range changes, trailing-debounced.
 *
 * Debounced because a single wheel gesture emits a range per frame, and each
 * one that slips through while a fetch is already in flight is a duplicate
 * request for history that is on its way. Long enough (220ms) that a fast
 * flick of the wheel is read once, where it stopped, rather than several times
 * on the way. Returns an unsubscribe.
 */
export function watchLogicalRange(
  chart: IChartApi,
  onRange: (range: LogicalRange) => void,
  debounceMs = 220
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handler = (range: LogicalRange | null) => {
    if (!range) return; // no data on the scale yet
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRange(range);
    }, debounceMs);
  };

  chart.timeScale().subscribeVisibleLogicalRangeChange(handler);

  return () => {
    if (timer) clearTimeout(timer);
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  };
}

/**
 * The viewport in TIME, for restoring across a rebuild.
 *
 * Time, not logical indices: extending history prepends bars, so index 0 stops
 * meaning the same bar. The time range the user was looking at survives that;
 * a logical range would silently jump them backwards by however many bars
 * arrived.
 */
export function captureVisibleRange(chart: IChartApi): TimeRange<Time> | null {
  try {
    const range = chart.timeScale().getVisibleRange();
    return range ? { from: range.from, to: range.to } : null;
  } catch {
    return null; // chart already disposed
  }
}

/**
 * Put a captured viewport back. Returns false if the engine rejected it —
 * typically a range that lies entirely outside the data now loaded, in which
 * case the caller should fall back to fitting the content.
 */
export function applyVisibleRange(chart: IChartApi, range: TimeRange<Time>): boolean {
  try {
    chart.timeScale().setVisibleRange({ from: range.from, to: range.to });
    return true;
  } catch {
    return false;
  }
}
