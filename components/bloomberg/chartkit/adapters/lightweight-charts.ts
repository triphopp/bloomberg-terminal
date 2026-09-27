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
 *
 * With `inputTarget`, only ranges the USER caused are reported. The engine
 * emits the same event for `fitContent()`, a resize, a `setData()` refill and a
 * restored viewport — and a fitted chart sits exactly on its oldest bar, which
 * reads as "zoomed out to the edge". Unfiltered, every chart load climbed the
 * history ladder by itself (3M → YTD, 1Y → 5Y) without anyone touching it.
 */
export function watchLogicalRange(
  chart: IChartApi,
  onRange: (range: LogicalRange) => void,
  debounceMs = 220,
  inputTarget?: HTMLElement | null
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Last wheel / drag / touch / key on the chart. A range event within the
  // window counts as the user's; kinetic scroll after a drag keeps emitting
  // for a few hundred ms after the pointer lets go, hence not zero.
  const USER_INPUT_WINDOW_MS = 800;
  let lastInput = Number.NEGATIVE_INFINITY;
  const markInput = () => {
    lastInput = Date.now();
  };
  const markDrag = (e: PointerEvent) => {
    if (e.buttons !== 0) markInput();
  };
  const inputEvents: [string, EventListener][] = inputTarget
    ? [
        ["wheel", markInput],
        ["pointerdown", markInput],
        ["pointermove", markDrag as EventListener],
        ["touchstart", markInput],
        ["touchmove", markInput],
        ["keydown", markInput],
      ]
    : [];
  for (const [type, fn] of inputEvents) {
    inputTarget?.addEventListener(type, fn, { capture: true, passive: true });
  }

  const handler = (range: LogicalRange | null) => {
    if (!range) return; // no data on the scale yet
    if (inputTarget && Date.now() - lastInput > USER_INPUT_WINDOW_MS) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRange(range);
    }, debounceMs);
  };

  chart.timeScale().subscribeVisibleLogicalRangeChange(handler);

  return () => {
    if (timer) clearTimeout(timer);
    for (const [type, fn] of inputEvents) {
      inputTarget?.removeEventListener(type, fn, { capture: true });
    }
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
