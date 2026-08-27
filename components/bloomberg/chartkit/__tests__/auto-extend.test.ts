import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_EXTEND_MARGIN_BARS,
  needsExtend,
  planExtend,
  requestedBarRatio,
} from "../auto-extend.ts";
import { buildLadder, nextWider } from "../range-ladder.ts";

// ── buildLadder ────────────────────────────────────────────────────────────

test("buildLadder orders windows narrowest first", () => {
  const ladder = buildLadder([
    { period: "1y", spanDays: 365 },
    { period: "1m", spanDays: 30 },
    { period: "max", spanDays: Number.POSITIVE_INFINITY },
    { period: "3m", spanDays: 90 },
  ]);
  assert.deepEqual(ladder, ["1m", "3m", "1y", "max"]);
});

// Same span = same rung. Keeping both would let auto-extend "widen" into a
// window holding the same bars and immediately try again.
test("buildLadder drops equal-span duplicates", () => {
  const ladder = buildLadder([
    { period: "3m", spanDays: 90 },
    { period: "ytd", spanDays: 90 },
    { period: "1y", spanDays: 365 },
  ]);
  assert.deepEqual(ladder, ["3m", "1y"]);
});

// ── nextWider ──────────────────────────────────────────────────────────────

test("nextWider climbs one rung", () => {
  assert.equal(nextWider(["1m", "3m", "1y", "max"], "3m"), "1y");
});

test("nextWider returns null at the top of the ladder", () => {
  assert.equal(nextWider(["1m", "3m", "1y", "max"], "max"), null);
});

test("nextWider returns null for a window that is off the ladder", () => {
  assert.equal(nextWider(["1m", "3m", "1y"], "5y"), null);
});

// ── needsExtend ────────────────────────────────────────────────────────────
//
// `from` is a bar index and runs NEGATIVE into the whitespace left of the data.
// That is the signal: the user has zoomed out past what is loaded.

test("needsExtend is false while the viewport sits inside the data", () => {
  assert.equal(needsExtend({ range: { from: 40, to: 120 }, barCount: 250 }), false);
});

test("needsExtend is true once the left edge reaches the margin", () => {
  assert.equal(
    needsExtend({ range: { from: DEFAULT_EXTEND_MARGIN_BARS, to: 120 }, barCount: 250 }),
    true
  );
});

test("needsExtend is true when the viewport runs past the oldest bar", () => {
  assert.equal(needsExtend({ range: { from: -30, to: 120 }, barCount: 250 }), true);
});

test("needsExtend honours a custom margin", () => {
  const sample = { range: { from: 8, to: 120 }, barCount: 250 };
  assert.equal(needsExtend(sample, 2), false);
  assert.equal(needsExtend(sample, 10), true);
});

// An empty chart must not ask for more history: there is nothing to be at the
// edge of, and the request would fire on every mount before the first fetch.
test("needsExtend is false with no bars loaded", () => {
  assert.equal(needsExtend({ range: { from: -5, to: 5 }, barCount: 0 }), false);
});

// ── planExtend ─────────────────────────────────────────────────────────────

const STEPS = [
  { period: "1m" as const, spanDays: 30 },
  { period: "3m" as const, spanDays: 90 },
  { period: "1y" as const, spanDays: 365 },
  { period: "max" as const, spanDays: Number.POSITIVE_INFINITY },
];

test("planExtend picks the next window when the edge is reached", () => {
  assert.equal(
    planExtend({
      sample: { range: { from: -4, to: 60 }, barCount: 90 },
      current: "3m",
      steps: STEPS,
    }),
    "1y"
  );
});

test("planExtend does nothing away from the edge", () => {
  assert.equal(
    planExtend({
      sample: { range: { from: 30, to: 60 }, barCount: 90 },
      current: "3m",
      steps: STEPS,
    }),
    null
  );
});

test("planExtend does nothing on the widest window", () => {
  assert.equal(
    planExtend({
      sample: { range: { from: -4, to: 60 }, barCount: 5000 },
      current: "max",
      steps: STEPS,
    }),
    null
  );
});

// ── planExtend: multi-rung jumps ───────────────────────────────────────────
//
// Every rung costs a refetch, and every refetch rebuilds the chart. A fast
// scroll that lands three windows out must arrive in ONE jump, not flash
// through the two in between.

test("planExtend jumps straight to the rung that covers a fast scroll", () => {
  // 90 bars loaded (3m) with ~630 bars of empty space to the left: the viewport
  // wants roughly 8x what is loaded, which is past 1y and into 5y.
  assert.equal(
    planExtend({
      sample: { range: { from: -630, to: 60 }, barCount: 90 },
      current: "3m",
      steps: [...STEPS, { period: "5y" as const, spanDays: 1825 }],
    }),
    "5y"
  );
});

test("planExtend still moves one rung for a slow scroll", () => {
  assert.equal(
    planExtend({
      sample: { range: { from: -1, to: 60 }, barCount: 90 },
      current: "3m",
      steps: STEPS,
    }),
    "1y"
  );
});

test("planExtend tops out at the widest window when asked for more than exists", () => {
  assert.equal(
    planExtend({
      sample: { range: { from: -99999, to: 60 }, barCount: 90 },
      current: "3m",
      steps: [
        { period: "1m" as const, spanDays: 30 },
        { period: "3m" as const, spanDays: 90 },
        { period: "1y" as const, spanDays: 365 },
      ],
    }),
    "1y"
  );
});

// ── requestedBarRatio ──────────────────────────────────────────────────────

test("requestedBarRatio is 1 when the edge is merely reached", () => {
  assert.equal(requestedBarRatio({ range: { from: 0, to: 60 }, barCount: 90 }), 1);
});

test("requestedBarRatio counts the empty space left of the oldest bar", () => {
  assert.equal(requestedBarRatio({ range: { from: -90, to: 60 }, barCount: 90 }), 2);
});
