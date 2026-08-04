/**
 * Event rail — dividends / earnings / splits drawn as labelled chips on a fixed
 * row at the bottom of the price pane.
 *
 * Replaces `createSeriesMarkers`, which had two problems this fixes:
 *
 *   1. Library markers only come in four shapes (circle, square, arrowUp,
 *      arrowDown). Four shapes cannot express five states, and an arrow is
 *      ambiguous anyway — a down arrow reads as "price fell" as readily as
 *      "missed estimates". Drawing on canvas means the chip can just say what
 *      it is: `$`, `E+`, `E-`, `E?`, `x10`.
 *   2. Markers hang off each bar, so they wander up and down with price and
 *      collide with the candles. The rail is pinned to one row, so the eye can
 *      scan events along a straight line and the price action stays clean.
 *
 * Colliding chips collapse into a `···N` cluster; clicking one opens a list
 * (the hit-test in ModularChart returns every marker within range, not just the
 * nearest).
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { PlacedEvent } from "./event-reaction";
import type { CanvasOverlay, ChartEventMarker, OhlcvBar } from "./types";

/** Height of the chip row, in CSS pixels. */
const RAIL_HEIGHT = 14;
/** Gap between the rail and the bottom edge of the pane. */
const RAIL_BOTTOM_PAD = 3;
/** Horizontal padding inside a chip. */
const CHIP_PAD_X = 3;
/** Chips closer than this collapse into a cluster. */
const CLUSTER_GAP = 3;

const FONT = "bold 9px monospace";

export interface EventChipStyle {
  /** Short text drawn inside the chip. */
  text: string;
  color: string;
}

/**
 * What a marker says on the rail.
 *
 * `$` for a dividend and `x10` for a split are self-describing; earnings carry
 * their outcome in the second character so beat/miss/pending never depends on
 * colour alone (which is unreadable for the ~8% of men with red-green colour
 * blindness, and invisible on a printout).
 */
export function eventChipStyle(marker: ChartEventMarker): EventChipStyle {
  if (marker.type === "dividend") return { text: "$", color: "#4fc3f7" };
  if (marker.type === "split") {
    const ratio = marker.splitRatio;
    // A ratio like 1.5:1 must not render as "x1" — keep one decimal when it has one.
    const label = ratio == null ? "SPL" : `x${Number.isInteger(ratio) ? ratio : ratio.toFixed(1)}`;
    return { text: label, color: "#ce93d8" };
  }
  if (marker.surprise == null) return { text: "E?", color: "#ffb74d" };
  return marker.surprise >= 0 ? { text: "E+", color: "#26a69a" } : { text: "E-", color: "#ef5350" };
}

/** A chip with its measured footprint, before clustering. */
export interface PositionedChip {
  /** Centre x, in CSS pixels. */
  x: number;
  /** Full chip width including padding. */
  w: number;
  style: EventChipStyle;
}

/** One chip as it will actually be painted, after clustering. */
export interface Chip {
  x: number;
  style: EventChipStyle;
  /** How many events this chip stands for. >1 renders as `···N`. */
  count: number;
}

/**
 * Collapse chips that would overlap into clusters, left to right.
 *
 * Has to run in pixel space on every draw rather than once up front: how many
 * chips collide depends entirely on the current zoom, and at 5Y a quarterly
 * dividend payer puts ~20 chips inside a few hundred pixels.
 *
 * A cluster keeps the leftmost chip's position and style; the caller renders it
 * as a neutral `···N` and offers the full list on click.
 */
export function clusterChips(positioned: PositionedChip[], gap = CLUSTER_GAP): Chip[] {
  const sorted = [...positioned].sort((a, b) => a.x - b.x);
  const chips: Chip[] = [];
  let cursor = Number.NEGATIVE_INFINITY;

  for (const item of sorted) {
    const left = item.x - item.w / 2;
    if (left < cursor + gap && chips.length > 0) {
      chips[chips.length - 1].count += 1;
      continue;
    }
    chips.push({ x: item.x, style: item.style, count: 1 });
    cursor = item.x + item.w / 2;
  }

  return chips;
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
 * Takes events already resolved onto bars (see `placeEvents`) rather than raw
 * markers, so the placement rule is applied exactly once per chart build and the
 * click hit-test in ModularChart works off the same list the rail draws.
 */
export function createEventRailOverlay(placed: PlacedEvent[]): CanvasOverlay {
  return {
    id: "event-rail",
    name: "Event Rail",
    mode: "full",
    width: 0, // unused for mode "full"
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      _series: ISeriesApi<SeriesType>,
      _data: OhlcvBar[],
      isDark: boolean,
      rect: { width: number; height: number }
    ) {
      if (placed.length === 0) return;

      const timeScale = chart.timeScale();
      const railTop = rect.height - RAIL_HEIGHT - RAIL_BOTTOM_PAD;
      if (railTop < 0) return; // pane too short to host the rail

      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";

      // Measure first, then cluster — collisions can only be judged once every
      // chip knows where it landed at the current zoom.
      const positioned: PositionedChip[] = [];
      for (const p of placed) {
        const x = timeScale.timeToCoordinate(p.time as Time);
        if (x === null) continue; // scrolled out of the visible range
        const style = eventChipStyle(p.marker);
        positioned.push({
          x,
          style,
          w: ctx.measureText(style.text).width + CHIP_PAD_X * 2,
        });
      }

      const chips = clusterChips(positioned);

      const railBg = isDark ? "#0b0b0b" : "#f2f2f2";
      const railLine = isDark ? "#1f1f1f" : "#d8d8d8";

      // A hairline under the rail separates it from the price action without
      // reading as a chart gridline.
      ctx.fillStyle = railBg;
      ctx.fillRect(0, railTop, rect.width, RAIL_HEIGHT);
      ctx.strokeStyle = railLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, railTop + 0.5);
      ctx.lineTo(rect.width, railTop + 0.5);
      ctx.stroke();

      const cy = railTop + RAIL_HEIGHT / 2;
      for (const chip of chips) {
        const clustered = chip.count > 1;
        const text = clustered ? `···${chip.count}` : chip.style.text;
        const color = clustered ? (isDark ? "#9e9e9e" : "#616161") : chip.style.color;
        const w = ctx.measureText(text).width + CHIP_PAD_X * 2;
        const h = RAIL_HEIGHT - 4;
        const x = chip.x - w / 2;
        const y = cy - h / 2;

        roundedRect(ctx, x, y, w, h, 2);
        ctx.fillStyle = `${color}22`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.fillText(text, chip.x, cy + 0.5);
      }

      ctx.restore();
    },
  };
}
