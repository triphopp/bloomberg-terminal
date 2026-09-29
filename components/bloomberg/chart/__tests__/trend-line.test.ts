import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type StoredTrendLine,
  createTrendHitMap,
  createTrendLineOverlay,
  sameTrendBar,
} from "../indicators/trend-line.ts";
import type { OhlcvBar } from "../types.ts";

const BAR_W = 10;
const data: OhlcvBar[] = Array.from({ length: 5 }, (_, i) => ({
  time: 1_600_000_000 + i * 86400,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 0,
}));

// x = bar index × 10, y = 200 − price — enough of lightweight-charts to paint.
const chart = {
  timeScale: () => ({
    timeToCoordinate: (t: number) => {
      const i = data.findIndex((b) => b.time === t);
      return i < 0 ? null : i * BAR_W;
    },
    logicalToCoordinate: (l: number) => l * BAR_W,
  }),
};
const series = { priceToCoordinate: (p: number) => 200 - p };

function fakeCtx() {
  const noop = () => {};
  return {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
    arc: noop, fill: noop, fillRect: noop, fillText: noop, setLineDash: noop,
    measureText: () => ({ width: 20 }),
  };
}

function paint(lines: StoredTrendLine[]) {
  const hits = createTrendHitMap();
  const overlay = createTrendLineOverlay(lines, null, null, hits);
  // biome-ignore lint/suspicious/noExplicitAny: minimal fakes
  overlay.draw(fakeCtx() as any, chart as any, series as any, data, true, { width: 500, height: 300 });
  return hits;
}

const line = (b: StoredTrendLine["b"]): StoredTrendLine => ({
  id: "l1",
  symbol: "X",
  barInterval: "1d",
  a: { time: data[1].time, price: 100 },
  b,
  color: "#fff",
});

test("an endpoint in the future whitespace is placed N bars past its anchor bar", () => {
  const hits = paint([line({ time: data[4].time, price: 110, futureBars: 6 })]);
  assert.equal(hits.segments.length, 1);
  assert.equal(hits.segments[0].ax, 1 * BAR_W);
  assert.equal(hits.segments[0].bx, (4 + 6) * BAR_W);
  assert.equal(hits.segments[0].by, 200 - 110);
});

test("an ordinary endpoint still sits on its bar", () => {
  const hits = paint([line({ time: data[3].time, price: 105 })]);
  assert.equal(hits.segments[0].bx, 3 * BAR_W);
});

test("an anchor bar that is not loaded hides the line", () => {
  const hits = paint([line({ time: 42, price: 105, futureBars: 2 })]);
  assert.equal(hits.segments.length, 0);
});

test("sameTrendBar compares bar and future offset", () => {
  const t = data[4].time;
  assert.equal(sameTrendBar({ time: t, price: 1 }, { time: t, price: 2 }), true);
  assert.equal(sameTrendBar({ time: t, price: 1 }, { time: t, price: 1, futureBars: 3 }), false);
  assert.equal(
    sameTrendBar({ time: t, price: 1, futureBars: 3 }, { time: String(t), price: 9, futureBars: 3 }),
    true
  );
});
