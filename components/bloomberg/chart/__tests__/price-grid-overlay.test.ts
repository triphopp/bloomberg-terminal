import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseBoundaries,
  niceStep,
  periodBoundaries,
  priceLevels,
} from "../price-grid-overlay.ts";
import type { OhlcvBar } from "../types.ts";

// The drawing itself needs a canvas and a live chart; what is testable — and
// what actually decides whether the grid looks like a grid — is where the lines
// go.

// ── niceStep ───────────────────────────────────────────────────────────────

test("a step is rounded up to 1/2/2.5/5 in its own decade", () => {
  assert.equal(niceStep(0.9), 1);
  assert.equal(niceStep(1.1), 2);
  assert.equal(niceStep(2.1), 2.5);
  assert.equal(niceStep(2.6), 5);
  assert.equal(niceStep(6), 10);
});

test("the step scales with the price, not with the number", () => {
  assert.equal(niceStep(230), 250);
  assert.equal(niceStep(0.023), 0.025);
});

test("a nonsensical step asks for no grid rather than an infinite one", () => {
  assert.equal(niceStep(0), 0);
  assert.equal(niceStep(-5), 0);
  assert.equal(niceStep(Number.NaN), 0);
});

// ── priceLevels ────────────────────────────────────────────────────────────

test("levels are round numbers covering the range", () => {
  // A 26-point range over 10 rows wants 2.6 per row, which rounds up to 5.
  assert.deepEqual(priceLevels(97, 123), [100, 105, 110, 115, 120]);
  assert.deepEqual(priceLevels(97, 123, 5), [100, 110, 120]);
});

test("levels never fall outside the visible range", () => {
  for (const level of priceLevels(97.4, 122.6)) {
    assert.ok(level >= 97.4 && level <= 122.6);
  }
});

test("a degenerate range draws nothing, not one arbitrary line", () => {
  assert.deepEqual(priceLevels(100, 100), []);
  assert.deepEqual(priceLevels(120, 100), []);
  assert.deepEqual(priceLevels(Number.NaN, 100), []);
});

// ── periodBoundaries ───────────────────────────────────────────────────────

const daily = (dates: string[]): OhlcvBar[] =>
  dates.map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));

test("daily bars break on the month by default", () => {
  const bars = daily(["2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03", "2026-03-02"]);
  assert.deepEqual(periodBoundaries(bars), [2, 4]);
});

test("a weekly division breaks between trading weeks, across the month too", () => {
  // Fri 2026-01-30 → Mon 2026-02-02 is one week boundary, not two.
  const bars = daily(["2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03"]);
  assert.deepEqual(periodBoundaries(bars, "week"), [3]);
});

test("a daily division breaks on every daily bar", () => {
  const bars = daily(["2026-01-05", "2026-01-06", "2026-01-07"]);
  assert.deepEqual(periodBoundaries(bars, "day"), [1, 2]);
});

test("the first bar is never a boundary — that is the pane edge", () => {
  assert.deepEqual(periodBoundaries(daily(["2026-01-05", "2026-01-06"])), []);
  assert.deepEqual(periodBoundaries(daily(["2026-01-05"])), []);
  assert.deepEqual(periodBoundaries([]), []);
});

test("intraday bars break on the day by default", () => {
  // Unix seconds: two bars on 2026-01-05, then one on the 6th.
  const t = (iso: string): OhlcvBar => ({
    time: Math.floor(Date.parse(iso) / 1000),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  });
  const bars = [
    t("2026-01-05T14:30:00Z"),
    t("2026-01-05T15:30:00Z"),
    t("2026-01-06T14:30:00Z"),
    t("2026-01-06T15:30:00Z"),
  ];
  assert.deepEqual(periodBoundaries(bars), [2]);
});

// ── chooseBoundaries ───────────────────────────────────────────────────────
//
// One fixed division cannot rule every timeframe: months leave a 3M chart with
// two lines, days turn a 5Y chart into a grey wash.

test("a short range drops to a finer division rather than drawing two lines", () => {
  // Ten weeks of Mondays: months give 2 boundaries, weeks give 9.
  const dates: string[] = [];
  for (let i = 0; i < 10; i++) {
    dates.push(new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10));
  }
  const bars = daily(dates);
  assert.equal(periodBoundaries(bars, "month").length, 2);
  assert.deepEqual(chooseBoundaries(bars, 20), periodBoundaries(bars, "week"));
});

test("a long range stays on months once the finer divisions overflow", () => {
  const dates: string[] = [];
  for (let i = 0; i < 60; i++) {
    dates.push(new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10));
  }
  const bars = daily(dates);
  assert.deepEqual(chooseBoundaries(bars, 20), periodBoundaries(bars, "month"));
});

test("no room means no lines", () => {
  assert.deepEqual(chooseBoundaries(daily(["2026-01-05", "2026-02-05"]), 0), []);
});
