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
 *
 * Each line is its own object: clicking it selects it (thicker, hollow handles,
 * a × box at its middle), and the × — or Delete — removes that line alone. The
 * overlay records where it painted each line into a `TrendHitMap` so a click can
 * be matched to a line in the same pane coordinates it was drawn in.
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

/** Where the overlay last painted each line — rewritten on every draw. */
export interface TrendHitMap {
  segments: { id: string; ax: number; ay: number; bx: number; by: number }[];
  deleteBox: { id: string; x: number; y: number; size: number } | null;
}

export function createTrendHitMap(): TrendHitMap {
  return { segments: [], deleteBox: null };
}

/** Pixels from the line that still count as clicking it. */
const HIT_TOLERANCE = 8;
const DELETE_BOX = 13;

function distToSegment(px: number, py: number, s: TrendHitMap["segments"][number]): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len2));
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
}

/**
 * What a click at `p` (price-pane coordinates) landed on: the selected line's
 * × box, else the nearest line within tolerance, else nothing.
 */
export function hitTestTrendLines(
  hits: TrendHitMap,
  p: { x: number; y: number }
): { id: string; onDelete: boolean } | null {
  const box = hits.deleteBox;
  if (
    box &&
    Math.abs(p.x - box.x) <= box.size / 2 + 2 &&
    Math.abs(p.y - box.y) <= box.size / 2 + 2
  ) {
    return { id: box.id, onDelete: true };
  }
  let best: { id: string; d: number } | null = null;
  for (const seg of hits.segments) {
    const d = distToSegment(p.x, p.y, seg);
    if (d <= HIT_TOLERANCE && (!best || d < best.d)) best = { id: seg.id, d };
  }
  return best ? { id: best.id, onDelete: false } : null;
}

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
  pending: TrendPoint | null,
  selectedId: string | null = null,
  hits: TrendHitMap | null = null
): CanvasOverlay {
  return {
    id: "trend-lines",
    name: "Trend Lines",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, data, isDark, rect) {
      if (hits) {
        hits.segments = [];
        hits.deleteBox = null;
      }
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
        const selected = line.id === selectedId;
        hits?.segments.push({ id: line.id, ax: pa[0], ay: pa[1], bx: pb[0], by: pb[1] });
        ctx.save();
        ctx.strokeStyle = line.color;
        ctx.fillStyle = line.color;
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
        for (const [x, y] of [pa, pb]) {
          ctx.beginPath();
          if (selected) {
            // Hollow handles mark the selected line.
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = bg;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = line.color;
          } else {
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (selected) {
          // × box just above the line's midpoint: click it (or press Delete).
          const size = DELETE_BOX;
          const x = Math.max(size, Math.min(rect.width - size, (pa[0] + pb[0]) / 2));
          const y = Math.max(size, (pa[1] + pb[1]) / 2 - size);
          ctx.fillStyle = "#c62828";
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x - 3, y - 3);
          ctx.lineTo(x + 3, y + 3);
          ctx.moveTo(x + 3, y - 3);
          ctx.lineTo(x - 3, y + 3);
          ctx.stroke();
          if (hits) hits.deleteBox = { id: line.id, x, y, size };
          ctx.strokeStyle = line.color;
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
