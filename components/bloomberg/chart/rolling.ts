/**
 * Rolling-window statistics in O(1) amortised per bar (median / rank: O(log k)
 * search + one typed-array shift).
 *
 * Every indicator that needs "the last k bars" goes through here instead of
 * re-reading the window at each bar. The naive form — `slice(i - k + 1, i + 1)`
 * then reduce/sort/`Math.max(...)` — is O(N·k): on a MAX chart with a 200-bar
 * window it is 200× the work, runs on every live tick, and allocates a fresh
 * array per bar for the GC to chase. See `__tests__/indicator-rules.test.ts`
 * for the rules this enforces and `__tests__/rolling.test.ts` for the
 * brute-force equivalence proofs.
 *
 * Numerics: running sums drift by one rounding per add/remove. Each helper
 * re-sums the window exactly once every `k` bars, so drift is bounded by k
 * operations and the amortised cost stays O(1). Outputs agree with the
 * two-pass window formulas to ~1e-12 relative.
 */

/**
 * Mean of the last `period` values ending at each index. NaN during warm-up,
 * and NaN wherever the window holds any non-finite value (matching a plain
 * loop that bails on the first NaN).
 */
export function rollingMean(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(Number.NaN);
  if (period < 1) return out;
  let sum = 0;
  let bad = 0; // non-finite values inside the window
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v;
    else bad++;
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) sum -= old;
      else bad--;
    }
    if (i < period - 1) continue;
    if (i % period === 0) sum = exactSum(values, i - period + 1, i);
    out[i] = bad > 0 ? Number.NaN : sum / period;
  }
  return out;
}

/**
 * Variance of the last `period` values ending at each index, about the window
 * mean. `ddof` 0 = population (Bollinger), 1 = sample (realized vol). NaN
 * during warm-up or when the window holds a non-finite value.
 *
 * Sliding Welford update rather than E[x²] − E[x]²: the latter cancels
 * catastrophically on prices like 50,000 ± 5 and can go negative.
 */
export function rollingVariance(
  values: ArrayLike<number>,
  period: number,
  ddof: 0 | 1 = 0
): { mean: Float64Array; variance: Float64Array } {
  const n = values.length;
  const mean = new Float64Array(n).fill(Number.NaN);
  const variance = new Float64Array(n).fill(Number.NaN);
  if (period < 1 || period - ddof < 1) return { mean, variance };

  let bad = 0;
  let m = 0; // window mean
  let m2 = 0; // sum of squared deviations about m
  let synced = false; // m/m2 describe exactly the current (all-finite) window
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) bad++;
    if (i >= period && !Number.isFinite(values[i - period])) bad--;
    if (i < period - 1) continue;
    if (bad > 0) {
      synced = false;
      continue;
    }
    const lo = i - period + 1;
    if (!synced || i % period === 0) {
      // Exact two-pass over the window: first full window, after a NaN left
      // it, and once per `period` bars to wipe accumulated drift.
      m = exactSum(values, lo, i) / period;
      m2 = 0;
      for (let j = lo; j <= i; j++) m2 += (values[j] - m) * (values[j] - m);
      synced = true;
    } else {
      const old = values[i - period];
      const next = m + (v - old) / period;
      m2 += (v - old) * (v - next + old - m);
      m = next;
    }
    if (m2 < 0) m2 = 0;
    mean[i] = m;
    variance[i] = m2 / (period - ddof);
  }
  return { mean, variance };
}

/**
 * Highest / lowest of the last `period` values ending at each index —
 * monotone deque, each index enters and leaves once. NaN during warm-up.
 * Inputs must be finite (a NaN never compares, so it would stick in the deque).
 */
export function rollingMax(values: ArrayLike<number>, period: number): Float64Array {
  return rollingExtreme(values, period, true);
}

export function rollingMin(values: ArrayLike<number>, period: number): Float64Array {
  return rollingExtreme(values, period, false);
}

function rollingExtreme(values: ArrayLike<number>, period: number, max: boolean): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(Number.NaN);
  if (period < 1) return out;
  const dq = new Int32Array(n); // indices, values monotone from head to tail
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    while (tail > head && (max ? values[dq[tail - 1]] <= v : values[dq[tail - 1]] >= v)) tail--;
    dq[tail++] = i;
    if (dq[head] <= i - period) head++;
    if (i >= period - 1) out[i] = values[dq[head]];
  }
  return out;
}

/**
 * A bounded window kept in sorted order — median, rank and quantile without
 * sorting per bar. Insert / remove are a binary search plus one
 * `copyWithin` (a memmove the CPU does at cache speed); no allocation after
 * construction.
 */
export class SortedWindow {
  private readonly buf: Float64Array;
  private n = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(Math.max(1, capacity));
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  /** How many stored values are strictly below `v`. */
  countBelow(v: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(v: number): void {
    if (this.n === this.buf.length) throw new RangeError("SortedWindow full");
    const at = this.countBelow(v);
    this.buf.copyWithin(at + 1, at, this.n);
    this.buf[at] = v;
    this.n++;
  }

  /** Remove one copy of `v`. Returns false if it was not stored. */
  remove(v: number): boolean {
    const at = this.countBelow(v);
    if (at >= this.n || this.buf[at] !== v) return false;
    this.buf.copyWithin(at, at + 1, this.n);
    this.n--;
    return true;
  }

  /** Median as the sorted-array formula gives it; NaN when empty. */
  median(): number {
    const n = this.n;
    if (n === 0) return Number.NaN;
    const mid = n >> 1;
    return n % 2 ? this.buf[mid] : (this.buf[mid - 1] + this.buf[mid]) / 2;
  }

  /** The i-th smallest stored value (0-based). */
  at(i: number): number {
    return this.buf[i];
  }

  /**
   * Median of |x − c| over the stored values — the MAD — without building or
   * sorting the distance list.
   *
   * Values below c give distances c − x that ASCEND walking left from c;
   * values at/above c give x − c that ascend walking right. The k-th smallest
   * distance is the k-th smallest of two sorted sequences: a binary search on
   * how many come from the left side, O(log k). Distances are computed with
   * the same single subtraction `Math.abs(v - c)` performs, so the result is
   * bit-identical to the sort-based formula.
   */
  madAbout(c: number): number {
    const n = this.n;
    if (n === 0) return Number.NaN;
    const mid = n >> 1;
    if (n % 2) return this.kthDistance(c, mid);
    return (this.kthDistance(c, mid - 1) + this.kthDistance(c, mid)) / 2;
  }

  private kthDistance(c: number, k: number): number {
    const buf = this.buf;
    const p = this.countBelow(c); // buf[0..p) < c <= buf[p..n)
    const a = p; // left sequence length: L[i] = c - buf[p - 1 - i]
    const b = this.n - p; // right sequence length: R[j] = buf[p + j] - c
    const L = (i: number) => c - buf[p - 1 - i];
    const R = (j: number) => buf[p + j] - c;
    // Take i from L and k + 1 - i from R; find the i where the split is valid.
    let lo = Math.max(0, k + 1 - b);
    let hi = Math.min(k + 1, a);
    while (lo < hi) {
      const i = (lo + hi) >> 1;
      const j = k + 1 - i;
      // Too few from L: the next L is smaller than the last R taken.
      if (j > 0 && i < a && L(i) < R(j - 1)) lo = i + 1;
      else hi = i;
    }
    const i = lo;
    const j = k + 1 - i;
    const fromL = i > 0 ? L(i - 1) : Number.NEGATIVE_INFINITY;
    const fromR = j > 0 ? R(j - 1) : Number.NEGATIVE_INFINITY;
    return fromL > fromR ? fromL : fromR;
  }
}

/**
 * The last `capacity` SLOTS of a stream, some of which may be empty — the
 * shape every "prior N bars" baseline has: a bar with no volume still takes
 * its place in the window, it just contributes no value. `push(NaN)` records
 * an empty slot.
 *
 * Sorted view for median / MAD / quantiles, running sum and sum of squares
 * (re-summed exactly once per `capacity` pushes to cancel drift), and the
 * chronological ring for the rare statistic that needs the values in order.
 */
export class RollingSample {
  readonly sorted: SortedWindow;
  private readonly ring: Float64Array;
  private head = 0; // index of the oldest slot
  private slots = 0; // slots filled, ≤ capacity
  private sum = 0;
  private sumSq = 0;
  private pushes = 0;

  readonly capacity: number;

  constructor(capacity: number) {
    const cap = Math.max(1, Math.floor(capacity));
    this.capacity = cap;
    this.sorted = new SortedWindow(cap);
    this.ring = new Float64Array(cap);
  }

  /** Values present (empty slots excluded). */
  get size(): number {
    return this.sorted.size;
  }

  push(v: number): void {
    const cap = this.ring.length;
    if (this.slots === cap) {
      const old = this.ring[this.head];
      if (Number.isFinite(old)) {
        this.sorted.remove(old);
        this.sum -= old;
        this.sumSq -= old * old;
      }
      this.ring[this.head] = v;
      this.head = (this.head + 1) % cap;
    } else {
      this.ring[(this.head + this.slots) % cap] = v;
      this.slots++;
    }
    if (Number.isFinite(v)) {
      this.sorted.insert(v);
      this.sum += v;
      this.sumSq += v * v;
    }
    if (++this.pushes % cap === 0) this.resync();
  }

  median(): number {
    return this.sorted.median();
  }

  /** Arithmetic mean of the present values, in chronological order. */
  mean(): number {
    const n = this.size;
    return n === 0 ? Number.NaN : this.sum / n;
  }

  /** Σ(x − c)² over present values via running sums: Σx² − 2cΣx + nc². */
  sumSquaresAbout(c: number): number {
    const v = this.sumSq - 2 * c * this.sum + this.size * c * c;
    return v > 0 ? v : 0;
  }

  /** Visit present values oldest → newest (O(k); for rare fallbacks only). */
  forEachValue(fn: (v: number) => void): void {
    const cap = this.ring.length;
    for (let s = 0; s < this.slots; s++) {
      const v = this.ring[(this.head + s) % cap];
      if (Number.isFinite(v)) fn(v);
    }
  }

  private resync(): void {
    let s = 0;
    let q = 0;
    this.forEachValue((v) => {
      s += v;
      q += v * v;
    });
    this.sum = s;
    this.sumSq = q;
  }
}

/** Sum of the finite values in [lo, hi] — non-finite ones are counted separately by the callers. */
function exactSum(values: ArrayLike<number>, lo: number, hi: number): number {
  let s = 0;
  for (let j = lo; j <= hi; j++) if (Number.isFinite(values[j])) s += values[j];
  return s;
}
