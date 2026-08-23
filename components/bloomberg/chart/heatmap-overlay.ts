/**
 * HeatmapSpec → CanvasOverlay adapter.
 *
 * lightweight-charts has no cell-grid series, so a heatmap pane is built from
 * two pieces: an invisible anchor series that makes the sub-pane exist, and this
 * overlay attached to it as a primitive. Being a primitive is what makes the
 * cells clip to their own pane and repaint on every internal invalidation —
 * including price-scale rescales, which emit no public event (see
 * overlay-primitive.ts for the longer version of that story).
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 *
 *   ┌──────────────────────────┬───────────────────────────────────────┐
 *   │  +2σ    2.3%    597.9+   │ 1σ/30d ±8.2% · IV 24.3%               │
 *   │  +1σ   15.9%    511.3+   │          [cells]                      │
 *   │   0σ   50.0%    437.2+   │                                    ▓▓ │
 *   └──────────────────────────┴───────────────────────────────────────┘
 *             gutter                            plot
 *
 * Everything that is REFERENCE — the level, the odds of that outcome, the price
 * it starts at — lives in the left gutter and never scrolls away. The plot is
 * left entirely to the data, save for the caption: the SCALE the grid is drawn
 * at, which no cell can state, pinned top-left over the oldest columns.
 *
 * That split is not cosmetic. An earlier design put the per-row values in a
 * strip down the RIGHT edge, which is exactly where the newest column sits: the
 * strip clipped the most important cell to zero width and the pane rendered its
 * labels over a heatmap with no cells in it at all.
 *
 * Rows are laid out by even division of the pane height rather than through
 * `priceToCoordinate()`. The rows are categories, not prices: mapping them
 * through a price scale would make their thickness depend on that scale's
 * margins and autoscale state, so a row could silently drift off the pane.
 *
 * Row order follows the spec: `rows[0]` is the BOTTOM row. For the SD heatmap
 * that puts −2σ at the bottom and +2σ at the top, matching the price axis above.
 */

import type { Time } from "lightweight-charts";

import type { CanvasOverlay, HeatmapRowLabel, HeatmapSpec } from "./types";

/**
 * Width a cell is given when the columns are sparse enough to afford it.
 *
 * Cell width used to be `barSpacing * 0.9` unconditionally, which is right for a
 * dense heatmap and absurd for a young one: two columns on a 1-year daily chart
 * are ~250 bars apart, so each cell was about 2px — a sliver with no room for the
 * number it exists to show. A cell is widened up to this, but never past the gap
 * to its neighbour, so a dense series still lines up bar-for-bar.
 *
 * Sized for a price RANGE ("438-513"), which is what a bucket row actually means.
 */
const READABLE_CELL_W = 86;

/**
 * Type is sized from the row, not fixed — 9px type in a 9px row is a pile.
 *
 * The ceiling is deliberately generous: this pane is read for its numbers, and an
 * 11px cap left them squint-small even in a tall pane.
 */
const MIN_FONT_PX = 7;
const MAX_FONT_PX = 14;

export function fontFor(rowH: number): number {
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.floor(rowH * 0.48)));
}

/** Secondary type (the odds beside a level) sits a step below the primary. */
function subFontFor(primary: number): number {
  return Math.max(MIN_FONT_PX, primary - 3);
}

/** Gutter padding; its width is measured from its own content, not guessed. */
const GUTTER_PAD = 6;
const MIN_PLOT_W = 90;

/**
 * Gutter priority, most important first: `level` (which row is this), `value`
 * (what it is worth — the number the pane exists to show), `odds` (a constant a
 * reader learns once).
 *
 * Nothing here is dropped for being in a SHORT pane — the type shrinks instead,
 * down to MIN_FONT_PX. Columns are dropped only when the pane is too NARROW to
 * fit them beside the plot, and then in reverse priority order. An earlier cut
 * hid the value below a 20px row height, which silently emptied the gutter on
 * any chart carrying three sub-panes.
 */

/** A cell must be at least this wide before it is asked to hold text. */
const MIN_CELL_W_FOR_TEXT = 26;

/**
 * Caption geometry.
 *
 * It sits top-LEFT, over the oldest columns. Every placement covers cells — the
 * grid runs edge to edge — so the choice is which cells to cover, and the oldest
 * ones are the cheapest. The newest column, top right, is the one the reader is
 * actually deciding against, so it stays clear.
 */
const CAPTION_PAD = 4;
const CAPTION_MAX_FONT = 10;
const MIN_ROW_H_FOR_CAPTION = 12;
const MIN_PLOT_W_FOR_CAPTION = 120;
const CAPTION_SEP = "  ·  ";

/**
 * Ink for text sitting ON a cell, decided from the cell's own fill.
 *
 * The fills are a diverging ramp that runs from near-transparent to nearly
 * opaque, so one fixed ink is wrong at one end or the other: white type
 * disappears on a pale cell in a light theme, black type disappears on a deep
 * one. The fill is composited over the pane background and the ink picked from
 * the result's luminance, which is correct at both ends and in both themes.
 */
export function inkFor(fill: string, isDark: boolean): string {
  const m = fill.match(/rgba?\(([^)]+)\)/);
  if (!m) return isDark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.88)";
  const parts = m[1].split(",").map((v) => Number.parseFloat(v));
  const [r, g, b] = parts;
  const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
  if (![r, g, b].every(Number.isFinite))
    return isDark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.88)";
  const bg = isDark ? 16 : 255;
  const lum =
    (0.2126 * (r * a + bg * (1 - a)) +
      0.7152 * (g * a + bg * (1 - a)) +
      0.0722 * (b * a + bg * (1 - a))) /
    255;
  return lum > 0.55 ? "rgba(0,0,0,0.88)" : "rgba(255,255,255,0.95)";
}

export function createHeatmapOverlay(spec: HeatmapSpec): CanvasOverlay {
  return {
    id: "heatmap",
    name: "Heatmap",
    mode: "full",
    width: 0,

    draw(ctx, chart, _series, data, isDark, rect) {
      const rowCount = spec.rows.length;
      if (rect.height <= 0 || rect.width <= 0) return;

      const dimText = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)";
      const textColor = isDark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.88)";
      const gridColor = isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)";
      const plateBg = isDark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.68)";

      // Nothing to plot. The pane exists anyway (it comes from the indicator
      // being active, not from the data), so say why instead of leaving a box.
      if (rowCount === 0 || spec.columns.length === 0) {
        if (spec.emptyMessage) {
          ctx.save();
          ctx.fillStyle = dimText;
          ctx.font = "11px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(spec.emptyMessage, rect.width / 2, rect.height / 2);
          ctx.restore();
        }
        return;
      }

      const timeScale = chart.timeScale();
      const rowH = rect.height / rowCount;
      const fontPx = fontFor(rowH);
      const subPx = subFontFor(fontPx);

      ctx.save();

      // ── Gutter width, measured from the labels themselves ──
      const labels: HeatmapRowLabel[] = spec.rows.map((r) =>
        typeof r === "string" ? { level: r } : r
      );
      let levelW = 0;
      let oddsW = 0;
      let valueW = 0;
      ctx.font = `${fontPx}px monospace`;
      for (const l of labels) levelW = Math.max(levelW, ctx.measureText(l.level).width);
      for (const l of labels)
        valueW = Math.max(valueW, l.value ? ctx.measureText(l.value).width : 0);
      ctx.font = `${subPx}px monospace`;
      for (const l of labels) oddsW = Math.max(oddsW, l.odds ? ctx.measureText(l.odds).width : 0);

      // Fit as many columns as the WIDTH allows, dropping the least important
      // first. Height never removes a column — it only shrinks the type.
      const hasValue = valueW > 0;
      const hasOdds = oddsW > 0;
      const widthFor = (withValue: boolean, withOdds: boolean) =>
        levelW +
        (withOdds ? oddsW + GUTTER_PAD : 0) +
        (withValue ? valueW + GUTTER_PAD : 0) +
        GUTTER_PAD * 2;

      let showValue = hasValue;
      let showOdds = hasOdds;
      if (rect.width - widthFor(showValue, showOdds) < MIN_PLOT_W) showOdds = false;
      if (rect.width - widthFor(showValue, showOdds) < MIN_PLOT_W) showValue = false;

      const wantGutter = widthFor(showValue, showOdds);
      const showGutter = rect.width - wantGutter >= MIN_PLOT_W;
      const gutterW = showGutter ? wantGutter : 0;

      // ── Where every column lands ──
      // Resolved before sizing: the spacing BETWEEN columns decides how wide a
      // cell may be, and that is a property of this heatmap's own data, not of
      // the price chart's bar pitch.
      const placed: { column: (typeof spec.columns)[number]; x: number }[] = [];
      for (const column of spec.columns) {
        const x = timeScale.timeToCoordinate(column.time as Time);
        if (x != null) placed.push({ column, x });
      }
      if (placed.length === 0) {
        ctx.restore();
        return;
      }
      placed.sort((a, b) => a.x - b.x);

      let minGap = Number.POSITIVE_INFINITY;
      for (let i = 1; i < placed.length; i++) {
        minGap = Math.min(minGap, placed[i].x - placed[i - 1].x);
      }

      const barSpacing = timeScale.options().barSpacing ?? 6;
      const cellW = Math.max(
        1,
        Math.min(Math.max(barSpacing * 0.9, READABLE_CELL_W), minGap * 0.95)
      );

      const hasCellText =
        !!spec.formatValue ||
        spec.columns.some(
          (c) => c.cellLabels?.length === rowCount || c.cellLabelsCompact?.length === rowCount
        );
      const cellsCanLabel = cellW >= MIN_CELL_W_FOR_TEXT && rowH >= fontPx + 3 && hasCellText;

      // The plot owns everything right of the gutter, all the way to the edge —
      // nothing may sit over the newest column.
      const plotL = gutterW;
      const plotR = rect.width;

      /** Top edge of a row, given `rows[0]` is the bottom one. */
      const rowTop = (rowIndex: number) => rect.height - (rowIndex + 1) * rowH;

      // ── Cells ──
      for (const { column, x: xCenter } of placed) {
        if (column.values.length !== rowCount) continue; // malformed — skip, don't mis-stack

        const xLeft = xCenter - cellW / 2;
        // Clipped to the plot, so a cell can never paint over the gutter labels.
        const drawL = Math.max(xLeft, plotL);
        const drawR = Math.min(xLeft + cellW, plotR);
        if (drawR <= drawL) continue;

        for (let row = 0; row < rowCount; row++) {
          const value = column.values[row];
          if (value == null || !Number.isFinite(value)) continue;

          const fill = spec.colorScale(value, row);
          if (!fill) continue;

          const yTop = rowTop(row);
          ctx.fillStyle = fill;
          ctx.fillRect(drawL, yTop, drawR - drawL, rowH);

          // Widest label the cell can hold, in order of preference. Skip rather
          // than spill: a number wider than its cell would bleed into the
          // neighbouring column and read as that column's value.
          if (cellsCanLabel) {
            const candidates = [
              column.cellLabels?.[row] ?? spec.formatValue?.(value) ?? null,
              column.cellLabelsCompact?.[row] ?? null,
            ];
            ctx.font = `${fontPx}px monospace`;
            const budget = drawR - drawL - 4;
            const label = candidates.find((c) => !!c && ctx.measureText(c).width <= budget);
            if (label) {
              ctx.fillStyle = inkFor(fill, isDark);
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(label, (drawL + drawR) / 2, yTop + rowH / 2);
            }
          }
        }

        // ── Marked row (where price actually is/landed) ──
        if (column.markRow != null && column.markRow >= 0 && column.markRow < rowCount) {
          ctx.strokeStyle = spec.markColor ?? (isDark ? "#ffffff" : "#111111");
          ctx.lineWidth = 1.5;
          ctx.strokeRect(
            drawL + 0.75,
            rowTop(column.markRow) + 0.75,
            Math.max(1, drawR - drawL - 1.5),
            Math.max(1, rowH - 1.5)
          );
        }
      }

      // ── Caption: the scale the whole pane is drawn at ──
      // Drawn after the cells so it is never buried, and only as much of it as
      // fits — trailing segments are dropped whole rather than clipped.
      if (spec.caption?.length && rowH >= MIN_ROW_H_FOR_CAPTION) {
        const capPx = Math.max(MIN_FONT_PX, Math.min(CAPTION_MAX_FONT, fontPx));
        ctx.font = `${capPx}px monospace`;
        const budget = plotR - plotL - CAPTION_PAD * 4;
        if (budget >= MIN_PLOT_W_FOR_CAPTION) {
          let text = "";
          for (const seg of spec.caption) {
            const next = text ? `${text}${CAPTION_SEP}${seg}` : seg;
            if (ctx.measureText(next).width > budget) break;
            text = next;
          }
          if (text) {
            const w = ctx.measureText(text).width;
            const h = capPx + CAPTION_PAD;
            ctx.fillStyle = plateBg;
            ctx.fillRect(plotL, 0, w + CAPTION_PAD * 2, h);
            ctx.fillStyle = textColor;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(text, plotL + CAPTION_PAD, h / 2);
          }
        }
      }

      // ── Row separators across the plot ──
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (let row = 1; row < rowCount; row++) {
        const y = Math.round(rowTop(row)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
      }

      // ── Gutter: what each row means ──
      // Level on the left, odds of that outcome on the right. Opaque, so a
      // saturated cell behind it can never render it unreadable.
      if (showGutter) {
        ctx.fillStyle = plateBg;
        ctx.fillRect(0, 0, gutterW, rect.height);

        ctx.beginPath();
        ctx.moveTo(gutterW - 0.5, 0);
        ctx.lineTo(gutterW - 0.5, rect.height);
        ctx.strokeStyle = gridColor;
        ctx.stroke();

        for (let row = 0; row < rowCount; row++) {
          const label = labels[row];
          const centre = rowTop(row) + rowH / 2;

          ctx.fillStyle = label.color ?? textColor;
          ctx.font = `${fontPx}px monospace`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label.level, GUTTER_PAD, centre);

          if (showValue && label.value) {
            ctx.fillStyle = textColor;
            ctx.font = `${fontPx}px monospace`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(label.value, gutterW - GUTTER_PAD, centre);
          }

          if (showOdds && label.odds) {
            ctx.fillStyle = dimText;
            ctx.font = `${subPx}px monospace`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            const oddsRight = showValue
              ? gutterW - GUTTER_PAD - valueW - GUTTER_PAD
              : gutterW - GUTTER_PAD;
            ctx.fillText(label.odds, oddsRight, centre);
          }
        }
      }

      ctx.restore();
      void data; // heatmap columns carry their own times — OHLCV is not needed
    },
  };
}
