import assert from "node:assert/strict";
import { test } from "node:test";

import { applyInterval, applyPeriod, arrowShortcutAllowed, stepIn } from "../useChartTimeframe.ts";

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

test("stepIn moves one place and stops at the ends", () => {
  const list = ["a", "b", "c"] as const;
  assert.equal(stepIn(list, "b", 1), "c");
  assert.equal(stepIn(list, "c", 1), "c");
  assert.equal(stepIn(list, "a", -1), "a");
  assert.equal(stepIn(list, "b", -1), "a");
  assert.equal(stepIn<string>(list, "zz", 1), "a");
});

test("arrow shortcuts stay out of typing, used keys, modifiers and owned controls", () => {
  const ev = (over: Partial<Parameters<typeof arrowShortcutAllowed>[0]> = {}) => ({
    key: "ArrowUp",
    defaultPrevented: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...over,
  });
  const el = (tagName: string, owned = false, editable = false) =>
    ({
      tagName,
      isContentEditable: editable,
      closest: () => (owned ? {} : null),
    }) as unknown as EventTarget;
  assert.equal(arrowShortcutAllowed(ev()), true);
  assert.equal(arrowShortcutAllowed(ev({ target: el("BUTTON") })), true);
  assert.equal(arrowShortcutAllowed(ev({ key: "a" })), false);
  assert.equal(arrowShortcutAllowed(ev({ defaultPrevented: true })), false);
  assert.equal(arrowShortcutAllowed(ev({ shiftKey: true })), false);
  assert.equal(arrowShortcutAllowed(ev({ target: el("INPUT") })), false);
  assert.equal(arrowShortcutAllowed(ev({ target: el("DIV", false, true) })), false);
  assert.equal(arrowShortcutAllowed(ev({ target: el("DIV", true) })), false);
});
