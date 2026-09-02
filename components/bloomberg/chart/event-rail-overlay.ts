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
import { type EventIconName, drawEventIcon } from "./event-icons.ts";
import type { PlacedEvent } from "./event-reaction";
import type { CanvasOverlay, ChartEventMarker, OhlcvBar } from "./types";

/** Height of the chip row, in CSS pixels. */
const RAIL_HEIGHT = 18;
/** Icon side length inside a chip, in CSS pixels. */
const ICON_SIZE = 11;
/** Gap between the rail and the bottom edge of the pane. */
const RAIL_BOTTOM_PAD = 3;
/** Horizontal padding inside a chip. */
const CHIP_PAD_X = 3;
/** Every icon chip is the same width — nothing has to be measured to lay them out. */
const CHIP_W = ICON_SIZE + CHIP_PAD_X * 2;
/**
 * Pane colour painted under each chip, at ~87% opacity.
 *
 * Not fully opaque: a hard rectangle punched out of the candles is as loud as
 * the old full-width band was. At this alpha a wick behind a chip reads as a
 * shadow rather than as a line crossing the icon.
 */
const CHIP_BACKDROP_DARK = "#0b0b0bde";
const CHIP_BACKDROP_LIGHT = "#f2f2f2de";
/** Chips closer than this collapse into a cluster. */
const CLUSTER_GAP = 3;
/** Gap between the last bar and the first upcoming chip. */
const FUTURE_LEAD = 8;
/** Gap between consecutive upcoming chips. */
const FUTURE_GAP = 4;

const FONT = "bold 9px monospace";

export interface EventChipStyle {
  /** Mark drawn inside the chip. */
  icon: EventIconName;
  /**
   * Text form of the same mark.
   *
   * Not drawn on the rail any more, but it is what the chip *means* in one
   * token: the popover uses it as the accessible name for the icon, and the
   * tests assert on it rather than on a path string.
   */
  label: string;
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
  if (marker.type === "dividend") {
    return { icon: "cash", label: marker.upcoming ? "$?" : "$", color: "#4fc3f7" };
  }
  if (marker.type === "split") {
    const ratio = marker.splitRatio;
    // A ratio like 1.5:1 must not read as "x1" — keep one decimal when it has one.
    const label = ratio == null ? "SPL" : `x${Number.isInteger(ratio) ? ratio : ratio.toFixed(1)}`;
    return { icon: "split", label, color: "#ce93d8" };
  }
  if (marker.surprise == null) return { icon: "clock", label: "E?", color: "#ffb74d" };
  return marker.surprise >= 0
    ? { icon: "arrowUp", label: "E+", color: "#26a69a" }
    : { icon: "arrowDown", label: "E-", color: "#ef5350" };
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
      data: OhlcvBar[],
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
        if (p.future) continue; // queued past the right edge instead, below
        const x = timeScale.timeToCoordinate(p.time as Time);
        if (x === null) continue; // scrolled out of the visible range
        positioned.push({ x, style: eventChipStyle(p.marker), w: CHIP_W });
      }

      const chips = clusterChips(positioned);

      // Upcoming events have no bar to sit on, so the time scale has no
      // coordinate for them. They queue rightwards from the last bar in date
      // order — close enough to read as "next", far enough not to claim a
      // candle that does not exist yet. Clustering would be wrong here: the
      // queue is already collision-free, and collapsing two different upcoming
      // events into `···2` hides the only thing the reader wants.
      const futureChips: PositionedChip[] = [];
      const lastBar = data.length > 0 ? data[data.length - 1].time : null;
      const anchor = lastBar === null ? null : timeScale.timeToCoordinate(lastBar as Time);
      if (anchor !== null) {
        let cursor = anchor + FUTURE_LEAD;
        for (const p of placed) {
          if (!p.future) continue;
          const w = CHIP_W;
          if (cursor + w > rect.width) break; // no room left in the pane
          futureChips.push({ x: cursor + w / 2, style: eventChipStyle(p.marker), w });
          cursor += w + FUTURE_GAP;
        }
      }

      // No band and no divider under the row. The rail used to paint an opaque
      // strip across the full pane width, which was a solid bar of chart real
      // estate spent on a handful of chips and read as a second axis. The chips
      // carry their own backdrop instead, so the row is invisible where nothing
      // sits on it.
      const backdrop = isDark ? CHIP_BACKDROP_DARK : CHIP_BACKDROP_LIGHT;

      const cy = railTop + RAIL_HEIGHT / 2;
      for (const chip of chips) {
        const clustered = chip.count > 1;
        // A cluster stands for a number of events, and a number is the one thing
        // an icon cannot say — that chip stays text.
        const text = clustered ? `···${chip.count}` : null;
        const color = clustered ? (isDark ? "#9e9e9e" : "#616161") : chip.style.color;
        const w = text === null ? CHIP_W : ctx.measureText(text).width + CHIP_PAD_X * 2;
        const h = RAIL_HEIGHT - 4;
        const x = chip.x - w / 2;
        const y = cy - h / 2;

        roundedRect(ctx, x, y, w, h, 2);
        // Two passes: the pane colour first so gridlines and wicks do not run
        // through the mark, then the type tint over it. One translucent fill
        // cannot do both — it either hides the chart or fails to hide it.
        ctx.fillStyle = backdrop;
        ctx.fill();
        ctx.fillStyle = `${color}22`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        if (text === null) {
          drawEventIcon(ctx, chip.style.icon, chip.x, cy, ICON_SIZE, color);
        } else {
          ctx.fillStyle = color;
          ctx.fillText(text, chip.x, cy + 0.5);
        }
      }

      // Same chip, dashed outline and no fill — an announced date is not a
      // recorded one, and the rail should not let the two look alike.
      for (const chip of futureChips) {
        const h = RAIL_HEIGHT - 4;
        const x = chip.x - chip.w / 2;
        const y = cy - h / 2;

        roundedRect(ctx, x, y, chip.w, h, 2);
        ctx.fillStyle = backdrop;
        ctx.fill();
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = chip.style.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        // The dash belongs to the chip border, not to the mark inside it — an
        // icon drawn with a dashed stroke at 11px falls apart into dots.
        ctx.setLineDash([]);

        drawEventIcon(ctx, chip.style.icon, chip.x, cy, ICON_SIZE, chip.style.color);
      }

      ctx.restore();
    },
  };
}
