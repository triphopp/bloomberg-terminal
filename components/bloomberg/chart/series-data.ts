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
 */

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

export function setSeriesData<P>(series: SeriesLike<P>, next: P[]): void {
  const prev = lastPushed.get(series);
  const from = prev && prev !== next ? tailStart(prev, next) : -1;
  if (from < 0) series.setData(next.map(copy));
  else for (let i = from; i < next.length; i++) series.update(copy(next[i]));
  lastPushed.set(series, next);
}
