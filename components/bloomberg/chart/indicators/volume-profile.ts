/**
 * Volume Profile — Session-based & Composite Canvas Overlay
 *
 * Two overlay modes:
 *   1. **Session VP** (full-chart) — per-day horizontal volume bars with V-POC, VA-H, VA-L labels
 *   2. **Composite VP** (right-strip) — aggregated volume distribution on the right edge
 *
 * Requires intraday data (5m/15m/1h) for meaningful session profiles.
 * When only daily bars are available, falls back to composite-only mode.
 */

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import type { CanvasOverlay, OhlcvBar } from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION_BUCKETS = 24; // fallback price buckets per session (adaptive at draw)
const COMPOSITE_WIDTH_PX = 56; // width of right-side composite strip
const VALUE_AREA_PCT = 0.7; // 70% of volume = Value Area
const SESSION_FILL_PCT = 0.85; // max fill width relative to session pixel width

// Session detection: split intraday bars by time-gap, NOT by browser-local date.
// A 4h threshold cleanly separates the overnight gap (≥17h for US, ≥ a day for daily
// bars) from intraday breaks like the SET lunch pause (12:30→14:30 = 2h), so a single
// trading session is never chopped in two just because it straddles Thai midnight.
const SESSION_GAP_SEC = 4 * 60 * 60;
// 24/7 markets (crypto) have no gaps → the whole dataset would be one giant "session".
// Skip session VP for any group spanning more than this; the composite strip still draws.
const MAX_SESSION_SPAN_SEC = 2 * 24 * 60 * 60;

/** Scale bucket count with the canvas pixel height so resolution tracks the display. */
function adaptiveBuckets(canvasPx: number, pxPerBucket: number, min: number, max: number): number {
  if (!(canvasPx > 0)) return min;
  return Math.max(min, Math.min(max, Math.floor(canvasPx / pxPerBucket)));
}

// ── Types ────────────────────────────────────────────────────────────────────

interface VPBucket {
  volume: number;
  buyVolume: number; // volume from up-bars (close ≥ open)
  sellVolume: number; // volume from down-bars (close < open)
  priceLow: number;
  priceHigh: number;
}

/** Display options, mirrors VPConfig in atoms/index.ts (kept local to avoid an import cycle). */
export interface VPOptions {
  deltaMode: boolean;
  showNakedPoc: boolean;
  showHvnLvn: boolean;
}

const DEFAULT_OPTIONS: VPOptions = {
  deltaMode: false,
  showNakedPoc: true,
  showHvnLvn: false,
};

interface SessionProfile {
  date: string;
  bars: OhlcvBar[];
  buckets: VPBucket[];
  totalVolume: number;
  pocIdx: number; // Point of Control — bucket with max volume
  pocPrice: number;
  vaHighPrice: number; // Value Area High
  vaLowPrice: number; // Value Area Low
  priceMin: number;
  priceMax: number;
  /** true if no later session's range has touched pocPrice (a "naked"/virgin POC) */
  naked: boolean;
}

// ── Session detection ────────────────────────────────────────────────────────

function groupBySession(data: OhlcvBar[]): OhlcvBar[][] {
  // Assumes `data` is sorted ascending by time (guaranteed by the callers in
  // stock-view.tsx, which sort before feeding VP), so groups come out time-ordered.
  const sessions: OhlcvBar[][] = [];
  let current: OhlcvBar[] = [];
  let prevTime: number | null = null;

  const flush = () => {
    if (current.length > 0) {
      sessions.push(current);
      current = [];
    }
    prevTime = null;
  };

  for (const bar of data) {
    if (typeof bar.time !== "number") {
      // "YYYY-MM-DD" string — each bar IS a session (daily bars)
      flush();
      sessions.push([bar]);
      continue;
    }
    if (prevTime !== null && bar.time - prevTime > SESSION_GAP_SEC) flush();
    current.push(bar);
    prevTime = bar.time;
  }
  flush();

  return sessions;
}

// ── Volume distribution into buckets ─────────────────────────────────────────

function distributeToBuckets(
  bars: OhlcvBar[],
  numBuckets: number
): {
  buckets: VPBucket[];
  priceMin: number;
  priceMax: number;
  totalVolume: number;
} {
  const priceMin = Math.min(...bars.map((b) => b.low));
  const priceMax = Math.max(...bars.map((b) => b.high));
  const range = priceMax - priceMin;
  const bucketSize = range / numBuckets || 1;

  const buckets: VPBucket[] = Array.from({ length: numBuckets }, (_, i) => ({
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    priceLow: priceMin + i * bucketSize,
    priceHigh: priceMin + (i + 1) * bucketSize,
  }));

  let totalVolume = 0;

  for (const bar of bars) {
    const vol = bar.volume ?? 0;
    if (vol <= 0) continue;
    totalVolume += vol;
    const barRange = bar.high - bar.low;
    const isUp = bar.close >= bar.open;

    const add = (b: number, share: number) => {
      buckets[b].volume += share;
      if (isUp) buckets[b].buyVolume += share;
      else buckets[b].sellVolume += share;
    };

    if (barRange > 0) {
      for (let b = 0; b < numBuckets; b++) {
        const overlap = Math.max(
          0,
          Math.min(bar.high, buckets[b].priceHigh) - Math.max(bar.low, buckets[b].priceLow)
        );
        if (overlap > 0) add(b, vol * (overlap / barRange));
      }
    } else {
      // Zero-range bar (doji): the topmost bucket's priceHigh is exclusive, so a bar
      // sitting exactly at priceMax would match no bucket and lose its volume. Clamp
      // the index into [0, numBuckets-1] so every bar lands somewhere.
      const idx = Math.min(
        Math.max(0, Math.floor((bar.low - priceMin) / bucketSize)),
        numBuckets - 1
      );
      add(idx, vol);
    }
  }

  return { buckets, priceMin, priceMax, totalVolume };
}

// ── Value Area calculation ───────────────────────────────────────────────────

function computeValueArea(
  buckets: VPBucket[],
  pocIdx: number,
  totalVolume: number
): {
  vaHighIdx: number;
  vaLowIdx: number;
} {
  const targetVol = totalVolume * VALUE_AREA_PCT;
  let accumulated = buckets[pocIdx].volume;
  let hiIdx = pocIdx;
  let loIdx = pocIdx;

  // Expand outward from POC, adding the side with more volume first
  while (accumulated < targetVol && (hiIdx < buckets.length - 1 || loIdx > 0)) {
    const aboveVol = hiIdx < buckets.length - 1 ? buckets[hiIdx + 1].volume : -1;
    const belowVol = loIdx > 0 ? buckets[loIdx - 1].volume : -1;

    if (aboveVol >= belowVol && hiIdx < buckets.length - 1) {
      hiIdx++;
      accumulated += buckets[hiIdx].volume;
    } else if (loIdx > 0) {
      loIdx--;
      accumulated += buckets[loIdx].volume;
    } else {
      break;
    }
  }

  return { vaHighIdx: hiIdx, vaLowIdx: loIdx };
}

// ── Build session profiles ───────────────────────────────────────────────────

function buildSessionProfiles(data: OhlcvBar[], numBuckets = SESSION_BUCKETS): SessionProfile[] {
  const sessions = groupBySession(data);
  const profiles: SessionProfile[] = [];

  for (const bars of sessions) {
    // Need at least 2 bars for a meaningful profile
    if (bars.length < 2) continue;

    const first = bars[0];
    const last = bars[bars.length - 1];

    // Skip a "session" that never gapped (24/7 crypto) and spans too long to be one day
    if (
      typeof first.time === "number" &&
      typeof last.time === "number" &&
      last.time - first.time > MAX_SESSION_SPAN_SEC
    ) {
      continue;
    }

    const date =
      typeof first.time === "number"
        ? new Date(first.time * 1000).toISOString().slice(0, 10)
        : (first.time as string);

    const { buckets, priceMin, priceMax, totalVolume } = distributeToBuckets(bars, numBuckets);
    if (totalVolume <= 0) continue;

    // POC = bucket with maximum volume
    let pocIdx = 0;
    let maxVol = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].volume > maxVol) {
        maxVol = buckets[i].volume;
        pocIdx = i;
      }
    }

    const pocPrice = (buckets[pocIdx].priceLow + buckets[pocIdx].priceHigh) / 2;

    // Value Area
    const { vaHighIdx, vaLowIdx } = computeValueArea(buckets, pocIdx, totalVolume);
    const vaHighPrice = buckets[vaHighIdx].priceHigh;
    const vaLowPrice = buckets[vaLowIdx].priceLow;

    profiles.push({
      date,
      bars,
      buckets,
      totalVolume,
      pocIdx,
      pocPrice,
      vaHighPrice,
      vaLowPrice,
      priceMin,
      priceMax,
      naked: true,
    });
  }

  // Naked POC: a session's POC is "naked" if no LATER session's price range revisited it.
  // O(n²) over sessions (~≤40), cheap and done once per build (cached by the overlay).
  for (let i = 0; i < profiles.length; i++) {
    const poc = profiles[i].pocPrice;
    for (let j = i + 1; j < profiles.length; j++) {
      if (profiles[j].priceMin <= poc && poc <= profiles[j].priceMax) {
        profiles[i].naked = false;
        break;
      }
    }
  }

  return profiles;
}

// ── Session VP Overlay (full-chart mode) ─────────────────────────────────────

export function createSessionVPOverlay(
  intradayData?: OhlcvBar[],
  options: VPOptions = DEFAULT_OPTIONS
): CanvasOverlay {
  // Cache profiles to avoid recomputing every frame
  let cachedProfiles: SessionProfile[] | null = null;
  let cachedKey = "";

  return {
    id: "session-vp",
    name: "Session Volume Profile",
    mode: "full",
    width: 0, // not used for full mode

    draw(ctx, chart, mainSeries, data, isDark) {
      // Use intraday data if provided, otherwise use chart data
      const vpData = intradayData && intradayData.length > 0 ? intradayData : data;

      // Only works with intraday data (multiple bars per session)
      const isIntraday = vpData.length > 0 && typeof vpData[0].time === "number";
      if (!isIntraday) return;
      if (!vpData.some((d) => (d.volume ?? 0) > 0)) return;

      // Resolution scales with chart height (taller chart → finer price buckets).
      const sessionBuckets = adaptiveBuckets(ctx.canvas.offsetHeight, 14, 16, 48);

      // Recompute profiles only when data (or bucket count) changes. Key on the last bar
      // too, so a live poll that mutates the final bar in place still invalidates.
      const last = vpData[vpData.length - 1];
      const key = `${vpData.length}|${last.time}|${last.close}|${last.volume ?? 0}|${sessionBuckets}`;
      if (!cachedProfiles || cachedKey !== key) {
        cachedProfiles = buildSessionProfiles(vpData, sessionBuckets);
        cachedKey = key;
      }

      if (cachedProfiles.length === 0) return;

      const timeScale = chart.timeScale();

      // Colors
      const abovePocColor = isDark ? "rgba(38, 166, 154, 0.22)" : "rgba(38, 166, 154, 0.18)";
      const belowPocColor = isDark ? "rgba(239, 83, 80, 0.18)" : "rgba(239, 83, 80, 0.14)";
      const pocBarColor = isDark ? "rgba(255, 210, 60, 0.40)" : "rgba(255, 130, 0, 0.35)";
      const pocLineColor = isDark ? "rgba(239, 83, 80, 0.90)" : "rgba(200, 50, 50, 0.85)";
      const vaLineColor = isDark ? "rgba(156, 136, 255, 0.60)" : "rgba(120, 100, 200, 0.50)";
      const labelBg = isDark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.80)";
      const buyColor = isDark ? "rgba(38, 166, 154, 0.45)" : "rgba(38, 166, 154, 0.40)";
      const sellColor = isDark ? "rgba(239, 83, 80, 0.42)" : "rgba(239, 83, 80, 0.38)";
      const nakedPocColor = isDark ? "rgba(255, 210, 60, 0.85)" : "rgba(230, 150, 0, 0.85)";

      for (const profile of cachedProfiles) {
        const firstBar = profile.bars[0];
        const lastBar = profile.bars[profile.bars.length - 1];

        // Get x coordinates for session boundaries
        // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
        const xStart = timeScale.timeToCoordinate(firstBar.time as any);
        // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
        const xEnd = timeScale.timeToCoordinate(lastBar.time as any);
        if (xStart == null || xEnd == null) continue;

        const sessionWidth = Math.abs(xEnd - xStart);
        if (sessionWidth < 8) continue; // too narrow to draw

        const maxBucketVol = Math.max(...profile.buckets.map((b) => b.volume), 1);

        // Draw volume bars
        for (let b = 0; b < profile.buckets.length; b++) {
          const bucket = profile.buckets[b];
          if (bucket.volume <= 0) continue;

          const yTop = mainSeries.priceToCoordinate(bucket.priceHigh);
          const yBot = mainSeries.priceToCoordinate(bucket.priceLow);
          if (yTop == null || yBot == null) continue;

          const barH = Math.max(1, yBot - yTop);
          const barW = (bucket.volume / maxBucketVol) * sessionWidth * SESSION_FILL_PCT;

          if (options.deltaMode) {
            // Two-tone: buy segment (teal) then sell segment (red), widths ∝ their share.
            const buyW = bucket.volume > 0 ? barW * (bucket.buyVolume / bucket.volume) : 0;
            ctx.fillStyle = buyColor;
            ctx.fillRect(xStart, yTop, buyW, barH);
            ctx.fillStyle = sellColor;
            ctx.fillRect(xStart + buyW, yTop, barW - buyW, barH);
          } else {
            // Color: POC = highlight, above POC = teal, below POC = red
            if (b === profile.pocIdx) {
              ctx.fillStyle = pocBarColor;
            } else if (b > profile.pocIdx) {
              ctx.fillStyle = abovePocColor;
            } else {
              ctx.fillStyle = belowPocColor;
            }
            ctx.fillRect(xStart, yTop, barW, barH);
          }
        }

        // Naked POC — extend this session's POC rightward to the chart edge if price
        // never revisited it. Drawn before the per-session POC line so labels sit on top.
        if (options.showNakedPoc && profile.naked) {
          const nY = mainSeries.priceToCoordinate(profile.pocPrice);
          const canvasW = ctx.canvas.offsetWidth;
          if (nY != null && xStart + sessionWidth < canvasW) {
            ctx.strokeStyle = nakedPocColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([1, 3]);
            ctx.beginPath();
            ctx.moveTo(xStart + sessionWidth, nY);
            ctx.lineTo(canvasW, nY);
            ctx.stroke();
            ctx.setLineDash([]);

            const nLabel = `nPOC ${profile.pocPrice.toFixed(profile.pocPrice > 1000 ? 0 : 2)}`;
            ctx.font = "7px monospace";
            const ntw = ctx.measureText(nLabel).width;
            ctx.fillStyle = labelBg;
            ctx.fillRect(canvasW - ntw - 5, nY - 9, ntw + 4, 9);
            ctx.fillStyle = nakedPocColor;
            ctx.fillText(nLabel, canvasW - ntw - 3, nY - 2);
          }
        }

        // Draw V-POC line
        const pocY = mainSeries.priceToCoordinate(profile.pocPrice);
        if (pocY != null) {
          ctx.strokeStyle = pocLineColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(xStart, pocY);
          ctx.lineTo(xStart + sessionWidth * 0.95, pocY);
          ctx.stroke();

          // POC label
          const labelText = `V-POC ${profile.pocPrice.toFixed(profile.pocPrice > 1000 ? 0 : 2)}`;
          ctx.font = "bold 8px monospace";
          const tw = ctx.measureText(labelText).width;
          const lx = xStart + sessionWidth * 0.95 - tw - 4;
          const ly = pocY - 3;

          ctx.fillStyle = labelBg;
          ctx.fillRect(lx - 2, ly - 8, tw + 4, 10);
          ctx.fillStyle = pocLineColor;
          ctx.fillText(labelText, lx, ly);
        }

        // Draw VA-H line
        const vaHY = mainSeries.priceToCoordinate(profile.vaHighPrice);
        if (vaHY != null && sessionWidth > 30) {
          ctx.strokeStyle = vaLineColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(xStart, vaHY);
          ctx.lineTo(xStart + sessionWidth * 0.7, vaHY);
          ctx.stroke();

          // VA-H label
          if (sessionWidth > 50) {
            const label = `VA-H ${profile.vaHighPrice.toFixed(profile.vaHighPrice > 1000 ? 0 : 2)}`;
            ctx.font = "7px monospace";
            ctx.fillStyle = labelBg;
            const tw2 = ctx.measureText(label).width;
            ctx.fillRect(xStart + 1, vaHY - 9, tw2 + 3, 9);
            ctx.fillStyle = vaLineColor;
            ctx.fillText(label, xStart + 2, vaHY - 2);
          }
        }

        // Draw VA-L line
        const vaLY = mainSeries.priceToCoordinate(profile.vaLowPrice);
        if (vaLY != null && sessionWidth > 30) {
          ctx.strokeStyle = vaLineColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(xStart, vaLY);
          ctx.lineTo(xStart + sessionWidth * 0.7, vaLY);
          ctx.stroke();

          // VA-L label
          if (sessionWidth > 50) {
            const label = `VA-L ${profile.vaLowPrice.toFixed(profile.vaLowPrice > 1000 ? 0 : 2)}`;
            ctx.font = "7px monospace";
            ctx.fillStyle = labelBg;
            const tw2 = ctx.measureText(label).width;
            ctx.fillRect(xStart + 1, vaLY + 1, tw2 + 3, 9);
            ctx.fillStyle = vaLineColor;
            ctx.fillText(label, xStart + 2, vaLY + 8);
          }
        }

        ctx.setLineDash([]);
      }
    },
  };
}

// ── Composite VP Overlay (right-side strip, keeps existing behavior) ─────────

export function createCompositeVPOverlay(options: VPOptions = DEFAULT_OPTIONS): CanvasOverlay {
  // Cache the distribution so we don't rebuild 40 buckets on every pointermove redraw.
  let cache: {
    key: string;
    buckets: VPBucket[];
    pocIdx: number;
    maxVol: number;
    vaHighIdx: number;
    vaLowIdx: number;
  } | null = null;

  return {
    id: "composite-vp",
    name: "Composite Volume Profile",
    mode: "right",
    width: COMPOSITE_WIDTH_PX,

    draw(ctx, chart, mainSeries, data, isDark) {
      if (!data.some((d) => (d.volume ?? 0) > 0)) return;

      // Visible-Range VP: build the profile only from bars currently in view, so
      // zooming/panning reshapes the distribution (matches TradingView VRVP).
      const range = chart.timeScale().getVisibleLogicalRange();
      let vpBars = data;
      let from = 0;
      let to = data.length - 1;
      if (range !== null) {
        from = Math.max(0, Math.floor(range.from));
        to = Math.min(data.length - 1, Math.ceil(range.to));
        if (to > from) vpBars = data.slice(from, to + 1);
      }

      // Resolution scales with the strip's pixel height.
      const numBuckets = adaptiveBuckets(ctx.canvas.offsetHeight, 4, 20, 120);

      const last = vpBars[vpBars.length - 1];
      const key = `${vpBars.length}|${from}|${to}|${last?.time}|${last?.close}|${last?.volume ?? 0}|${numBuckets}`;
      if (!cache || cache.key !== key) {
        const { buckets, totalVolume } = distributeToBuckets(vpBars, numBuckets);
        if (totalVolume <= 0) return;

        // POC
        let pocIdx = 0;
        let maxVol = 0;
        for (let i = 0; i < buckets.length; i++) {
          if (buckets[i].volume > maxVol) {
            maxVol = buckets[i].volume;
            pocIdx = i;
          }
        }

        // Value Area
        const { vaHighIdx, vaLowIdx } = computeValueArea(buckets, pocIdx, totalVolume);
        cache = { key, buckets, pocIdx, maxVol, vaHighIdx, vaLowIdx };
      }
      if (!cache) return;

      const { buckets, pocIdx, maxVol, vaHighIdx, vaLowIdx } = cache;

      const barColor = isDark ? "rgba(100, 160, 255, 0.25)" : "rgba(33, 150, 243, 0.25)";
      const vaColor = isDark ? "rgba(100, 160, 255, 0.40)" : "rgba(33, 150, 243, 0.40)";
      const pocColor = isDark ? "rgba(255, 210, 60, 0.55)" : "rgba(255, 130, 0, 0.55)";
      const pocLine = isDark ? "rgba(255, 210, 60, 0.80)" : "rgba(255, 130, 0, 0.80)";
      const buyColor = isDark ? "rgba(38, 166, 154, 0.45)" : "rgba(38, 166, 154, 0.40)";
      const sellColor = isDark ? "rgba(239, 83, 80, 0.42)" : "rgba(239, 83, 80, 0.38)";

      for (let b = 0; b < buckets.length; b++) {
        if (buckets[b].volume <= 0) continue;

        const yTop = mainSeries.priceToCoordinate(buckets[b].priceHigh);
        const yBot = mainSeries.priceToCoordinate(buckets[b].priceLow);
        if (yTop == null || yBot == null) continue;

        const barH = Math.max(1, yBot - yTop);
        const barW = (buckets[b].volume / maxVol) * COMPOSITE_WIDTH_PX;

        if (options.deltaMode) {
          // Buy segment nearest the price axis (right), sell to its left.
          const buyW =
            buckets[b].volume > 0 ? barW * (buckets[b].buyVolume / buckets[b].volume) : 0;
          ctx.fillStyle = sellColor;
          ctx.fillRect(COMPOSITE_WIDTH_PX - barW, yTop, barW - buyW, barH);
          ctx.fillStyle = buyColor;
          ctx.fillRect(COMPOSITE_WIDTH_PX - buyW, yTop, buyW, barH);
        } else {
          // POC = gold, Value Area = brighter blue, outside = dim
          if (b === pocIdx) {
            ctx.fillStyle = pocColor;
          } else if (b >= vaLowIdx && b <= vaHighIdx) {
            ctx.fillStyle = vaColor;
          } else {
            ctx.fillStyle = barColor;
          }
          ctx.fillRect(COMPOSITE_WIDTH_PX - barW, yTop, barW, barH);
        }
      }

      // HVN / LVN — mark high/low volume nodes on a 3-bucket smoothed profile.
      if (options.showHvnLvn) {
        const vols = buckets.map((b) => b.volume);
        const avg = vols.reduce((s, v) => s + v, 0) / (vols.length || 1);
        const smooth = (i: number) =>
          (vols[i - 1] ?? vols[i]) * 0.25 + vols[i] * 0.5 + (vols[i + 1] ?? vols[i]) * 0.25;
        const hvnColor = isDark ? "rgba(38,166,154,0.75)" : "rgba(20,120,110,0.7)";
        const lvnColor = isDark ? "rgba(150,150,150,0.6)" : "rgba(120,120,120,0.55)";
        for (let b = 1; b < buckets.length - 1; b++) {
          const s = smooth(b);
          const isMax = s >= smooth(b - 1) && s >= smooth(b + 1);
          const isMin = s <= smooth(b - 1) && s <= smooth(b + 1);
          const midY = mainSeries.priceToCoordinate(
            (buckets[b].priceLow + buckets[b].priceHigh) / 2
          );
          if (midY == null) continue;
          if (isMax && s >= maxVol * 0.7) {
            ctx.strokeStyle = hvnColor;
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(COMPOSITE_WIDTH_PX - 6, midY);
            ctx.lineTo(COMPOSITE_WIDTH_PX, midY);
            ctx.stroke();
          } else if (isMin && s <= avg * 0.3) {
            ctx.strokeStyle = lvnColor;
            ctx.setLineDash([1, 2]);
            ctx.beginPath();
            ctx.moveTo(COMPOSITE_WIDTH_PX - 6, midY);
            ctx.lineTo(COMPOSITE_WIDTH_PX, midY);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // POC dashed line
      const pocMidPrice = (buckets[pocIdx].priceLow + buckets[pocIdx].priceHigh) / 2;
      const pocY = mainSeries.priceToCoordinate(pocMidPrice);
      if (pocY != null) {
        ctx.strokeStyle = pocLine;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, pocY);
        ctx.lineTo(COMPOSITE_WIDTH_PX, pocY);
        ctx.stroke();
        ctx.setLineDash([]);

        // POC label
        ctx.font = "bold 7px monospace";
        ctx.fillStyle = pocLine;
        ctx.fillText("POC", 1, pocY - 2);
      }

      // VA-H / VA-L markers
      const vaHPrice = buckets[vaHighIdx].priceHigh;
      const vaLPrice = buckets[vaLowIdx].priceLow;
      const vaHY = mainSeries.priceToCoordinate(vaHPrice);
      const vaLY = mainSeries.priceToCoordinate(vaLPrice);

      ctx.strokeStyle = isDark ? "rgba(156,136,255,0.50)" : "rgba(120,100,200,0.40)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);

      if (vaHY != null) {
        ctx.beginPath();
        ctx.moveTo(0, vaHY);
        ctx.lineTo(COMPOSITE_WIDTH_PX, vaHY);
        ctx.stroke();
      }
      if (vaLY != null) {
        ctx.beginPath();
        ctx.moveTo(0, vaLY);
        ctx.lineTo(COMPOSITE_WIDTH_PX, vaLY);
        ctx.stroke();
      }

      ctx.setLineDash([]);

      // Tag the strip so it's clear the profile follows the visible range.
      ctx.font = "bold 7px monospace";
      ctx.fillStyle = isDark ? "rgba(180,180,180,0.65)" : "rgba(90,90,90,0.65)";
      ctx.fillText("VRVP", 1, 8);
    },
  };
}

// ── Legacy single-factory (backward compat) ──────────────────────────────────

export function createVolumeProfileOverlay(): CanvasOverlay {
  return createCompositeVPOverlay();
}
