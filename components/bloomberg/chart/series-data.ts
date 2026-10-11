/**
 * `setData` only when it has to be.
 *
 * A live tick changes the LAST bar (or appends one), yet every tick used to
 * hand each series its whole array again: `setData` re-indexes and re-copies
 * every point. Measured on the MKT chart (5Y daily, 1,246 bars, EMA 20/50 +
 * volume, dev build): a tick refill cost 5.6 ms, of which the candle series'
 * `setData` alone was 2.05 ms — against 0.057 ms for `update(lastBar)`.
 *
 * This remembers the array last pushed to each series and, when the new one
 * is that array with only its last point changed and/or one point appended,
 * pushes just those points through `update()`. Anything else — a different
 * length, a changed earlier point (history prepended, an indicator whose past
 * values move, a recolour) — falls back to `setData`, so the series always
 * ends up holding exactly `next`. Points are compared field by field, not by
 * reference: callers rebuild their point objects every render.
 *
 * lightweight-charts MUTATES the points it is given — after `setData` a
 * "YYYY-MM-DD" `time` has become a BusinessDay object and an
 * `_internal_originalTime` field has been added. So it only ever receives
 * COPIES: the caller's bars stay exactly as built (string times) for the
 * indicators and overlays that read the same array afterwards, and the
 * caller's array itself is the baseline for the next comparison. A full push
 * copies every point (as the old in-place mutation effectively cost); a tail
 * push copies one or two.
 *
 * Contract: callers must not mutate an array or its points after pushing it.
 *
 * ── Two ways in ──────────────────────────────────────────────────────────────
 *
 * `setSeriesData(series, points)` is the above: point objects, compared field
 * by field against the last push (`tailStart`). It serves the candle series
 * and every indicator that only has `compute()` — the ones that repaint
 * (zigzag, S/D zones) or carry labels. (The candle series skips the
 * comparison when the caller passes the bars' own delta — see the function.)
 *
 * `setSeriesColumns(series, columns, bars, delta, causal)` is for a columnar
 * indicator (`ChartIndicator.columns`). The comparison above cost more than
 * the indicators did — 5.9 ms of a 9.6 ms tick at 10,000 bars with eight
 * indicators — because it walks every point of every series. Here nothing is
 * walked that does not have to be:
 *
 *   - the bars are compared ONCE per refill (`barsDelta`, chart/columns.ts);
 *     unless the time axis only moved at its end, it is `setData`, as before;
 *   - a `causal` indicator is then taken at its word: slots before the first
 *     changed bar are unchanged, so only the last one or two are sent;
 *   - any other columnar indicator has its typed columns compared with the
 *     previous ones (`firstItemDiff` — a loop over two Float64Arrays), which
 *     finds the same answer `tailStart` did;
 *   - in both cases the points sent are built for those slots alone.
 *
 * The copy contract holds without copies on this path: the points handed to
 * the library are built for that call and never read again, and the baseline
 * for the next comparison is the typed columns, which the library never sees.
 */

import type { BarColumns, BarsDelta } from "./columns.ts";
import {
  firstItemDiff,
  hasPoint,
  itemAt,
  lastItemSlot,
  sameLayout,
  seriesPoints,
} from "./series-columns.ts";
import type { SeriesColumns } from "./types";

export interface SeriesLike<P> {
  setData(data: P[]): void;
  update(point: P): void;
}

/** Per series: the caller's array last pushed (never handed to LW itself). */
const lastPushed = new WeakMap<object, readonly unknown[]>();

const copy = <P>(p: P): P => ({ ...(p as object) }) as P;

/** Same own enumerable fields with identical values (`Object.is`). */
function samePoint(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!Object.hasOwn(ra, k)) continue;
    if (!Object.hasOwn(rb, k) || !Object.is(ra[k], rb[k])) return false;
    n++;
  }
  for (const k in rb) if (Object.hasOwn(rb, k)) n--;
  return n === 0;
}

/**
 * Index of the first point `update()` must send, or -1 when only `setData`
 * can produce `next` from `prev`.
 */
export function tailStart(prev: readonly unknown[], next: readonly unknown[]): number {
  const p = prev.length;
  const n = next.length;
  if (p === 0 || (n !== p && n !== p + 1)) return -1;
  // Every point before the old last one must be unchanged.
  for (let i = 0; i < p - 1; i++) if (!samePoint(prev[i], next[i])) return -1;
  // A replaced last point must keep its time — `update()` with a new time
  // appends instead of replacing.
  const oldLast = prev[p - 1] as { time?: unknown };
  const newAtLast = next[p - 1] as { time?: unknown };
  if (!Object.is(oldLast?.time, newAtLast?.time)) return -1;
  if (n === p + 1) {
    // An appended point must be strictly newer, or `update()` throws. Unix
    // seconds and "YYYY-MM-DD" both order correctly with `>`; any other time
    // shape (BusinessDay objects) is not compared — full setData.
    const t0 = oldLast?.time;
    const t1 = (next[p] as { time?: unknown })?.time;
    const comparable =
      (typeof t0 === "number" && typeof t1 === "number") ||
      (typeof t0 === "string" && typeof t1 === "string");
    if (!comparable || !((t1 as number | string) > (t0 as number | string))) return -1;
  }
  return samePoint(prev[p - 1], next[p - 1]) ? p : p - 1;
}

/**
 * `delta` is for a series whose points ARE the bars — the candle series, when
 * no overlay has marked a bar (bar-borders.ts). If the last push and this one
 * are the very arrays `delta` compares, it already says where they first
 * differ in time, OHLC or volume — everything a candle is drawn from — and the
 * scan would only find the same index again. For any other pair of arrays the
 * delta is ignored.
 */
export function setSeriesData<P>(series: SeriesLike<P>, next: P[], delta?: BarsDelta | null): void {
  const prev = lastPushed.get(series);
  let from = -1;
  if (prev && prev !== next) {
    if (delta && delta.prev.bars === prev && delta.next.bars === next) {
      if (delta.tail && delta.sameUntil >= prev.length - 1) from = delta.sameUntil;
    } else {
      from = tailStart(prev, next);
    }
  }
  if (from < 0) series.setData(next.map(copy));
  else for (let i = from; i < next.length; i++) series.update(copy(next[i]));
  lastPushed.set(series, next);
}

// ── Columnar series ──────────────────────────────────────────────────────────

interface PushedColumns {
  cols: SeriesColumns;
  bars: BarColumns;
  /** Last slot that sent a point or whitespace, -1 when the series is empty. */
  last: number;
}

/** Per series: the columns last pushed and the bars they were computed on. */
const lastColumns = new WeakMap<object, PushedColumns>();

/**
 * First slot `update()` must send for `next` to replace what the series holds,
 * or -1 when only `setData` can do it.
 *
 * `delta` must describe the step from the bars of the last push to `bars`;
 * anything else (no delta, a delta for other arrays, a time axis that did not
 * simply grow) is -1.
 */
export function columnsTailStart(
  prev: PushedColumns | undefined,
  next: SeriesColumns,
  bars: BarColumns,
  delta: BarsDelta | null | undefined,
  causal: boolean
): number {
  if (!prev || prev.last < 0 || !delta || !delta.tail) return -1;
  if (delta.prev !== prev.bars || delta.next !== bars) return -1;
  if (!sameLayout(prev.cols, next)) return -1;
  const p = delta.prev.length;
  // Causal: the indicator vouches for every slot before the first changed bar.
  // Otherwise, and whenever a closed bar changed, look.
  const k =
    causal && delta.sameUntil >= p - 1 ? delta.sameUntil : firstItemDiff(prev.cols, next, p);
  // `update()` can replace the last item or add after it — nothing earlier,
  // and it cannot take the last item away.
  if (k < prev.last) return -1;
  if (k === prev.last && !next.whitespace && !hasPoint(next, k)) return -1;
  return k;
}

/**
 * Point `series` at `next`: `update()` for the changed tail when that is
 * enough, `setData` otherwise. The series always ends up holding exactly the
 * points of `next`.
 */
export function setSeriesColumns<P>(
  series: SeriesLike<P>,
  next: SeriesColumns,
  bars: BarColumns,
  delta?: BarsDelta | null,
  causal = false
): void {
  const n = bars.length;
  const from = columnsTailStart(lastColumns.get(series), next, bars, delta, causal);
  if (from < 0) {
    series.setData(seriesPoints(next, bars.times) as P[]);
  } else {
    for (let i = from; i < n; i++) {
      const item = itemAt(next, bars.times, i);
      if (item) series.update(item as P);
    }
  }
  lastColumns.set(series, { cols: next, bars, last: lastItemSlot(next, n) });
}
