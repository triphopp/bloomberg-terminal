import assert from "node:assert/strict";
import { test } from "node:test";

import type { RsiState } from "../indicators/rsiInverse.ts";
import type { RsiScaleBasis } from "../indicators/rsiScale.ts";
import { inferPriceDecimals, rsiAxisFormatter, rsiLevelPreview } from "../indicators/rsiScale.ts";

// Same worked example as the inverse tests: close 150, avgGain 1.20,
// avgLoss 0.90, period 14 — current RSI 57.14, RSI 70 sits at 161.70.
const STATE: RsiState = { rsi: (100 * 1.2) / 2.1, avgGain: 1.2, avgLoss: 0.9 };
const BASIS: RsiScaleBasis = { close: 150, state: STATE, period: 14, decimals: 2 };

test("standard and autofit leave the axis in rsi units", () => {
  assert.equal(rsiAxisFormatter("standard", BASIS), null);
  assert.equal(rsiAxisFormatter("autofit", BASIS), null);
});

test("price mode labels each level with the close that reaches it", () => {
  const fmt = rsiAxisFormatter("price", BASIS);
  assert.ok(fmt);
  assert.equal(fmt(70), "161.70");
  assert.equal(fmt(30), "125.30");
  // The current rsi maps back to the current close — the branch seam.
  assert.equal(fmt(STATE.rsi), "150.00");
});

test("pct mode is that same projection as a move from the close", () => {
  const fmt = rsiAxisFormatter("pct", BASIS);
  assert.ok(fmt);
  assert.equal(fmt(70), "7.8%");
  assert.equal(fmt(30), "-16.5%");
});

test("avgmoves mode divides the gap by one bar's average movement", () => {
  const fmt = rsiAxisFormatter("avgmoves", BASIS);
  assert.ok(fmt);
  // 11.70 / (1.2 + 0.9) = 5.571…
  assert.equal(fmt(70), "5.6x");
});

test("log rs needs no state — it is a reparametrisation of the axis", () => {
  const fmt = rsiAxisFormatter("logrs", null);
  assert.ok(fmt, "log rs must work with no bars loaded");
  assert.equal(fmt(50), "0.00");
  // Symmetric: 70 and 30 are equal and opposite in log RS, unlike in price.
  assert.equal(fmt(70), (-Number(fmt(30))).toFixed(2));
});

test("unreachable levels are marked, not printed as a wrong number", () => {
  const fmt = rsiAxisFormatter("price", BASIS);
  assert.ok(fmt);
  // Below the floor (8.798…) the next close would have to be negative.
  assert.equal(fmt(5), "—");
  assert.equal(fmt(0), "—");
  assert.equal(fmt(100), "—");
});

test("a flat window formats as unreachable rather than dividing by zero", () => {
  const flat: RsiScaleBasis = {
    close: 150,
    state: { rsi: Number.NaN, avgGain: 0, avgLoss: 0 },
    period: 14,
    decimals: 2,
  };
  for (const mode of ["price", "pct", "avgmoves"] as const) {
    const fmt = rsiAxisFormatter(mode, flat);
    assert.ok(fmt);
    assert.equal(fmt(70), "—", `${mode} should refuse a flat window`);
  }
});

test("modes needing a projection fall back to rsi units with no basis", () => {
  assert.equal(rsiAxisFormatter("price", null), null);
  assert.equal(rsiAxisFormatter("pct", null), null);
  assert.equal(rsiAxisFormatter("avgmoves", null), null);
});

test("the preview line states the level, the price and the move", () => {
  assert.equal(rsiLevelPreview(70, BASIS), "RSI 70 → 161.70 (+7.8%)");
  assert.equal(rsiLevelPreview(30, BASIS), "RSI 30 → 125.30 (-16.5%)");
  assert.equal(rsiLevelPreview(5, BASIS), "RSI 5 — unreachable in one bar");
  assert.equal(rsiLevelPreview(70, null), "RSI 70 — no data");
});

test("decimals are read off the data, not assumed", () => {
  assert.equal(inferPriceDecimals([150, 151.25, 149.5]), 2);
  assert.equal(inferPriceDecimals([1.23456, 1.2, 1.3]), 4);
  // Whole numbers still print to 2 — an index at "54086" reads worse as "54086".
  assert.equal(inferPriceDecimals([54086, 54100]), 2);
});
