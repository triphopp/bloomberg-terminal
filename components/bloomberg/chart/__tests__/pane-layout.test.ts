import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAIN_PANE_MIN,
  SUB_PANE_MAX,
  SUB_PANE_MIN,
  SUB_PANE_USER_MAX,
  clampPaneHeight,
  computePaneLayout,
  paneKey,
} from "../pane-layout.ts";

// ── paneKey ────────────────────────────────────────────────────────────────
//
// Heights are stored per indicator FAMILY. Keying on the instance id would drop
// a user's pane height the moment they edited a period, which is the same class
// of bug as losing it on a view switch.

test("paneKey strips a single numeric param", () => {
  assert.equal(paneKey("rsi-14"), "rsi");
});

test("paneKey strips multiple numeric params", () => {
  assert.equal(paneKey("macd-12-26-9"), "macd");
});

test("paneKey keeps a height across a period change", () => {
  assert.equal(paneKey("rsi-14"), paneKey("rsi-30"));
});

test("paneKey leaves word-hyphenated ids alone", () => {
  assert.equal(paneKey("bb-width"), "bb-width");
  assert.equal(paneKey("fear-greed"), "fear-greed");
  assert.equal(paneKey("volume"), "volume");
});

// ── clampPaneHeight ────────────────────────────────────────────────────────

test("clampPaneHeight rejects values that would break the chart", () => {
  assert.equal(clampPaneHeight(-50), SUB_PANE_MIN);
  assert.equal(clampPaneHeight(0), SUB_PANE_MIN);
  assert.equal(clampPaneHeight(99_999), SUB_PANE_USER_MAX);
  assert.equal(clampPaneHeight(120.4), 120);
});

// ── computePaneLayout ──────────────────────────────────────────────────────

test("no panes: chart just takes the available height", () => {
  const l = computePaneLayout(500, [], {});
  assert.equal(l.chartHeight, 500);
  assert.equal(l.subPaneHeight, 0);
});

test("without overrides every pane gets the same auto height", () => {
  const l = computePaneLayout(536, ["volume", "rsi"], {});
  assert.equal(l.heightFor("volume"), l.heightFor("rsi"));
  assert.ok(l.subPaneHeight <= SUB_PANE_MAX);
  assert.ok(l.subPaneHeight >= SUB_PANE_MIN);
  // Fits inside what the parent granted, so no scrollbar.
  assert.equal(l.chartHeight, 536);
});

test("a stored height is honoured verbatim", () => {
  const l = computePaneLayout(536, ["volume", "rsi"], { rsi: 200 });
  assert.equal(l.heightFor("rsi"), 200);
});

test("only the untouched panes share the leftover space", () => {
  const available = 536;
  const l = computePaneLayout(available, ["volume", "rsi"], { rsi: 200 });
  // volume auto-sizes from what's left after the main pane and the pinned rsi
  const expected = Math.max(
    SUB_PANE_MIN,
    Math.min(SUB_PANE_MAX, Math.floor((available - MAIN_PANE_MIN - 200) / 1))
  );
  assert.equal(l.heightFor("volume"), expected);
});

test("a tall stored pane grows the chart so nothing is clipped", () => {
  // 140 main + 400 rsi + 44 volume = 584 > 484 available, so the chart must
  // grow (the wrapper scrolls) instead of squashing the panes.
  const l = computePaneLayout(484, ["volume", "rsi"], { rsi: 400 });
  assert.equal(l.heightFor("rsi"), 400);
  assert.equal(l.chartHeight, MAIN_PANE_MIN + 400 + l.heightFor("volume"));
  assert.ok(l.chartHeight > 484, "chart should overflow rather than clip");
});

test("every pane pinned: no auto height is computed", () => {
  const l = computePaneLayout(600, ["volume", "rsi"], { volume: 60, rsi: 90 });
  assert.equal(l.subPaneHeight, 0);
  assert.equal(l.heightFor("volume"), 60);
  assert.equal(l.heightFor("rsi"), 90);
  assert.equal(l.chartHeight, Math.max(600, MAIN_PANE_MIN + 150));
});

test("a corrupt stored height cannot squash the layout", () => {
  const l = computePaneLayout(536, ["rsi"], { rsi: -999 });
  assert.equal(l.heightFor("rsi"), SUB_PANE_MIN);
});

test("panes never shrink below the label-collision minimum", () => {
  // Very little room and several panes — they clamp at SUB_PANE_MIN and the
  // chart overflows rather than rendering unreadable panes.
  const l = computePaneLayout(200, ["volume", "rsi", "macd"], {});
  assert.equal(l.subPaneHeight, SUB_PANE_MIN);
  assert.ok(l.chartHeight > 200);
});
