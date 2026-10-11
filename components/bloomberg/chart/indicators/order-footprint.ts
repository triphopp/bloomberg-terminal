/**
 * Order Footprint Canvas Overlay — volumetric bars
 *
 * Each candle is drawn on one shared price grid: a thin candle on the left,
 * then one row per price step coloured by who won it (green buyers, red
 * sellers) and by how much. What the rows carry depends on the room a bar has:
 *
 *   wide    SELL | BUY volume per row
 *   medium  the row's delta (buy − sell)
 *   narrow  colour only — the shape of the buying and selling, no numbers
 *
 * The numbers that matter are coloured, the rest stay quiet:
 *   yellow  — the row that traded the most (point of control)
 *   magenta — sellers 3x the buyers one row up   (sell imbalance)
 *   cyan    — buyers 3x the sellers one row down  (buy imbalance)
 *
 * A strip at the bottom of the pane carries the per-candle totals at every
 * zoom — DELTA and CUM Δ are the trend of the order flow across the screen.
 *
 * Data source: Binance klines (totals, every candle) + aggTrades (rows, the
 * most recent candles). Crypto only.
 */

import type { Time } from "lightweight-charts";
import type { CanvasOverlay, OhlcvBar } from "../types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FootprintLevel {
  priceLow: number;
  priceHigh: number;
  buyVol: number;
  sellVol: number;
}

export interface FootprintCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
  /** Empty when the candle is outside the detail window or not read yet. */
  levels: FootprintLevel[];
  /** Exact, from the kline — not the sum of `levels`. */
  totalBuyVol: number;
  totalSellVol: number;
  /** Share of the candle's volume the levels hold; null when it has no levels. */
  coverage?: number | null;
  /** Lowest / highest running delta inside the candle; null when coverage is partial. */
  minDelta?: number | null;
  maxDelta?: number | null;
}

export interface FootprintData {
  symbol: string;
  interval: string;
  /** Price grid of `levels`: every level is [k*step, (k+1)*step). */
  step?: number;
  /** Candles whose levels the backend has still to read. */
  pending?: number;
  candles: FootprintCandle[];
}

// ── Row maths (pure — chart/__tests__/order-footprint.test.ts) ───────────────

const IMBALANCE_RATIO = 3;
const MULTIPLES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

export interface FootprintRow {
  /** Row index on the display grid: the row spans [k*displayStep, (k+1)*displayStep). */
  k: number;
  buy: number;
  sell: number;
  poc: boolean;
  buyImbalance: boolean;
  sellImbalance: boolean;
}

/** Smallest grid multiple whose row is at least `minPx` tall. */
export function displayMultiple(pxPerStep: number, minPx: number): number {
  if (!(pxPerStep > 0)) return MULTIPLES[MULTIPLES.length - 1];
  for (const m of MULTIPLES) if (m * pxPerStep >= minPx) return m;
  return MULTIPLES[MULTIPLES.length - 1];
}

/** Merge a candle's levels onto a grid `mult` times coarser; rows come back top price first. */
export function mergeLevels(levels: FootprintLevel[], step: number, mult: number): FootprintRow[] {
  const byRow = new Map<number, FootprintRow>();
  for (const lvl of levels) {
    const k = Math.floor(Math.round(lvl.priceLow / step) / mult);
    let row = byRow.get(k);
    if (!row) {
      row = { k, buy: 0, sell: 0, poc: false, buyImbalance: false, sellImbalance: false };
      byRow.set(k, row);
    }
    row.buy += lvl.buyVol;
    row.sell += lvl.sellVol;
  }

  let poc: FootprintRow | null = null;
  for (const row of byRow.values()) {
    if (!poc || row.buy + row.sell > poc.buy + poc.sell) poc = row;
    // Diagonal, as a footprint is read: a market buy lifts the offer one row
    // above the bid it is compared with.
    const below = byRow.get(row.k - 1);
    const above = byRow.get(row.k + 1);
    row.buyImbalance = !!below && below.sell > 0 && row.buy >= IMBALANCE_RATIO * below.sell;
    row.sellImbalance = !!above && above.buy > 0 && row.sell >= IMBALANCE_RATIO * above.buy;
  }
  if (poc) poc.poc = true;

  // perf-ok: once per candle per zoom step (cached in the overlay), not per bar per tick
  return [...byRow.values()].sort((a, b) => b.k - a.k);
}

/**
 * The value a colour scale saturates at: the `q` quantile of the magnitudes,
 * so one freak candle does not wash every other one out to grey.
 */
export function scaleTop(magnitudes: number[], q = 0.95): number {
  const present = magnitudes.filter((v) => v > 0);
  if (!present.length) return 0;
  // perf-ok: once per data set / zoom step, cached by the overlay
  present.sort((a, b) => a - b);
  return present[Math.min(present.length - 1, Math.floor(q * present.length))];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** One number of decimals for a whole column, so the digits line up. */
function decimalsFor(max: number): number {
  if (max >= 100) return 0;
  if (max >= 10) return 1;
  return 2;
}

const formatters = new Map<number, Intl.NumberFormat>();
function fmt(v: number, decimals: number): string {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    formatters.set(decimals, f);
  }
  return f.format(v);
}

function signed(v: number, decimals: number): string {
  const s = fmt(v, decimals);
  // A value that rounds to nothing is "0", not "-0" or "+0".
  if (Number(s.replace(/,/g, "")) === 0) return fmt(0, decimals);
  return v > 0 ? `+${s}` : s;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  // perf-ok: once per bar set (cached below), not per frame
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Colour of the surface the chart sits on. The chart itself is transparent, so
 * this is the nearest ancestor that paints an opaque background.
 */
const grounds = new WeakMap<Element, string>();
function groundOf(el: Element, isDark: boolean): string {
  const known = grounds.get(el);
  if (known) return known;
  let found = isDark ? "#000000" : "#ffffff";
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const parts = bg
      .match(/rgba?\(([^)]+)\)/)?.[1]
      .split(",")
      .map(Number);
    if (parts && (parts.length < 4 || parts[3] >= 0.99)) {
      found = bg;
      break;
    }
  }
  grounds.set(el, found);
  return found;
}

const GREEN = "38,166,91";
const RED = "220,53,69";

/** Signed strength in −1..1 for a colour: sign of `v`, √ of its share of `top`. */
function tone(v: number, top: number): number {
  return top > 0 ? Math.sign(v) * Math.min(1, Math.sqrt(Math.abs(v) / top)) : 0;
}

interface SummaryRow {
  label: string;
  cell(c: FootprintCandle, cum: number): { text: string; tone: number } | null;
}

// ── Overlay Factory ─────────────────────────────────────────────────────────

export function createFootprintOverlay(footprintData?: FootprintData | null): CanvasOverlay {
  const candles = footprintData?.candles ?? [];
  const step = footprintData?.step ?? 0;

  // Rows per display multiple — merged once, reused on every frame.
  const merged = new Map<
    number,
    { rows: FootprintRow[][]; deltaTop: number; volDec: number; deltaDec: number }
  >();
  const rowsFor = (mult: number) => {
    let hit = merged.get(mult);
    if (!hit) {
      const rows = candles.map((c) => mergeLevels(c.levels, step, mult));
      const deltas: number[] = [];
      const vols: number[] = [];
      for (const candleRows of rows) {
        for (const r of candleRows) {
          deltas.push(Math.abs(r.buy - r.sell));
          vols.push(Math.max(r.buy, r.sell));
        }
      }
      // Decimals follow an ordinary row, not the largest: most cells should
      // show a digit that means something.
      hit = {
        rows,
        deltaTop: scaleTop(deltas, 0.98),
        volDec: decimalsFor(scaleTop(vols, 0.75)),
        deltaDec: decimalsFor(scaleTop(deltas, 0.75)),
      };
      merged.set(mult, hit);
    }
    return hit;
  };

  let maxCandleVol = 0;
  let cumTop = 0;
  const cumDelta: number[] = [];
  {
    let cum = 0;
    for (const c of candles) {
      cum += c.totalBuyVol - c.totalSellVol;
      cumDelta.push(cum);
      maxCandleVol = Math.max(maxCandleVol, c.volume);
      cumTop = Math.max(cumTop, Math.abs(cum));
    }
  }
  const candleDeltaTop = scaleTop(candles.map((c) => Math.abs(c.totalBuyVol - c.totalSellVol)));
  // Decimals of an ordinary candle; one spike should not round the rest to 0.
  const sumDec = decimalsFor(
    scaleTop(
      candles.map((c) => c.volume),
      0.5
    ) || maxCandleVol
  );

  const SUMMARY: SummaryRow[] = [
    { label: "VOL", cell: (c) => ({ text: fmt(c.volume, sumDec), tone: 0 }) },
    { label: "BUY", cell: (c) => ({ text: fmt(c.totalBuyVol, sumDec), tone: 0 }) },
    { label: "SELL", cell: (c) => ({ text: fmt(c.totalSellVol, sumDec), tone: 0 }) },
    {
      label: "DELTA",
      cell: (c) => {
        const d = c.totalBuyVol - c.totalSellVol;
        return { text: signed(d, sumDec), tone: tone(d, candleDeltaTop) };
      },
    },
    {
      label: "DELTA %",
      cell: (c) => {
        if (!(c.volume > 0)) return null;
        const pct = ((c.totalBuyVol - c.totalSellVol) / c.volume) * 100;
        return { text: `${signed(pct, 1)}%`, tone: tone(pct, 30) };
      },
    },
    { label: "CUM Δ", cell: (_c, cum) => ({ text: signed(cum, sumDec), tone: tone(cum, cumTop) }) },
    {
      label: "MIN Δ",
      cell: (c) => (c.minDelta == null ? null : { text: signed(c.minDelta, sumDec), tone: 0 }),
    },
    {
      label: "MAX Δ",
      cell: (c) => (c.maxDelta == null ? null : { text: signed(c.maxDelta, sumDec), tone: 0 }),
    },
  ];

  // What depends on the chart's bars only — rebuilt when a new bar set arrives,
  // not on every frame.
  let placedFor: OhlcvBar[] | null = null;
  let times: Array<string | number> = [];
  let chartBars = new Map<string | number, OhlcvBar>();
  let basis = 0;
  const place = (data: OhlcvBar[]) => {
    if (placedFor === data) return;
    placedFor = data;

    // Intraday bars reach the chart as `new Date("2026-10-10T02:55:00")` — the
    // exchange's wall clock (UTC for crypto) read in the browser's zone — so
    // the footprint's UTC instant has to be read the same way, or no candle
    // matches a bar on any machine that is not itself on UTC.
    const useDateStr = data.length > 0 && typeof data[0].time === "string";
    times = candles.map((c) => {
      if (useDateStr) return msToDateStr(c.openTime);
      const d = new Date(c.openTime);
      return Math.floor(
        new Date(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
          d.getUTCHours(),
          d.getUTCMinutes(),
          d.getUTCSeconds()
        ).getTime() / 1000
      );
    });

    chartBars = new Map();
    for (let i = data.length - 1; i >= 0; i--) {
      const t = data[i].time;
      // Both sides are seconds or both "YYYY-MM-DD": `<` orders either.
      if ((t as number) < (times[0] as number)) break;
      chartBars.set(t, data[i]);
    }

    // The chart's bars are Yahoo's BTC-USD, the footprint is Binance's USDT
    // pair: the same move a few dozen dollars apart. One shift for the whole
    // set (the median gap between the two mid-ranges) puts the rows on the
    // chart's price scale and keeps every candle on the same grid.
    const gaps: number[] = [];
    candles.forEach((c, i) => {
      const bar = chartBars.get(times[i]);
      if (bar && bar.high > bar.low) gaps.push((bar.high + bar.low) / 2 - (c.high + c.low) / 2);
    });
    basis = median(gaps);
  };

  return {
    id: "order-footprint",
    name: "Order Footprint",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, _data, isDark, rect) {
      if (!candles.length || !_data.length) return;
      place(_data);

      const timeScale = chart.timeScale();
      const barSpacing = timeScale.options().barSpacing;
      const y = (price: number) => mainSeries.priceToCoordinate(price + basis);

      // ── Layout: what a bar has room for ──
      const gap =
        barSpacing >= 12 ? Math.min(8, Math.max(2, barSpacing * 0.06)) : barSpacing >= 5 ? 1 : 0;
      const slotW = barSpacing - gap;
      const level: "table" | "delta" | "heat" | "wash" =
        slotW >= 64 ? "table" : slotW >= 30 ? "delta" : slotW >= 7 ? "heat" : "wash";
      const withText = level === "table" || level === "delta";

      // ── Colors ──
      // The card is the pane's own ground: it takes the chart's candle away
      // without leaving a box behind the rows.
      const card = groundOf(chart.chartElement(), isDark);
      const frame = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.18)";
      const text = isDark ? "#e4e6ea" : "#1b1d21";
      const dim = isDark ? "rgba(228,230,234,0.6)" : "rgba(27,29,33,0.65)";
      const pocText = isDark ? "#ffd60a" : "#9a6b00";
      const sellImbText = isDark ? "#ff5fd2" : "#b3128c";
      const buyImbText = isDark ? "#3fd9f0" : "#0a7f96";
      const neutral = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
      const fill = (t: number, floor = 0.14) =>
        t === 0
          ? neutral
          : `rgba(${t > 0 ? GREEN : RED},${(floor + (0.86 - floor) * Math.abs(t)).toFixed(3)})`;

      // ── Bars ──
      const drawn: Array<{ i: number; xLeft: number }> = [];
      const ref = candles[candles.length - 1].close;
      const y0 = y(ref);
      const y1 = step > 0 ? y(ref + step) : null;
      const canRows = y0 != null && y1 != null;
      const mult = canRows ? displayMultiple(Math.abs(y0 - y1), withText ? 13 : 4) : 1;
      const displayStep = step * mult;
      const set = canRows ? rowsFor(mult) : null;
      const volDec = set?.volDec ?? 0;
      const deltaDec = set?.deltaDec ?? 0;
      const deltaTop = set?.deltaTop ?? 0;
      const candleW =
        level === "wash"
          ? 0
          : withText
            ? Math.max(4, Math.min(10, Math.round(slotW * 0.08)))
            : Math.max(2, Math.min(4, Math.round(slotW * 0.18)));
      const rowsGap = level === "wash" ? 0 : withText ? 3 : 1;
      const fontPx = slotW >= 112 ? 11 : slotW >= 84 ? 10 : 9;

      for (let i = 0; i < candles.length; i++) {
        const xCenter = timeScale.timeToCoordinate(times[i] as Time);
        if (xCenter == null) continue;
        const xLeft = xCenter - slotW / 2;
        if (xLeft > rect.width || xLeft + slotW < 0) continue;
        drawn.push({ i, xLeft });

        const candle = candles[i];
        const candleRows = set?.rows[i];
        if (!candleRows?.length) continue;

        const top = y((candleRows[0].k + 1) * displayStep);
        const bottom = y(candleRows[candleRows.length - 1].k * displayStep);
        if (top == null || bottom == null) continue;

        const partial = (candle.coverage ?? 1) < 0.9;

        if (level === "wash") {
          // Bars a few pixels wide: tint the candle, leave it readable.
          ctx.globalAlpha = partial ? 0.3 : 0.7;
          for (const row of candleRows) {
            const yTop = y((row.k + 1) * displayStep);
            const yBot = y(row.k * displayStep);
            if (yTop == null || yBot == null) continue;
            ctx.fillStyle = fill(tone(row.buy - row.sell, deltaTop), 0.3);
            ctx.fillRect(xLeft, yTop, Math.max(1, slotW), Math.max(1, yBot - yTop));
          }
          ctx.globalAlpha = 1;
          continue;
        }

        // Card: hides the chart's own candle, so the slot reads as one object.
        const bar = chartBars.get(times[i]);
        const barTop = bar ? mainSeries.priceToCoordinate(bar.high) : null;
        const barBottom = bar ? mainSeries.priceToCoordinate(bar.low) : null;
        const hi = y(candle.high);
        const lo = y(candle.low);
        const cardTop = Math.min(top, barTop ?? top, hi ?? top) - 1;
        const cardBottom = Math.max(bottom, barBottom ?? bottom, lo ?? bottom) + 1;
        ctx.fillStyle = card;
        ctx.fillRect(xLeft - gap / 2, cardTop, slotW + gap, cardBottom - cardTop);

        // Thin candle, from the same feed as the rows beside it.
        const o = y(candle.open);
        const c = y(candle.close);
        if (o != null && c != null && hi != null && lo != null) {
          ctx.fillStyle = `rgb(${candle.close >= candle.open ? GREEN : RED})`;
          ctx.fillRect(Math.round(xLeft + candleW / 2) - 0.5, hi, 1, Math.max(1, lo - hi));
          ctx.fillRect(xLeft, Math.min(o, c), candleW, Math.max(1, Math.abs(c - o)));
        }

        const rowsX = xLeft + candleW + rowsGap;
        const rowsW = slotW - candleW - rowsGap;
        const colW = rowsW / 2;
        const rowGap = withText ? 1 : 0;

        ctx.globalAlpha = partial ? 0.45 : 1;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        for (const row of candleRows) {
          const yTop = y((row.k + 1) * displayStep);
          const yBot = y(row.k * displayStep);
          if (yTop == null || yBot == null) continue;
          const h = yBot - yTop;
          const delta = row.buy - row.sell;
          ctx.fillStyle = fill(tone(delta, deltaTop));
          ctx.fillRect(rowsX, yTop, rowsW, Math.max(1, h - rowGap));

          if (!withText || h < fontPx + 1) continue;
          const midY = yTop + (h - rowGap) / 2;
          if (level === "delta") {
            const hot = row.buyImbalance || row.sellImbalance || row.poc;
            ctx.font = `${hot ? "700" : "400"} ${fontPx}px ${FONT}`;
            ctx.fillStyle = row.sellImbalance
              ? sellImbText
              : row.buyImbalance
                ? buyImbText
                : row.poc
                  ? pocText
                  : text;
            ctx.fillText(signed(delta, deltaDec), rowsX + rowsW / 2, midY, rowsW - 3);
            continue;
          }
          ctx.font = `${row.sellImbalance || row.poc ? "700" : "400"} ${fontPx}px ${FONT}`;
          ctx.fillStyle = row.sellImbalance ? sellImbText : row.poc ? pocText : text;
          ctx.fillText(fmt(row.sell, volDec), rowsX + colW / 2, midY, colW - 4);
          ctx.font = `${row.buyImbalance || row.poc ? "700" : "400"} ${fontPx}px ${FONT}`;
          ctx.fillStyle = row.buyImbalance ? buyImbText : row.poc ? pocText : text;
          ctx.fillText(fmt(row.buy, volDec), rowsX + colW + colW / 2, midY, colW - 4);
        }
        ctx.globalAlpha = 1;

        if (withText) {
          ctx.strokeStyle = frame;
          ctx.lineWidth = 1;
          ctx.strokeRect(rowsX + 0.5, top + 0.5, rowsW - 1, bottom - top - 1);
        }

        if (partial && level === "table") {
          ctx.font = `400 9px ${FONT}`;
          ctx.fillStyle = dim;
          ctx.textBaseline = "bottom";
          ctx.fillText(
            `${Math.round((candle.coverage ?? 0) * 100)}% of trades`,
            rowsX + rowsW / 2,
            cardTop - 1,
            rowsW
          );
        }
      }

      // ── Summary strip: every candle, every zoom ──
      if (!drawn.length) return;
      const stripText = slotW >= 44;
      const rowH = stripText ? 14 : 9;
      const wanted = !stripText
        ? ["DELTA", "CUM Δ"]
        : rect.height >= 440
          ? ["VOL", "BUY", "SELL", "DELTA", "DELTA %", "CUM Δ", "MIN Δ", "MAX Δ"]
          : rect.height >= 260
            ? ["VOL", "DELTA", "DELTA %", "CUM Δ"]
            : ["DELTA", "CUM Δ"];
      const summary = SUMMARY.filter((r) => wanted.includes(r.label));
      const stripTop = rect.height - summary.length * rowH - 2;
      const sumFont = slotW >= 84 ? 10 : 9;
      const cellW = Math.max(1, slotW);

      ctx.fillStyle = card;
      ctx.fillRect(0, stripTop - 1, rect.width, summary.length * rowH + 3);

      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.font = `400 ${sumFont}px ${FONT}`;
      for (const { i, xLeft } of drawn) {
        for (let r = 0; r < summary.length; r++) {
          const cell = summary[r].cell(candles[i], cumDelta[i]);
          if (!cell) continue;
          const yTop = stripTop + r * rowH;
          ctx.fillStyle = fill(cell.tone, stripText ? 0.14 : 0.25);
          ctx.fillRect(xLeft, yTop, cellW, rowH - 1);
          if (!stripText) continue;
          ctx.fillStyle = text;
          ctx.fillText(cell.text, xLeft + slotW / 2, yTop + (rowH - 1) / 2, slotW - 4);
        }
      }

      // Row names, over the left edge of the strip.
      ctx.font = `400 ${stripText ? 9 : 8}px ${FONT}`;
      ctx.textAlign = "left";
      const labelW = stripText ? 46 : 34;
      for (let r = 0; r < summary.length; r++) {
        const yTop = stripTop + r * rowH;
        ctx.fillStyle = card;
        ctx.fillRect(0, yTop - (r === 0 ? 1 : 0), labelW, rowH + 1);
        ctx.fillStyle = dim;
        ctx.fillText(summary[r].label, 3, yTop + (rowH - 1) / 2);
      }
    },
  };
}
