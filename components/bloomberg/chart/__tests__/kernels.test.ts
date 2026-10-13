/**
 * The typed kernels and the helpers other code imports, against what they
 * replaced — in the manner of rolling.test.ts, except that the reference is
 * not a brute-force formula but the previous implementation itself
 * (./legacy). The operation order is unchanged everywhere, so every
 * comparison is exact: `deepStrictEqual` / `Object.is`, not a tolerance.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bollingerColumns, calcBollingerStats } from "../bollinger-fit.ts";
import { barColumns } from "../columns.ts";
import { calcAtrRegime, latestAtrRegime } from "../indicators/atr.ts";
import { calcEMA } from "../indicators/ema.ts";
import { calcRSIState, rsiColumns } from "../indicators/rsi.ts";
import {
  calcRealizedVol,
  inferPeriodsPerYear,
  percentRank,
  rollingPercentRank,
} from "../indicators/rv-core.ts";
import { calcSMA } from "../indicators/sma.ts";
import { boxed, constant, difference, ema } from "../kernels.ts";
import { rollingMean } from "../rolling.ts";
import type { OhlcvBar } from "../types.ts";
import { datasets, lcg, makeBars } from "./fixtures.ts";
import { calcAtrRegime as legacyAtrRegime } from "./legacy/atr.ts";
import { calcBollingerStats as legacyBollingerStats } from "./legacy/bollinger-stats.ts";
import { calcEMA as legacyEMA } from "./legacy/ema.ts";
import { calcRSIState as legacyRSIState } from "./legacy/rsi.ts";
import {
  rollingPercentRank as legacyPercentRank,
  inferPeriodsPerYear as legacyPeriodsPerYear,
  calcRealizedVol as legacyRealizedVol,
} from "./legacy/rv-core.ts";
import { calcSMA as legacySMA } from "./legacy/sma.ts";

test("indicators read the shared columns — none pulls a field out of the bars itself", () => {
  // `data.map((d) => d.close)` was 58 µs of a 218 µs EMA at 10,000 bars, once
  // per indicator per tick (rule 7 in indicators/index.ts).
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    ...readdirSync(join(dir, "indicators")).map((f) => join(dir, "indicators", f)),
    join(dir, "bollinger-fit.ts"),
    join(dir, "kernels.ts"),
    join(dir, "series-columns.ts"),
  ];
  const own = /\b(data|bars)\.map\(\s*\(?\w+\)?\s*=>\s*\w+\.(open|high|low|close|volume)\b/;
  const found = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, i) => ({ line, at: `${file.slice(dir.length + 1)}:${i + 1}` }))
      .filter(({ line }) => !/^\s*(\*|\/\*)/.test(line)) // doc comments
      .filter(({ line }) => own.test(line.replace(/\/\/.*$/, "")) && !/perf-ok:/.test(line))
      .map(({ line, at }) => `${at} ${line.trim()}`)
  );
  assert.deepEqual(found, [], "use barColumns(data) / the `bars` handed to columnar()");
});

/** A price walk at a level that stresses cancellation, optionally with NaN holes. */
function series(n: number, seed: number, holes = false): number[] {
  const rnd = lcg(seed);
  let p = 50_000;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 10;
    out.push(holes && rnd() < 0.03 ? Number.NaN : p);
  }
  return out;
}

const DATA = datasets();

test("barColumns: one view per array, the bars' own values, missing volume reads 0", () => {
  for (const { name, bars } of DATA) {
    const c = barColumns(bars);
    assert.equal(barColumns(bars), c, `${name}: cached on the array`);
    assert.equal(c.bars, bars);
    assert.equal(c.length, bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      assert.equal(c.times[i], b.time);
      assert.ok(Object.is(c.open[i], b.open), `${name} open ${i}`);
      assert.ok(Object.is(c.high[i], b.high), `${name} high ${i}`);
      assert.ok(Object.is(c.low[i], b.low), `${name} low ${i}`);
      assert.ok(Object.is(c.close[i], b.close), `${name} close ${i}`);
      assert.ok(Object.is(c.volume[i], b.volume ?? 0), `${name} volume ${i}`);
    }
  }
  // A new array with the same bars is a new view: nothing is shared across ticks.
  const bars = makeBars(10);
  assert.notEqual(barColumns([...bars]), barColumns(bars));
});

test("ema kernel equals the boxed loop it replaced, bit for bit", () => {
  for (const holes of [false, true])
    for (const period of [1, 2, 9, 20, 50, 200, 500]) {
      for (const n of [0, 1, period - 1, period, period + 1, 3000]) {
        if (n < 0) continue;
        const v = series(n, period + n + (holes ? 7 : 0), holes);
        assert.deepStrictEqual(calcEMA(v, period), legacyEMA(v, period), `p=${period} n=${n}`);
        const typed = ema(Float64Array.from(v), period);
        const want = legacyEMA(v, period);
        for (let i = 0; i < n; i++) {
          assert.ok(Object.is(typed[i], want[i] ?? Number.NaN), `typed p=${period} n=${n} i=${i}`);
        }
      }
    }
});

test("ema with a start offset equals compacting the prefix away (MACD's signal line)", () => {
  for (const start of [0, 1, 25, 400])
    for (const period of [2, 9, 26]) {
      const tail = series(1200, start * 31 + period, true);
      const padded = [...new Array<number>(start).fill(Number.NaN), ...tail];
      const got = ema(padded, period, start);
      const want = legacyEMA(tail, period);
      for (let i = 0; i < start; i++) assert.ok(Number.isNaN(got[i]));
      for (let i = 0; i < tail.length; i++) {
        assert.ok(
          Object.is(got[start + i], want[i] ?? Number.NaN),
          `s=${start} p=${period} i=${i}`
        );
      }
    }
});

test("rollingMean with a start offset equals compacting the prefix away (stochastic %K → %D)", () => {
  for (const start of [0, 1, 13, 250])
    for (const period of [1, 3, 5, 14]) {
      const tail = series(900, start * 17 + period, true);
      const padded = [...new Array<number>(start).fill(Number.NaN), ...tail];
      const got = rollingMean(padded, period, start);
      const want = rollingMean(tail, period);
      for (let i = 0; i < start; i++) assert.ok(Number.isNaN(got[i]));
      for (let i = 0; i < tail.length; i++) {
        assert.ok(Object.is(got[start + i], want[i]), `s=${start} p=${period} i=${i}`);
      }
    }
});

test("calcSMA keeps its boxed contract", () => {
  for (const holes of [false, true])
    for (const period of [1, 2, 20, 200]) {
      const v = series(1500, period * 3 + (holes ? 1 : 0), holes);
      assert.deepStrictEqual(calcSMA(v, period), legacySMA(v, period));
      assert.deepStrictEqual(calcSMA(v.slice(0, 7), period), legacySMA(v.slice(0, 7), period));
    }
});

test("calcBollingerStats / bollingerColumns equal the boxed version", () => {
  for (const { name, bars } of DATA)
    for (const period of [2, 5, 20, 100, 1, 0, 2.5, Number.NaN]) {
      const want = legacyBollingerStats(bars, period);
      assert.deepStrictEqual(calcBollingerStats(bars, period), want, `${name} p=${period}`);
      const { middle, deviation, from } = bollingerColumns(barColumns(bars).close, period);
      assert.deepStrictEqual(boxed(middle, from), want.middle);
      assert.deepStrictEqual(boxed(deviation, from), want.deviation);
    }
});

test("calcRSIState / rsiColumns equal the object-per-bar version", () => {
  for (const holes of [false, true])
    for (const period of [2, 14, 30, 100]) {
      for (const n of [0, period, period + 1, 2500]) {
        const v = series(n, period + n + (holes ? 3 : 0), holes);
        const want = legacyRSIState(v, period);
        assert.deepStrictEqual(calcRSIState(v, period), want, `p=${period} n=${n}`);
        const { rsi, from } = rsiColumns(v, period);
        assert.equal(from, want.findIndex((s) => s != null) === -1 ? n : period);
        for (let i = 0; i < n; i++) {
          assert.ok(Object.is(rsi[i], want[i]?.rsi ?? Number.NaN), `rsi p=${period} i=${i}`);
        }
      }
    }
  // No down bar in the seed window: pinned at 100, as before.
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.deepStrictEqual(calcRSIState(up, 14), legacyRSIState(up, 14));
});

test("calcRealizedVol, rollingPercentRank and inferPeriodsPerYear keep their values", () => {
  for (const { name, bars } of DATA) {
    assert.equal(inferPeriodsPerYear(bars), legacyPeriodsPerYear(bars), name);
    for (const est of ["cc", "parkinson", "gk", "rs", "yz"] as const)
      for (const period of [1, 2, 5, 21, 63]) {
        const want = legacyRealizedVol(bars, period, est, 252);
        const got = calcRealizedVol(bars, period, est, 252);
        assert.deepStrictEqual(got, want, `${name} ${est} ${period}`);
        for (const [lookback, minObs] of [
          [10, 5],
          [252, 30],
          [0, 1],
        ]) {
          const ranks = legacyPercentRank(want, lookback, minObs);
          assert.deepStrictEqual(rollingPercentRank(got, lookback, minObs), ranks);
          const typed = percentRank(
            Float64Array.from(want, (v) => v ?? Number.NaN),
            lookback,
            minObs
          );
          for (let i = 0; i < ranks.length; i++) {
            assert.ok(Object.is(typed[i], ranks[i] ?? Number.NaN), `${name} rank ${i}`);
          }
        }
      }
  }
});

test("calcAtrRegime keeps its points; latestAtrRegime is its last one", () => {
  for (const { name, bars } of DATA)
    for (const cfg of [
      {},
      { period: 3, lookback: 5, trendPeriod: 5, slopeBars: 2 },
      { period: 2, lookback: 500, trendPeriod: 500, slopeBars: 100, maxRatio: 0.1 },
    ]) {
      // Fresh arrays on both sides: each implementation caches on the array.
      const a = bars.map((b) => ({ ...b })) as OhlcvBar[];
      const want = legacyAtrRegime(a, cfg);
      const got = calcAtrRegime(bars, cfg);
      assert.deepStrictEqual(got, want, `${name} ${JSON.stringify(cfg)}`);
      assert.deepStrictEqual(latestAtrRegime(bars, cfg), want.at(-1));
      assert.equal(calcAtrRegime(bars, cfg), got, "cached per array and settings");
    }
});

test("small kernels: difference, constant, boxed", () => {
  const a = Float64Array.from([5, 6, 7, 8]);
  const b = Float64Array.from([1, 1, Number.NaN, 3]);
  assert.deepStrictEqual([...difference(a, b, 1)], [Number.NaN, 5, Number.NaN, 5]);
  assert.deepStrictEqual(
    [...difference(a, b, 9)],
    [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
  );
  assert.deepStrictEqual([...constant(4, 50, 2)], [Number.NaN, Number.NaN, 50, 50]);
  assert.deepStrictEqual([...constant(2, 1, -3)], [1, 1]);
  assert.deepStrictEqual(boxed(b, 1), [null, 1, Number.NaN, 3]);
  assert.deepStrictEqual(boxed(b, 10), [null, null, null, null]);
});
