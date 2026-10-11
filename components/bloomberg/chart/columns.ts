/**
 * A bar array as columns — built once per array, read by every indicator.
 *
 * Indicators used to start with `data.map((d) => d.close)`: an array of boxed
 * numbers pulled out of 10,000 objects, once per indicator, on every tick
 * (58 µs of EMA's 218 µs at 10,000 bars — more than its arithmetic). The
 * columns here are `Float64Array`s, filled in one pass over the bars and then
 * shared: `barColumns(data)` answers from a WeakMap for the second indicator on.
 *
 * `OhlcvBar[]` stays the public shape. Overlays, lightweight-charts and the
 * fits that hash closed bars still read the array; `columns.bars` is that array.
 *
 * The cache is keyed on the array's identity ON PURPOSE. Rule 5 in
 * indicators/index.ts warns against identity keys for work that should survive
 * a tick — a tick hands over a new array. This view is the opposite case: it
 * belongs to one array and is meant to be rebuilt when the array is.
 *
 * Contract: a bar array is not mutated after it has been handed to the chart
 * (the same contract series-data.ts and React's dependency checks rely on).
 */

import type { OhlcvBar } from "./types";

export interface BarColumns {
  /** The array this view was built from. */
  readonly bars: readonly OhlcvBar[];
  readonly length: number;
  /** `bars[i].time`, untouched: "YYYY-MM-DD" or UNIX seconds. */
  readonly times: readonly (string | number)[];
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  /** `bars[i].volume ?? 0` — a bar without the field reads as no volume. */
  readonly volume: Float64Array;
}

const cache = new WeakMap<readonly OhlcvBar[], BarColumns>();

export function barColumns(bars: readonly OhlcvBar[]): BarColumns {
  const hit = cache.get(bars);
  if (hit) return hit;

  const n = bars.length;
  // One buffer, five views: a single allocation, and the columns of one array
  // are freed together.
  const buf = new Float64Array(n * 5);
  const open = buf.subarray(0, n);
  const high = buf.subarray(n, 2 * n);
  const low = buf.subarray(2 * n, 3 * n);
  const close = buf.subarray(3 * n, 4 * n);
  const volume = buf.subarray(4 * n, 5 * n);
  const times: (string | number)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    times[i] = b.time;
    open[i] = b.open;
    high[i] = b.high;
    low[i] = b.low;
    close[i] = b.close;
    const v = b.volume;
    volume[i] = v == null ? 0 : v;
  }

  const cols: BarColumns = { bars, length: n, times, open, high, low, close, volume };
  cache.set(bars, cols);
  return cols;
}

/** `Object.is` for two doubles: NaN equals NaN, +0 differs from −0. */
export function sameNumber(a: number, b: number): boolean {
  // biome-ignore lint/suspicious/noSelfCompare: the NaN test, without a call
  return a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b;
}

/**
 * How one bar array differs from the one drawn before it — worked out once per
 * refill and shared by every series, instead of each series scanning its own
 * points to find out.
 */
export interface BarsDelta {
  readonly prev: BarColumns;
  readonly next: BarColumns;
  /**
   * The time axis only moved at its end: every bar of `prev` is still at the
   * same index with the same time, and at most one bar — strictly newer —
   * was added. False for history prepended, a different range, another symbol:
   * anything that needs `setData`.
   */
  readonly tail: boolean;
  /**
   * Leading bars identical in time, OHLC and volume. On a live tick this is
   * `prev.length - 1` (the last bar moved) or `prev.length` (a bar was only
   * added). Meaningful only when `tail`.
   */
  readonly sameUntil: number;
}

export function barsDelta(prev: BarColumns, next: BarColumns): BarsDelta {
  const p = prev.length;
  const n = next.length;
  let tail = p > 0 && (n === p || n === p + 1);
  if (tail) {
    const pt = prev.times;
    const nt = next.times;
    for (let i = 0; i < p; i++) {
      if (pt[i] !== nt[i]) {
        tail = false;
        break;
      }
    }
    if (tail && n === p + 1) {
      // `update()` throws unless the appended time is strictly newer. Unix
      // seconds and "YYYY-MM-DD" both order correctly with `>`; any other pair
      // is not compared — full setData (same rule as series-data.ts tailStart).
      const t0 = nt[p - 1];
      const t1 = nt[p];
      const comparable =
        (typeof t0 === "number" && typeof t1 === "number") ||
        (typeof t0 === "string" && typeof t1 === "string");
      tail = comparable && t1 > t0;
    }
  }

  let sameUntil = 0;
  if (tail) {
    const { open: po, high: ph, low: pl, close: pc, volume: pv } = prev;
    const { open: no, high: nh, low: nl, close: nc, volume: nv } = next;
    while (
      sameUntil < p &&
      sameNumber(pc[sameUntil], nc[sameUntil]) &&
      sameNumber(ph[sameUntil], nh[sameUntil]) &&
      sameNumber(pl[sameUntil], nl[sameUntil]) &&
      sameNumber(po[sameUntil], no[sameUntil]) &&
      sameNumber(pv[sameUntil], nv[sameUntil])
    ) {
      sameUntil++;
    }
  }
  return { prev, next, tail, sameUntil };
}
