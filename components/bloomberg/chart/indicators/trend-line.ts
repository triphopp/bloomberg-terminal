/**
 * Trend line — a plain point-to-point line the user draws on the price pane.
 *
 * No fit, no statistics: the two clicked points ARE the line. That is the
 * difference from the Regression Channel (REG), which only borrows the clicked
 * bars' times and then fits its own centre line through the closes in between.
 *
 * Each endpoint is stored as (bar time, price) — the time so a data refresh
 * cannot slide the line onto different bars, the price because a hand-drawn
 * line connects wicks, not closes. Holding Shift on the second click copies the
 * first point's price, which makes the line exactly horizontal (support /
 * resistance).
 *
 * Endpoints on bars that are not loaded on the current timeframe hide the line
 * rather than guessing where it would go.
 */

import { fmtPriceStd } from "../../lib/number-format";
import type { CanvasOverlay, OhlcvBar } from "../types";

export interface TrendPoint {
  time: string | number;
  price: number;
}

export interface StoredTrendLine {
  id: string;
  symbol: string;
  barInterval: string;
  a: TrendPoint;
  b: TrendPoint;
  color: string;
}

export const TREND_LINE_COLOR = "#4fc3f7";

function indexOfTime(data: OhlcvBar[], t: string | number): number {
  const want = String(t);
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i].time) === want) return i;
  }
  return -1;
}

/**
 * One overlay paints every line on the chart plus, while a line is being
 * drawn, the dot marking its first point.
 */
export function createTrendLineOverlay(
  lines: StoredTrendLine[],
  pending: TrendPoint | null
): CanvasOverlay {
  return {
    id: "trend-lines",
    name: "Trend Lines",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, data, isDark, rect) {
      if (data.length === 0) return;
      const timeScale = chart.timeScale();
      const toXY = (p: TrendPoint): [number, number] | null => {
        const i = indexOfTime(data, p.time);
        if (i < 0) return null;
        // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
        const x = timeScale.timeToCoordinate(data[i].time as any);
        const y = mainSeries.priceToCoordinate(p.price);
        return x == null || y == null ? null : [x, y];
      };
      const bg = isDark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)";

      for (const line of lines) {
        const pa = toXY(line.a);
        const pb = toXY(line.b);
        if (!pa || !pb) continue;
        ctx.save();
        ctx.strokeStyle = line.color;
        ctx.fillStyle = line.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
        for (const [x, y] of [pa, pb]) {
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Readout at the right-hand end: a flat line reads as a level, a
        // sloped one as a move.
        const flat = line.a.price === line.b.price;
        const ia = indexOfTime(data, line.a.time);
        const ib = indexOfTime(data, line.b.time);
        // Left → right, whichever order the points were clicked in.
        const [from, to] = ia <= ib ? [line.a, line.b] : [line.b, line.a];
        const pct = from.price !== 0 ? ((to.price - from.price) / from.price) * 100 : 0;
        const label = flat
          ? fmtPriceStd(line.a.price)
          : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%  ${Math.abs(ib - ia)} bars`;
        const end = pa[0] >= pb[0] ? pa : pb;
        ctx.font = "8px monospace";
        const w = ctx.measureText(label).width;
        const lx = Math.min(end[0] + 5, rect.width - w - 6);
        const ly = end[1] - 4;
        ctx.fillStyle = bg;
        ctx.fillRect(lx - 2, ly - 8, w + 4, 11);
        ctx.fillStyle = line.color;
        ctx.fillText(label, lx, ly);
        ctx.restore();
      }

      if (pending) {
        const p = toXY(pending);
        if (p) {
          ctx.save();
          ctx.strokeStyle = TREND_LINE_COLOR;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    },
  };
}
