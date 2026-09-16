import assert from "node:assert/strict";
import test from "node:test";
import { fmtWeight, navBreakdown, weightPct } from "../weights.ts";

test("weights of every holding plus cash sum to 100%", () => {
  const b = navBreakdown({ equityValues: [600, 250], optionValues: [50], cash: 100 });
  assert.equal(b.nav, 1000);
  const total = [600, 250, 50, 100].reduce((s, v) => s + (weightPct(v, b.nav) ?? 0), 0);
  assert.equal(Math.round(total * 1e9) / 1e9, 100);
});

test("selling moves weight into cash, other rows do not jump", () => {
  const before = navBreakdown({ equityValues: [500, 500], optionValues: [], cash: 0 });
  const after = navBreakdown({ equityValues: [500], optionValues: [], cash: 500 });
  assert.equal(weightPct(500, before.nav), weightPct(500, after.nav));
});

test("unpriced positions are counted, not silently zeroed into the NAV", () => {
  const b = navBreakdown({
    equityValues: [100, null, Number.NaN],
    optionValues: [undefined],
    cash: 0,
  });
  assert.equal(b.nav, 100);
  assert.equal(b.unpriced, 3);
});

test("cash unknown is flagged and treated as zero", () => {
  const b = navBreakdown({ equityValues: [100], optionValues: [], cash: null });
  assert.equal(b.cashKnown, false);
  assert.equal(b.nav, 100);
});

test("negative delta exposure keeps its sign; no NAV → null", () => {
  assert.equal(weightPct(-80, 1000), -8);
  assert.equal(weightPct(10, 0), null);
  assert.equal(weightPct(null, 1000), null);
});

test("formatting", () => {
  assert.equal(fmtWeight(12.34), "12.3%");
  assert.equal(fmtWeight(0.4251), "0.43%");
  assert.equal(fmtWeight(0.004), "<0.01%");
  assert.equal(fmtWeight(-8), "-8.0%");
  assert.equal(fmtWeight(null), "—");
});
