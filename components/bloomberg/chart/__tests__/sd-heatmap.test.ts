import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cheapnessColor,
  createSdHeatmap,
  fmtBand,
  occupancyColor,
} from "../indicators/sd-heatmap.ts";
import type { SdBandsPayload } from "../indicators/sd-heatmap.ts";
import type { HeatmapSpec, OhlcvBar } from "../types.ts";

const REF = [0.066807, 0.24173, 0.382925, 0.24173, 0.066807];

function payload(over: Partial<SdBandsPayload> = {}): SdBandsPayload {
  return {
    symbol: "SPY",
    mode: "occupancy",
    horizonDays: 30,
    levels: [-2, -1, 0, 1, 2],
    refProbs: REF,
    snapshotCount: 3,
    series: [
      {
        time: "2026-01-02",
        spot: 100,
        sigmaIv: 0.2,
        sigmaRv: 0.18,
        dteAtSnapshot: 30,
        T: 0.0822,
        prices: [90, 95, 100, 105, 110],
        edges: [null, 92, 97, 103, 108, null],
        cells: [0.0, 0.1, 0.6, 0.3, 0.0],
        hitRow: 3,
        hitZ: 0.8,
      },
      {
        time: "2026-01-05",
        spot: 101,
        sigmaIv: 0.21,
        sigmaRv: 0.19,
        dteAtSnapshot: 30,
        T: 0.0822,
        prices: [91, 96, 101, 106, 111],
        edges: [null, 93, 98, 104, 109, null],
        cells: [0.1, 0.1, 0.5, 0.3, 0.0],
        hitRow: 0,
        hitZ: -2.2,
      },
    ],
    exceedProbs: [0.97725, 0.84134, 0.5, 0.15866, 0.02275],
    current: null,
    ...over,
  };
}

const bars = (times: (string | number)[]): OhlcvBar[] =>
  times.map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));

function build(p: SdBandsPayload | null, times: (string | number)[]) {
  const indicator = createSdHeatmap();
  return indicator.compute(bars(times), { ...indicator.config, preloadedData: p });
}

const heat = (out: ReturnType<typeof build>): HeatmapSpec => {
  const spec = out[0]?.heatmap;
  assert.ok(spec, "expected a heatmap output");
  return spec;
};

// ── Empty states ─────────────────────────────────────────────────────────────
//
// Every one of these must still produce an output. Returning `[]` leaves the
// pane on screen but blank — and this indicator is empty by design until the IV
// history accumulates, so a blank box would be the first thing most users see.

test("no payload yet says it is loading", () => {
  const spec = heat(build(null, ["2026-01-02"]));
  assert.equal(spec.columns.length, 0);
  assert.match(spec.emptyMessage ?? "", /Loading/i);
});

test("zero snapshots says one is being recorded now", () => {
  const spec = heat(build(payload({ series: [], snapshotCount: 0 }), ["2026-01-02"]));
  assert.equal(spec.columns.length, 0);
  assert.match(spec.emptyMessage ?? "", /No IV snapshots yet/i);
  assert.match(spec.emptyMessage ?? "", /recording one now/i);
});

test("snapshots that exist but are all front-week say THAT, not 'none'", () => {
  // Telling this user to open the options chain would be telling them to repeat
  // the action that produced these unusable rows.
  const spec = heat(
    build(payload({ series: [], snapshotCount: 0, rawSnapshotCount: 3, horizonDays: 30 }), [
      "2026-01-02",
    ])
  );
  assert.match(spec.emptyMessage ?? "", /3 IV snapshots on file/);
  assert.match(spec.emptyMessage ?? "", /under 7 DTE/);
  assert.match(spec.emptyMessage ?? "", /30-day expiry/);
  assert.doesNotMatch(spec.emptyMessage ?? "", /No IV snapshots/);
});

test("a single front-week snapshot is not pluralised either", () => {
  const spec = heat(
    build(payload({ series: [], snapshotCount: 0, rawSnapshotCount: 1 }), ["2026-01-02"])
  );
  assert.match(spec.emptyMessage ?? "", /1 IV snapshot on file/);
});

test("some snapshots but no resolved outcomes says what is still missing", () => {
  const occ = heat(
    build(payload({ series: [], snapshotCount: 4, horizonDays: 30 }), ["2026-01-02"])
  );
  assert.match(occ.emptyMessage ?? "", /4 IV snapshots recorded/);
  assert.match(occ.emptyMessage ?? "", /30 more days/);
  // Cheapness needs no outcomes, so it is the mode to offer while waiting.
  assert.match(occ.emptyMessage ?? "", /CHEAPNESS/);

  const cheap = heat(
    build(payload({ mode: "cheapness", series: [], snapshotCount: 4 }), ["2026-01-02"])
  );
  assert.match(cheap.emptyMessage ?? "", /realized vol/i);
});

test("one snapshot is not pluralised", () => {
  const spec = heat(build(payload({ series: [], snapshotCount: 1 }), ["2026-01-02"]));
  assert.match(spec.emptyMessage ?? "", /1 IV snapshot recorded/);
});

test("empty states keep the row labels so the pane still reads as a σ scale", () => {
  const spec = heat(build(payload({ series: [], snapshotCount: 0 }), ["2026-01-02"]));
  assert.deepEqual(
    spec.rows.map((r) => (typeof r === "string" ? r : r.level)),
    ["-2σ", "-1σ", "0σ", "+1σ", "+2σ"]
  );
});

test("data outside the visible timeframe names the range it covers", () => {
  const spec = heat(build(payload(), ["2025-06-01", "2025-06-02"]));
  assert.equal(spec.columns.length, 0);
  assert.match(spec.emptyMessage ?? "", /2026-01-02 … 2026-01-05/);
  assert.match(spec.emptyMessage ?? "", /outside this timeframe/i);
});

// ── Alignment ────────────────────────────────────────────────────────────────

test("columns land on the bars whose dates match, and only those", () => {
  const out = build(payload(), ["2026-01-02", "2026-01-03", "2026-01-05"]);
  const spec = heat(out);
  assert.deepEqual(
    spec.columns.map((c) => c.time),
    ["2026-01-02", "2026-01-05"]
  );
});

test("intraday bars get one column per day, on that day's first bar", () => {
  // 2026-01-02 09:30 and 10:30 UTC — the second must not add a duplicate column,
  // which lightweight-charts would reject as a non-ascending time.
  const first = Date.UTC(2026, 0, 2, 14, 30) / 1000;
  const second = Date.UTC(2026, 0, 2, 15, 30) / 1000;
  const spec = heat(build(payload(), [first, second]));
  assert.equal(spec.columns.length, 1);
  assert.equal(spec.columns[0].time, first);
});

test("column values and markRow come straight from the payload row", () => {
  const spec = heat(build(payload(), ["2026-01-02", "2026-01-05"]));
  assert.deepEqual(spec.columns[0].values, [0.0, 0.1, 0.6, 0.3, 0.0]);
  assert.equal(spec.columns[0].markRow, 3);
  assert.equal(spec.columns[1].markRow, 0);
});

test("a payload row with the wrong cell count is ignored", () => {
  const p = payload();
  p.series[0].cells = [0.5, 0.5];
  const spec = heat(build(p, ["2026-01-02", "2026-01-05"]));
  assert.deepEqual(
    spec.columns.map((c) => c.time),
    ["2026-01-05"]
  );
});

// ── Labels ───────────────────────────────────────────────────────────────────

const rowsOf = (spec: HeatmapSpec) =>
  spec.rows.map((r) => (typeof r === "string" ? { level: r } : r));

test("the level and the odds of reaching it sit side by side", () => {
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.deepEqual(
    rowsOf(spec).map((r) => [r.level, r.odds]),
    [
      ["-2σ", "98%"],
      ["-1σ", "84%"],
      ["0σ", "50%"],
      ["+1σ", "16%"],
      ["+2σ", "2.3%"],
    ]
  );
});

test("the gutter quotes EXCEEDANCE odds, not the bucket probability", () => {
  // "What are the odds at +1σ" means the chance of getting there (15.9%), not
  // the chance of finishing exactly inside that band (24.2%).
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.equal(rowsOf(spec)[3].odds, "16%");
  assert.notEqual(rowsOf(spec)[3].odds, "24%");
});

test("upside and downside levels are tinted apart, the median left neutral", () => {
  const rows = rowsOf(heat(build(payload(), ["2026-01-02"])));
  assert.ok(rows[0].color && rows[4].color && rows[0].color !== rows[4].color);
  assert.equal(rows[2].color, undefined);
});

test("labels survive a payload with no exceedProbs", () => {
  const spec = heat(build(payload({ exceedProbs: undefined }), ["2026-01-02"]));
  assert.deepEqual(
    rowsOf(spec).map((r) => r.odds),
    [undefined, undefined, undefined, undefined, undefined]
  );
});

// ── Mode wiring ──────────────────────────────────────────────────────────────

test("occupancy mode scores each row against its own reference", () => {
  const spec = heat(build(payload({ mode: "occupancy" }), ["2026-01-02"]));
  // 30% in the +1 row is above its 24.2% reference → warm; the same 30% in the
  // 0 row would be well below 38.3% → cool. Same number, opposite reading.
  const warm = spec.colorScale(0.3, 3);
  const cool = spec.colorScale(0.3, 2);
  assert.ok(warm?.startsWith("rgba(234, 88, 12"), warm ?? "null");
  assert.ok(cool?.startsWith("rgba(37, 99, 235"), cool ?? "null");
});

test("cheapness mode reads the sign, not the reference", () => {
  const spec = heat(build(payload({ mode: "cheapness" }), ["2026-01-02"]));
  assert.ok(spec.colorScale(-0.05, 0)?.startsWith("rgba(220, 38, 38"));
  assert.ok(spec.colorScale(0.05, 0)?.startsWith("rgba(22, 163, 74"));
});

test("output label names the active mode", () => {
  assert.equal(build(payload({ mode: "occupancy" }), ["2026-01-02"])[0].label, "SD Occupancy");
  assert.equal(build(payload({ mode: "cheapness" }), ["2026-01-02"])[0].label, "SD Cheapness");
});

test("heatmap outputs carry no series data", () => {
  const out = build(payload(), ["2026-01-02"]);
  assert.equal(out[0].type, "heatmap");
  assert.deepEqual(out[0].data, []);
});

// ── Colour scales ────────────────────────────────────────────────────────────

test("occupancy grows with the ratio away from the reference", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  const atRef = alpha(occupancyColor(0.0701, 0.066807)); // just outside the neutral band
  const double = alpha(occupancyColor(0.1336, 0.066807));
  const quadruple = alpha(occupancyColor(0.2672, 0.066807));
  assert.ok(atRef < double && double < quadruple, `${atRef} ${double} ${quadruple}`);
  assert.ok(quadruple <= 0.72 + 1e-9, "saturates rather than exceeding full alpha");
});

test("occupancy tails read hotter than the centre for the same overshoot", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  const tail = alpha(occupancyColor(REF[0] + 0.05, REF[0]));
  const centre = alpha(occupancyColor(REF[2] + 0.05, REF[2]));
  assert.ok(tail > centre, `${tail} vs ${centre}`);
});

test("occupancy with a zero reference paints nothing rather than dividing by zero", () => {
  assert.equal(occupancyColor(0.2, 0), null);
});

test("a reading at the reference looks like nothing, not a faint wash", () => {
  assert.equal(cheapnessColor(0.0005), "rgba(120,120,130,0.05)");
  assert.equal(cheapnessColor(-0.0005), "rgba(120,120,130,0.05)");
  assert.equal(occupancyColor(0.2417, 0.24173), "rgba(120,120,130,0.05)");
});

test("intensity is sqrt-shaped so mid-range readings are still separable", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  // A quarter of the way up the range should already be half the contrast; a
  // linear ramp would leave the common middle looking uniformly washed out.
  const quarter = alpha(cheapnessColor(0.02));
  const full = alpha(cheapnessColor(0.08));
  assert.ok(quarter > 0.06 + (full - 0.06) * 0.45, `${quarter} vs ${full}`);
});

test("colour saturates below opaque so the cell's number stays legible", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  assert.ok(alpha(cheapnessColor(-0.9)) <= 0.72 + 1e-9);
  assert.ok(alpha(cheapnessColor(0.9)) <= 0.72 + 1e-9);
  assert.ok(alpha(occupancyColor(0.9, 0.0668)) <= 0.72 + 1e-9);
});

// ── Registry contract ────────────────────────────────────────────────────────

test("factory honours config overrides and defaults the rest", () => {
  const custom = createSdHeatmap({ mode: "cheapness", horizonDays: 90 });
  assert.equal(custom.config.mode, "cheapness");
  assert.equal(custom.config.horizonDays, 90);
  assert.equal(custom.config.rvWindow, 21);
  assert.equal(custom.type, "pane");
  assert.equal(custom.id, "sd-heatmap");
});

// ── Prices in the cells ──────────────────────────────────────────────────────

test("each cell is labelled with the price RANGE its row covers", () => {
  // A row is a bucket. Labelling it with the single centre price said "554"
  // for a cell that actually means 513–599, and nothing on screen said so.
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.deepEqual(spec.columns[0].cellLabels, [
    "<92.00",
    "92.00-97.00",
    "97.00-103.0",
    "103.0-108.0",
    ">108.0",
  ]);
});

test("the outer rows read as open-ended, not as a fake bound", () => {
  const spec = heat(build(payload(), ["2026-01-02"]));
  const labels = spec.columns[0].cellLabels ?? [];
  assert.ok(labels[0]?.startsWith("<"), String(labels[0]));
  assert.ok(labels[4]?.startsWith(">"), String(labels[4]));
});

test("a row with no edges leaves the cells unlabelled rather than guessing", () => {
  const p = payload();
  p.series[0].edges = [null, 1];
  const spec = heat(build(p, ["2026-01-02"]));
  assert.equal(spec.columns[0].cellLabels, undefined);
});

test("price precision follows magnitude, not a fixed setting", () => {
  // One band can span an index in the thousands and a stock under ten; a single
  // precision is either unreadable noise or loses the band entirely.
  assert.equal(fmtBand(1234.5, 2345.6), "1235-2346");
  assert.equal(fmtBand(12.345, 23.456), "12.35-23.46");
  assert.equal(fmtBand(1.2345, 2.3456), "1.234-2.346");
});

test("fmtBand handles both open ends and rejects a fully open row", () => {
  assert.equal(fmtBand(null, 92), "<92.00");
  assert.equal(fmtBand(108, null), ">108.0");
  assert.equal(fmtBand(null, null), null);
});

// ── Reference rail ───────────────────────────────────────────────────────────

test("rail carries bucket EDGES, which are unambiguous alone", () => {
  // The rail is too narrow for a full range, and an edge needs no second number:
  // the next row starts exactly where this one ends.
  const p = payload();
  p.series = [p.series[0]];
  const spec = heat(build(p, ["2026-01-02"]));
  assert.ok(spec.rail);
  assert.deepEqual(spec.rail?.rows, ["<92.00", "92.00+", "97.00+", "103.0+", "108.0+"]);
  assert.deepEqual(spec.rail?.subRows, ["≥ 98%", "≥ 84%", "≥ 50%", "≥ 16%", "≥ 2.3%"]);
});

test("rail reports the NEWEST reading even when that column is off-screen", () => {
  // The rail is a reference for "where things stand now", not an annotation of
  // the visible columns — a timeframe that hides the newest snapshot must not
  // silently roll the quoted prices back to an older band.
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.deepEqual(spec.rail?.rows, ["<93.00", "93.00+", "98.00+", "104.0+", "109.0+"]);
});

test("rail prefers the still-open projection over the last plotted column", () => {
  // (edges omitted below on purpose — the centre-price fallback is asserted.)
  // In occupancy mode the last column is horizonDays old by construction; the
  // number a reader is deciding against is today's forward band.
  const p = payload({
    current: {
      time: "2026-01-06",
      targetDate: "2026-02-05",
      spot: 102,
      sigmaIv: 0.22,
      sigmaRv: 0.2,
      dteAtSnapshot: 30,
      T: 0.0822,
      prices: [200, 205, 210, 215, 220],
      edges: [null, 202, 207, 212, 217, null],
    },
  });
  const spec = heat(build(p, ["2026-01-02"]));
  assert.deepEqual(spec.rail?.rows, ["<202.0", "202.0+", "207.0+", "212.0+", "217.0+"]);
  assert.equal(spec.rail?.title, "→ 02-05");
});

test("rail falls back to the newest column when there is no open projection", () => {
  const spec = heat(build(payload({ current: null }), ["2026-01-02", "2026-01-05"]));
  assert.deepEqual(spec.rail?.rows, ["<93.00", "93.00+", "98.00+", "104.0+", "109.0+"]);
});

test("rail falls back to centre prices when a payload carries no edges", () => {
  const p = payload({ current: null });
  p.series = [{ ...p.series[1], edges: [] }];
  const spec = heat(build(p, ["2026-01-05"]));
  assert.deepEqual(spec.rail?.rows, ["91.00", "96.00", "101.0", "106.0", "111.0"]);
});

test("rail omits the odds when the payload predates exceedProbs", () => {
  const spec = heat(build(payload({ exceedProbs: undefined }), ["2026-01-02"]));
  assert.deepEqual(spec.rail?.subRows, [null, null, null, null, null]);
  assert.equal(spec.rail?.rows.length, 5);
});
