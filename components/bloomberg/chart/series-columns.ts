/**
 * Typed series columns ⇄ point objects.
 *
 * An indicator's output used to be born as point objects: a boxed
 * `(number | null)[]` per line, then `data.map(...).filter(...)` into
 * `{ time, value }` — 1.5 MB per EMA call at 10,000 bars, every tick, for a
 * chart that then sent ONE of those points to the library. A columnar
 * indicator (`ChartIndicator.columns`) returns `SeriesColumns` instead: the
 * values stay in a `Float64Array`, and points are built here, in one pass into
 * a preallocated array, only for the slots someone asks for.
 *
 * The points built are exactly the ones the old code built — same slots, same
 * fields, NaN where it sent NaN. `__tests__/indicator-equivalence.test.ts`
 * holds every converted indicator to its previous implementation.
 */

import { barColumns, sameNumber } from "./columns.ts";
import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorSeriesOutput,
  SeriesColumns,
  SeriesDataPoint,
  WhitespaceDataPoint,
} from "./types";

export type SeriesPoint = SeriesDataPoint | HistogramDataPoint | WhitespaceDataPoint;
type Times = readonly (string | number)[];

/** Does slot `i` carry a point (not whitespace)? */
export function hasPoint(s: SeriesColumns, i: number): boolean {
  if (i < s.from) return false;
  const emit = s.emit;
  if (emit === "all") return true;
  if (emit === "valued") {
    const v = s.values[i];
    // biome-ignore lint/suspicious/noSelfCompare: the NaN test, without a call
    return v === v;
  }
  return emit[i] !== 0;
}

/** What slot `i` sends to the series: a point, whitespace, or nothing (null). */
export function itemAt(s: SeriesColumns, times: Times, i: number): SeriesPoint | null {
  if (i < s.from) return null;
  if (!hasPoint(s, i)) return s.whitespace ? { time: times[i] } : null;
  return s.colors && s.palette
    ? { time: times[i], value: s.values[i], color: s.palette[s.colors[i]] }
    : { time: times[i], value: s.values[i] };
}

/** Last slot below `n` that sends something, or -1. */
export function lastItemSlot(s: SeriesColumns, n: number): number {
  if (n <= s.from) return -1;
  if (s.whitespace || s.emit === "all") return n - 1;
  for (let i = n - 1; i >= s.from; i--) if (hasPoint(s, i)) return i;
  return -1;
}

/**
 * The points of slots `start .. times.length - 1`, oldest first — what
 * `compute()` returns as `data` when `start` is 0.
 */
export function seriesPoints(s: SeriesColumns, times: Times, start = 0): SeriesPoint[] {
  const n = times.length;
  const lo = Math.ceil(Math.max(start, s.from, 0));
  if (lo >= n) return [];
  const { values, emit, colors, palette } = s;
  const whitespace = s.whitespace === true;
  const all = emit === "all";
  const mask = typeof emit === "string" ? null : emit;

  let count = n - lo;
  if (!all && !whitespace) {
    count = 0;
    if (mask) {
      for (let i = lo; i < n; i++) if (mask[i] !== 0) count++;
    } else {
      for (let i = lo; i < n; i++) {
        const v = values[i];
        // biome-ignore lint/suspicious/noSelfCompare: the NaN test, without a call
        if (v === v) count++;
      }
    }
  }

  const out: SeriesPoint[] = new Array(count);
  let j = 0;
  if (all && !colors) {
    // The common line: every slot, no colour. Kept apart so the loop has no
    // branch in it.
    for (let i = lo; i < n; i++) out[j++] = { time: times[i], value: values[i] };
    return out;
  }
  for (let i = lo; i < n; i++) {
    const v = values[i];
    // biome-ignore lint/suspicious/noSelfCompare: the NaN test, without a call
    const present = all || (mask ? mask[i] !== 0 : v === v);
    if (present) {
      out[j++] =
        colors && palette
          ? { time: times[i], value: v, color: palette[colors[i]] }
          : { time: times[i], value: v };
    } else if (whitespace) {
      out[j++] = { time: times[i] };
    }
  }
  return out;
}

/** `SeriesColumns` with every point built — the shape `compute()` returns. */
export function toSeriesOutput(s: SeriesColumns, times: Times): IndicatorSeriesOutput {
  const { values: _v, from: _f, emit: _e, whitespace: _w, colors: _c, palette: _p, ...meta } = s;
  return { ...meta, data: seriesPoints(s, times) };
}

/**
 * Both halves of a columnar indicator from one function:
 *
 *   const indicator: ChartIndicator = {
 *     id, name, …,
 *     ...columnar((bars, config) => [{ id, label, type: "line", values, from, emit: "all" }]),
 *     causal: true,
 *   };
 *
 * `compute` is `columns` with every point built, so the two cannot disagree.
 * Neither uses `this`: indicator instances are copied with a spread when a
 * runtime config is patched in (useChartIndicators).
 */
export function columnar(
  columns: NonNullable<ChartIndicator["columns"]>
): Pick<ChartIndicator, "columns" | "compute"> {
  return {
    columns,
    compute(data, config) {
      const bars = barColumns(data);
      return columns(bars, config).map((s) => toSeriesOutput(s, bars.times));
    },
  };
}

export function isCausal(indicator: ChartIndicator): boolean {
  const c = indicator.causal;
  return typeof c === "function" ? c(indicator.config) : c === true;
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Two column sets that can be compared slot by slot: same warm-up, same rule
 * for which slots send a point, same colours behind the same indices.
 */
export function sameLayout(a: SeriesColumns, b: SeriesColumns): boolean {
  return (
    a.from === b.from &&
    (typeof a.emit === "string" ? a.emit === b.emit : typeof b.emit !== "string") &&
    (a.whitespace === true) === (b.whitespace === true) &&
    !a.colors === !b.colors &&
    sameStrings(a.palette, b.palette)
  );
}

/**
 * First slot below `end` whose item differs between two column sets with the
 * same layout, or `end` when none does. A tight loop over typed arrays — the
 * whole reason this is ~100× cheaper than comparing point objects field by
 * field. Conservative: a slot that sends nothing still counts as different if
 * its stored value, colour index or mask bit is.
 */
export function firstItemDiff(a: SeriesColumns, b: SeriesColumns, end: number): number {
  let k = Math.min(end, a.values.length, b.values.length);
  const lo = Math.ceil(Math.max(0, a.from));
  const av = a.values;
  const bv = b.values;
  for (let i = lo; i < k; i++) {
    if (!sameNumber(av[i], bv[i])) {
      k = i;
      break;
    }
  }
  if (typeof a.emit !== "string" && typeof b.emit !== "string") {
    const am = a.emit;
    const bm = b.emit;
    for (let i = lo; i < k; i++) {
      if (am[i] !== bm[i]) {
        k = i;
        break;
      }
    }
  }
  if (a.colors && b.colors) {
    const ac = a.colors;
    const bc = b.colors;
    for (let i = lo; i < k; i++) {
      if (ac[i] !== bc[i]) {
        k = i;
        break;
      }
    }
  }
  return k;
}
