import assert from "node:assert/strict";
import test from "node:test";
import { fmtZ, focusOrder, marketLive, zScore, zTone } from "../day-context.ts";

test("a +3% day on a 2% sigma book is 1.5 sigma", () => {
  assert.equal(zScore(3, 2), 1.5);
  assert.equal(zScore(-1, 2), -0.5);
});

test("no sigma or no move gives no z-score, never Infinity", () => {
  assert.equal(zScore(3, null), null);
  assert.equal(zScore(3, 0), null);
  assert.equal(zScore(null, 2), null);
  assert.equal(zScore(Number.NaN, 2), null);
});

test("tone bands: under 1 quiet, 1 to 2 normal, 2 and over watch — either direction", () => {
  assert.equal(zTone(0.94), "quiet");
  assert.equal(zTone(-1), "normal");
  assert.equal(zTone(1.94), "normal");
  assert.equal(zTone(1.99), "watch"); // prints as 2.0σ, so it is coloured as 2.0σ
  assert.equal(zTone(-2), "watch");
  assert.equal(zTone(null), null);
});

test("z is printed signed, one decimal, approximate when the price moves in steps", () => {
  assert.equal(fmtZ(1.52), "+1.5σ");
  assert.equal(fmtZ(-0.31), "−0.3σ");
  assert.equal(fmtZ(0.04), "0.0σ");
  assert.equal(fmtZ(-0.04), "0.0σ");
  assert.equal(fmtZ(12.4), "+12σ");
  assert.equal(fmtZ(0.84, true), "≈+0.8σ");
  assert.equal(fmtZ(null), "");
});

test("a market is live only when something is trading", () => {
  assert.equal(marketLive("REGULAR", false), true);
  assert.equal(marketLive("POST", true), true);
  assert.equal(marketLive("PRE", false), false); // SET before the open
  assert.equal(marketLive("POSTPOST", true), false);
  assert.equal(marketLive("CLOSED", false), false);
  assert.equal(marketLive(null, false), null); // unknown is not closed
});

test("live accounts come first and both halves keep their order", () => {
  const g = ["fin", "dime", "inx", "x"];
  assert.deepEqual(
    focusOrder(g, (k) => k === "dime" || k === "x"),
    ["dime", "x", "fin", "inx"]
  );
});

test("nothing live or everything live leaves the order alone", () => {
  const g = ["fin", "dime"];
  assert.equal(
    focusOrder(g, () => false),
    g
  );
  assert.equal(
    focusOrder(g, () => true),
    g
  );
});
