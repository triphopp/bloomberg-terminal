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
 *   ┌───────────────┬──────────────────────────────────┬─────────────┐
 *   │  +2σ    2.3%  │        [cells, labelled]         │  (rail)     │
 *   │  +1σ   15.9%  │                                  │  fallback   │
 *   │   0σ   50.0%  │                                  │  only       │
 *   └───────────────┴──────────────────────────────────┴─────────────┘
 *        gutter                    plot
 *
 * The gutter carries what each row MEANS — the level, and beside it the odds of
 * that outcome — and never scrolls away. The cells carry what the row is worth
 * right now.
 *
 * The right rail is a fallback, not a fixture: when the cells are wide enough to
 * print their own values it would only repeat them, so it is dropped and its
 * width handed back to the plot.
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

/** Fallback rail, used only when the cells cannot label themselves. */
const RAIL_W = 72;
const MIN_ROW_H_FOR_RAIL_SUB = 24;
const MIN_ROW_H_FOR_RAIL_TITLE = 30;

/** A cell must be at least this wide before it is asked to hold text. */
const MIN_CELL_W_FOR_TEXT = 26;

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
      ctx.font = `${fontPx}px monospace`;
      for (const l of labels) levelW = Math.max(levelW, ctx.measureText(l.level).width);
      ctx.font = `${subPx}px monospace`;
      for (const l of labels) oddsW = Math.max(oddsW, l.odds ? ctx.measureText(l.odds).width : 0);

      const wantGutter = levelW + oddsW + GUTTER_PAD * 3;
      const showGutter = rowH >= fontPx + 3 && rect.width - wantGutter >= MIN_PLOT_W;
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
        !!spec.formatValue || spec.columns.some((c) => c.cellLabels?.length === rowCount);
      const cellsCanLabel = cellW >= MIN_CELL_W_FOR_TEXT && rowH >= fontPx + 3 && hasCellText;

      // The rail answers "what is this row worth" only when the cells are too
      // narrow to say it themselves. When they can, it is pure duplication.
      const showRail = !!spec.rail && !cellsCanLabel && rect.width - gutterW - RAIL_W >= MIN_PLOT_W;
      const plotL = gutterW;
      const plotR = rect.width - (showRail ? RAIL_W : 0);

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

          const label = column.cellLabels?.[row] ?? spec.formatValue?.(value) ?? null;
          if (cellsCanLabel && label) {
            ctx.font = `${fontPx}px monospace`;
            // Skip rather than spill: a number wider than its cell would bleed
            // into the neighbouring column and read as that column's value.
            if (ctx.measureText(label).width <= drawR - drawL - 4) {
              ctx.fillStyle = textColor;
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

          if (label.odds) {
            ctx.fillStyle = dimText;
            ctx.font = `${subPx}px monospace`;
            ctx.textAlign = "right";
            ctx.fillText(label.odds, gutterW - GUTTER_PAD, centre);
          }
        }
      }

      // ── Fallback rail ──
      if (showRail && spec.rail) {
        const railX = plotR;
        ctx.fillStyle = plateBg;
        ctx.fillRect(railX, 0, RAIL_W, rect.height);

        ctx.beginPath();
        ctx.moveTo(railX + 0.5, 0);
        ctx.lineTo(railX + 0.5, rect.height);
        ctx.strokeStyle = gridColor;
        ctx.stroke();

        const showSub = rowH >= MIN_ROW_H_FOR_RAIL_SUB && !!spec.rail.subRows;
        const railFont = Math.max(MIN_FONT_PX, Math.min(fontPx, Math.floor(rowH - 1)));
        const rightEdge = railX + RAIL_W - 4;
        ctx.textAlign = "right";

        for (let row = 0; row < rowCount; row++) {
          const primary = spec.rail.rows[row];
          if (!primary) continue;
          const centre = rowTop(row) + rowH / 2;
          const sub = showSub ? spec.rail.subRows?.[row] : null;

          ctx.fillStyle = textColor;
          ctx.font = `${railFont}px monospace`;
          ctx.textBaseline = sub ? "bottom" : "middle";
          ctx.fillText(primary, rightEdge, centre);

          if (sub) {
            ctx.fillStyle = dimText;
            ctx.font = `${Math.max(MIN_FONT_PX, railFont - 3)}px monospace`;
            ctx.textBaseline = "top";
            ctx.fillText(sub, rightEdge, centre + 1);
          }
        }

        if (spec.rail.title && rowH >= MIN_ROW_H_FOR_RAIL_TITLE) {
          ctx.fillStyle = dimText;
          ctx.font = `${MIN_FONT_PX + 1}px monospace`;
          ctx.textBaseline = "top";
          ctx.fillText(spec.rail.title, rightEdge, 2);
        }
      }

      ctx.restore();
      void data; // heatmap columns carry their own times — OHLCV is not needed
    },
  };
}
