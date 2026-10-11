/**
 * Ichimoku Kinko Hyo — overlay on the price pane.
 *
 *   Tenkan-sen  (conversion)  midpoint of the last `tenkan` bars' high/low   (9)
 *   Kijun-sen   (base)        midpoint of the last `kijun` bars' high/low    (26)
 *   Senkou A    (leading A)   (Tenkan + Kijun) / 2, plotted `shift` ahead
 *   Senkou B    (leading B)   midpoint of the last `senkou` bars, `shift` ahead (52)
 *   Chikou      (lagging)     the close, plotted `shift` back
 *   Kumo        (cloud)       the space between Senkou A and B — green while A ≥ B
 *
 * Displacement follows TradingView: `shift` 26 counts the current bar as the
 * first, so the spans land 25 bars ahead and Chikou 25 back. That is the chart
 * most readers compare against; a lib that moves by a full 26 is one bar off.
 *
 * Two halves, like S/D zones:
 *   - `compute` returns the five lines on the bars that exist, so they reach the
 *     price axis, the autoscale and the hover legend like any other series.
 *   - createIchimokuCloudOverlay (added by useChartIndicators while this is on)
 *     fills the cloud under the candles and draws the part of both spans that
 *     lies in the future — no bar time exists there, so no series can hold it.
 *     It is not a forecast: every point of it is already fixed by closed bars
 *     (as of the forming one). The autoscale does not see it, so a cloud far
 *     from price can run off the pane until the user scrolls the price axis.
 *
 * O(N): five rolling extremes (monotone deque) and one pass. The overlay only
 * walks the visible range.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { rollingMax, rollingMin } from "../rolling.ts";
import type {
  CanvasOverlay,
  ChartIndicator,
  IndicatorFactory,
  IndicatorParam,
  IndicatorSeriesOutput,
  OhlcvBar,
  OverlayRect,
  SeriesDataPoint,
} from "../types";

export const ICHIMOKU_COLORS = {
  tenkan: "#2962ff",
  kijun: "#e53935",
  chikou: "#43a047",
  spanA: "#66bb6a",
  spanB: "#ef5350",
  cloudUp: "rgba(76,175,80,0.16)",
  cloudDown: "rgba(239,83,80,0.16)",
} as const;

export const ICHIMOKU_PARAMS: IndicatorParam[] = [
  { key: "tenkan", label: "Tenkan", type: "number", default: 9, min: 2, max: 200, step: 1 },
  { key: "kijun", label: "Kijun", type: "number", default: 26, min: 2, max: 300, step: 1 },
  { key: "senkou", label: "Senkou B", type: "number", default: 52, min: 2, max: 500, step: 1 },
  { key: "shift", label: "Displacement", type: "number", default: 26, min: 1, max: 300, step: 1 },
  {
    key: "chikou",
    label: "Chikou",
    type: "select",
    default: "on",
    options: [
      { value: "on", label: "Show" },
      { value: "off", label: "Hide" },
    ],
  },
];

export interface IchimokuConfig {
  tenkan: number;
  kijun: number;
  senkou: number;
  shift: number;
  chikou: boolean;
}

const posInt = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

export function readIchimokuConfig(raw: Record<string, unknown>): IchimokuConfig {
  return {
    tenkan: posInt(raw.tenkan, 9),
    kijun: posInt(raw.kijun, 26),
    senkou: posInt(raw.senkou, 52),
    shift: posInt(raw.shift, 26),
    chikou: raw.chikou !== "off" && raw.chikou !== false,
  };
}

export interface IchimokuResult {
  /** Per bar, NaN during warm-up. */
  tenkan: Float64Array;
  kijun: Float64Array;
  /**
   * Leading spans by PLOT position: index p is drawn at bar p, and p ≥ bars
   * lies `p - (bars - 1)` bars right of the last one. Length bars + offset.
   */
  spanA: Float64Array;
  spanB: Float64Array;
  /** Bars the spans move forward and Chikou back (`shift` − 1, ≥ 0). */
  offset: number;
}

function midpoint(highs: number[], lows: number[], period: number): Float64Array {
  const hh = rollingMax(highs, period);
  const ll = rollingMin(lows, period);
  const out = new Float64Array(highs.length);
  for (let i = 0; i < out.length; i++) out[i] = (hh[i] + ll[i]) / 2; // NaN stays NaN
  return out;
}

export function calcIchimoku(data: OhlcvBar[], cfg: IchimokuConfig): IchimokuResult {
  const n = data.length;
  const highs = new Array<number>(n);
  const lows = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // rollingMax needs finite input — a bad print falls back to the close.
    const c = data[i].close;
    highs[i] = Number.isFinite(data[i].high) ? data[i].high : c;
    lows[i] = Number.isFinite(data[i].low) ? data[i].low : c;
  }
  const tenkan = midpoint(highs, lows, cfg.tenkan);
  const kijun = midpoint(highs, lows, cfg.kijun);
  const lead = midpoint(highs, lows, cfg.senkou);
  const offset = Math.max(0, cfg.shift - 1);

  const spanA = new Float64Array(n + offset).fill(Number.NaN);
  const spanB = new Float64Array(n + offset).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    spanA[i + offset] = (tenkan[i] + kijun[i]) / 2;
    spanB[i + offset] = lead[i];
  }
  return { tenkan, kijun, spanA, spanB, offset };
}

const points = (data: OhlcvBar[], values: ArrayLike<number>): SeriesDataPoint[] => {
  const out: SeriesDataPoint[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) out.push({ time: data[i].time, value: v });
  }
  return out;
};

export const createIchimoku: IndicatorFactory = (overrides = {}) => {
  const cfg = readIchimokuConfig(overrides);

  const indicator: ChartIndicator = {
    id: `ichimoku-${cfg.tenkan}-${cfg.kijun}-${cfg.senkou}-${cfg.shift}`,
    name: `Ichimoku (${cfg.tenkan}, ${cfg.kijun}, ${cfg.senkou})`,
    category: "trend",
    type: "overlay",
    description: "Ichimoku Cloud — Tenkan, Kijun, leading spans + cloud, Chikou",
    minBars: Math.min(cfg.tenkan, cfg.kijun),
    params: ICHIMOKU_PARAMS.map((p) => ({
      ...p,
      default: p.key === "chikou" ? (cfg.chikou ? "on" : "off") : cfg[p.key as "tenkan"],
    })),
    config: { ...cfg, chikou: cfg.chikou ? "on" : "off" },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const c = readIchimokuConfig(config);
      const r = calcIchimoku(data, c);
      const out: IndicatorSeriesOutput[] = [
        {
          id: "ichimoku-span-a",
          label: `Senkou A (${c.shift})`,
          type: "line",
          color: ICHIMOKU_COLORS.spanA,
          lineWidth: 1,
          data: points(data, r.spanA),
        },
        {
          id: "ichimoku-span-b",
          label: `Senkou B (${c.senkou}, ${c.shift})`,
          type: "line",
          color: ICHIMOKU_COLORS.spanB,
          lineWidth: 1,
          data: points(data, r.spanB),
        },
        {
          id: "ichimoku-tenkan",
          label: `Tenkan (${c.tenkan})`,
          type: "line",
          color: ICHIMOKU_COLORS.tenkan,
          lineWidth: 1,
          data: points(data, r.tenkan),
        },
        {
          id: "ichimoku-kijun",
          label: `Kijun (${c.kijun})`,
          type: "line",
          color: ICHIMOKU_COLORS.kijun,
          lineWidth: 1,
          data: points(data, r.kijun),
        },
      ];
      if (c.chikou) {
        // The close of bar i, drawn on bar i − offset.
        const chikou: SeriesDataPoint[] = [];
        for (let i = r.offset; i < data.length; i++) {
          chikou.push({ time: data[i - r.offset].time, value: data[i].close });
        }
        out.push({
          id: "ichimoku-chikou",
          label: `Chikou (${c.shift})`,
          type: "line",
          color: ICHIMOKU_COLORS.chikou,
          lineWidth: 1,
          data: chikou,
        });
      }
      return out;
    },
  };

  return indicator;
};

// ── Cloud overlay ────────────────────────────────────────────────────────────

/**
 * The cloud fill (under the candles) and both spans' future stretch. Colour
 * flips at the exact crossing, not at the next bar, so a twist is drawn where
 * the spans meet.
 */
export function createIchimokuCloudOverlay(config: Record<string, unknown>): CanvasOverlay {
  const cfg = readIchimokuConfig(config);
  let cacheKey: OhlcvBar[] | null = null;
  let result: IchimokuResult | null = null;

  return {
    id: "ichimoku-cloud",
    name: "Ichimoku Cloud",
    mode: "full",
    zOrder: "bottom",
    width: 0,

    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      series: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      _isDark: boolean,
      _rect: OverlayRect
    ) {
      const n = data.length;
      if (n === 0) return;
      if (data !== cacheKey) {
        cacheKey = data;
        result = calcIchimoku(data, cfg);
      }
      if (!result) return;
      const { spanA, spanB } = result;
      const ts = chart.timeScale();
      const last = n - 1;
      // Bars keep their own time; the future is the last bar plus k logical
      // steps, as trend-line.ts places a future endpoint.
      const xAt = (p: number): number | null =>
        p <= last
          ? ts.timeToCoordinate(data[p].time as Time)
          : // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Logical brand
            ts.logicalToCoordinate(p as any);

      const range = ts.getVisibleLogicalRange();
      const from = Math.max(0, Math.floor(range ? range.from : 0) - 1);
      const to = Math.min(spanA.length - 1, Math.ceil(range ? range.to : spanA.length) + 1);
      if (to <= from) return;

      ctx.save();
      // ── Fill: one quad per bar gap, split in two at a crossing ──
      let prev: { x: number; a: number; b: number } | null = null;
      for (let p = from; p <= to; p++) {
        const a = spanA[p];
        const b = spanB[p];
        const x = Number.isFinite(a) && Number.isFinite(b) ? xAt(p) : null;
        if (x == null) {
          prev = null;
          continue;
        }
        if (prev) fillGap(ctx, series, prev, { x, a, b });
        prev = { x, a, b };
      }

      // ── Future stretch of both spans (the series stop at the last bar) ──
      for (const [values, color] of [
        [spanA, ICHIMOKU_COLORS.spanA],
        [spanB, ICHIMOKU_COLORS.spanB],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let open = false;
        for (let p = Math.max(from, last); p <= to; p++) {
          const v = values[p];
          const x = Number.isFinite(v) ? xAt(p) : null;
          const y = x == null ? null : series.priceToCoordinate(v);
          if (x == null || y == null) {
            open = false;
            continue;
          }
          if (open) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          open = true;
        }
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function fillGap(
  ctx: CanvasRenderingContext2D,
  series: ISeriesApi<SeriesType>,
  l: { x: number; a: number; b: number },
  r: { x: number; a: number; b: number }
): void {
  const y = (v: number) => series.priceToCoordinate(v);
  const dl = l.a - l.b;
  const dr = r.a - r.b;
  const poly = (pts: [number, number | null][], up: boolean) => {
    if (pts.some(([, py]) => py == null)) return;
    ctx.fillStyle = up ? ICHIMOKU_COLORS.cloudUp : ICHIMOKU_COLORS.cloudDown;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1] as number);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1] as number);
    ctx.closePath();
    ctx.fill();
  };
  if ((dl >= 0 && dr >= 0) || (dl <= 0 && dr <= 0)) {
    poly(
      [
        [l.x, y(l.a)],
        [r.x, y(r.a)],
        [r.x, y(r.b)],
        [l.x, y(l.b)],
      ],
      dl + dr >= 0
    );
    return;
  }
  // The spans cross inside the gap: where A − B hits zero.
  const t = dl / (dl - dr);
  const cx = l.x + (r.x - l.x) * t;
  const cv = l.a + (r.a - l.a) * t;
  poly(
    [
      [l.x, y(l.a)],
      [cx, y(cv)],
      [l.x, y(l.b)],
    ],
    dl > 0
  );
  poly(
    [
      [cx, y(cv)],
      [r.x, y(r.a)],
      [r.x, y(r.b)],
    ],
    dr > 0
  );
}
