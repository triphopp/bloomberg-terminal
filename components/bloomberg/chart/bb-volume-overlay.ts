/**
 * Volume drawn inside the Bollinger Band — so BB users read participation
 * without opening a volume pane (lib/bb-volume.ts has the readings and the why).
 *
 * Columns stand on the lower band and their height is a fraction of the band's
 * width at that bar (delta: colour = which side owned it). The
 * dashed line is the VOLUME σ threshold, not a price level: a column through it
 * is an abnormal bar. Painted under the candles (zOrder "bottom") so price
 * stays the thing in front.
 *
 * Squeeze: a band a few pixels wide would shrink every column to nothing right
 * when a volume spike matters most, so the drawing space never drops below
 * MIN_SPACE_PX — the columns overflow a tight band instead of vanishing.
 *
 * Layout (readability): columns stand exactly behind the candles, so a tall
 * column swallows the bar in front of it. `clear` (default) cuts each column
 * out around its own candle's high–low with a small gap — both stay legible,
 * the volume reads above/below the bar. `band` is the old solid draw; `base`
 * moves the columns to a strip along the bottom of the pane, off the price.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import {
  BB_VOL_BASES,
  BB_VOL_MODES,
  type BbVolBasis,
  type BbVolColumns,
  type BbVolMode,
  type BlockProfile,
  DRY_UP_RATIO,
  RVOL_ABNORMAL,
  VP_PERIODS,
  type VpPeriod,
  bbVolumeColumns,
  blockProfiles,
} from "../lib/bb-volume.ts";
import { calcBollingerStats, resolveBollingerParameters } from "./bollinger-fit.ts";
import type { CanvasOverlay, IndicatorParam, OhlcvBar, OverlayRect } from "./types";
import { EVENT_COLOR } from "./volume-event-overlay.ts";

export type BbVolLayout = "clear" | "band" | "base";
const BB_VOL_LAYOUTS: { value: BbVolLayout; label: string }[] = [
  { value: "clear", label: "Clear (gap at candle)" },
  { value: "band", label: "Band (solid)" },
  { value: "base", label: "Base strip" },
];

export const BB_VOLUME_PARAMS: IndicatorParam[] = [
  {
    key: "volOverlay",
    label: "Vol overlay",
    type: "select",
    default: "off",
    options: BB_VOL_MODES,
  },
  {
    key: "volBasis",
    label: "Vol basis",
    type: "select",
    default: "z",
    options: BB_VOL_BASES,
  },
  {
    key: "volLayout",
    label: "Vol layout",
    type: "select",
    default: "clear",
    options: BB_VOL_LAYOUTS,
  },
  { key: "volSigma", label: "Vol σ", type: "number", default: 2, min: 1, max: 4, step: 0.5 },
  {
    key: "volLookback",
    label: "Vol lookback",
    type: "number",
    default: 20,
    min: 8,
    max: 120,
    step: 1,
  },
  {
    key: "volShow",
    label: "Vol show",
    type: "select",
    default: "all",
    options: [
      { value: "all", label: "All bars" },
      { value: "abnormal", label: "Abnormal only" },
    ],
  },
  {
    key: "volOpacity",
    label: "Vol opacity",
    type: "select",
    default: "55",
    options: [
      { value: "33", label: "Light" },
      { value: "55", label: "Medium" },
      { value: "88", label: "Strong" },
    ],
  },
  { key: "vpPeriod", label: "VP period", type: "select", default: "auto", options: VP_PERIODS },
  { key: "vpBars", label: "VP N bars", type: "number", default: 21, min: 15, max: 250, step: 1 },
];

/**
 * Display-only keys. Alert builders skip them the way they skip fitCostBps:
 * they change what is drawn, not the band a rule would evaluate.
 */
export const BB_VOLUME_PARAM_KEYS: ReadonlySet<string> = new Set(
  BB_VOLUME_PARAMS.map((p) => p.key)
);

export interface BbVolumeSettings {
  mode: BbVolMode;
  basis: BbVolBasis;
  layout: BbVolLayout;
  sigma: number;
  lookback: number;
  abnormalOnly: boolean;
  opacity: string;
  vpPeriod: VpPeriod;
  vpBars: number;
}

const num = (v: unknown, fallback: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** BB indicator config → overlay settings, with every value clamped to its param range. */
export function readBbVolumeSettings(config: Record<string, unknown>): BbVolumeSettings {
  const modes = BB_VOL_MODES.map((m) => m.value as string);
  const periods = VP_PERIODS.map((p) => p.value as string);
  const opacity = String(config.volOpacity ?? "55");
  return {
    mode: (modes.includes(config.volOverlay as string) ? config.volOverlay : "off") as BbVolMode,
    basis: config.volBasis === "ratio" ? "ratio" : "z",
    layout: (["clear", "band", "base"].includes(config.volLayout as string)
      ? config.volLayout
      : "clear") as BbVolLayout,
    sigma: num(config.volSigma, 2, 1, 4),
    lookback: Math.round(num(config.volLookback, 20, 8, 120)),
    abnormalOnly: config.volShow === "abnormal",
    opacity: /^[0-9a-f]{2}$/i.test(opacity) ? opacity : "55",
    vpPeriod: (periods.includes(config.vpPeriod as string) ? config.vpPeriod : "auto") as VpPeriod,
    vpBars: Math.round(num(config.vpBars, 21, 15, 250)),
  };
}

const MIN_SPACE_PX = 12;
/** Pixels kept clear above and below a candle in the `clear` layout. */
const CANDLE_GAP_PX = 3;
/** Height of the `base` strip as a share of the pane. */
const BASE_STRIP = 0.2;
const UP = "#4caf50";
const DOWN = "#ef5350";
const SPIKE = "#ff9800";
const DRY_UP = "#7e57c2";
const NEUTRAL_DARK = "#9e9e9e";
const NEUTRAL_LIGHT = "#757575";
const HVN = "#ff9800";
const POC = "#ffd54f";
const PROFILE_FILL = 0.85;

/** One swatch in the on-chart colour key. `line` draws a dash, not a block. */
export interface ColorKeyItem {
  color: string;
  label: string;
  line?: "solid" | "dashed";
}

const EVENT_LABEL: Record<keyof typeof EVENT_COLOR, string> = {
  climax: "climax",
  absorption: "absorption",
  vacuum: "vacuum (thin vol)",
  breakout: "breakout",
  noDemand: "no demand",
  dryUp: "dry-up run",
};

/**
 * What every colour the overlay can paint means under these settings — the
 * same branches as columnColor/drawProfiles, so the key can't drift from the
 * drawing. Empty when the overlay is off.
 */
export function bbVolumeColorKey(s: BbVolumeSettings, isDark = true): ColorKeyItem[] {
  if (s.mode === "off") return [];
  const neutral = isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  if (s.mode === "profile") {
    return [
      { color: HVN, label: "HVN · heavy-volume price" },
      { color: neutral, label: "volume at price" },
      { color: POC, label: "POC", line: "solid" },
      { color: POC, label: "naked POC (untested)", line: "dashed" },
      { color: isDark ? "#ffffff60" : "#00000060", label: "VAH / VAL (70%)", line: "solid" },
    ];
  }
  const ratio = s.basis === "ratio";
  const hi = ratio || s.mode === "rvol" ? `≥ ${RVOL_ABNORMAL}× normal` : `≥ ${s.sigma}σ vol`;
  const dry = ratio ? `≤ ${DRY_UP_RATIO}× normal` : "≤ −1σ vol";
  const thr = {
    color: isDark ? "#ffffffb0" : "#000000b0",
    label: "threshold (volume, not price)",
    line: "dashed" as const,
  };
  if (s.mode === "delta") {
    return [
      { color: UP, label: `buyers owned it (${hi})` },
      { color: DOWN, label: `sellers owned it (${hi})` },
      { color: neutral, label: "normal" },
      thr,
    ];
  }
  const out: ColorKeyItem[] = [
    { color: SPIKE, label: `spike ${hi}` },
    { color: DRY_UP, label: `dry ${dry}` },
    { color: neutral, label: "normal" },
  ];
  if (s.mode === "events") {
    for (const [k, c] of Object.entries(EVENT_COLOR)) {
      if (k !== "climax" && k !== "dryUp")
        out.push({ color: c, label: EVENT_LABEL[k as keyof typeof EVENT_COLOR] });
    }
    out[0] = { color: SPIKE, label: `climax / spike ${hi}` };
  }
  if (s.mode !== "vol") out.push(thr);
  return out;
}

interface Bands {
  upper: (number | null)[];
  lower: (number | null)[];
}

function computeBands(data: OhlcvBar[], bbConfig: Record<string, unknown>): Bands {
  const { period, stdDev } = resolveBollingerParameters(data, bbConfig);
  const { middle, deviation } = calcBollingerStats(data, period);
  const upper = middle.map((m, i) =>
    m == null || deviation[i] == null ? null : m + stdDev * (deviation[i] as number)
  );
  const lower = middle.map((m, i) =>
    m == null || deviation[i] == null ? null : m - stdDev * (deviation[i] as number)
  );
  return { upper, lower };
}

/**
 * Ordinary bars are neutral grey: green/red columns under green/red candles
 * read as more candles. Colour is spent only where it says something —
 * abnormal, dry-up, an event, or (delta) which side owned the bar.
 */
function columnColor(
  c: BbVolColumns["columns"][number],
  mode: BbVolMode,
  alpha: string,
  isDark: boolean
): string {
  if (c.event) return EVENT_COLOR[c.event];
  if (c.tier === "dryUp") return DRY_UP;
  if (mode === "delta" && c.tier === "abnormal") return c.dir > 0 ? UP : DOWN;
  if (c.tier === "abnormal") return SPIKE;
  return `${isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT}${alpha}`;
}

/**
 * Overlay for one BB instance. `bbConfig` is that indicator's config, so the
 * bands drawn here are the bands on screen — same period, deviation and fit.
 */
export function createBbVolumeOverlay(bbConfig: Record<string, unknown>): CanvasOverlay {
  const settings = readBbVolumeSettings(bbConfig);
  let cacheKey: OhlcvBar[] | null = null;
  let bands: Bands = { upper: [], lower: [] };
  let columns: BbVolColumns | null = null;
  let profiles: BlockProfile[] = [];

  return {
    id: "bb-volume",
    name: "BB Volume",
    mode: "full",
    zOrder: "bottom",
    width: 0,
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      series: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      isDark: boolean,
      rect: OverlayRect
    ) {
      if (data.length === 0 || settings.mode === "off") return;
      if (data !== cacheKey) {
        cacheKey = data;
        if (settings.mode === "profile") {
          profiles = blockProfiles(data, settings.vpPeriod, settings.sigma, settings.vpBars);
        } else {
          bands = computeBands(data, bbConfig);
          columns = bbVolumeColumns(data, settings);
        }
      }

      const ts = chart.timeScale();
      const spacing = ts.options().barSpacing ?? 6;
      const y = (p: number | null) => (p == null ? null : series.priceToCoordinate(p));
      ctx.save();

      if (settings.mode === "profile") {
        drawProfiles(ctx, chart, series, data, profiles, spacing, settings.opacity, isDark, rect);
        ctx.restore();
        return;
      }
      if (!columns) {
        ctx.restore();
        return;
      }

      const w = Math.max(1, Math.min(spacing * 0.5, 16));
      const thr = columns.threshold;
      const line: [number, number][] = [];
      const base = settings.layout === "base";
      const baseSpace = Math.max(MIN_SPACE_PX, rect.height * BASE_STRIP);

      for (const c of columns.columns) {
        const x = ts.timeToCoordinate(c.time as Time);
        if (x === null || x < -w || x > rect.width + w) continue;
        let yLo: number;
        let space: number;
        if (base) {
          yLo = rect.height;
          space = baseSpace;
        } else {
          const yUp = y(bands.upper[c.index]);
          const yBand = y(bands.lower[c.index]);
          if (yUp == null || yBand == null) continue;
          yLo = yBand;
          space = Math.max(yBand - yUp, MIN_SPACE_PX);
        }

        if (thr != null) line.push([x, yLo - thr * space]);
        if (settings.abnormalOnly && c.tier === "dim" && !c.event) continue;
        const h = Math.max(1, c.frac * space);
        ctx.fillStyle = columnColor(c, settings.mode, settings.opacity, isDark);
        const top = yLo - h;
        const bar = data[c.index];
        const yHi = settings.layout === "clear" && bar ? y(bar.high) : null;
        const yLw = settings.layout === "clear" && bar ? y(bar.low) : null;
        if (yHi == null || yLw == null) {
          ctx.fillRect(x - w / 2, top, w, h);
          continue;
        }
        // Cut the column around its own candle: draw the part above the
        // wick top and the part below the wick bottom, skip the candle.
        const cutTop = yHi - CANDLE_GAP_PX;
        const cutBot = yLw + CANDLE_GAP_PX;
        if (top < cutTop) ctx.fillRect(x - w / 2, top, w, Math.min(yLo, cutTop) - top);
        if (yLo > cutBot)
          ctx.fillRect(x - w / 2, Math.max(top, cutBot), w, yLo - Math.max(top, cutBot));
      }

      if (line.length > 1) {
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = isDark ? "#ffffff70" : "#00000070";
        ctx.beginPath();
        line.forEach(([lx, ly], i) => (i === 0 ? ctx.moveTo(lx, ly) : ctx.lineTo(lx, ly)));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (settings.mode === "delta") {
        ctx.font = "9px monospace";
        ctx.fillStyle = isDark ? "#ffffff66" : "#00000066";
        ctx.textAlign = "left";
        ctx.fillText(
          settings.basis === "ratio" ? "Δ est. · ×normal" : `Δ est. · ${settings.sigma}σ`,
          6,
          12
        );
      }
      ctx.restore();
    },
  };
}

function drawProfiles(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  data: OhlcvBar[],
  profiles: BlockProfile[],
  spacing: number,
  alpha: string,
  isDark: boolean,
  rect: OverlayRect
) {
  const ts = chart.timeScale();
  const dim = isDark ? `#9e9e9e${alpha}` : `#616161${alpha}`;
  ctx.font = "9px monospace";
  ctx.textAlign = "left";

  for (const p of profiles) {
    const xs = ts.timeToCoordinate(data[p.start].time as Time);
    const xe = ts.timeToCoordinate(data[p.end].time as Time);
    if (xs === null || xe === null) continue;
    const left = xs - spacing / 2;
    const right = xe + spacing / 2;
    if (right < 0 || left > rect.width) continue;
    const maxW = (right - left) * PROFILE_FILL;
    if (maxW < 2) continue;
    ctx.globalAlpha = p.partial ? 0.45 : 1;

    for (const b of p.buckets) {
      if (b.volume <= 0) continue;
      const yTop = series.priceToCoordinate(b.high);
      const yBot = series.priceToCoordinate(b.low);
      if (yTop === null || yBot === null) continue;
      ctx.fillStyle = b.hvn ? `${HVN}${alpha}` : dim;
      ctx.fillRect(left, yTop, maxW * (b.volume / p.maxVolume), Math.max(1, yBot - yTop - 1));
    }

    const yPoc = series.priceToCoordinate(p.poc);
    if (yPoc !== null) {
      ctx.strokeStyle = POC;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, yPoc);
      ctx.lineTo(right, yPoc);
      ctx.stroke();
      if (p.naked && right < rect.width) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = `${POC}99`;
        ctx.beginPath();
        ctx.moveTo(right, yPoc);
        ctx.lineTo(rect.width, yPoc);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.strokeStyle = isDark ? "#ffffff30" : "#00000030";
    for (const price of [p.vah, p.val]) {
      const yv = series.priceToCoordinate(price);
      if (yv === null) continue;
      ctx.beginPath();
      ctx.moveTo(left, yv);
      ctx.lineTo(right, yv);
      ctx.stroke();
    }

    if (p.partial) {
      const yHi = series.priceToCoordinate(p.buckets[p.buckets.length - 1].high);
      if (yHi !== null) {
        ctx.fillStyle = isDark ? "#ffffff80" : "#00000080";
        ctx.fillText("partial", left + 2, yHi - 3);
      }
    }
    ctx.globalAlpha = 1;
  }
}
