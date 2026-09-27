import assert from "node:assert/strict";
import test from "node:test";
import { type LivePosition, applyTicks } from "../live-patch.ts";

const usdPos: LivePosition = {
  yf_symbol: "AAPL",
  volume: 10,
  price_entry: 100,
  current_price: 110,
  prev_close: 108,
  currency: "USD",
  unrealized_pnl: 100,
  unrealized_pnl_thb: 3000, // entry-date FX baked in — must survive
  unrealized_pnl_base: 3000,
  market_value_base: 33_000,
  day_pnl: 20,
  day_pnl_thb: 600,
  day_pnl_base: 600,
  day_pct: 1.85,
  day_stale: false,
};

test("USD position in a THB book moves by the price delta at today's FX", () => {
  const out = applyTicks({ positions: [usdPos], thb_per_usd: 33 }, { AAPL: { price: 111 } }, "THB");
  const p = out.positions[0];
  assert.equal(p.current_price, 111);
  assert.equal(p.unrealized_pnl, 110);
  assert.equal(p.unrealized_pnl_base, 3330);
  assert.equal(p.market_value_base, 33_330);
  assert.equal(p.day_pnl_base, 930);
  assert.equal(Math.round((p.day_pct ?? 0) * 1000) / 1000, 2.778);
  assert.equal(p.unrealized_pct, 11);
});

test("losses deepen with a falling tick", () => {
  const out = applyTicks({ positions: [usdPos], thb_per_usd: 33 }, { AAPL: { price: 109 } }, "USD");
  assert.equal(out.positions[0].unrealized_pnl_base, 3000 - 10);
});

test("THB position in a USD book converts the delta the other way", () => {
  const th = { ...usdPos, yf_symbol: "PTT.BK", currency: "THB", unrealized_pnl_base: 50 };
  const out = applyTicks(
    { positions: [th], thb_per_usd: 33 },
    { "PTT.BK": { price: 113.3 } },
    "USD"
  );
  // (113.3 − 110) × 10 = 33 THB = 1 USD
  assert.equal(Math.round((out.positions[0].unrealized_pnl_base ?? 0) * 1e9) / 1e9, 51);
});

test("no tick for this book returns the same object (no re-render)", () => {
  const payload = { positions: [usdPos], thb_per_usd: 33 };
  assert.equal(applyTicks(payload, { MSFT: { price: 1 } }, "THB"), payload);
  assert.equal(applyTicks(payload, { AAPL: { price: 110 } }, "THB"), payload);
});

test("a market that has not traded today gets no invented day P&L", () => {
  const stale = { ...usdPos, day_stale: true, day_pnl: null, day_pnl_base: null, day_pct: null };
  const p = applyTicks({ positions: [stale], thb_per_usd: 33 }, { AAPL: { price: 111 } }, "THB")
    .positions[0];
  assert.equal(p.day_pnl_base, null);
  assert.equal(p.day_pct, null);
  assert.equal(p.unrealized_pnl_base, 3330);
});

test("deltas chain across ticks", () => {
  let payload = { positions: [usdPos], thb_per_usd: 33 };
  payload = applyTicks(payload, { AAPL: { price: 112 } }, "THB");
  payload = applyTicks(payload, { AAPL: { price: 111 } }, "THB");
  assert.equal(payload.positions[0].unrealized_pnl_base, 3330);
});
