import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterChips, eventChipStyle } from "../event-rail-overlay.ts";
import type { PositionedChip } from "../event-rail-overlay.ts";
import type { ChartEventMarker } from "../types.ts";

// Placement onto bars lives in event-reaction.ts and is tested there — this
// file covers only what the rail itself decides: the glyph and the clustering.
const marker = (over: Partial<ChartEventMarker> = {}): ChartEventMarker => ({
  time: "2026-03-05",
  type: "earnings",
  label: "E",
  ...over,
});

// ── eventChipStyle ─────────────────────────────────────────────────────────
//
// The chip text has to carry the meaning on its own: colour alone fails for
// red-green colour blindness and disappears entirely on a printout.

test("a dividend reads as money", () => {
  const style = eventChipStyle(marker({ type: "dividend", dividend: 1.47 }));
  assert.equal(style.icon, "cash");
  assert.equal(style.label, "$");
});

test("a declared but unpaid dividend is marked as not yet certain", () => {
  // A paid dividend and an announced one must not draw the same chip — the
  // amount on the upcoming one is last quarter's until the issuer says so.
  assert.equal(
    eventChipStyle(marker({ type: "dividend", dividend: 1.47, upcoming: true })).label,
    "$?"
  );
});

test("earnings say beat, miss, or pending in the mark itself", () => {
  // Direction is carried by the arrow, not by the colour it is drawn in.
  assert.equal(eventChipStyle(marker({ surprise: 5.8 })).icon, "arrowUp");
  assert.equal(eventChipStyle(marker({ surprise: -4.1 })).icon, "arrowDown");
  assert.equal(eventChipStyle(marker({ surprise: null })).icon, "clock");
});

test("an exactly in-line report counts as a beat, not a miss", () => {
  assert.equal(eventChipStyle(marker({ surprise: 0 })).icon, "arrowUp");
});

test("a split shows its ratio", () => {
  assert.equal(eventChipStyle(marker({ type: "split", splitRatio: 10 })).label, "x10");
});

test("a fractional split ratio is not rounded away to x1", () => {
  // A 1.5:1 split rendered as "x1" would read as no split at all.
  assert.equal(eventChipStyle(marker({ type: "split", splitRatio: 1.5 })).label, "x1.5");
});

test("a split with no ratio still gets a label", () => {
  assert.equal(eventChipStyle(marker({ type: "split" })).label, "SPL");
});

// ── clusterChips ───────────────────────────────────────────────────────────

const chip = (x: number, w = 12): PositionedChip => ({
  x,
  w,
  style: { icon: "cash", label: "$", color: "#4fc3f7" },
});

test("well-separated chips each stay their own", () => {
  const chips = clusterChips([chip(10), chip(60), chip(110)]);
  assert.equal(chips.length, 3);
  assert.deepEqual(
    chips.map((c) => c.count),
    [1, 1, 1]
  );
});

test("overlapping chips collapse into one cluster carrying the count", () => {
  // Three chips 4px apart, each 12px wide — they cannot all be drawn.
  const chips = clusterChips([chip(50), chip(54), chip(58)]);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].count, 3);
  // The cluster sits where the leftmost chip was.
  assert.equal(chips[0].x, 50);
});

test("a cluster does not swallow the next well-separated chip", () => {
  const chips = clusterChips([chip(50), chip(54), chip(200)]);
  assert.deepEqual(
    chips.map((c) => c.count),
    [2, 1]
  );
});

test("input order does not change the result", () => {
  const ordered = clusterChips([chip(10), chip(14), chip(200)]);
  const shuffled = clusterChips([chip(200), chip(14), chip(10)]);
  assert.deepEqual(shuffled, ordered);
});

test("clustering does not mutate the caller's array", () => {
  const input = [chip(200), chip(10)];
  const copy = [...input];
  clusterChips(input);
  assert.deepEqual(input, copy);
});

test("an empty rail produces no chips", () => {
  assert.deepEqual(clusterChips([]), []);
});
