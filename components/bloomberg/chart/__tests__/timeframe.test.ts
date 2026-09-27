import assert from "node:assert/strict";
import { test } from "node:test";

import { applyInterval, applyPeriod } from "../useChartTimeframe.ts";

test("an interval that forces a period gives the hand-picked one back afterwards", () => {
  // 3M on 1D → 1W (cannot show 3M, forced to MAX) → 1D: back to 3M, not MAX.
  const toWeekly = applyInterval("1wk", "3m", "3m");
  assert.deepEqual(toWeekly, { barInterval: "1wk", timePeriod: "max" });
  assert.deepEqual(applyInterval("1d", toWeekly.timePeriod, "3m"), {
    barInterval: "1d",
    timePeriod: "3m",
  });
});

test("a period the new interval can show is kept", () => {
  assert.deepEqual(applyInterval("1wk", "5y", "5y"), { barInterval: "1wk", timePeriod: "5y" });
  assert.deepEqual(applyInterval("1d", "1y"), { barInterval: "1d", timePeriod: "1y" });
});

test("without a hand-picked period the old behaviour stands", () => {
  assert.deepEqual(applyInterval("1wk", "3m"), { barInterval: "1wk", timePeriod: "max" });
  assert.deepEqual(applyInterval("1m", "1y", "1y"), { barInterval: "1m", timePeriod: "1d" });
});

test("applyPeriod still moves an interval that cannot cover the period", () => {
  assert.deepEqual(applyPeriod("max", "1h"), { timePeriod: "max", barInterval: "1wk" });
});
