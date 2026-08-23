import assert from "node:assert/strict";
import { test } from "node:test";

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

import { createHeatmapOverlay, inkFor } from "../heatmap-overlay.ts";
import type { HeatmapSpec, OhlcvBar } from "../types.ts";

// The overlay is pure geometry over a 2D context, so it can be checked without a
// browser: a recording stub stands in for the canvas and the chart, and the test
// asserts on what would have been painted.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

interface PaintedText {
  text: string;
  x: number;
  y: number;
  /** Needed to turn `y` into a real box — `y` alone means different things per baseline. */
  baseline: string;
  fontPx: number;
  /** The ink it was drawn with — cell text picks it from the cell's own fill. */
  fill: string;
}

interface Painted {
  fills: Rect[];
  strokes: Rect[];
  texts: PaintedText[];
  lines: { from: [number, number]; to: [number, number] }[];
}

/** Vertical extent of a drawn string, honouring its baseline. */
function textBox(t: PaintedText): [number, number] {
  if (t.baseline === "top") return [t.y, t.y + t.fontPx];
  if (t.baseline === "bottom") return [t.y - t.fontPx, t.y];
  return [t.y - t.fontPx / 2, t.y + t.fontPx / 2]; // middle / alphabetic
}

function stubCtx(painted: Painted) {
  let fillStyle = "";
  let pen: [number, number] = [0, 0];
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    fillRect(x: number, y: number, w: number, h: number) {
      painted.fills.push({ x, y, w, h, fill: fillStyle });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      painted.strokes.push({ x, y, w, h, fill: this.strokeStyle });
    },
    fillText(text: string, x: number, y: number) {
      painted.texts.push({
        text,
        x,
        y,
        baseline: String(this.textBaseline),
        fontPx: Number(/(\d+)px/.exec(String(this.font))?.[1] ?? 10),
        fill: fillStyle,
      });
    },
    measureText(text: string) {
      return { width: text.length * 5 };
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      pen = [x, y];
    },
    lineTo(x: number, y: number) {
      painted.lines.push({ from: pen, to: [x, y] });
    },
    stroke() {},
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Chart stub: linear time→x mapping, and a settable bar pitch. */
function stubChart(barSpacing: number, xOf: (time: string | number) => number | null) {
  return {
    timeScale: () => ({
      options: () => ({ barSpacing }),
      timeToCoordinate: (t: string | number) => xOf(t),
    }),
  } as unknown as IChartApi;
}

const ROWS = ["-2", "-1", "0", "+1", "+2"];

function spec(over: Partial<HeatmapSpec> = {}): HeatmapSpec {
  return {
    rows: ROWS,
    columns: [{ time: "2026-01-02", values: [0.1, 0.2, 0.4, 0.2, 0.1], markRow: 2 }],
    colorScale: () => "rgb(1,2,3)",
    ...over,
  };
}

const BARS: OhlcvBar[] = [];

function paint(
  s: HeatmapSpec,
  {
    barSpacing = 40,
    height = 100,
    width = 500,
    xOf = () => 200,
    isDark = true,
  }: {
    barSpacing?: number;
    height?: number;
    width?: number;
    xOf?: (t: string | number) => number | null;
    isDark?: boolean;
  } = {}
): Painted {
  const painted: Painted = { fills: [], strokes: [], texts: [], lines: [] };
  createHeatmapOverlay(s).draw(
    stubCtx(painted),
    stubChart(barSpacing, xOf),
    null as unknown as ISeriesApi<SeriesType>,
    BARS,
    isDark,
    { width, height }
  );
  return painted;
}

/** Cell rects only — the label plates are also fillRects. */
const cells = (p: Painted) => p.fills.filter((f) => f.fill === "rgb(1,2,3)");

/** Row separators only — the rail draws a vertical border through `lines` too. */
const hLines = (p: Painted) => p.lines.filter((l) => l.from[1] === l.to[1]);

// ── Row layout ───────────────────────────────────────────────────────────────

test("rows[0] is painted at the BOTTOM of the pane", () => {
  const p = paint(spec());
  const c = cells(p);
  assert.equal(c.length, 5);
  // 5 rows over 100px → 20px each; row 0 occupies y 80–100, row 4 occupies 0–20.
  assert.equal(c[0].y, 80);
  assert.equal(c[4].y, 0);
  for (const cell of c) assert.equal(cell.h, 20);
});

test("rows tile the pane exactly, with no gap or overflow", () => {
  const p = paint(spec(), { height: 97 });
  const c = cells(p);
  const top = Math.min(...c.map((x) => x.y));
  const bottom = Math.max(...c.map((x) => x.y + x.h));
  assert.ok(Math.abs(top) < 1e-9, `top ${top}`);
  assert.ok(Math.abs(bottom - 97) < 1e-9, `bottom ${bottom}`);
});

test("a sparse heatmap gets readable cells, not bar-thin slivers", () => {
  // Two columns on a 1-year daily chart are ~250 bars apart. Sizing the cell off
  // barSpacing gave ~2px — a sliver with no room for the number it exists to
  // show. The gap to the neighbour is what actually constrains it.
  const p = paint(spec(), { barSpacing: 2, xOf: () => 200 });
  const c = cells(p);
  assert.equal(c[0].w, 86); // sized for a price RANGE, e.g. "438-513"
  assert.equal(c[0].x, 157); // still centred on the bar: 200 − 86/2
});

test("a dense heatmap keeps bar-for-bar alignment", () => {
  // Columns 10px apart: widening to 52 would overlap the neighbours and destroy
  // the correspondence with the candles above.
  const times = ["a", "b", "c"];
  const xs: Record<string, number> = { a: 100, b: 110, c: 120 };
  const p = paint(spec({ columns: times.map((time) => ({ time, values: [1, 2, 3, 4, 5] })) }), {
    barSpacing: 10,
    xOf: (t) => xs[t as string],
  });
  const c = cells(p);
  assert.ok(c[0].w <= 10, `cell ${c[0].w} wider than the 10px gap`);
});

test("cells are centred on their bar", () => {
  const p = paint(spec(), { barSpacing: 40, xOf: () => 200 });
  const c = cells(p);
  assert.equal(c[0].x + c[0].w / 2, 200);
});

// ── Value handling ───────────────────────────────────────────────────────────

test("null and non-finite cells are skipped, not painted as zero", () => {
  const p = paint(
    spec({
      columns: [{ time: "t", values: [0.1, null, Number.NaN, Number.POSITIVE_INFINITY, 0.2] }],
    })
  );
  assert.equal(cells(p).length, 2);
});

test("a colorScale returning null leaves the cell unpainted", () => {
  const p = paint(spec({ colorScale: (_v, row) => (row === 2 ? "rgb(1,2,3)" : null) }));
  assert.equal(cells(p).length, 1);
});

test("the value reaches colorScale with its own row index", () => {
  const seen: [number, number][] = [];
  paint(
    spec({
      columns: [{ time: "t", values: [10, 20, 30, 40, 50] }],
      colorScale: (v, row) => {
        seen.push([v, row]);
        return "rgb(1,2,3)";
      },
    })
  );
  assert.deepEqual(seen, [
    [10, 0],
    [20, 1],
    [30, 2],
    [40, 3],
    [50, 4],
  ]);
});

test("a column whose length disagrees with rows is dropped whole", () => {
  // Painting it anyway would stack values against the wrong sd levels — a
  // wrong answer is worse than a missing column.
  const p = paint(spec({ columns: [{ time: "t", values: [0.5, 0.5] }] }));
  assert.equal(cells(p).length, 0);
});

// ── Mark row ─────────────────────────────────────────────────────────────────

test("markRow outlines exactly that row", () => {
  const p = paint(spec({ columns: [{ time: "t", values: [1, 1, 1, 1, 1], markRow: 4 }] }));
  assert.equal(p.strokes.length, 1);
  assert.ok(p.strokes[0].y < 20, "top row outlined");
});

test("markRow out of range or null draws no outline", () => {
  for (const markRow of [null, -1, 5, 99]) {
    const p = paint(spec({ columns: [{ time: "t", values: [1, 1, 1, 1, 1], markRow }] }));
    assert.equal(p.strokes.length, 0, `markRow ${markRow}`);
  }
});

// ── Culling ──────────────────────────────────────────────────────────────────

test("columns the time scale cannot place are skipped", () => {
  const p = paint(spec(), { xOf: () => null });
  assert.equal(cells(p).length, 0);
});

test("columns scrolled off-screen are skipped", () => {
  assert.equal(cells(paint(spec(), { xOf: () => -500 })).length, 0);
  assert.equal(cells(paint(spec(), { xOf: () => 9999, width: 500 })).length, 0);
});

test("a 1px bar pitch no longer suppresses a sparse heatmap", () => {
  // The old guard bailed on barSpacing < 2, which killed exactly the case this
  // indicator starts in: a couple of columns on a long timeframe.
  const p = paint(spec(), { barSpacing: 1 });
  assert.equal(cells(p).length, 5);
});

test("columns packed tighter than a pixel still collapse to hairlines", () => {
  const xs: Record<string, number> = { a: 100, b: 100.4 };
  const p = paint(
    spec({ columns: ["a", "b"].map((time) => ({ time, values: [1, 2, 3, 4, 5] })) }),
    { barSpacing: 1, xOf: (t) => xs[t as string] }
  );
  for (const c of cells(p)) assert.ok(c.w <= 1, `cell ${c.w} exceeds the sub-pixel gap`);
});

test("empty rows or columns paint no cells", () => {
  assert.equal(paint(spec({ rows: [], columns: [] })).fills.length, 0);
  assert.equal(paint(spec({ columns: [] })).fills.length, 0);
});

test("with no columns, emptyMessage is drawn in the middle of the pane", () => {
  const p = paint(spec({ columns: [], emptyMessage: "No IV snapshots yet" }), {
    width: 400,
    height: 100,
  });
  assert.equal(p.texts.length, 1);
  assert.equal(p.texts[0].text, "No IV snapshots yet");
  assert.equal(p.texts[0].x, 200);
  assert.equal(p.texts[0].y, 50);
  // No row separators either — the pane is not a scale until it has data.
  assert.equal(p.lines.length, 0);
});

test("no columns and no emptyMessage stays silent", () => {
  const p = paint(spec({ columns: [] }));
  assert.equal(p.texts.length, 0);
});

test("emptyMessage is not drawn once there are columns", () => {
  const p = paint(spec({ emptyMessage: "should not appear" }));
  assert.ok(!p.texts.some((t) => t.text === "should not appear"));
});

test("a zero-height pane paints nothing", () => {
  assert.equal(paint(spec(), { height: 0 }).fills.length, 0);
});

// ── Labels and text ──────────────────────────────────────────────────────────

test("row labels are drawn once each, bottom row lowest on screen", () => {
  const p = paint(spec());
  const labels = p.texts.filter((t) => ROWS.includes(t.text));
  assert.equal(labels.length, 5);
  const minusTwo = labels.find((t) => t.text === "-2");
  const plusTwo = labels.find((t) => t.text === "+2");
  assert.ok(minusTwo && plusTwo && minusTwo.y > plusTwo.y);
});

test("row labels survive even an 8px row — they shrink instead", () => {
  // Height must never remove a label. It removed them until 2026-08-18, which
  // is how a three-sub-pane chart ended up with an unlabelled heatmap.
  const p = paint(spec(), { height: 40 }); // 8px rows
  assert.equal(p.texts.filter((t) => ROWS.includes(t.text)).length, 5);
  assert.ok(p.texts.every((t) => t.fontPx >= 7));
});

test("a value too wide for its cell is skipped, never spilled", () => {
  // Bleeding into the neighbouring column would read as THAT column's value.
  // 60px apart → 54px cells: wide enough to print a short label, too narrow for
  // a long one. (The stub measures 5px per character.)
  const xs: Record<string, number> = { a: 100, b: 160 };
  const p = paint(
    spec({
      columns: ["a", "b"].map((time) => ({
        time,
        values: [1, 2, 3, 4, 5],
        cellLabels: ["123456789012", "x", "x", "x", "x"],
      })),
    }),
    { barSpacing: 60, height: 130, xOf: (t) => xs[t as string] }
  );
  assert.ok(!p.texts.some((t) => t.text === "123456789012"), "long label must be skipped");
  assert.ok(
    p.texts.some((t) => t.text === "x"),
    "short labels still print"
  );
});

test("a sparse column prints its value even at a tiny bar pitch", () => {
  const p = paint(spec({ formatValue: (v) => `${v}` }), { barSpacing: 2, height: 130 });
  assert.ok(p.texts.some((t) => t.text === "0.4"));
});

test("no cell text without a formatValue", () => {
  const p = paint(spec(), { barSpacing: 40, height: 100 });
  assert.equal(p.texts.filter((t) => !ROWS.includes(t.text)).length, 0);
});

// ── Separators ───────────────────────────────────────────────────────────────

test("one separator between each pair of rows, none at the outer edges", () => {
  const p = paint(spec());
  const rows = hLines(p);
  assert.equal(rows.length, 4);
  for (const line of rows) {
    // Starts at the gutter's inner edge and stops at the plot's right edge.
    assert.ok(line.from[0] >= 0 && line.from[0] < line.to[0]);
    assert.ok(line.to[0] <= 500);
    assert.ok(line.from[1] > 0 && line.from[1] < 100);
  }
});

// ── Cell labels ──────────────────────────────────────────────────────────────

test("a column's own cellLabels win over formatValue", () => {
  // The SD heatmap colours by an occupancy frequency but labels with the price
  // at that sigma — the label is not a rendering of the plotted number.
  const p = paint(
    spec({
      columns: [
        { time: "t", values: [1, 2, 3, 4, 5], cellLabels: ["90", "95", "100", "105", "110"] },
      ],
      formatValue: (v) => `val${v}`,
    }),
    { barSpacing: 40, height: 100 }
  );
  const texts = p.texts.map((x) => x.text);
  assert.ok(texts.includes("100"));
  assert.ok(!texts.some((x) => x.startsWith("val")));
});

test("cell labels are drawn even without a formatValue", () => {
  const p = paint(
    spec({
      columns: [{ time: "t", values: [1, 2, 3, 4, 5], cellLabels: ["a", "b", "c", "d", "e"] }],
    }),
    { barSpacing: 40, height: 100 }
  );
  assert.equal(p.texts.filter((x) => ["a", "b", "c", "d", "e"].includes(x.text)).length, 5);
});

test("a null cell label falls back to formatValue for that row only", () => {
  const p = paint(
    spec({
      columns: [{ time: "t", values: [1, 2, 3, 4, 5], cellLabels: ["a", null, "c", "d", "e"] }],
      formatValue: () => "fb",
    }),
    { barSpacing: 40, height: 100 }
  );
  assert.ok(p.texts.some((x) => x.text === "fb"));
});

test("a cell too narrow for the range falls back to the compact price", () => {
  // The regression this locks down: on a year of daily columns the cells are a
  // fraction of the ~90px a price RANGE needs, so every cell printed nothing —
  // on exactly the chart where the drift of the bands is the whole point.
  const narrow = { a: 200, b: 230 } as Record<string, number>;
  const p = paint(
    spec({
      columns: (["a", "b"] as const).map((time) => ({
        time,
        values: [1, 2, 3, 4, 5],
        cellLabels: Array.from({ length: 5 }, () => "438-513"),
        cellLabelsCompact: Array.from({ length: 5 }, () => "438+"),
      })),
    }),
    { xOf: (t) => narrow[t as string] ?? null, height: 100 }
  );
  const texts = p.texts.map((x) => x.text);
  assert.ok(texts.includes("438+"), "compact label missing");
  assert.ok(!texts.includes("438-513"), "range should not fit this cell");
});

test("the full range wins whenever the cell can hold it", () => {
  const p = paint(
    spec({
      columns: [
        {
          time: "t",
          values: [1, 2, 3, 4, 5],
          cellLabels: Array.from({ length: 5 }, () => "438-513"),
          cellLabelsCompact: Array.from({ length: 5 }, () => "438+"),
        },
      ],
    }),
    { height: 100 }
  );
  const texts = p.texts.map((x) => x.text);
  assert.ok(texts.includes("438-513"));
  assert.ok(!texts.includes("438+"));
});

test("compact labels alone are enough to turn cell text on", () => {
  const p = paint(
    spec({
      columns: [
        { time: "t", values: [1, 2, 3, 4, 5], cellLabelsCompact: ["a", "b", "c", "d", "e"] },
      ],
    }),
    { height: 100 }
  );
  assert.equal(p.texts.filter((x) => ["a", "b", "c", "d", "e"].includes(x.text)).length, 5);
});

// ── Caption ──────────────────────────────────────────────────────────────────

const CAPTION = ["1σ/30d ±8.2%", "IV 24.3%", "RV 18.1%", "IV/RV 1.34"];

test("the caption is drawn top-left, clear of the newest column", () => {
  const p = paint(spec({ caption: CAPTION }), { height: 100, width: 500 });
  const cap = p.texts.find((t) => t.text.startsWith("1σ"));
  assert.ok(cap, "caption missing");
  assert.ok(textBox(cap)[1] <= 20, `caption at y=${cap.y} is not at the top`);
  assert.ok(cap.x < 500 / 2, `caption at x=${cap.x} is not on the left`);
});

test("a narrow pane drops whole trailing segments, never a clipped word", () => {
  // measureText in this stub is 5px per character.
  const p = paint(spec({ caption: CAPTION }), { height: 100, width: 260 });
  const cap = p.texts.find((t) => t.text.startsWith("1σ"));
  assert.ok(cap, "the leading segment must survive");
  assert.ok(!cap.text.includes("IV/RV"), `kept too much: ${cap.text}`);
  // Whatever it kept, it kept whole.
  for (const seg of cap.text.split("  ·  ")) assert.ok(CAPTION.includes(seg), seg);
});

test("a pane too short for a caption row drops it rather than overlapping", () => {
  const p = paint(spec({ caption: CAPTION }), { height: 40 });
  assert.ok(!p.texts.some((t) => t.text.startsWith("1σ")));
});

test("no caption, no plate — the pane is unchanged", () => {
  const withCap = paint(spec({ caption: CAPTION }), { height: 100 });
  const without = paint(spec(), { height: 100 });
  assert.ok(withCap.fills.length > without.fills.length);
});

// ── Ink on a cell ────────────────────────────────────────────────────────────

test("cell text takes its ink from the cell's own fill, not the theme", () => {
  // A ramp that runs from near-transparent to nearly opaque cannot be read with
  // one fixed ink: white type vanishes on the pale end of a light pane, black
  // type on the deep end.
  const deep = paint(
    spec({ colorScale: () => "rgba(185, 28, 28, 0.95)", formatValue: () => "x" }),
    {
      isDark: false,
    }
  );
  const pale = paint(
    spec({ colorScale: () => "rgba(252, 165, 165, 0.12)", formatValue: () => "x" }),
    {
      isDark: false,
    }
  );
  const inkOf = (p: Painted) => p.texts.find((t) => t.text === "x")?.fill;
  assert.equal(inkOf(deep), "rgba(255,255,255,0.95)", "deep cell needs light type");
  assert.equal(inkOf(pale), "rgba(0,0,0,0.88)", "pale cell on a light pane needs dark type");
});

test("inkFor falls back to the theme ink when the fill is not rgb", () => {
  assert.equal(inkFor("#123456", true), "rgba(255,255,255,0.92)");
  assert.equal(inkFor("nonsense", false), "rgba(0,0,0,0.88)");
});

// ── Reference rail ───────────────────────────────────────────────────────────

// ── The gutter carries the reference, and nothing sits over the plot ─────────
//
// The bug this locks down: a right-hand strip held the per-row values, and the
// newest column sits at the right edge by definition. The strip clipped that
// column to zero width — the pane drew its labels over a heatmap with NO CELLS.

const LABELLED = [
  { level: "-2σ", odds: "98%", value: "<373.9" },
  { level: "-1σ", odds: "84%", value: "373.9+" },
  { level: "0σ", odds: "50%", value: "437.2+" },
  { level: "+1σ", odds: "16%", value: "511.3+" },
  { level: "+2σ", odds: "2.3%", value: "597.9+" },
];

/** The live case: daily columns bunched at the right edge of a 1-year chart. */
function paintNewest(over: Partial<HeatmapSpec> = {}, height = 190, width = 820) {
  const xs: Record<string, number> = { a: width - 40, b: width - 37, c: width - 34 };
  return paint(
    spec({
      rows: LABELLED,
      columns: ["a", "b", "c"].map((time) => ({
        time,
        values: [0.12, -0.03, -0.13, -0.05, 0.08],
        markRow: 2,
      })),
      ...over,
    }),
    { width, height, barSpacing: 3.2, xOf: (t) => xs[t as string] }
  );
}

test("the newest column is still painted when it sits at the right edge", () => {
  const p = paintNewest();
  assert.equal(cells(p).length, 15, "3 columns x 5 rows");
});

test("nothing is drawn to the right of the plot", () => {
  const p = paintNewest();
  const rightmost = Math.max(...cells(p).map((c) => c.x + c.w));
  assert.ok(rightmost <= 820, `cell reaches ${rightmost}`);
  // Every label lives in the gutter, left of every cell.
  const leftmostCell = Math.min(...cells(p).map((c) => c.x));
  for (const label of p.texts) {
    assert.ok(label.x <= leftmostCell + 1, `${label.text} at x=${label.x} is over the plot`);
  }
});

test("the gutter shows level, odds and value on one row", () => {
  const p = paintNewest();
  for (const l of LABELLED) {
    assert.ok(
      p.texts.some((x) => x.text === l.level),
      l.level
    );
    assert.ok(
      p.texts.some((x) => x.text === l.odds),
      l.odds
    );
    assert.ok(
      p.texts.some((x) => x.text === l.value),
      l.value
    );
  }
});

test("the three gutter columns never overlap horizontally", () => {
  const p = paintNewest();
  const row = (lvl: string, odds: string, val: string) => {
    const L = p.texts.find((x) => x.text === lvl);
    const O = p.texts.find((x) => x.text === odds);
    const V = p.texts.find((x) => x.text === val);
    assert.ok(L && O && V);
    // level is left-aligned, odds and value right-aligned; ordering must hold.
    assert.ok(L.x < O.x, `${lvl} at ${L.x} not left of odds at ${O.x}`);
    assert.ok(O.x <= V.x, `odds at ${O.x} not left of value at ${V.x}`);
  };
  row("+2σ", "2.3%", "597.9+");
  row("0σ", "50%", "437.2+");
});

test("a short pane shrinks the type — it never drops the numbers", () => {
  // The regression this locks down: hiding the value below a 20px row height
  // silently emptied the gutter on any chart carrying three sub-panes.
  for (const height of [190, 130, 87, 60, 44]) {
    const p = paintNewest({}, height);
    assert.ok(
      p.texts.some((x) => x.text === "0σ"),
      `level at ${height}px`
    );
    assert.ok(
      p.texts.some((x) => x.text === "437.2+"),
      `value at ${height}px`
    );
    assert.ok(
      p.texts.some((x) => x.text === "50%"),
      `odds at ${height}px`
    );
  }
});

test("type scales down with the row and stops at a floor", () => {
  const px = (p: Painted) => p.texts.find((x) => x.text === "0σ")?.fontPx ?? 0;
  assert.ok(px(paintNewest({}, 190)) > px(paintNewest({}, 87)));
  assert.ok(px(paintNewest({}, 44)) >= 7, "never below 7px");
});

test("a narrow pane drops odds before the value", () => {
  // Priority: which row this is > what it is worth > a constant you learn once.
  const mid = paintNewest({}, 130, 250);
  assert.ok(mid.texts.some((x) => x.text === "0σ"));
  assert.ok(
    mid.texts.some((x) => x.text === "437.2+"),
    "value outranks odds"
  );

  const tight = paintNewest({}, 130, 160);
  assert.ok(
    tight.texts.some((x) => x.text === "0σ"),
    "the level always survives"
  );
  assert.ok(!tight.texts.some((x) => x.text === "50%"), "odds gone first");
});

test("the plot always keeps a usable width", () => {
  for (const width of [820, 300, 220, 160, 120]) {
    const p = paintNewest({}, 130, width);
    const labels = p.texts.map((x) => x.x);
    const gutterEdge = labels.length ? Math.max(...labels) : 0;
    assert.ok(width - gutterEdge >= 60, `plot squeezed to ${width - gutterEdge} at ${width}px`);
  }
});

test("cells never paint over the gutter even when a column lands on it", () => {
  const xs: Record<string, number> = { a: 5 };
  const p = paint(spec({ rows: LABELLED, columns: [{ time: "a", values: [1, 2, 3, 4, 5] }] }), {
    width: 820,
    height: 190,
    barSpacing: 3.2,
    xOf: () => xs.a,
  });
  const gutterEnd = Math.max(...p.texts.map((x) => x.x));
  for (const c of cells(p)) assert.ok(c.x >= gutterEnd - 40, `cell at ${c.x} under the gutter`);
});
