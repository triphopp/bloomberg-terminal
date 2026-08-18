import assert from "node:assert/strict";
import { test } from "node:test";

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

import { createHeatmapOverlay } from "../heatmap-overlay.ts";
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

test("row labels are dropped when rows get too thin for them", () => {
  const p = paint(spec(), { height: 40 }); // 8px rows
  assert.equal(p.texts.filter((t) => ROWS.includes(t.text)).length, 0);
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

// ── Reference rail ───────────────────────────────────────────────────────────

const RAIL = {
  rows: ["90", "95", "100", "105", "110"],
  subRows: ["≥98%", "≥84%", "≥50%", "≥16%", "≥2%"],
  title: "→ 09-16",
};

test("rail prints one entry per row, bottom row lowest", () => {
  const p = paint(spec({ rail: RAIL }), { width: 500, height: 120 });
  const rows = p.texts.filter((x) => RAIL.rows.includes(x.text));
  assert.equal(rows.length, 5);
  const bottom = rows.find((x) => x.text === "90");
  const top = rows.find((x) => x.text === "110");
  assert.ok(bottom && top && bottom.y > top.y);
});

test("rail entries sit inside the reserved strip, not over the plot", () => {
  const p = paint(spec({ rail: RAIL }), { width: 500, height: 120 });
  for (const t of p.texts.filter((x) => RAIL.rows.includes(x.text))) {
    assert.ok(t.x > 500 - 74, `${t.text} at ${t.x} is outside the rail`);
  }
});

test("cells are clipped at the rail edge so they never run under it", () => {
  const p = paint(spec({ rail: RAIL }), { width: 500, xOf: () => 600 });
  assert.equal(cells(p).length, 0);
  const q = paint(spec({ rail: RAIL }), { width: 500, xOf: () => 200 });
  assert.equal(cells(q).length, 5);
  for (const c of cells(q)) assert.ok(c.x + c.w <= 500 - 72 + 0.001);
});

test("cells never paint over the gutter", () => {
  const p = paint(spec(), { width: 500, xOf: () => 0 });
  for (const c of cells(p)) assert.ok(c.x >= 0);
});

test("row separators stop at the rail", () => {
  // No cellLabels/formatValue here, so the cells cannot label themselves and the
  // fallback rail is shown.
  const p = paint(spec({ rail: RAIL }), { width: 500, height: 120 });
  const rows = hLines(p);
  assert.equal(rows.length, 4);
  for (const line of rows) assert.equal(line.to[0], 500 - 72);
});

test("the probability sub-line is dropped when rows get thin", () => {
  const roomy = paint(spec({ rail: RAIL }), { width: 500, height: 150 });
  assert.ok(roomy.texts.some((x) => x.text === "≥50%"));

  const thin = paint(spec({ rail: RAIL }), { width: 500, height: 80 });
  assert.ok(!thin.texts.some((x) => x.text === "≥50%"));
  // The price itself survives — it is the more important half.
  assert.ok(thin.texts.some((x) => x.text === "100"));
});

test("the rail is dropped entirely when it would crowd out the plot", () => {
  const p = paint(spec({ rail: RAIL }), { width: 150, height: 120 });
  assert.ok(!p.texts.some((x) => RAIL.rows.includes(x.text)));
  // And the plot gets the full width back.
  for (const line of hLines(p)) assert.equal(line.to[0], 150);
});

test("no rail means the plot runs to the right edge", () => {
  const p = paint(spec(), { width: 500, height: 120 });
  const rows = hLines(p);
  assert.equal(rows.length, 4);
  for (const line of rows) assert.equal(line.to[0], 500);
});

test("the rail is dropped when the cells can label themselves", () => {
  // Duplication, not information: the rail would repeat what is already in every
  // cell, and the plot wants that width back.
  const p = paint(
    spec({
      rail: RAIL,
      columns: [{ time: "t", values: [1, 2, 3, 4, 5], cellLabels: ["a", "b", "c", "d", "e"] }],
    }),
    { width: 500, height: 190, barSpacing: 2 }
  );
  assert.ok(!p.texts.some((x) => RAIL.rows.includes(x.text)));
  for (const line of hLines(p)) assert.equal(line.to[0], 500);
});

// ── Rail legibility at small pane heights ────────────────────────────────────
//
// The bug this guards: a sub-pane defaults to 44–80px, which over five rows is
// 9–16px each — at or below the 9px type size. The rail drew all five prices
// regardless, so they overlapped into an unreadable pile at the right edge.
// Text is now dropped or thinned before it is ever allowed to collide.

test("rail prices survive every pane height — they shrink, they do not vanish", () => {
  // Hiding them below a height threshold turned a cramped pane into an empty
  // one, which is a worse answer than small type.
  for (const height of [40, 50, 60, 80, 100, 130]) {
    const p = paint(spec({ rail: RAIL }), { width: 500, height });
    assert.equal(
      p.texts.filter((x) => RAIL.rows.includes(x.text)).length,
      5,
      `height ${height} dropped rail prices`
    );
  }
});

test("rail type shrinks with the row", () => {
  const small = paint(spec({ rail: RAIL }), { width: 500, height: 50 });
  const large = paint(spec({ rail: RAIL }), { width: 500, height: 130 });
  const px = (p: Painted) => p.texts.find((x) => x.text === "100")?.fontPx ?? 0;
  assert.ok(px(small) < px(large), `${px(small)} !< ${px(large)}`);
  assert.ok(px(small) >= 6, "never smaller than 6px");
});

test("the preferred pane height prints every row", () => {
  const p = paint(spec({ rail: RAIL }), { width: 500, height: 130 }); // 26px rows
  const shown = p.texts.filter((x) => RAIL.rows.includes(x.text));
  assert.equal(shown.length, 5);
});

test("rail entries never overlap vertically", () => {
  for (const height of [60, 70, 80, 100, 130, 200]) {
    const p = paint(spec({ rail: RAIL }), { width: 500, height });
    const boxes = p.texts
      .filter((x) => RAIL.rows.includes(x.text) || RAIL.subRows.includes(x.text))
      .map(textBox)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(
        boxes[i][0] >= boxes[i - 1][1],
        `height ${height}: ${boxes[i - 1]} and ${boxes[i]} overlap`
      );
    }
  }
});

test("cell labels never overlap their row separators either", () => {
  const p = paint(
    spec({
      columns: [{ time: "t", values: [1, 2, 3, 4, 5], cellLabels: ["a", "b", "c", "d", "e"] }],
    }),
    { barSpacing: 40, height: 130 }
  );
  const seps = p.lines.filter((l) => l.from[1] === l.to[1]).map((l) => l.from[1]);
  for (const box of p.texts.filter((x) => "abcde".includes(x.text)).map(textBox)) {
    for (const y of seps) {
      assert.ok(y <= box[0] || y >= box[1], `separator ${y} cuts through ${box}`);
    }
  }
});

test("the title is withheld until it clears the top row", () => {
  const cramped = paint(spec({ rail: RAIL }), { width: 500, height: 100 }); // 20px rows
  assert.ok(!cramped.texts.some((x) => x.text === RAIL.title));

  const roomy = paint(spec({ rail: RAIL }), { width: 500, height: 150 }); // 30px rows
  const title = roomy.texts.find((x) => x.text === RAIL.title);
  const topRow = roomy.texts.find((x) => x.text === "110");
  assert.ok(title && topRow && topRow.y - title.y >= 8);
});
