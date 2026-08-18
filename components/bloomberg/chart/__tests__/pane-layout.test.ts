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
  subPaneKeyAtOffset,
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

// ── subPaneKeyAtOffset ─────────────────────────────────────────────────────
//
// Resolves a pointer y to the sub-pane under it, so a right-click can be
// attributed to the indicator it landed on rather than to the chart at large.

// A 536px chart: 348px price pane, then volume and rsi at 80px, 1px dividers.
const HEIGHTS = [348, 80, 80];
const KEYS = ["volume", "rsi"];

test("resolves a y inside each sub-pane", () => {
  assert.equal(subPaneKeyAtOffset(400, HEIGHTS, KEYS), "volume");
  assert.equal(subPaneKeyAtOffset(480, HEIGHTS, KEYS), "rsi");
});

test("the price pane is not a sub-pane", () => {
  assert.equal(subPaneKeyAtOffset(0, HEIGHTS, KEYS), null);
  assert.equal(subPaneKeyAtOffset(347, HEIGHTS, KEYS), null);
});

test("pane boundaries belong to the pane below", () => {
  // volume starts one divider past the price pane and ends before rsi begins.
  assert.equal(subPaneKeyAtOffset(349, HEIGHTS, KEYS), "volume");
  assert.equal(subPaneKeyAtOffset(428, HEIGHTS, KEYS), "volume");
  assert.equal(subPaneKeyAtOffset(429, HEIGHTS, KEYS), null); // the divider
  assert.equal(subPaneKeyAtOffset(430, HEIGHTS, KEYS), "rsi");
});

test("below the last pane resolves to nothing", () => {
  // The time axis lives past the panes and belongs to no indicator.
  assert.equal(subPaneKeyAtOffset(520, HEIGHTS, KEYS), null);
  assert.equal(subPaneKeyAtOffset(10_000, HEIGHTS, KEYS), null);
});

test("collapsed panes are never hit", () => {
  // lightweight-charts reports 0 for sub-panes it has squashed. A zero-width
  // band must not swallow the y that follows it, or a right-click would open a
  // menu for a pane nobody can see.
  assert.equal(subPaneKeyAtOffset(510, [510, 0, 0], KEYS), null);
  assert.equal(subPaneKeyAtOffset(512, [510, 0, 0], KEYS), null);
});

test("a chart with no sub-panes resolves to nothing", () => {
  assert.equal(subPaneKeyAtOffset(100, [536], []), null);
});

test("a pane count that disagrees with the keys is refused", () => {
  // Reading heights and reading keys are separate calls; if a rebuild lands
  // between them, guessing an alignment would attribute clicks to the wrong
  // indicator.
  assert.equal(subPaneKeyAtOffset(400, [348, 80], KEYS), null);
  assert.equal(subPaneKeyAtOffset(400, [348, 80, 80, 80], KEYS), null);
});

// ── Per-indicator preferred heights ──────────────────────────────────────────
//
// The default 80px ceiling suits a single line; a pane that stacks rows divides
// it among them. The SD heatmap's five σ rows got ~9px each — under its own 9px
// type — and every label piled up illegibly.

test("a pane with a preference gets it when the space is there", () => {
  const { heightFor } = computePaneLayout(600, ["sd-heatmap"], {}, { "sd-heatmap": 130 });
  assert.equal(heightFor("sd-heatmap"), 130);
});

test("a preference is a ceiling, not a claim on space that isn't there", () => {
  // Room for ~60px after the main pane's minimum — the preference cannot conjure
  // the rest, and must not squeeze the main pane below MAIN_PANE_MIN.
  const { heightFor } = computePaneLayout(200, ["sd-heatmap"], {}, { "sd-heatmap": 130 });
  assert.ok(heightFor("sd-heatmap") <= 60);
  assert.ok(heightFor("sd-heatmap") >= SUB_PANE_MIN);
});

test("panes without a preference keep the default ceiling", () => {
  const { heightFor } = computePaneLayout(600, ["rsi", "sd-heatmap"], {}, { "sd-heatmap": 130 });
  assert.equal(heightFor("rsi"), SUB_PANE_MAX);
  assert.equal(heightFor("sd-heatmap"), 130);
});

test("a user drag still beats the preference", () => {
  const { heightFor } = computePaneLayout(
    600,
    ["sd-heatmap"],
    { "sd-heatmap": 200 },
    { "sd-heatmap": 130 }
  );
  assert.equal(heightFor("sd-heatmap"), 200);
});

test("chartHeight accounts for the taller pane so it is never clipped", () => {
  const { chartHeight } = computePaneLayout(220, ["sd-heatmap"], {}, { "sd-heatmap": 130 });
  // 140 main + whatever the pane got; the chart scrolls rather than truncating.
  assert.ok(chartHeight >= 220);
});

test("omitting preferences entirely behaves exactly as before", () => {
  const withArg = computePaneLayout(600, ["rsi", "macd"], {}, {});
  const without = computePaneLayout(600, ["rsi", "macd"], {});
  assert.equal(withArg.chartHeight, without.chartHeight);
  assert.equal(withArg.heightFor("rsi"), without.heightFor("rsi"));
});
