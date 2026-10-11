import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FootprintLevel,
  displayMultiple,
  mergeLevels,
} from "../indicators/order-footprint.ts";

const lvl = (priceLow: number, buyVol: number, sellVol: number, step = 2): FootprintLevel => ({
  priceLow,
  priceHigh: priceLow + step,
  buyVol,
  sellVol,
});

test("display multiple: the smallest 1-2-5 step that gives a readable row", () => {
  assert.equal(displayMultiple(13, 13), 1);
  assert.equal(displayMultiple(4, 13), 5);
  assert.equal(displayMultiple(0.7, 13), 20);
  assert.equal(displayMultiple(0, 13), 5000);
});

test("merging keeps every unit of volume and puts rows on one grid", () => {
  const levels = [lvl(100, 1, 2), lvl(102, 3, 4), lvl(104, 5, 6), lvl(110, 7, 8)];
  const rows = mergeLevels(levels, 2, 5); // rows of 10: [100,110) and [110,120)
  assert.deepEqual(
    rows.map((r) => [r.k, r.buy, r.sell]),
    [
      [11, 7, 8],
      [10, 9, 12],
    ]
  );
});

test("rows come back top price first, with the busiest row as POC", () => {
  const rows = mergeLevels([lvl(100, 1, 1), lvl(102, 9, 9), lvl(104, 2, 2)], 2, 1);
  assert.deepEqual(
    rows.map((r) => r.k),
    [52, 51, 50]
  );
  assert.deepEqual(
    rows.map((r) => r.poc),
    [false, true, false]
  );
});

test("imbalance is diagonal: buys against the sells one row below", () => {
  const rows = mergeLevels([lvl(100, 1, 2), lvl(102, 6, 30), lvl(104, 10, 1)], 2, 1);
  const at = (k: number) => rows.find((r) => r.k === k);
  // 6 bought at 102 vs 2 sold at 100 → 3x.
  assert.equal(at(51)?.buyImbalance, true);
  // 30 sold at 102 vs 10 bought at 104 → 3x.
  assert.equal(at(51)?.sellImbalance, true);
  // 10 bought at 104 vs 30 sold at 102 → no.
  assert.equal(at(52)?.buyImbalance, false);
  // The bottom row has nothing below it to be compared with.
  assert.equal(at(50)?.buyImbalance, false);
});
