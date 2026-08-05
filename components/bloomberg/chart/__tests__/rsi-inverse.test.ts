import assert from "node:assert/strict";
import { test } from "node:test";

import { calcRSIState } from "../indicators/rsi.ts";
import { priceForRsi, rsiFloor, rsiForPrice } from "../indicators/rsiInverse.ts";
import type { RsiState } from "../indicators/rsiInverse.ts";

const PERIOD = 14;

// Worked by hand: close 150, avgGain 1.20, avgLoss 0.90, period 14. Current RSI
// is 100·1.2/2.1 = 57.14, so k = 13, k·avgGain = 15.6, k·avgLoss = 11.7.
const CLOSE = 150;
const STATE: RsiState = { rsi: (100 * 1.2) / 2.1, avgGain: 1.2, avgLoss: 0.9 };

function price(target: number): number {
  const p = priceForRsi(CLOSE, STATE, PERIOD, target);
  assert.ok(p, `expected a projection for rsi ${target}`);
  return p.price;
}

test("matches prices worked out by hand", () => {
  assert.ok(Math.abs(price(70) - 161.7) < 1e-9);
  assert.ok(Math.abs(price(50) - 146.1) < 1e-9);
  assert.ok(Math.abs(price(40) - 138.3) < 1e-9);
  assert.ok(Math.abs(price(30) - 125.3) < 1e-9);
  assert.ok(Math.abs(price(20) - 99.3) < 1e-9);
});

test("picks the branch from the required move, not from the caller", () => {
  assert.equal(priceForRsi(CLOSE, STATE, PERIOD, 70)?.direction, "up");
  assert.equal(priceForRsi(CLOSE, STATE, PERIOD, 30)?.direction, "down");
});

test("the two branches meet at the current rsi", () => {
  const seam = priceForRsi(CLOSE, STATE, PERIOD, STATE.rsi);
  assert.ok(seam);
  assert.ok(Math.abs(seam.price - CLOSE) < 1e-9);
});

test("round-trips through the forward map", () => {
  for (const target of [9, 15, 25, 40, 57.14285714285714, 60, 75, 88, 97]) {
    const p = priceForRsi(CLOSE, STATE, PERIOD, target);
    assert.ok(p, `no projection for ${target}`);
    const back = rsiForPrice(CLOSE, STATE, PERIOD, p.price);
    assert.ok(back !== null);
    assert.ok(Math.abs(back - target) < 1e-9, `${target} came back as ${back}`);
  }
});

test("floor is where the next close would hit zero", () => {
  const floor = rsiFloor(CLOSE, STATE, PERIOD);
  assert.ok(floor !== null);
  // 100 · 15.6 / (15.6 + 11.7 + 150)
  assert.ok(Math.abs(floor - 8.798646362098138) < 1e-9);

  // Just above the floor still resolves, and lands just above zero.
  const reachable = priceForRsi(CLOSE, STATE, PERIOD, floor + 1e-6);
  assert.ok(reachable);
  assert.ok(reachable.price > 0 && reachable.price < 0.01);

  // At or below it, price would have to be zero or negative.
  assert.equal(priceForRsi(CLOSE, STATE, PERIOD, floor), null);
  assert.equal(priceForRsi(CLOSE, STATE, PERIOD, floor - 1), null);
});

test("handles a window with no down bars", () => {
  const noLoss: RsiState = { rsi: 100, avgGain: 2, avgLoss: 0 };
  const p = priceForRsi(CLOSE, noLoss, PERIOD, 70);
  assert.ok(p);
  assert.equal(p.direction, "down");
  // k·avgGain / RS = 26 / (7/3)
  assert.ok(Math.abs(p.price - (CLOSE - 26 / (7 / 3))) < 1e-9);
});

test("handles a window with no up bars", () => {
  const noGain: RsiState = { rsi: 0, avgGain: 0, avgLoss: 2 };
  const p = priceForRsi(CLOSE, noGain, PERIOD, 30);
  assert.ok(p);
  assert.equal(p.direction, "up");
  // RS · k·avgLoss = (3/7) · 26
  assert.ok(Math.abs(p.price - (CLOSE + (3 / 7) * 26)) < 1e-9);
});

test("refuses a flat window instead of returning the current close", () => {
  const flat: RsiState = { rsi: Number.NaN, avgGain: 0, avgLoss: 0 };
  assert.equal(priceForRsi(CLOSE, flat, PERIOD, 70), null);
  assert.equal(rsiForPrice(CLOSE, flat, PERIOD, CLOSE), null);
});

test("rejects targets at or outside the open interval", () => {
  for (const bad of [0, 100, -5, 140, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(priceForRsi(CLOSE, STATE, PERIOD, bad), null, `accepted ${bad}`);
  }
});

test("rejects degenerate inputs", () => {
  assert.equal(priceForRsi(CLOSE, STATE, 1, 70), null);
  assert.equal(priceForRsi(0, STATE, PERIOD, 70), null);
  assert.equal(priceForRsi(-10, STATE, PERIOD, 70), null);
  assert.equal(rsiFloor(0, STATE, PERIOD), null);
});

test("seed bar and smoothed bars agree when there are no down bars", () => {
  // 14 straight up bars: avgLoss is 0 at the seed and stays 0 on the next bar,
  // so both must report 100. The seed used to substitute a finite RS and land
  // on 99.0099 instead.
  const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
  const states = calcRSIState(closes, PERIOD);

  const seed = states[PERIOD];
  const next = states[PERIOD + 1];
  assert.ok(seed && next);
  assert.equal(seed.avgLoss, 0);
  assert.equal(next.avgLoss, 0);
  assert.equal(seed.rsi, 100);
  assert.equal(next.rsi, 100);

  // And the forward map, which uses the 100·a/(a+b) form, agrees with both.
  const prior = states[PERIOD - 1];
  assert.equal(prior, null);
  assert.equal(rsiForPrice(closes[PERIOD], seed, PERIOD, closes[PERIOD] + 1), 100);
});

test("agrees with the indicator that produced the state", () => {
  // A synthetic series long enough to clear the seed, then projected forward and
  // fed back through calcRSIState. If the exported state and the inverse ever
  // drift apart, this is what catches it.
  const closes: number[] = [100];
  for (let i = 1; i < 60; i++) {
    closes.push(closes[i - 1] * (1 + Math.sin(i * 1.7) * 0.012 + 0.001));
  }

  const states = calcRSIState(closes, PERIOD);
  const last = states[states.length - 1];
  assert.ok(last);

  for (const target of [35, 50, 65, 80]) {
    const p = priceForRsi(closes[closes.length - 1], last, PERIOD, target);
    assert.ok(p, `no projection for ${target}`);

    const extended = calcRSIState([...closes, p.price], PERIOD);
    const projected = extended[extended.length - 1];
    assert.ok(projected);
    assert.ok(
      Math.abs(projected.rsi - target) < 1e-9,
      `target ${target} replayed as ${projected.rsi}`
    );
  }
});
