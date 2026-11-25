/**
 * Price Range — the measure tool (TradingView's "Price Range" / ruler).
 *
 * Two clicks on the price pane: the first is where the move starts, the second
 * where it ends. The box between them reads the change in price, the change in
 * percent (against the FIRST click's price — click order, not left to right, so
 * measuring a drop from a high reads negative), and the bars in between.
 *
 * Nothing is saved: a measurement is a question asked of the chart, not a
 * drawing. It stays on screen until the next click on the chart, Escape, the
 * button, or a symbol / interval change.
 *
 * Shares `TrendPoint` with the trend line, so a point may sit in the future
 * whitespace right of the last bar (`futureBars`).
 */

import { fmtPriceStd } from "../../lib/number-format.ts";
import type { CanvasOverlay, OhlcvBar } from "../types.ts";
import type { TrendPoint, TrendPreview } from "./trend-line.ts";

export const PRICE_RANGE_UP = "#26a69a";
export const PRICE_RANGE_DOWN = "#ef5350";

export interface PriceRangeMeasure {
  /** end − start, in price units */
  change: number;
  /** change / start × 100; null when the start price is 0 */
  pct: number | null;
  /** signed bar count from start to end */
  bars: number;
}

function indexOfTime(data: OhlcvBar[], t: string | number): number {
  const want = String(t);
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i].time) === want) return i;
  }
  return -1;
}

/** Bar position of a point (its bar's index plus any future offset), −1 if not loaded. */
export function barPosition(data: OhlcvBar[], p: TrendPoint): number {
  const i = indexOfTime(data, p.time);
  return i < 0 ? -1 : i + (p.futureBars ?? 0);
}

export function measurePriceRange(
  start: TrendPoint,
  end: TrendPoint,
  data: OhlcvBar[]
): PriceRangeMeasure {
  const change = end.price - start.price;
  const pct = start.price !== 0 ? (change / start.price) * 100 : null;
  const ia = barPosition(data, start);
  const ib = barPosition(data, end);
  return { change, pct, bars: ia < 0 || ib < 0 ? 0 : ib - ia };
}

/** Two label lines: "+1.23 (+4.56%)" and "23 bars". */
export function priceRangeLabel(m: PriceRangeMeasure): [string, string] {
  const sign = m.change > 0 ? "+" : m.change < 0 ? "−" : "";
  const pct =
    m.pct == null ? "—" : `${m.pct > 0 ? "+" : m.pct < 0 ? "−" : ""}${Math.abs(m.pct).toFixed(2)}%`;
  const n = Math.abs(m.bars);
  return [`${sign}${fmtPriceStd(Math.abs(m.change))} (${pct})`, `${n} bar${n === 1 ? "" : "s"}`];
}

/**
 * Paints the measurement: a shaded box from start to end, arrows along both
 * axes, and the readout under (rise) or over (fall) the box. With only a start
 * point, follows `preview` (the cursor) as a live measurement.
 */
export function createPriceRangeOverlay(
  start: TrendPoint | null,
  end: TrendPoint | null,
  preview: TrendPreview | null = null
): CanvasOverlay {
  return {
    id: "price-range",
    name: "Price Range",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, data, isDark, rect) {
      if (!start || data.length === 0) return;
      const timeScale = chart.timeScale();
      const toXY = (p: TrendPoint): [number, number] | null => {
        const i = indexOfTime(data, p.time);
        if (i < 0) return null;
        const x = p.futureBars
          ? // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Logical brand
            timeScale.logicalToCoordinate((i + p.futureBars) as any)
          : // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
            timeScale.timeToCoordinate(data[i].time as any);
        const y = mainSeries.priceToCoordinate(p.price);
        return x == null || y == null ? null : [x, y];
      };

      const a = toXY(start);
      if (!a) return;
      const target = end ?? preview?.current ?? null;
      const b = target ? toXY(target) : null;

      ctx.save();
      if (!target || !b) {
        // Only the start: a ring where the measurement begins.
        ctx.strokeStyle = PRICE_RANGE_UP;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(a[0], a[1], 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
      }

      const m = measurePriceRange(start, target, data);
      const color = m.change < 0 ? PRICE_RANGE_DOWN : PRICE_RANGE_UP;
      const x0 = Math.min(a[0], b[0]);
      const x1 = Math.max(a[0], b[0]);
      const y0 = Math.min(a[1], b[1]);
      const y1 = Math.max(a[1], b[1]);

      ctx.fillStyle = `${color}26`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      // Start and end price levels across the box.
      ctx.beginPath();
      ctx.moveTo(x0, a[1]);
      ctx.lineTo(x1, a[1]);
      ctx.moveTo(x0, b[1]);
      ctx.lineTo(x1, b[1]);
      ctx.stroke();

      // Vertical arrow (price) through the middle, pointing at the end price.
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, a[1]);
      ctx.lineTo(mx, b[1]);
      ctx.stroke();
      if (Math.abs(b[1] - a[1]) > 8) {
        const dir = b[1] < a[1] ? 1 : -1; // tip up when the price rose
        ctx.beginPath();
        ctx.moveTo(mx - 4, b[1] + dir * 6);
        ctx.lineTo(mx, b[1]);
        ctx.lineTo(mx + 4, b[1] + dir * 6);
        ctx.stroke();
      }
      // Horizontal arrow (time) through the middle, pointing at the end bar.
      ctx.beginPath();
      ctx.moveTo(a[0], my);
      ctx.lineTo(b[0], my);
      ctx.stroke();
      if (Math.abs(b[0] - a[0]) > 8) {
        const dir = b[0] > a[0] ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(b[0] + dir * 6, my - 4);
        ctx.lineTo(b[0], my);
        ctx.lineTo(b[0] + dir * 6, my + 4);
        ctx.stroke();
      }

      // Readout: under the box on a rise, over it on a fall (TradingView's place).
      const [l1, l2] = priceRangeLabel(m);
      ctx.font = "bold 9px monospace";
      const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 10;
      const h = 26;
      const lx = Math.max(2, Math.min(rect.width - w - 2, mx - w / 2));
      let ly = m.change < 0 ? y0 - h - 4 : y1 + 4;
      if (ly < 2) ly = y1 + 4;
      if (ly + h > rect.height - 2) ly = Math.max(2, y0 - h - 4);
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly, w, h);
      ctx.fillStyle = isDark ? "#000" : "#fff";
      ctx.textAlign = "center";
      ctx.fillText(l1, lx + w / 2, ly + 11);
      ctx.font = "9px monospace";
      ctx.fillText(l2, lx + w / 2, ly + 22);
      ctx.restore();
    },
  };
}
