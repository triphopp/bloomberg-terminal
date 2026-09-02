/**
 * The chart grid, drawn as our own layer in the price pane only.
 *
 * lightweight-charts has one grid setting for the whole chart — every pane gets
 * it or none does. Masking it back out inside each indicator pane worked, but it
 * left the grid and the thing hiding it sharing one layer and one z-order: the
 * grid was still being drawn under every RSI, and only an ordering rule kept it
 * out of sight.
 *
 * So the built-in grid is off and this draws it instead, attached to the candle
 * series at `zOrder: "bottom"`. A sub-pane has no grid because nothing draws one
 * there — not because something covers it.
 *
 * The two axes come from different places on purpose:
 *
 *   - Horizontal lines are placed on *round prices* (1 / 2 / 2.5 / 5 × 10ⁿ)
 *     picked from the visible range, so they land where the axis labels land.
 *   - Vertical lines are placed on *calendar boundaries* — the first bar of each
 *     month on a daily chart, of each day on an intraday one. That is a real
 *     division of the series rather than a tick every N pixels, so the lines
 *     stay on the same bars while panning instead of sliding through them.
 *
 * Both are drawn as dot rules, the way a LaTeX/TikZ `dotted` grid is: round
 * caps on a zero-length dash. A solid rule at this weight competes with the
 * indicator lines drawn over it; a row of dots reads as a background even at
 * full opacity, and the dots on crossing rules land on a shared lattice because
 * the dash phase is keyed to the canvas origin rather than to each line's start.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { CanvasOverlay, OhlcvBar } from "./types";

/** Roughly how many horizontal lines to aim for; the round-number step decides the rest. */
const TARGET_ROWS = 10;
/** Steps a price grid is allowed to use, per decade. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** The smallest allowed step ≥ `raw`, snapped to a round number. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const decade = 10 ** Math.floor(Math.log10(raw));
  for (const step of NICE_STEPS) {
    if (step * decade >= raw) return step * decade;
  }
  return 10 * decade;
}

/**
 * Round price levels covering [min, max].
 *
 * Returned low to high, and empty for a degenerate range — a pane too short to
 * hold two lines should draw none rather than one arbitrary line.
 */
export function priceLevels(min: number, max: number, targetRows = TARGET_ROWS): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const step = niceStep((max - min) / targetRows);
  if (step <= 0) return [];
  const out: number[] = [];
  // Guard against a pathological step/range ratio producing an unbounded loop.
  for (let level = Math.ceil(min / step) * step; level <= max && out.length < 64; level += step) {
    out.push(level);
  }
  return out;
}

/**
 * Calendar divisions a grid may break on, coarsest first.
 *
 * One fixed granularity cannot serve every timeframe: month boundaries give a
 * 5Y chart a sensible ruling and a 3M chart exactly two lines. The draw picks
 * the finest division that still fits (see `chooseBoundaries`).
 */
export type GridPeriod = "month" | "week" | "day" | "hour";

const MS_PER_DAY = 86_400_000;

/** Calendar key a bar belongs to at the given division. */
function periodKey(time: string | number, period: GridPeriod): string {
  const date =
    typeof time === "number" ? new Date(time * 1000) : new Date(`${time.slice(0, 10)}T00:00:00Z`);
  const y = date.getUTCFullYear();
  if (period === "month") return `${y}-${date.getUTCMonth()}`;
  if (period === "week") {
    // Whole weeks since the epoch, shifted so a week starts on Monday — the
    // epoch itself is a Thursday, and unshifted buckets would break the ruling
    // in the middle of a trading week. No year-boundary special case either: a
    // week straddling New Year stays one week.
    return String(Math.floor((date.getTime() / MS_PER_DAY + 3) / 7));
  }
  const day = `${y}-${date.getUTCMonth()}-${date.getUTCDate()}`;
  return period === "day" ? day : `${day}-${date.getUTCHours()}`;
}

/**
 * Indices of the bars that open a new calendar period.
 *
 * Index 0 is never included: a line on the very first bar is the pane's own edge.
 */
export function periodBoundaries(data: OhlcvBar[], period?: GridPeriod): number[] {
  if (data.length < 2) return [];
  const division = period ?? (typeof data[0].time === "number" ? "day" : "month");
  const out: number[] = [];
  let previous = periodKey(data[0].time, division);
  for (let i = 1; i < data.length; i++) {
    const key = periodKey(data[i].time, division);
    if (key !== previous) out.push(i);
    previous = key;
  }
  return out;
}

/** Coarsest to finest. A division below the bar interval yields nothing and is skipped. */
const PERIOD_ORDER: GridPeriod[] = ["month", "week", "day", "hour"];

/**
 * The finest calendar division whose lines still fit in `maxLines`.
 *
 * Ruling a 3M daily chart on months gives two lines, which is not a grid; ruling
 * a 5Y chart on days gives one per bar, which is a wash. Choosing per draw —
 * from the bars actually loaded and the width actually available — is what lets
 * the same grid density hold across every timeframe.
 */
export function chooseBoundaries(data: OhlcvBar[], maxLines: number): number[] {
  if (maxLines < 1) return [];
  let best: number[] = [];
  for (const period of PERIOD_ORDER) {
    const boundaries = periodBoundaries(data, period);
    if (boundaries.length === 0) continue;
    if (boundaries.length > maxLines) break; // finer divisions only get denser
    best = boundaries;
  }
  return best;
}

/**
 * Thin the boundary list until the lines are at least `minGap` apart.
 *
 * Five years of daily bars is 60 month boundaries; drawn at 3px apart they are
 * not a grid, they are a grey wash. Dropping every other one keeps the spacing
 * legible and the remaining lines still land on real boundaries.
 */
function thin(xs: number[], minGap: number): number[] {
  const kept: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (x - last < minGap) continue;
    kept.push(x);
    last = x;
  }
  return kept;
}

/** Minimum distance between vertical grid lines, in CSS pixels. */
const MIN_VERT_GAP = 30;
/** Centre-to-centre spacing of the dots along a rule, in CSS pixels. */
const DOT_PITCH = 4;

/**
 * Set up a dotted stroke.
 *
 * A zero-length dash with a round cap paints a dot of exactly `lineWidth`
 * across — the same construction TikZ uses for `dotted`. Chrome and Firefox
 * both draw it; Safari has historically dropped zero-length segments, so the
 * dash carries a hair of length to stay a dot everywhere.
 */
function dottedStroke(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.setLineDash([0.01, DOT_PITCH]);
}

export function createPriceGridOverlay(color: string): CanvasOverlay {
  return {
    id: "price-grid",
    name: "Price Grid",
    mode: "full",
    // Under the candles: a grid line crossing a wick is a rendering artefact,
    // not information.
    zOrder: "bottom",
    width: 0, // unused for mode "full"
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      series: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      _isDark: boolean,
      rect: { width: number; height: number }
    ) {
      ctx.save();
      dottedStroke(ctx, color);

      // ── Horizontal: round prices across the visible range ──
      const top = series.coordinateToPrice(0);
      const bottom = series.coordinateToPrice(rect.height);
      if (top != null && bottom != null) {
        for (const level of priceLevels(Math.min(top, bottom), Math.max(top, bottom))) {
          const y = series.priceToCoordinate(level);
          if (y === null || y < 0 || y > rect.height) continue;
          // Half-pixel offset so a 1px line lands on one row of pixels rather
          // than smeared across two.
          const py = Math.round(y) + 0.5;
          // Phase keyed to the canvas origin, not to the line's own start, so
          // every rule puts its dots on the same lattice columns.
          ctx.lineDashOffset = 0;
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(rect.width, py);
          ctx.stroke();
        }
      }

      // ── Vertical: calendar boundaries in the data ──
      const timeScale = chart.timeScale();
      const xs: number[] = [];
      for (const index of chooseBoundaries(data, Math.floor(rect.width / MIN_VERT_GAP))) {
        const x = timeScale.timeToCoordinate(data[index].time as Time);
        if (x === null || x < 0 || x > rect.width) continue;
        xs.push(x);
      }
      for (const x of thin(xs, MIN_VERT_GAP)) {
        const px = Math.round(x) + 0.5;
        ctx.lineDashOffset = 0;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, rect.height);
        ctx.stroke();
      }

      ctx.restore();
    },
  };
}
