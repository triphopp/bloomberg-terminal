import assert from "node:assert/strict";
import { test } from "node:test";

import { calcRealizedVol, inferPeriodsPerYear, rollingPercentRank } from "../indicators/rv-core.ts";
import type { OhlcvBar } from "../types.ts";

const DAY = 86_400;

/** Daily bars whose close alternates ±`step` — |log return| is constant, so
 *  close-to-close RV has a closed form and can be asserted exactly. */
function zigzagBars(n: number, step = 0.01): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    if (i > 0) close = i % 2 === 1 ? close * (1 + step) : close / (1 + step);
    bars.push({
      time: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    });
  }
  // Times must be strictly increasing for the spacing inference; rewrite them
  // from a fixed epoch rather than wrapping the day-of-month.
  return bars.map((b, i) => ({
    ...b,
    time: new Date((19_000 + i) * DAY * 1000).toISOString().slice(0, 10),
  }));
}

test("close-to-close RV matches the closed form on constant-|return| bars", () => {
  const bars = zigzagBars(40);
  const rv = calcRealizedVol(bars, 5, "cc", 252);
  const expected = Math.abs(Math.log(1.01)) * Math.sqrt(252) * 100;
  const last = rv[rv.length - 1];
  assert.ok(last != null);
  assert.ok(Math.abs(last - expected) < 1e-9, `${last} vs ${expected}`);
});

test("RV is null during warm-up and non-null after it", () => {
  const bars = zigzagBars(20);
  const rv = calcRealizedVol(bars, 5, "cc", 252);
  // cc needs a previous close, so the first usable window ends at index 5.
  assert.equal(rv[4], null);
  assert.ok(rv[5] != null);
});

test("parkinson uses the bar range, not the close path", () => {
  // Flat closes: cc RV is zero, but each bar still has a 2% high-low range.
  const bars: OhlcvBar[] = Array.from({ length: 30 }, (_, i) => ({
    time: new Date((19_000 + i) * DAY * 1000).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
  const cc = calcRealizedVol(bars, 10, "cc", 252);
  assert.equal(cc[cc.length - 1], null); // variance 0 → no plottable point

  const pk = calcRealizedVol(bars, 10, "parkinson", 252);
  const hl = Math.log(101 / 99);
  const expected = Math.sqrt((hl * hl) / (4 * Math.LN2)) * Math.sqrt(252) * 100;
  const last = pk[pk.length - 1];
  assert.ok(last != null);
  assert.ok(Math.abs(last - expected) < 1e-9, `${last} vs ${expected}`);
});

test("every estimator produces a finite reading on ordinary OHLC bars", () => {
  const bars: OhlcvBar[] = Array.from({ length: 60 }, (_, i) => {
    const base = 100 + Math.sin(i / 3) * 2;
    return {
      time: new Date((19_000 + i) * DAY * 1000).toISOString().slice(0, 10),
      open: base,
      high: base * 1.012,
      low: base * 0.988,
      close: base * (i % 2 ? 1.004 : 0.996),
      volume: 1,
    };
  });
  for (const est of ["cc", "parkinson", "gk", "rs", "yz"] as const) {
    const rv = calcRealizedVol(bars, 21, est, 252);
    const last = rv[rv.length - 1];
    assert.ok(last != null && Number.isFinite(last) && last > 0, `${est} → ${last}`);
  }
});

test("annualisation factor follows the bar spacing", () => {
  const daily = zigzagBars(30);
  assert.equal(inferPeriodsPerYear(daily), 252);

  const weekly: OhlcvBar[] = Array.from({ length: 30 }, (_, i) => ({
    time: new Date((19_000 + i * 7) * DAY * 1000).toISOString().slice(0, 10),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  }));
  assert.equal(inferPeriodsPerYear(weekly), 52);

  // 5-minute bars as UNIX seconds → 78 bars per 390-minute session.
  const intraday: OhlcvBar[] = Array.from({ length: 30 }, (_, i) => ({
    time: 1_700_000_000 + i * 300,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  }));
  assert.equal(inferPeriodsPerYear(intraday), 252 * 78);
});

test("percentile rank is null until enough history, then ranks against the past", () => {
  const values = Array.from({ length: 12 }, (_, i) => i + 1); // strictly rising
  const ranks = rollingPercentRank(values, 10, 5);
  assert.equal(ranks[4], null); // only 4 prior observations
  // 6th value beats all 5 stored priors.
  assert.equal(ranks[5], 100);

  const falling = rollingPercentRank(
    Array.from({ length: 12 }, (_, i) => 12 - i),
    10,
    5
  );
  assert.equal(falling[5], 0);
});
