/**
 * Volume-event chips — the classified volume events (lib/volume-events.ts)
 * painted onto the price pane, one two-letter chip per event.
 *
 * ── Why on the bar, and not on a pinned rail ────────────────────────────────
 *
 * The corporate-event rail (event-rail-overlay.ts) pins its chips to one row at
 * the bottom of the pane, and for dividends and earnings that is right: those
 * events have no direction, and a row the eye can scan along beats chips that
 * wander with price. Volume events are the opposite case. Which side owned the
 * bar is half of what the event says, so the chip is anchored to the bar itself
 * — above the high when the up side owned it, below the low when the down side
 * did. That also keeps this overlay clear of the rail's row, so a stock with
 * both switched on does not stack them.
 *
 * Chips never label a price level, only a bar. A climax at a naked POC is a
 * different event from the same bar mid-range, but this overlay has no access
 * to those levels and will not pretend otherwise — read it with VP or the VWAP
 * bands on.
 *
 * ── Collision ───────────────────────────────────────────────────────────────
 *
 * At 5Y on daily bars a whole year fits in a few hundred pixels, so chips
 * collide. They are placed strongest-first by |z| and a chip that would overlap
 * one already placed is dropped, rather than clustered into a `···N` the way
 * the rail does: a cluster of volume events would hide the very thing the chip
 * exists to name, and the panel beside the chart already lists every event
 * including the ones the pixels could not fit.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import {
  EVENT_CODE,
  type VolumeEvent,
  type VolumeEventType,
  classifyVolumeEvents,
} from "../lib/volume-events.ts";
import type { CanvasOverlay, OhlcvBar, OverlayRect } from "./types";

/**
 * One hue per event TYPE, not per direction — direction is carried by whether
 * the chip sits above or below the bar, which survives both colour blindness
 * and a printout. Dry-up shares the RVOL pane's purple so the same state reads
 * the same in both places.
 */
export const EVENT_COLOR: Record<VolumeEventType, string> = {
  climax: "#ff9800",
  absorption: "#26a69a",
  vacuum: "#42a5f5",
  breakout: "#ffd54f",
  noDemand: "#8d6e63",
  dryUp: "#7e57c2",
};

const CHIP_H = 13;
const CHIP_PAD_X = 3;
const FONT = "bold 9px monospace";
/** Gap between a chip and the bar's high or low. */
const BAR_GAP = 5;
/** Chips closer than this horizontally are treated as colliding. */
const COLLIDE_GAP = 2;
const BACKDROP_DARK = "#0b0b0bde";
const BACKDROP_LIGHT = "#f2f2f2de";

/** A chip with its measured geometry, before collision resolution. */
export interface PlacedChip {
  event: VolumeEvent;
  /** Centre x, in pixels. */
  x: number;
  /** Top y, in pixels. */
  y: number;
  w: number;
}

/**
 * Keep the chips that fit, strongest |z| first.
 *
 * Two chips collide when their horizontal extents overlap within COLLIDE_GAP —
 * vertical position is deliberately ignored. Two chips at the same x on
 * different rows still read as one smear at 9px, and treating them as distinct
 * is how a chart ends up with unreadable stacks at every earnings date.
 */
export function resolveCollisions(chips: PlacedChip[], gap = COLLIDE_GAP): PlacedChip[] {
  const byStrength = [...chips].sort((a, b) => Math.abs(b.event.z) - Math.abs(a.event.z));
  const kept: PlacedChip[] = [];
  for (const chip of byStrength) {
    const left = chip.x - chip.w / 2;
    const right = chip.x + chip.w / 2;
    const clash = kept.some((k) => left < k.x + k.w / 2 + gap && right > k.x - k.w / 2 - gap);
    if (!clash) kept.push(chip);
  }
  return kept.sort((a, b) => a.x - b.x);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The overlay classifies from the bars it is handed rather than taking a
 * prepared list, because `draw` is the only place the current bar array is
 * available — and it caches on that array's identity, so classification runs
 * once per data change and not once per frame (draw fires on every pan, zoom
 * and crosshair move).
 *
 * The panel beside the chart classifies the same bars with the same defaults,
 * so the two agree; nothing is passed between them.
 */
export function createVolumeEventOverlay(): CanvasOverlay {
  let cacheKey: OhlcvBar[] | null = null;
  let cached: VolumeEvent[] = [];

  return {
    id: "volume-events",
    name: "Volume Events",
    mode: "full",
    zOrder: "top",
    width: 0, // unused for mode "full"
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      mainSeries: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      isDark: boolean,
      rect: OverlayRect
    ) {
      if (data.length === 0) return;
      if (data !== cacheKey) {
        cached = classifyVolumeEvents(data);
        cacheKey = data;
      }
      if (cached.length === 0) return;

      const timeScale = chart.timeScale();
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";

      const chips: PlacedChip[] = [];
      for (const event of cached) {
        const bar = data[event.index];
        // The events were classified from this very array, so an index that no
        // longer lines up means the cache missed a data swap. Skip rather than
        // label the wrong bar.
        if (!bar || bar.time !== event.time) continue;
        const x = timeScale.timeToCoordinate(event.time as Time);
        if (x === null) continue; // scrolled out of the visible range

        const above = event.dir >= 0;
        const anchorPrice = above ? bar.high : bar.low;
        const py = mainSeries.priceToCoordinate(anchorPrice);
        if (py === null) continue;
        const y = above ? py - BAR_GAP - CHIP_H : py + BAR_GAP;
        if (y < 0 || y + CHIP_H > rect.height) continue; // off the pane

        const w = ctx.measureText(EVENT_CODE[event.type]).width + CHIP_PAD_X * 2;
        chips.push({ event, x, y, w });
      }

      const backdrop = isDark ? BACKDROP_DARK : BACKDROP_LIGHT;
      for (const chip of resolveCollisions(chips)) {
        const color = EVENT_COLOR[chip.event.type];
        const x = chip.x - chip.w / 2;

        roundedRect(ctx, x, chip.y, chip.w, CHIP_H, 2);
        // Two passes, same as the event rail: the pane colour first so wicks and
        // gridlines do not run through the text, then the type tint over it.
        ctx.fillStyle = backdrop;
        ctx.fill();
        ctx.fillStyle = `${color}22`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.fillText(EVENT_CODE[chip.event.type], chip.x, chip.y + CHIP_H / 2 + 0.5);
      }

      ctx.restore();
    },
  };
}
