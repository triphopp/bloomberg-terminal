/**
 * Order Footprint Canvas Overlay — NinjaTrader-style
 *
 * Renders buy×sell volume cells at each price level inside each candlestick.
 * Visual: green cells where buyers dominate, red where sellers dominate.
 * Delta shown below each candle. Text format: "buyVol x sellVol".
 *
 * Data source: Binance aggTrades (crypto only).
 */

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import type { OhlcvBar, CanvasOverlay } from "../types";

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
  levels: FootprintLevel[];
  totalBuyVol: number;
  totalSellVol: number;
}

export interface FootprintData {
  symbol: string;
  interval: string;
  candles: FootprintCandle[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const IMBALANCE_RATIO = 2.0;

function fmtVol(v: number): string {
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 1) return v.toFixed(0);
  if (v >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
}

function alphaHex(base: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return base + a;
}

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Overlay Factory ─────────────────────────────────────────────────────────

export function createFootprintOverlay(footprintData?: FootprintData | null): CanvasOverlay {
  return {
    id: "order-footprint",
    name: "Order Footprint",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, _data, isDark) {
      if (!footprintData?.candles?.length) return;

      const timeScale = chart.timeScale();
      const candles = footprintData.candles;

      // Detect if chart uses date strings or UNIX seconds
      const useDateStr = _data.length > 0 && typeof _data[0].time === "string";

      // Convert footprint openTime (ms) to chart-compatible time value
      const toChartTime = (openTimeMs: number) =>
        useDateStr ? msToDateStr(openTimeMs) : openTimeMs / 1000;

      // ── Estimate bar pixel width ──
      let barWidthPx = 40;
      if (candles.length >= 2) {
        const t0 = toChartTime(candles[0].openTime);
        const t1 = toChartTime(candles[1].openTime);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const x0 = timeScale.timeToCoordinate(t0 as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const x1 = timeScale.timeToCoordinate(t1 as any);
        if (x0 != null && x1 != null) barWidthPx = Math.abs(x1 - x0);
      }

      // Skip rendering if bars too narrow
      if (barWidthPx < 12) return;

      const cellW = barWidthPx * 0.88;
      const showText = barWidthPx >= 36;
      const showDelta = barWidthPx >= 24;

      // ── Colors ──
      const buyBg   = isDark ? "#0d472e" : "#c8f7dc";
      const sellBg  = isDark ? "#4a1520" : "#fdd";
      const buyHi   = isDark ? "#1a6b45" : "#7de8a8";
      const sellHi  = isDark ? "#7a2030" : "#f9a0a0";
      const cellBorder = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
      const textBuy    = isDark ? "#4ade80" : "#166534";
      const textSell   = isDark ? "#f87171" : "#991b1b";
      const textNeutral = isDark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)";
      const deltaPlusBg  = isDark ? "#0d472e" : "#dcfce7";
      const deltaMinusBg = isDark ? "#4a1520" : "#fee2e2";
      const deltaPlusText  = isDark ? "#4ade80" : "#166534";
      const deltaMinusText = isDark ? "#f87171" : "#991b1b";

      for (const candle of candles) {
        if (!candle.levels.length) continue;

        const candleTime = toChartTime(candle.openTime);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xCenter = timeScale.timeToCoordinate(candleTime as any);
        if (xCenter == null) continue;

        const xLeft = xCenter - cellW / 2;

        // ── Draw cells ──
        for (const lvl of candle.levels) {
          const yTop = mainSeries.priceToCoordinate(lvl.priceHigh);
          const yBot = mainSeries.priceToCoordinate(lvl.priceLow);
          if (yTop == null || yBot == null) continue;

          const cellH = Math.max(2, yBot - yTop);
          const total = lvl.buyVol + lvl.sellVol;
          if (total <= 0) continue;

          const buyDominant = lvl.buyVol > lvl.sellVol;
          const ratio = buyDominant
            ? (lvl.sellVol > 0 ? lvl.buyVol / lvl.sellVol : 99)
            : (lvl.buyVol > 0 ? lvl.sellVol / lvl.buyVol : 99);
          const isImbalance = ratio >= IMBALANCE_RATIO;

          // Cell background
          if (buyDominant) {
            ctx.fillStyle = isImbalance ? buyHi : buyBg;
          } else {
            ctx.fillStyle = isImbalance ? sellHi : sellBg;
          }
          ctx.fillRect(xLeft, yTop, cellW, cellH);

          // Cell border
          ctx.strokeStyle = cellBorder;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(xLeft, yTop, cellW, cellH);

          // Text: "buyVol x sellVol"
          if (showText && cellH >= 9) {
            const midY = yTop + cellH / 2;
            const buyStr = fmtVol(lvl.buyVol);
            const sellStr = fmtVol(lvl.sellVol);

            ctx.font = isImbalance ? "bold 7px monospace" : "7px monospace";
            ctx.textBaseline = "middle";

            // Buy volume (left half)
            ctx.textAlign = "right";
            ctx.fillStyle = buyDominant && isImbalance ? textBuy : textNeutral;
            ctx.fillText(buyStr, xCenter - 3, midY);

            // Separator "x"
            ctx.textAlign = "center";
            ctx.fillStyle = textNeutral;
            ctx.fillText("x", xCenter, midY);

            // Sell volume (right half)
            ctx.textAlign = "left";
            ctx.fillStyle = !buyDominant && isImbalance ? textSell : textNeutral;
            ctx.fillText(sellStr, xCenter + 3, midY);
          }
        }

        // ── Delta label below candle ──
        if (showDelta) {
          const delta = candle.totalBuyVol - candle.totalSellVol;
          const yBottom = mainSeries.priceToCoordinate(candle.low);
          if (yBottom == null) continue;

          const deltaStr = `${delta >= 0 ? "+" : ""}${fmtVol(Math.abs(delta))}`;
          const labelY = yBottom + 12;

          ctx.font = "bold 8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          // Background pill
          const tw = ctx.measureText(deltaStr).width;
          const pillW = tw + 6;
          const pillH = 11;
          ctx.fillStyle = delta >= 0 ? deltaPlusBg : deltaMinusBg;
          ctx.fillRect(xCenter - pillW / 2, labelY - pillH / 2, pillW, pillH);

          // Border
          ctx.strokeStyle = delta >= 0
            ? alphaHex(deltaPlusText, 0.3)
            : alphaHex(deltaMinusText, 0.3);
          ctx.lineWidth = 0.5;
          ctx.strokeRect(xCenter - pillW / 2, labelY - pillH / 2, pillW, pillH);

          // Text
          ctx.fillStyle = delta >= 0 ? deltaPlusText : deltaMinusText;
          ctx.fillText(deltaStr, xCenter, labelY);
        }
      }
    },
  };
}
