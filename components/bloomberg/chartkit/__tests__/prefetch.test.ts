import assert from "node:assert/strict";
import { test } from "node:test";

import { isApproachingEdge, planPrefetch } from "../prefetch.ts";

const STEPS = [
  { period: "1m" as const, spanDays: 30 },
  { period: "3m" as const, spanDays: 90 },
  { period: "1y" as const, spanDays: 365 },
  { period: "5y" as const, spanDays: 1825 },
  { period: "max" as const, spanDays: Number.POSITIVE_INFINITY },
];

// ── isApproachingEdge ──────────────────────────────────────────────────────

test("isApproachingEdge is false in the middle of the data", () => {
  assert.equal(isApproachingEdge({ range: { from: 400, to: 500 }, barCount: 900 }), false);
});

test("isApproachingEdge is true within half a screen of the oldest bar", () => {
  // 100 bars visible, left edge 40 bars from the start: inside the 50-bar lead.
  assert.equal(isApproachingEdge({ range: { from: 40, to: 140 }, barCount: 900 }), true);
});

test("isApproachingEdge honours a custom lead", () => {
  const sample = { range: { from: 40, to: 140 }, barCount: 900 };
  assert.equal(isApproachingEdge(sample, 0.1), false);
  assert.equal(isApproachingEdge(sample, 0.9), true);
});

// ── planPrefetch ───────────────────────────────────────────────────────────

test("planPrefetch without a sample warms the next rung", () => {
  assert.equal(planPrefetch({ current: "3m", steps: STEPS }), "1y");
});

test("planPrefetch without a sample warms nothing at the top", () => {
  assert.equal(planPrefetch({ current: "max", steps: STEPS }), null);
});

test("planPrefetch stays quiet while the viewport is nowhere near the edge", () => {
  assert.equal(
    planPrefetch({
      sample: { range: { from: 400, to: 500 }, barCount: 900 },
      current: "3m",
      steps: STEPS,
    }),
    null
  );
});

test("planPrefetch warms the next rung as the edge comes into view", () => {
  assert.equal(
    planPrefetch({
      sample: { range: { from: 20, to: 80 }, barCount: 90 },
      current: "3m",
      steps: STEPS,
    }),
    "1y"
  );
});

// The case a "one rung ahead" prefetch gets wrong: a viewport already many
// times wider than its window will skip rungs when it extends, so the rung
// worth having cached is the one it will land on.
test("planPrefetch warms the rung a fast approach will actually land on", () => {
  assert.equal(
    planPrefetch({
      sample: { range: { from: -400, to: 600 }, barCount: 90 },
      current: "3m",
      steps: STEPS,
    }),
    "5y"
  );
});
