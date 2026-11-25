import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPriceRangeOverlay,
  measurePriceRange,
  priceRangeLabel,
} from "../indicators/price-range.ts";
import type { OhlcvBar } from "../types.ts";

const data: OhlcvBar[] = Array.from({ length: 10 }, (_, i) => ({
  time: `2026-01-${String(i + 1).padStart(2, "0")}`,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 0,
}));

test("rise: change, % against the first click, bars", () => {
  const m = measurePriceRange(
    { time: "2026-01-02", price: 100 },
    { time: "2026-01-07", price: 112.5 },
    data
  );
  assert.equal(m.change, 12.5);
  assert.equal(m.pct, 12.5);
  assert.equal(m.bars, 5);
  assert.deepEqual(priceRangeLabel(m), ["+12.50 (+12.50%)", "5 bars"]);
});

test("click order, not left to right: measuring back from a high reads negative", () => {
  const m = measurePriceRange(
    { time: "2026-01-08", price: 200 },
    { time: "2026-01-03", price: 150 },
    data
  );
  assert.equal(m.change, -50);
  assert.equal(m.pct, -25);
  assert.equal(m.bars, -5);
  assert.deepEqual(priceRangeLabel(m), ["−50.00 (−25.00%)", "5 bars"]);
});

test("future point counts its offset; zero start price has no %", () => {
  const m = measurePriceRange(
    { time: "2026-01-09", price: 0 },
    { time: "2026-01-10", price: 1, futureBars: 3 },
    data
  );
  assert.equal(m.bars, 4);
  assert.equal(m.pct, null);
  assert.equal(priceRangeLabel(m)[1], "4 bars");
  assert.match(priceRangeLabel(m)[0], /\(—\)$/);
});

test("one bar is singular; price below 1 keeps 4 dp", () => {
  const m = measurePriceRange(
    { time: "2026-01-01", price: 0.5 },
    { time: "2026-01-02", price: 0.5123 },
    data
  );
  assert.equal(priceRangeLabel(m)[1], "1 bar");
  assert.match(priceRangeLabel(m)[0], /^\+0\.0123 /);
});

test("overlay paints with only a start, with a preview, and finished", () => {
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (t: string) => data.findIndex((b) => b.time === t) * 10,
      logicalToCoordinate: (l: number) => l * 10,
    }),
  };
  const series = { priceToCoordinate: (p: number) => 300 - p };
  const texts: string[] = [];
  const noop = () => {};
  const ctx = new Proxy(
    {
      fillText: (s: string) => texts.push(s),
      measureText: (s: string) => ({ width: s.length * 5 }),
    },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : noop), set: () => true }
  );
  const rect = { width: 400, height: 300 };
  const start = { time: "2026-01-02", price: 100 };
  type Draw = ReturnType<typeof createPriceRangeOverlay>["draw"];
  type P = Parameters<Draw>;
  const draw = (o: ReturnType<typeof createPriceRangeOverlay>) =>
    o.draw(
      ctx as unknown as P[0],
      chart as unknown as P[1],
      series as unknown as P[2],
      data,
      true,
      rect as unknown as P[5]
    );

  draw(createPriceRangeOverlay(start, null));
  assert.equal(texts.length, 0);
  draw(createPriceRangeOverlay(start, null, { current: { time: "2026-01-04", price: 110 } }));
  assert.deepEqual(texts.splice(0), ["+10.00 (+10.00%)", "2 bars"]);
  draw(createPriceRangeOverlay(start, { time: "2026-01-06", price: 90 }));
  assert.deepEqual(texts.splice(0), ["−10.00 (−10.00%)", "4 bars"]);
});
