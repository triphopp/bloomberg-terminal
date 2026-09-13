import assert from "node:assert/strict";
import { test } from "node:test";

import { toRuns } from "../regime-runs.ts";

// The regime chart draws one shaded band per RUN, not per bar: 500 bars would
// mean 500 SVG rects, and the run form is also what makes a regime's DURATION
// visible. Everything else in that file is Recharts.

test("consecutive bars in one state collapse into a single run", () => {
  assert.deepEqual(toRuns([0, 0, 0]), [{ state: 0, from: 0, to: 2 }]);
});

test("each change starts a new run, and the boundaries do not overlap", () => {
  assert.deepEqual(toRuns([0, 0, 1, 1, 1, 2]), [
    { state: 0, from: 0, to: 1 },
    { state: 1, from: 2, to: 4 },
    { state: 2, from: 5, to: 5 },
  ]);
});

test("a state that comes back gets its own run, not the earlier one extended", () => {
  // Merging them would draw one band across the middle state and hide the
  // excursion entirely.
  assert.deepEqual(toRuns([1, 0, 1]), [
    { state: 1, from: 0, to: 0 },
    { state: 0, from: 1, to: 1 },
    { state: 1, from: 2, to: 2 },
  ]);
});

test("runs cover every bar exactly once", () => {
  const states = [0, 0, 1, 2, 2, 2, 1, 1, 0];
  const runs = toRuns(states);
  const covered = runs.flatMap((r) =>
    Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i)
  );
  assert.deepEqual(
    covered,
    states.map((_, i) => i)
  );
  for (const run of runs) {
    for (let i = run.from; i <= run.to; i++) assert.equal(states[i], run.state);
  }
});

test("an empty series has no runs", () => {
  assert.deepEqual(toRuns([]), []);
});
