import assert from "node:assert/strict";
import { test } from "node:test";

import { calcZigZag, createZigZag } from "../indicators/zigzag.ts";
import type { OhlcvBar } from "../types.ts";

/** Bars whose high = low = close, so "hl" and "close" agree. */
const line = (closes: number[]): OhlcvBar[] =>
  closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c }));

test("moves under the deviation are ignored; pivots alternate", () => {
  // 104 (−5.5%) confirms 110 · 107 is only +2.9% off 104 → ignored · 95 extends the leg
  const { pivots, live } = calcZigZag(line([100, 105, 110, 108, 104, 107, 95, 100, 120]), 5);
  assert.deepEqual(
    pivots.map((p) => [p.index, p.price, p.kind]),
    [
      [0, 100, "low"],
      [2, 110, "high"],
      [6, 95, "low"],
    ]
  );
  assert.deepEqual(live, { index: 8, price: 120, kind: "high" });
});

test("a smaller deviation catches the smaller swing", () => {
  const { pivots } = calcZigZag(line([100, 105, 110, 108, 104, 107, 95, 100, 120]), 2);
  assert.deepEqual(
    pivots.map((p) => p.index),
    [0, 2, 4, 5, 6]
  );
});

test("no turn yet → no pivots, no live leg", () => {
  const r = calcZigZag(line([100, 101, 102, 101.5]), 5);
  assert.deepEqual(r, { pivots: [], live: null });
});

test("confirmed pivots never move when bars are appended", () => {
  const base = [100, 112, 103, 115, 101, 108, 96, 110];
  const a = calcZigZag(line(base), 5).pivots;
  const b = calcZigZag(line([...base, 130, 90, 140]), 5).pivots;
  assert.deepEqual(b.slice(0, a.length), a);
});

test("hl source measures on wicks", () => {
  const bars: OhlcvBar[] = [
    { time: 0, open: 100, high: 101, low: 99, close: 100 },
    { time: 1, open: 100, high: 112, low: 100, close: 101 }, // wick +12%, close +1%
    { time: 2, open: 101, high: 101, low: 98, close: 99 },
  ];
  assert.equal(calcZigZag(bars, 5, "hl").pivots.length, 2);
  assert.equal(calcZigZag(bars, 5, "close").pivots.length, 0);
});

test("compute always returns two series so a tick never changes the count", () => {
  const z = createZigZag({});
  const flat = z.compute(line([100, 101]), z.config);
  const swung = z.compute(line([100, 110, 100, 115]), z.config);
  assert.equal(flat.length, 2);
  assert.equal(swung.length, 2);
  assert.deepEqual(
    swung[0].data.map((p) => p.value),
    [100, 110, 100]
  );
  assert.deepEqual(
    swung[1].data.map((p) => p.value),
    [100, 115]
  );
  const hidden = createZigZag({ showLive: false });
  assert.equal(hidden.compute(line([100, 110, 100, 115]), hidden.config)[1].data.length, 0);
});

test("pivot labels: off by default, price at each corner, swing % in pct mode", () => {
  const bars = line([100, 110, 100, 115]);
  const off = createZigZag({});
  assert.equal(off.compute(bars, off.config)[0].labels, undefined);

  const price = createZigZag({ labels: "price" });
  const [main, liveLeg] = price.compute(bars, price.config);
  assert.deepEqual(
    main.labels?.map((l) => [l.text, l.position]),
    [
      ["100.00", "below"],
      ["110.00", "above"],
      ["100.00", "below"],
    ]
  );
  // The forming corner is labelled too, faded — it can still move.
  assert.deepEqual(
    liveLeg.labels?.map((l) => [l.text, l.faded]),
    [["115.00", true]]
  );

  const pct = createZigZag({ labels: "pct" });
  const [m2, l2] = pct.compute(bars, pct.config);
  assert.deepEqual(
    m2.labels?.map((l) => l.text),
    ["100.00", "110.00 +10.00%", "100.00 -9.09%"]
  );
  assert.equal(l2.labels?.[0].text, "115.00 +15.00%");
});

test("labels stay an array (never undefined) while on, even with no pivots", () => {
  const z = createZigZag({ labels: "price" });
  const [main, liveLeg] = z.compute(line([100, 101]), z.config);
  assert.deepEqual(main.labels, []);
  assert.deepEqual(liveLeg.labels, []);
});
