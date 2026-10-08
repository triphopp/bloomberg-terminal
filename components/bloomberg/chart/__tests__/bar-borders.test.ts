import assert from "node:assert/strict";
import { test } from "node:test";

import { outlineBars } from "../bar-borders.ts";
import type { CanvasOverlay, OhlcvBar } from "../types.ts";

const BARS: OhlcvBar[] = [0, 1, 2, 3].map((i) => ({
  time: i,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
}));

const overlay = (borders: [number, string][] | null): CanvasOverlay => ({
  id: "t",
  name: "t",
  width: 0,
  draw() {},
  barBorders: () => (borders ? new Map(borders) : null),
});
const plain: CanvasOverlay = { id: "p", name: "p", width: 0, draw() {} };

test("nothing to mark hands back the same array", () => {
  assert.equal(outlineBars(BARS, []), BARS);
  assert.equal(outlineBars(BARS, [plain, overlay(null), overlay([])]), BARS);
});

test("a marked bar is a copy with a border colour — body and wick are left alone", () => {
  const out = outlineBars(BARS, [plain, overlay([[2, "#e040fb"]])]);
  assert.notEqual(out, BARS);
  assert.equal(out.length, BARS.length);
  // Exactly one field more: no `color` / `wickColor`, so up / down still shows.
  assert.deepEqual(out[2], { ...BARS[2], borderColor: "#e040fb" });
  // The caller's bars are untouched, and unmarked bars are shared, not copied.
  assert.equal("borderColor" in BARS[2], false);
  assert.equal(out[1], BARS[1]);
});

test("a later overlay wins a bar; an index outside the bars is ignored", () => {
  const out = outlineBars(BARS, [
    overlay([
      [1, "#111111"],
      [9, "#999999"],
    ]),
    overlay([[1, "#222222"]]),
  ]);
  assert.equal(out[1].borderColor, "#222222");
  assert.equal(out.length, 4);
});
