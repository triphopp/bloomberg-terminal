/**
 * Numeric kernels on typed columns — the arithmetic of the indicators, apart
 * from how their points are built (series-columns.ts) and from the windowed
 * statistics (rolling.ts).
 *
 * Shape, as in rolling.ts: `ArrayLike<number>` in, a `Float64Array` of the
 * same length out, NaN where there is no value yet. No boxed arrays, no
 * objects per bar. A full recompute of one series is ~14 µs per 10,000 bars
 * in this form — which is why nothing here keeps state between ticks.
 *
 * Every kernel that replaced an older implementation performs the same
 * operations in the same order, so its results are bit-identical
 * (`__tests__/kernels.test.ts`). Keep it that way when touching one: the
 * alert scanner's mirror of these indicators (backend/alerts/operands.py)
 * is checked against the numbers the chart draws.
 */

/**
 * Exponential moving average, seeded with the plain mean of the first
 * `period` values; the first value is at `start + period - 1`.
 *
 * `start` skips a leading stretch that is not part of the series (see
 * rollingMean) — MACD's signal line is the EMA of a line that itself begins
 * after a warm-up.
 */
export function ema(values: ArrayLike<number>, period: number, start = 0): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const first = start + period - 1;
  if (!(period >= 1) || n - start < period) return out.fill(Number.NaN);
  out.fill(Number.NaN, 0, first);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = start; i <= first; i++) sum += values[i];
  let e = sum / period;
  out[first] = e;
  for (let i = first + 1; i < n; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** `a[i] - b[i]` from `from` on, NaN before. */
export function difference(a: ArrayLike<number>, b: ArrayLike<number>, from: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  const lo = Math.min(Math.ceil(Math.max(0, from)), n);
  out.fill(Number.NaN, 0, lo);
  for (let i = lo; i < n; i++) out[i] = a[i] - b[i];
  return out;
}

/** A flat line: `value` from `from` on, NaN before. */
export function constant(n: number, value: number, from: number): Float64Array {
  const out = new Float64Array(n);
  const lo = Math.min(Math.ceil(Math.max(0, from)), n);
  out.fill(Number.NaN, 0, lo);
  out.fill(value, lo);
  return out;
}

/** The boxed form older callers expect: `null` before `from`, the value after. */
export function boxed(values: ArrayLike<number>, from: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n);
  const lo = Math.min(Math.ceil(Math.max(0, from)), n);
  for (let i = 0; i < lo; i++) out[i] = null;
  for (let i = lo; i < n; i++) out[i] = values[i];
  return out;
}
