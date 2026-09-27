import assert from "node:assert/strict";
import test from "node:test";
import { scaleBars, usdPriceSymbol } from "../price-scaling.ts";

test("BTC scaling converts each OHLC price using the matching daily BTC close", () => {
  const bars = [
    { time: "2026-09-24", open: 100, high: 110, low: 90, close: 105, volume: 50 },
    { time: "2026-09-25", open: 120, high: 130, low: 110, close: 125, volume: 70 },
  ];
  const result = scaleBars(
    bars,
    "USD",
    "BTC",
    [],
    [
      { date: "2026-09-24", close: 50_000 },
      { date: "2026-09-25", close: 100_000 },
    ]
  );
  assert.ok(Math.abs(result[0].close - 105 / 50_000) < 1e-12);
  assert.ok(Math.abs(result[1].close - 125 / 100_000) < 1e-12);
  assert.equal(result[1].volume, 70);
  assert.deepEqual(bars[0], {
    time: "2026-09-24",
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 50,
  });
});

test("non-USD instrument first converts to USD and missing rates never fake a price", () => {
  const bars = [
    { time: "2026-09-24", open: 100, high: 100, low: 100, close: 100 },
    { time: "2026-09-25", open: 100, high: 100, low: 100, close: 100 },
  ];
  const result = scaleBars(
    bars,
    "THB",
    "BTC",
    [{ date: "2026-09-25", close: 0.03 }],
    [{ date: "2026-09-25", close: 60_000 }]
  );
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].close - 3 / 60_000) < 1e-12);
  assert.equal(usdPriceSymbol("BTC"), "BTC-USD");
  assert.equal(usdPriceSymbol("USD"), null);
});
