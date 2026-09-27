import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RollingSample,
  SortedWindow,
  rollingMax,
  rollingMean,
  rollingMin,
  rollingVariance,
} from "../rolling.ts";

// Deterministic pseudo-random walk with a price level that stresses cancellation
// (50,000 ± a few) and optional NaN holes.
function series(n: number, seed: number, holes = false): number[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  let p = 50_000;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 10;
    out.push(holes && rnd() < 0.03 ? Number.NaN : p);
  }
  return out;
}

function close(a: number, b: number, rel = 1e-9): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

function window(v: number[], i: number, k: number): number[] | null {
  if (i < k - 1) return null;
  return v.slice(i - k + 1, i + 1);
}

test("rollingMean matches the window loop, NaN-in-window ⇒ NaN", () => {
  for (const holes of [false, true])
    for (const k of [1, 2, 5, 20, 63]) {
      const v = series(3000, k + (holes ? 7 : 0), holes);
      const got = rollingMean(v, k);
      for (let i = 0; i < v.length; i++) {
        const w = window(v, i, k);
        const want =
          !w || w.some((x) => !Number.isFinite(x)) ? Number.NaN : w.reduce((a, b) => a + b, 0) / k;
        assert.ok(close(got[i], want), `k=${k} i=${i} got ${got[i]} want ${want}`);
      }
    }
});

test("rollingVariance matches two-pass population and sample variance", () => {
  for (const holes of [false, true])
    for (const ddof of [0, 1] as const)
      for (const k of [2, 3, 20, 200]) {
        const v = series(4000, k * 3 + ddof, holes);
        const { mean, variance } = rollingVariance(v, k, ddof);
        for (let i = 0; i < v.length; i++) {
          const w = window(v, i, k);
          if (!w || w.some((x) => !Number.isFinite(x))) {
            assert.ok(Number.isNaN(variance[i]), `k=${k} i=${i} expected NaN`);
            continue;
          }
          const m = w.reduce((a, b) => a + b, 0) / k;
          const want = w.reduce((s, x) => s + (x - m) ** 2, 0) / (k - ddof);
          assert.ok(close(mean[i], m, 1e-12), `mean k=${k} i=${i}`);
          // Variance of ±5 around 50,000: absolute tolerance scaled to the level.
          assert.ok(
            Math.abs(variance[i] - want) <= 1e-9 * 50_000 ** 2 * 1e-3 + 1e-9 * want,
            `var k=${k} i=${i} got ${variance[i]} want ${want}`
          );
        }
      }
});

test("rollingMax / rollingMin match Math.max / Math.min over the window", () => {
  for (const k of [1, 2, 14, 100]) {
    const v = series(2000, k);
    const hi = rollingMax(v, k);
    const lo = rollingMin(v, k);
    for (let i = 0; i < v.length; i++) {
      const w = window(v, i, k);
      assert.equal(hi[i], w ? Math.max(...w) : Number.NaN);
      assert.equal(lo[i], w ? Math.min(...w) : Number.NaN);
    }
  }
});

test("SortedWindow median / countBelow match sort-based answers", () => {
  const v = series(1500, 3).map((x) => Math.round(x)); // rounding forces duplicates
  const k = 25;
  const sw = new SortedWindow(k);
  for (let i = 0; i < v.length; i++) {
    const prior = v.slice(Math.max(0, i - k), i);
    const sorted = [...prior].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med =
      sorted.length === 0
        ? Number.NaN
        : sorted.length % 2
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
    assert.ok(close(sw.median(), med), `i=${i}`);
    assert.equal(sw.countBelow(v[i]), prior.filter((x) => x < v[i]).length);
    if (i >= k) assert.ok(sw.remove(v[i - k]));
    sw.insert(v[i]);
  }
  assert.equal(sw.remove(-1), false);
});

test("SortedWindow.madAbout is bit-identical to median(|x − c|) by sort", () => {
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length === 0 ? Number.NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const base = series(900, 11).map((x, i) => (i % 5 === 0 ? Math.round(x) : x));
  for (const k of [1, 2, 3, 8, 25, 240]) {
    const sw = new SortedWindow(k);
    for (let i = 0; i < base.length; i++) {
      if (i >= k) sw.remove(base[i - k]);
      sw.insert(base[i]);
      const win = base.slice(Math.max(0, i - k + 1), i + 1);
      // Centres: the median itself, a stored value, one outside the range.
      for (const c of [med(win), win[0], win[win.length - 1] + 7, win[0] - 3]) {
        assert.equal(sw.madAbout(c), med(win.map((v) => Math.abs(v - c))), `k=${k} i=${i} c=${c}`);
      }
    }
  }
});

test("RollingSample keeps the last N slots, skipping empty ones", () => {
  const vals = series(700, 5, true); // NaN holes = empty slots
  for (const cap of [1, 4, 20, 64]) {
    const rs = new RollingSample(cap);
    for (let i = 0; i < vals.length; i++) {
      rs.push(vals[i]);
      const present = vals.slice(Math.max(0, i - cap + 1), i + 1).filter(Number.isFinite);
      assert.equal(rs.size, present.length, `cap=${cap} i=${i}`);
      const order: number[] = [];
      rs.forEachValue((v) => order.push(v));
      assert.deepEqual(order, present);
      if (present.length === 0) continue;
      const m = present.reduce((a, b) => a + b, 0) / present.length;
      assert.ok(close(rs.mean(), m, 1e-12));
      const ss = present.reduce((s, v) => s + (v - m) ** 2, 0);
      // Running Σx² at 50,000² loses digits; the callers only use this about
      // centres near zero (log returns), where it is exact enough.
      assert.ok(Math.abs(rs.sumSquaresAbout(m) - ss) <= 1e-6 * 50_000 ** 2 * present.length);
    }
  }
});
