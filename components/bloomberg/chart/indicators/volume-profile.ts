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
import type { OhlcvBar, CanvasOverlay } from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION_BUCKETS = 24;        // price buckets per session
const COMPOSITE_BUCKETS = 40;      // price buckets for right-side composite
const COMPOSITE_WIDTH_PX = 56;     // width of right-side composite strip
const VALUE_AREA_PCT = 0.70;       // 70% of volume = Value Area
const SESSION_FILL_PCT = 0.85;     // max fill width relative to session pixel width

// ── Types ────────────────────────────────────────────────────────────────────

interface VPBucket {
  volume: number;
  priceLow: number;
  priceHigh: number;
}

interface SessionProfile {
  date: string;
  bars: OhlcvBar[];
  buckets: VPBucket[];
  totalVolume: number;
  pocIdx: number;          // Point of Control — bucket with max volume
  pocPrice: number;
  vaHighPrice: number;     // Value Area High
  vaLowPrice: number;      // Value Area Low
  priceMin: number;
  priceMax: number;
}

// ── Session detection ────────────────────────────────────────────────────────

function groupBySession(data: OhlcvBar[]): Map<string, OhlcvBar[]> {
  const sessions = new Map<string, OhlcvBar[]>();

  for (const bar of data) {
    let dateKey: string;
    if (typeof bar.time === "number") {
      // UNIX seconds → extract date (local timezone, matching backend)
      const d = new Date(bar.time * 1000);
      dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } else {
      // "YYYY-MM-DD" string — each bar IS a session (daily)
      dateKey = bar.time;
    }

    let arr = sessions.get(dateKey);
    if (!arr) {
      arr = [];
      sessions.set(dateKey, arr);
    }
    arr.push(bar);
  }

  return sessions;
}

// ── Volume distribution into buckets ─────────────────────────────────────────

function distributeToBuckets(bars: OhlcvBar[], numBuckets: number): {
  buckets: VPBucket[];
  priceMin: number;
  priceMax: number;
  totalVolume: number;
} {
  const priceMin = Math.min(...bars.map(b => b.low));
  const priceMax = Math.max(...bars.map(b => b.high));
  const range = priceMax - priceMin;
  const bucketSize = range / numBuckets || 1;

  const buckets: VPBucket[] = Array.from({ length: numBuckets }, (_, i) => ({
    volume: 0,
    priceLow: priceMin + i * bucketSize,
    priceHigh: priceMin + (i + 1) * bucketSize,
  }));

  let totalVolume = 0;

  for (const bar of bars) {
    const vol = bar.volume ?? 0;
    if (vol <= 0) continue;
    totalVolume += vol;
    const barRange = bar.high - bar.low;

    for (let b = 0; b < numBuckets; b++) {
      if (barRange > 0) {
        const overlap = Math.max(0,
          Math.min(bar.high, buckets[b].priceHigh) - Math.max(bar.low, buckets[b].priceLow)
        );
        buckets[b].volume += vol * (overlap / barRange);
      } else if (bar.low >= buckets[b].priceLow && bar.low < buckets[b].priceHigh) {
        buckets[b].volume += vol;
      }
    }
  }

  return { buckets, priceMin, priceMax, totalVolume };
}

// ── Value Area calculation ───────────────────────────────────────────────────

function computeValueArea(buckets: VPBucket[], pocIdx: number, totalVolume: number): {
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

function buildSessionProfiles(data: OhlcvBar[]): SessionProfile[] {
  const sessions = groupBySession(data);
  const profiles: SessionProfile[] = [];

  for (const [date, bars] of sessions) {
    // Need at least 2 bars for a meaningful profile
    if (bars.length < 2) continue;

    const { buckets, priceMin, priceMax, totalVolume } = distributeToBuckets(bars, SESSION_BUCKETS);
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
    });
  }

  return profiles;
}

// ── Session VP Overlay (full-chart mode) ─────────────────────────────────────

export function createSessionVPOverlay(intradayData?: OhlcvBar[]): CanvasOverlay {
  // Cache profiles to avoid recomputing every frame
  let cachedProfiles: SessionProfile[] | null = null;
  let cachedDataLen = 0;

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
      if (!vpData.some(d => (d.volume ?? 0) > 0)) return;

      // Recompute profiles only when data changes
      if (!cachedProfiles || cachedDataLen !== vpData.length) {
        cachedProfiles = buildSessionProfiles(vpData);
        cachedDataLen = vpData.length;
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

      for (const profile of cachedProfiles) {
        const firstBar = profile.bars[0];
        const lastBar = profile.bars[profile.bars.length - 1];

        // Get x coordinates for session boundaries
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xStart = timeScale.timeToCoordinate(firstBar.time as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xEnd = timeScale.timeToCoordinate(lastBar.time as any);
        if (xStart == null || xEnd == null) continue;

        const sessionWidth = Math.abs(xEnd - xStart);
        if (sessionWidth < 8) continue; // too narrow to draw

        const maxBucketVol = Math.max(...profile.buckets.map(b => b.volume), 1);

        // Draw volume bars
        for (let b = 0; b < profile.buckets.length; b++) {
          const bucket = profile.buckets[b];
          if (bucket.volume <= 0) continue;

          const yTop = mainSeries.priceToCoordinate(bucket.priceHigh);
          const yBot = mainSeries.priceToCoordinate(bucket.priceLow);
          if (yTop == null || yBot == null) continue;

          const barH = Math.max(1, yBot - yTop);
          const barW = (bucket.volume / maxBucketVol) * sessionWidth * SESSION_FILL_PCT;

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

export function createCompositeVPOverlay(): CanvasOverlay {
  return {
    id: "composite-vp",
    name: "Composite Volume Profile",
    mode: "right",
    width: COMPOSITE_WIDTH_PX,

    draw(ctx, _chart, mainSeries, data, isDark) {
      if (!data.some(d => (d.volume ?? 0) > 0)) return;

      const { buckets, totalVolume } = distributeToBuckets(data, COMPOSITE_BUCKETS);
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

      const barColor = isDark ? "rgba(100, 160, 255, 0.25)" : "rgba(33, 150, 243, 0.25)";
      const vaColor = isDark ? "rgba(100, 160, 255, 0.40)" : "rgba(33, 150, 243, 0.40)";
      const pocColor = isDark ? "rgba(255, 210, 60, 0.55)" : "rgba(255, 130, 0, 0.55)";
      const pocLine = isDark ? "rgba(255, 210, 60, 0.80)" : "rgba(255, 130, 0, 0.80)";

      for (let b = 0; b < COMPOSITE_BUCKETS; b++) {
        if (buckets[b].volume <= 0) continue;

        const yTop = mainSeries.priceToCoordinate(buckets[b].priceHigh);
        const yBot = mainSeries.priceToCoordinate(buckets[b].priceLow);
        if (yTop == null || yBot == null) continue;

        const barH = Math.max(1, yBot - yTop);
        const barW = (buckets[b].volume / maxVol) * COMPOSITE_WIDTH_PX;

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
    },
  };
}

// ── Legacy single-factory (backward compat) ──────────────────────────────────

export function createVolumeProfileOverlay(): CanvasOverlay {
  return createCompositeVPOverlay();
}
