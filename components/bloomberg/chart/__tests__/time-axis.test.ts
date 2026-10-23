import assert from "node:assert/strict";
import { test } from "node:test";

import { tickMarkFormatter } from "../time-axis.ts";

const MONTH = 1;

test("month tick carries its number as a subscript", () => {
  assert.equal(tickMarkFormatter("2026-03-02", MONTH, "en-US"), "Mar₃");
  assert.equal(tickMarkFormatter({ year: 2025, month: 11, day: 3 }, MONTH, "en-US"), "Nov₁₁");
  // 2026-07-01T00:00:00Z — read in UTC, as the axis does
  assert.equal(tickMarkFormatter(1782864000 as never, MONTH, "en-US"), "Jul₇");
});

test("every other tick keeps the library's label", () => {
  for (const kind of [0, 2, 3, 4]) {
    assert.equal(tickMarkFormatter("2026-03-02", kind, "en-US"), null);
  }
});
