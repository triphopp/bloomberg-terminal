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
  // Asserted on the hue's DIRECTION, not on an exact triple: the ramps move
  // colour with magnitude, so pinning one rgb would pin the scale's shape too.
  const warm = rgbOf(spec.colorScale(0.3, 3));
  const cool = rgbOf(spec.colorScale(0.3, 2));
  assert.ok(warm[0] > warm[2], `warm ${warm}`);
  assert.ok(cool[2] > cool[0], `cool ${cool}`);
});

test("cheapness mode reads the sign, not the reference", () => {
  const spec = heat(build(payload({ mode: "cheapness" }), ["2026-01-02"]));
  const rich = rgbOf(spec.colorScale(-0.05, 0));
  const cheap = rgbOf(spec.colorScale(0.05, 0));
  assert.ok(rich[0] > rich[1], `rich ${rich}`);
  assert.ok(cheap[1] > cheap[0], `cheap ${cheap}`);
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

/** The rgb triple of an `rgba()` fill, for asserting hue direction. */
function rgbOf(fill: string | null): [number, number, number] {
  const parts =
    /rgba?\(([^)]+)\)/
      .exec(fill ?? "")?.[1]
      .split(",")
      .map(Number) ?? [];
  return [parts[0], parts[1], parts[2]];
}

/** The wash a reading sitting exactly at its reference gets. */
const NEUTRAL_FILL = "rgba(130, 135, 145, 0.14)";

test("occupancy grows with the ratio away from the reference", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  const atRef = alpha(occupancyColor(0.0701, 0.066807)); // just outside the neutral band
  const double = alpha(occupancyColor(0.1336, 0.066807));
  const quadruple = alpha(occupancyColor(0.2672, 0.066807));
  assert.ok(atRef < double && double < quadruple, `${atRef} ${double} ${quadruple}`);
  assert.ok(quadruple <= 0.95 + 1e-9, "saturates rather than exceeding full alpha");
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
  assert.equal(cheapnessColor(0.0005), NEUTRAL_FILL);
  assert.equal(cheapnessColor(-0.0005), NEUTRAL_FILL);
  assert.equal(occupancyColor(0.2417, 0.24173), NEUTRAL_FILL);
});

test("intensity is sqrt-shaped so mid-range readings are still separable", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  // A quarter of the way up the range should already be half the contrast; a
  // linear ramp would leave the common middle looking uniformly washed out.
  const quarter = alpha(cheapnessColor(0.015));
  const full = alpha(cheapnessColor(0.06));
  assert.ok(quarter > 0.1 + (full - 0.1) * 0.45, `${quarter} vs ${full}`);
});

test("colour saturates below opaque so the cell's number stays legible", () => {
  const alpha = (c: string | null) => Number(/([\d.]+)\)$/.exec(c ?? "")?.[1] ?? -1);
  assert.ok(alpha(cheapnessColor(-0.9)) <= 0.95 + 1e-9);
  assert.ok(alpha(cheapnessColor(0.9)) <= 0.95 + 1e-9);
  assert.ok(alpha(occupancyColor(0.9, 0.0668)) <= 0.95 + 1e-9);
});

// ── Caption: how big a sigma actually is ─────────────────────────────────────

const capOf = (out: ReturnType<typeof build>) => heat(out).caption ?? [];

test("the caption leads with the sigma move over the horizon", () => {
  // Newest row: σ=0.21, T=0.0822 → σ√T = 6.0%; on a spot of 101, ≈ ±6.08.
  const cap = capOf(build(payload(), ["2026-01-05"]));
  assert.ok(cap[0].startsWith("1σ/30d ±6.0%"), cap[0]);
  assert.ok(cap[0].includes("±6.081"), cap[0]);
});

test("the caption quotes annualised IV and RV, and the ratio between them", () => {
  const cap = capOf(build(payload(), ["2026-01-05"]));
  assert.ok(cap.includes("IV 21.0%"), cap.join("|"));
  assert.ok(cap.includes("RV 19.0%"), cap.join("|"));
  assert.ok(cap.includes("IV/RV 1.11"), cap.join("|"));
});

test("the caption reads the still-open projection when there is one", () => {
  const p = payload({
    current: {
      time: "2026-01-06",
      spot: 100,
      sigmaIv: 0.4,
      sigmaRv: null,
      dteAtSnapshot: 30,
      T: 0.0822,
      prices: [80, 90, 100, 110, 120],
      edges: [null, 85, 95, 105, 115, null],
      targetDate: "2026-02-05",
    },
  });
  const cap = capOf(build(p, ["2026-01-05"]));
  assert.ok(cap[0].includes("±11.5%"), cap[0]);
  // No RV on this snapshot: the pair is dropped, not printed as NaN.
  assert.ok(!cap.some((c) => c.includes("RV")), cap.join("|"));
});

test("the caption survives an empty grid — sigma is known before outcomes are", () => {
  const p = payload({ series: [] });
  p.current = {
    time: "2026-01-06",
    spot: 100,
    sigmaIv: 0.2,
    sigmaRv: null,
    dteAtSnapshot: 30,
    T: 0.0822,
    prices: [90, 95, 100, 105, 110],
    edges: [null, 92, 97, 103, 108, null],
    targetDate: "2026-02-05",
  };
  const spec = heat(build(p, ["2026-01-02"]));
  assert.equal(spec.columns.length, 0);
  assert.ok(spec.caption?.[0].startsWith("1σ/30d"), String(spec.caption));
});

test("a payload with no usable sigma gets no caption rather than a NaN one", () => {
  const p = payload({ series: [] });
  p.current = null;
  assert.equal(heat(build(p, ["2026-01-02"])).caption, undefined);
});

test("the caption carries no target-date pointer", () => {
  // Dropped on request: the horizon is already named in the sigma segment, and
  // an arrow to a date is a second way of saying it.
  const p = payload({
    current: {
      time: "2026-01-06",
      spot: 100,
      sigmaIv: 0.2,
      sigmaRv: 0.18,
      dteAtSnapshot: 30,
      T: 0.0822,
      prices: [90, 95, 100, 105, 110],
      edges: [null, 92, 97, 103, 108, null],
      targetDate: "2026-02-05",
    },
  });
  const cap = capOf(build(p, ["2026-01-05"]));
  assert.ok(!cap.some((c) => c.includes("→") || c.includes("2026-02-05")), cap.join("|"));
});

// ── Sigma basis ──────────────────────────────────────────────────────────────

const capWith = (basis: string) => {
  const indicator = createSdHeatmap({ mode: "occupancy", sigmaBasis: basis });
  indicator.config.preloadedData = payload();
  const out = indicator.compute(bars(["2026-01-05"]), indicator.config);
  return (out[0].heatmap as HeatmapSpec).caption ?? [];
};

test("daily basis quotes one session, not the horizon", () => {
  // σ=0.21 over 252 sessions → 1.32% a day, against 6.0% over the 30d horizon.
  const cap = capWith("daily");
  assert.ok(cap[0].startsWith("1σ/1d ±1.32%"), cap[0]);
  assert.ok(!cap.some((c) => c.includes("/30d")), cap.join("|"));
});

test("a sub-2% sigma keeps a second decimal — 1.3% and 1.32% are different days", () => {
  assert.ok(capWith("daily")[0].includes("1.32%"), capWith("daily")[0]);
  assert.ok(capWith("horizon")[0].includes("6.0%"), capWith("horizon")[0]);
});

test("both bases lead with the horizon, which is what the grid is drawn at", () => {
  const cap = capWith("both");
  assert.ok(cap[0].includes("/30d"), cap[0]);
  assert.ok(cap[1].includes("/1d"), cap[1]);
});

test("an unknown basis falls back to the horizon rather than dropping the line", () => {
  assert.ok(capWith("nonsense")[0].includes("/30d"));
});

test("the basis defaults to the horizon", () => {
  assert.equal(createSdHeatmap().config.sigmaBasis, "horizon");
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

test("each cell also carries THAT DAY's price in a compact form", () => {
  // What makes the trend visible: on a dense chart the range does not fit, and
  // the compact edge is the same price in half the width.
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.deepEqual(spec.columns[0].cellLabelsCompact, [
    "<92.00",
    "92.00+",
    "97.00+",
    "103.0+",
    "108.0+",
  ]);
});

test("compact cell prices come from the column's own day, not the newest one", () => {
  const spec = heat(build(payload(), ["2026-01-02", "2026-01-05"]));
  assert.notDeepEqual(spec.columns[0].cellLabelsCompact, spec.columns[1].cellLabelsCompact);
});

test("compact cell prices fall back to centre prices when a row has no edges", () => {
  const p = payload();
  p.series[0].edges = [];
  const spec = heat(build(p, ["2026-01-02"]));
  assert.deepEqual(spec.columns[0].cellLabelsCompact, [
    "90.00",
    "95.00",
    "100.0",
    "105.0",
    "110.0",
  ]);
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

// ── Row values in the gutter ─────────────────────────────────────────────────

const valuesOf = (spec: HeatmapSpec) =>
  spec.rows.map((r) => (typeof r === "string" ? undefined : r.value));

test("the gutter carries bucket EDGES, which are unambiguous alone", () => {
  // An edge needs no second number: the next row starts exactly where this one
  // ends. That is what lets it fit beside the level and the odds.
  const p = payload();
  p.series = [p.series[0]];
  const spec = heat(build(p, ["2026-01-02"]));
  assert.deepEqual(valuesOf(spec), ["<92.00", "92.00+", "97.00+", "103.0+", "108.0+"]);
});

test("gutter values report the NEWEST reading even when that column is off-screen", () => {
  // The gutter is a reference for "where things stand now", not an annotation of
  // the visible columns.
  const spec = heat(build(payload(), ["2026-01-02"]));
  assert.deepEqual(valuesOf(spec), ["<93.00", "93.00+", "98.00+", "104.0+", "109.0+"]);
});

test("gutter prefers the still-open projection over the last plotted column", () => {
  // In occupancy mode the newest column is horizonDays old by construction; the
  // number a reader decides against is today's forward band.
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
  assert.deepEqual(valuesOf(spec), ["<202.0", "202.0+", "207.0+", "212.0+", "217.0+"]);
});

test("gutter falls back to centre prices when a payload carries no edges", () => {
  const p = payload({ current: null });
  p.series = [{ ...p.series[1], edges: [] }];
  const spec = heat(build(p, ["2026-01-05"]));
  assert.deepEqual(valuesOf(spec), ["91.00", "96.00", "101.0", "106.0", "111.0"]);
});

test("gutter omits the odds when the payload predates exceedProbs", () => {
  const spec = heat(build(payload({ exceedProbs: undefined }), ["2026-01-02"]));
  assert.deepEqual(
    rowsOf(spec).map((r) => r.odds),
    [undefined, undefined, undefined, undefined, undefined]
  );
  // The value column is independent of the odds and must survive.
  assert.ok(valuesOf(spec).every(Boolean));
});
