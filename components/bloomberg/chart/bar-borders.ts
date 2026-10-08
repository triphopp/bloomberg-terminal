/**
 * Candles an overlay wants marked (`CanvasOverlay.barBorders`) — the S/D trap
 * bars, so far.
 *
 * Only the BORDER takes the mark's colour. The body and the wick keep their
 * up / down colour: that is the bar's own statement about price, and a reader
 * of supply and demand needs it on exactly these bars.
 *
 * lightweight-charts takes a border colour per candle on the data point, so
 * the bars are marked on their way into the candle series, not drawn over
 * afterwards: the candle keeps the library's own width and pixel snapping at
 * every zoom. (Zoomed far out a candle is too thin to have a body inside its
 * border — the library then draws the bar in the border colour alone.)
 *
 * Returns `bars` itself when nothing is marked. Otherwise a new array that
 * shares every unmarked bar with `bars` and holds a COPY of each marked one —
 * the caller's bars are read by every indicator and must stay as they are.
 * `setSeriesData` compares points field by field, so a bar that gains or loses
 * its mark falls back to a full `setData` by itself.
 */

import type { CanvasOverlay, OhlcvBar } from "./types";

export type OutlinedBar = OhlcvBar & { borderColor?: string };

export function outlineBars(bars: OhlcvBar[], overlays: readonly CanvasOverlay[]): OutlinedBar[] {
  let out: OutlinedBar[] | null = null;
  for (const overlay of overlays) {
    const borders = overlay.barBorders?.(bars);
    if (!borders || borders.size === 0) continue;
    for (const [i, borderColor] of borders) {
      if (i < 0 || i >= bars.length) continue;
      out ??= bars.slice();
      // Later overlays win: `out[i]` may already be a marked copy.
      out[i] = { ...out[i], borderColor };
    }
  }
  return out ?? bars;
}
