/**
 * ZigZag — joins the swing highs and lows that are at least `deviation` %
 * apart, filtering out every move smaller than that.
 *
 * One pass over the bars, O(N), no lookback window:
 *   - while rising, the running extreme is the highest high since the last
 *     pivot; a bar whose low falls `deviation` % below it CONFIRMS that high as
 *     a pivot and the leg turns down (mirror image while falling).
 *   - before the first turn there is no direction yet: the highest high and
 *     the lowest low are both tracked, and whichever reversal arrives first
 *     fixes the first pivot.
 *
 * The last leg — from the last confirmed pivot to the running extreme — is
 * NOT a pivot yet: a further move in the same direction extends it, so it
 * repaints. It is drawn as a separate dashed series so that is visible. Every
 * confirmed pivot is final: new bars never move it.
 *
 * `source: "hl"` measures swings on wicks (high/low), `"close"` on closes only.
 *
 * `labels` writes the price at each corner (highs above, lows below), with
 * the swing % from the previous corner in "pct" mode. The forming corner's
 * label is faded — its price can still change.
 */

import { fmtPriceStd } from "../../lib/number-format.ts";
import type {
  ChartIndicator,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
  PointLabel,
} from "../types";

export interface ZigZagPivot {
  index: number;
  price: number;
  kind: "high" | "low";
}

export interface ZigZagResult {
  /** Confirmed pivots, oldest first, alternating high/low. */
  pivots: ZigZagPivot[];
  /** The running extreme of the leg still forming — repaints. Null before the first turn. */
  live: ZigZagPivot | null;
}

export function calcZigZag(
  data: OhlcvBar[],
  deviationPct: number,
  source: "hl" | "close" = "hl"
): ZigZagResult {
  const d = Math.max(deviationPct, 0) / 100;
  const hiOf = source === "close" ? (b: OhlcvBar) => b.close : (b: OhlcvBar) => b.high;
  const loOf = source === "close" ? (b: OhlcvBar) => b.close : (b: OhlcvBar) => b.low;

  const pivots: ZigZagPivot[] = [];
  let trend: 0 | 1 | -1 = 0;
  // Direction unknown: both extremes are candidates.
  let hi = Number.NEGATIVE_INFINITY;
  let hiIdx = -1;
  let lo = Number.POSITIVE_INFINITY;
  let loIdx = -1;
  // Direction known: the running extreme of the current leg.
  let ext = 0;
  let extIdx = -1;

  for (let i = 0; i < data.length; i++) {
    const h = hiOf(data[i]);
    const l = loOf(data[i]);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    if (trend === 0) {
      if (h > hi) {
        hi = h;
        hiIdx = i;
      }
      if (l < lo) {
        lo = l;
        loIdx = i;
      }
      const upTurn = loIdx < i && h >= lo * (1 + d) && hiIdx === i;
      const downTurn = hiIdx < i && l <= hi * (1 - d) && loIdx === i;
      // Both on one bar: the extreme set earlier is the one the move left behind.
      if (upTurn && (!downTurn || loIdx < hiIdx)) {
        pivots.push({ index: loIdx, price: lo, kind: "low" });
        trend = 1;
        ext = h;
        extIdx = i;
      } else if (downTurn) {
        pivots.push({ index: hiIdx, price: hi, kind: "high" });
        trend = -1;
        ext = l;
        extIdx = i;
      }
      continue;
    }

    if (trend === 1) {
      if (h > ext) {
        ext = h;
        extIdx = i;
      } else if (l <= ext * (1 - d)) {
        pivots.push({ index: extIdx, price: ext, kind: "high" });
        trend = -1;
        ext = l;
        extIdx = i;
      }
    } else {
      if (l < ext) {
        ext = l;
        extIdx = i;
      } else if (h >= ext * (1 + d)) {
        pivots.push({ index: extIdx, price: ext, kind: "low" });
        trend = 1;
        ext = h;
        extIdx = i;
      }
    }
  }

  const live: ZigZagPivot | null =
    trend === 0 ? null : { index: extIdx, price: ext, kind: trend === 1 ? "high" : "low" };
  return { pivots, live };
}

export const ZIGZAG_SOURCES = [
  { value: "hl", label: "High / Low" },
  { value: "close", label: "Close" },
];

export const ZIGZAG_LIVE = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * The picker only renders selects and number boxes (a boolean param arrives as
 * 1/0), so the live leg is an On/Off select; booleans and 1/0 still read right.
 */
function readShowLive(v: unknown): boolean {
  return !(v === "off" || v === false || v === 0 || v === "0");
}

export const ZIGZAG_LABELS = [
  { value: "off", label: "Off" },
  { value: "price", label: "Price" },
  { value: "pct", label: "Price + swing %" },
];

type LabelMode = "off" | "price" | "pct";

function pivotLabel(
  p: ZigZagPivot,
  prev: ZigZagPivot | undefined,
  data: OhlcvBar[],
  mode: LabelMode,
  color: string,
  faded = false
): PointLabel {
  let text = fmtPriceStd(p.price);
  if (mode === "pct" && prev && prev.price !== 0) {
    const pct = ((p.price - prev.price) / Math.abs(prev.price)) * 100;
    text += ` ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  return {
    time: data[p.index].time,
    price: p.price,
    text,
    position: p.kind === "high" ? "above" : "below",
    color,
    faded,
  };
}

export const createZigZag: IndicatorFactory = (overrides = {}) => {
  const deviation = Number(overrides.deviation ?? 5);
  const source = overrides.source === "close" ? "close" : "hl";
  const showLive = readShowLive(overrides.showLive);
  const color = (overrides.color as string) ?? "#ffb300";
  const labels: LabelMode =
    overrides.labels === "price" || overrides.labels === "pct" ? overrides.labels : "off";

  const indicator: ChartIndicator = {
    id: `zigzag-${deviation}-${source}`,
    name: `ZigZag ${deviation}%`,
    category: "trend",
    type: "overlay",
    description: `Swing highs/lows at least ${deviation}% apart`,
    minBars: 2,
    params: [
      {
        key: "deviation",
        label: "Deviation %",
        type: "number",
        default: deviation,
        min: 0.1,
        max: 50,
        step: 0.1,
      },
      { key: "source", label: "Source", type: "select", default: source, options: ZIGZAG_SOURCES },
      {
        key: "showLive",
        label: "Live leg",
        type: "select",
        default: showLive ? "on" : "off",
        options: ZIGZAG_LIVE,
      },
      {
        key: "labels",
        label: "Pivot labels",
        type: "select",
        default: labels,
        options: ZIGZAG_LABELS,
      },
      {
        key: "color",
        label: "Color",
        type: "select",
        default: color,
        options: [
          { value: "#ffb300", label: "Amber" },
          { value: "#00bcd4", label: "Cyan" },
          { value: "#e91e63", label: "Pink" },
          { value: "#ffffff", label: "White" },
        ],
      },
    ],
    config: { deviation, source, showLive: showLive ? "on" : "off", color, labels },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const c = config.color as string;
      const mode: LabelMode =
        config.labels === "price" || config.labels === "pct" ? config.labels : "off";
      const { pivots, live } = calcZigZag(
        data,
        Number(config.deviation),
        config.source === "close" ? "close" : "hl"
      );

      const out: IndicatorSeriesOutput[] = [
        {
          id: "zigzag-line",
          label: `ZigZag ${config.deviation}%`,
          type: "line",
          color: c,
          lineWidth: 2,
          data: pivots.map((p) => ({ time: data[p.index].time, value: p.price })),
          // An array (possibly empty) whenever labels are on, never undefined:
          // ModularChart attaches the label layer once, at build time.
          labels:
            mode === "off"
              ? undefined
              : pivots.map((p, i) => pivotLabel(p, pivots[i - 1], data, mode, c)),
        },
      ];

      // Always emitted (empty when hidden) so the output count never changes
      // between ticks — a different count makes ModularChart rebuild the chart.
      const last = pivots[pivots.length - 1];
      const drawLive = readShowLive(config.showLive) && last && live && live.index > last.index;
      out.push({
        id: "zigzag-live",
        label: "ZigZag (forming)",
        type: "line",
        color: `${c}99`,
        lineWidth: 1,
        lineStyle: "dashed",
        data: drawLive
          ? [
              { time: data[last.index].time, value: last.price },
              { time: data[live.index].time, value: live.price },
            ]
          : [],
        labels:
          mode === "off"
            ? undefined
            : drawLive
              ? [pivotLabel(live, last, data, mode, c, true)]
              : [],
      });
      return out;
    },
  };

  return indicator;
};
