/**
 * Volume readings sized to live inside a Bollinger Band.
 *
 * The BB overlay (chart/bb-volume-overlay.ts) draws volume in the space between
 * the bands instead of in a pane of its own: the band's width at a bar is the
 * y-axis, so a column that reaches the band edge is "as abnormal as the scale
 * goes". This module does the arithmetic and nothing else — every reading is a
 * fraction of that space, so the overlay only has to multiply by pixels.
 *
 * ── Whose σ ─────────────────────────────────────────────────────────────────
 *
 * The threshold is measured on VOLUME, never on price. The band's own σ is the
 * dispersion of closes; a bar can sit dead centre of the band on the busiest
 * day of the quarter. Spike and events use the robust log z of
 * lib/volume-stats.ts (median/MAD, same slot in prior sessions intraday), so a
 * 2σ line here means the same thing as 2 on the VOL Z pane.
 *
 * ── Delta is an estimate ────────────────────────────────────────────────────
 *
 * OhlcvBar carries one volume number, no buy/sell split. Delta here is the
 * close-location value (Chaikin) times relative volume: where the bar closed in
 * its range says which side owned it, RVOL says how much that ownership
 * weighed. Using RVOL rather than raw volume keeps the reading slot-aware on
 * intraday bars — raw CLV×volume would flag every open. The UI labels it est.
 *
 * ── Profiles ────────────────────────────────────────────────────────────────
 *
 * `profile` mode is a volume-by-price histogram per calendar block (month on
 * daily bars, see resolveVpPeriod). Calendar blocks rather than rolling N bars:
 * a rolling window moves its POC every bar, and a level that moves is not a
 * level anyone remembers. Blocks under MIN_PROFILE_BARS are flagged partial —
 * a daily bar spreads its volume over its whole range, so a handful of bars is
 * a few flat slabs, not a distribution.
 */

import { RollingSample } from "../chart/rolling.ts";
import { type VolumeEventType, classifyVolumeEvents } from "./volume-events.ts";
import {
  MAD_TO_SIGMA,
  MIN_SAMPLES,
  SESSION_GAP_SEC,
  mean,
  median,
  stdev,
  volumeRatio,
  volumeZ,
} from "./volume-stats.ts";

export type BbVolMode = "off" | "vol" | "spike" | "delta" | "rvol" | "events" | "profile";
/**
 * What "abnormal" is measured in. `z` = robust log-volume z (median/MAD) against
 * the Vol σ setting; `ratio` = plain multiple of normal volume (RVOL vs the
 * median) with fixed cut-offs, for readers who don't want a z-score at all.
 */
export type BbVolBasis = "z" | "ratio";
export type VpPeriod = "auto" | "session" | "week" | "month" | "quarter" | "bars";
export type ResolvedVpPeriod = Exclude<VpPeriod, "auto">;

export const BB_VOL_BASES: { value: BbVolBasis; label: string }[] = [
  { value: "z", label: "Z-score (vol σ)" },
  { value: "ratio", label: "×Normal (no z)" },
];

export const BB_VOL_MODES: { value: BbVolMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "spike", label: "Spike (vol σ)" },
  { value: "delta", label: "Delta (est.)" },
  { value: "vol", label: "Volume" },
  { value: "rvol", label: "RVOL (×normal)" },
  { value: "events", label: "Events" },
  { value: "profile", label: "Volume profile" },
];

export const VP_PERIODS: { value: VpPeriod; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "session", label: "Session" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "bars", label: "Every N bars" },
];

/** z (or |z| for delta) that fills the whole band. */
export const Z_CAP = 4;
/** RVOL ratio that fills the whole band. */
export const RVOL_CAP = 4;
/** RVOL ratio drawn as the threshold line — the RVOL pane's "abnormal" tier. */
export const RVOL_ABNORMAL = 2;
/** At or below this z a bar reads as dry. Same as the RVOL pane. */
export const DRY_UP_Z = -1;
/** Ratio basis: at or below this multiple of normal volume a bar reads as dry. */
export const DRY_UP_RATIO = 0.5;
/** A profile block with fewer bars than this has no shape worth reading. */
export const MIN_PROFILE_BARS = 15;
/** Price buckets per profile block. */
export const PROFILE_BUCKETS = 24;
const VALUE_AREA_PCT = 0.7;

/** Anything with the fields these functions read. Structurally a subset of OhlcvBar. */
export interface BbVolBar {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BbVolConfig {
  mode: BbVolMode;
  /** Volume σ that counts as abnormal. */
  sigma: number;
  /** Prior bars (daily) or sessions (intraday) behind every baseline. */
  lookback: number;
  /** Default `z`. With `ratio` the σ setting is ignored. */
  basis?: BbVolBasis;
}

export type ColumnTier = "dim" | "abnormal" | "dryUp";

export interface BbVolColumn {
  index: number;
  time: string | number;
  /** Height as a fraction of the drawing space, 0..1. */
  frac: number;
  /** Which way the bar went (close vs open) — delta: which side owned it. */
  dir: 1 | -1;
  tier: ColumnTier;
  /** Set in events mode on classified bars. */
  event?: VolumeEventType;
}

export interface BbVolColumns {
  /** Fraction at which the σ line is drawn, or null when the mode has none. */
  threshold: number | null;
  columns: BbVolColumn[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const dirOf = (b: BbVolBar): 1 | -1 => (b.close >= b.open ? 1 : -1);

/** Robust log-volume z tier, shared by every lower-anchored mode. */
function zTier(z: number | null, sigma: number): ColumnTier {
  if (z == null) return "dim";
  if (z >= sigma) return "abnormal";
  if (z <= DRY_UP_Z) return "dryUp";
  return "dim";
}

/** Ratio-basis tier: fixed multiples of normal volume, no σ involved. */
function ratioTier(r: number | null): ColumnTier {
  if (r == null) return "dim";
  if (r >= RVOL_ABNORMAL) return "abnormal";
  if (r <= DRY_UP_RATIO) return "dryUp";
  return "dim";
}

/** 95th percentile — the raw-volume scale, so one monster print does not flatten the rest. */
function p95(window: RollingSample): number {
  const n = window.size;
  if (n === 0) return Number.NaN;
  return window.sorted.at(Math.min(n - 1, Math.floor(0.95 * (n - 1))));
}

/**
 * Close-location value: +1 closed on the high, −1 on the low. Zero-range bars
 * fall back to the tick rule vs the previous close, like the volume profile's
 * buy/sell split.
 */
export function closeLocation(bar: BbVolBar, prevClose: number | null): number {
  const range = bar.high - bar.low;
  if (range > 0) return (bar.close - bar.low - (bar.high - bar.close)) / range;
  if (prevClose == null || bar.close === prevClose) return 0;
  return bar.close > prevClose ? 1 : -1;
}

/**
 * Estimated delta per bar as a robust z: CLV × RVOL, standardised against the
 * trailing `lookback × 2` readings (median/MAD, stdev fallback). Null until
 * MIN_SAMPLES readings exist or when there is no scale.
 */
export function deltaZ(bars: BbVolBar[], lookback: number): (number | null)[] {
  const ratio = volumeRatio(bars, { lookback, baseline: "median" });
  const est: (number | null)[] = bars.map((b, i) => {
    const r = ratio[i];
    return r == null ? null : closeLocation(b, i > 0 ? bars[i - 1].close : null) * r;
  });
  const window = Math.max(MIN_SAMPLES, Math.floor(lookback) * 2);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  // The last `window` readings, sorted as they slide: median and MAD are
  // lookups, not a sort of up to 240 values per bar.
  const hist = new RollingSample(window);
  for (let i = 0; i < bars.length; i++) {
    const v = est[i];
    if (v == null) continue;
    if (hist.size >= MIN_SAMPLES) {
      const c = hist.median();
      let s = MAD_TO_SIGMA * hist.sorted.madAbout(c);
      if (!(s > 1e-9)) {
        const xs: number[] = [];
        hist.forEachValue((x) => xs.push(x));
        s = stdev(xs, mean(xs));
      }
      if (s > 1e-9) out[i] = (v - c) / s;
    }
    hist.push(v);
  }
  return out;
}

/** Column readings for every mode except `off` and `profile`. */
export function bbVolumeColumns(bars: BbVolBar[], cfg: BbVolConfig): BbVolColumns {
  const sigma = cfg.sigma;
  const lookback = cfg.lookback;
  const columns: BbVolColumn[] = [];

  const byRatio = cfg.basis === "ratio";

  if (cfg.mode === "delta") {
    // Lower-anchored like every other mode, side carried by `dir` (colour).
    // Growing from the middle band put the columns exactly under the candles.
    if (byRatio) {
      // Raw CLV × RVOL: ±2 = the bar's owner traded twice normal volume.
      const ratio = volumeRatio(bars, { lookback, baseline: "median" });
      for (let i = 0; i < bars.length; i++) {
        const r = ratio[i];
        if (r == null) continue;
        const est = closeLocation(bars[i], i > 0 ? bars[i - 1].close : null) * r;
        columns.push({
          index: i,
          time: bars[i].time,
          frac: clamp01(Math.abs(est) / RVOL_CAP),
          dir: est >= 0 ? 1 : -1,
          tier: Math.abs(est) >= RVOL_ABNORMAL ? "abnormal" : "dim",
        });
      }
      return { threshold: RVOL_ABNORMAL / RVOL_CAP, columns };
    }
    const dz = deltaZ(bars, lookback);
    for (let i = 0; i < bars.length; i++) {
      const z = dz[i];
      if (z == null) continue;
      columns.push({
        index: i,
        time: bars[i].time,
        frac: clamp01(Math.abs(z) / Z_CAP),
        dir: z >= 0 ? 1 : -1,
        tier: Math.abs(z) >= sigma ? "abnormal" : "dim",
      });
    }
    return { threshold: clamp01(sigma / Z_CAP), columns };
  }

  const z = byRatio ? [] : volumeZ(bars, { lookback });
  const ratio =
    byRatio || cfg.mode === "rvol" ? volumeRatio(bars, { lookback, baseline: "median" }) : [];
  const tierAt = (i: number): ColumnTier =>
    byRatio ? ratioTier(ratio[i] ?? null) : zTier(z[i] ?? null, sigma);

  if (cfg.mode === "rvol") {
    for (let i = 0; i < bars.length; i++) {
      const r = ratio[i];
      if (r == null) continue;
      columns.push({
        index: i,
        time: bars[i].time,
        frac: clamp01(r / RVOL_CAP),
        dir: dirOf(bars[i]),
        tier: byRatio
          ? ratioTier(r)
          : r >= RVOL_ABNORMAL
            ? "abnormal"
            : zTier(z[i], Number.POSITIVE_INFINITY),
      });
    }
    return { threshold: RVOL_ABNORMAL / RVOL_CAP, columns };
  }

  if (cfg.mode === "vol") {
    const span = Math.max(MIN_SAMPLES, Math.floor(lookback));
    const window = new RollingSample(span);
    for (let i = 0; i < bars.length; i++) {
      const v = bars[i].volume ?? 0;
      if (!(v > 0)) continue;
      window.push(v);
      const scale = p95(window);
      if (!(scale > 0)) continue;
      columns.push({
        index: i,
        time: bars[i].time,
        frac: clamp01(v / scale),
        dir: dirOf(bars[i]),
        tier: tierAt(i),
      });
    }
    // Raw volume has no fixed σ height — the tier colour carries the reading.
    return { threshold: null, columns };
  }

  // spike / events: height is the reading itself (z, or ×normal on the ratio
  // basis), floored so a dry bar still shows as a stub in its own colour
  // rather than vanishing.
  const events = cfg.mode === "events" ? classifyVolumeEvents(bars, { lookback }) : [];
  const eventAt = new Map(events.map((e) => [e.index, e.type]));
  for (let i = 0; i < bars.length; i++) {
    const reading = byRatio ? ratio[i] : z[i];
    if (reading == null) continue;
    const tier = tierAt(i);
    const event = eventAt.get(i);
    columns.push({
      index: i,
      time: bars[i].time,
      frac: tier === "dryUp" ? 0.04 : clamp01(reading / (byRatio ? RVOL_CAP : Z_CAP)),
      dir: dirOf(bars[i]),
      tier,
      ...(event ? { event } : {}),
    });
  }
  return {
    threshold: byRatio ? RVOL_ABNORMAL / RVOL_CAP : clamp01(sigma / Z_CAP),
    columns,
  };
}

// ── Profiles ────────────────────────────────────────────────────────────────

const DAY = 86_400;

function toSec(t: string | number): number {
  return typeof t === "number" ? t : Math.floor(Date.parse(`${t}T00:00:00Z`) / 1000);
}

/** Median spacing between bars, in seconds. */
export function medianSpacingSec(bars: { time: string | number }[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) gaps.push(toSec(bars[i].time) - toSec(bars[i - 1].time));
  return gaps.length ? median(gaps) : DAY;
}

/**
 * `auto` by timeframe: sub-hour → session, hourly → week, daily → month,
 * weekly and slower → quarter. Each keeps a block at ≥ ~15 bars.
 */
export function resolveVpPeriod(
  period: VpPeriod,
  bars: { time: string | number }[]
): ResolvedVpPeriod {
  if (period !== "auto") return period;
  const spacing = medianSpacingSec(bars);
  if (typeof bars[0]?.time === "number" && spacing < 3600) return "session";
  if (spacing < DAY / 2) return "week";
  if (spacing < 4 * DAY) return "month";
  return "quarter";
}

/** Calendar key of a bar in UTC. Weeks start Monday. */
function calendarKey(sec: number, period: "week" | "month" | "quarter"): string {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (period === "month") return `${y}-${m}`;
  if (period === "quarter") return `${y}-Q${Math.floor(m / 3)}`;
  const dow = (d.getUTCDay() + 6) % 7;
  return String(Math.floor(sec / DAY) - dow);
}

/** [start, end] index pairs (inclusive) of consecutive bars in the same block. */
export function periodBlocks(
  bars: { time: string | number }[],
  period: ResolvedVpPeriod,
  everyBars = 21
): [number, number][] {
  const blocks: [number, number][] = [];
  if (bars.length === 0) return blocks;
  let start = 0;
  let prevKey: string | null = null;
  const n = Math.max(1, Math.floor(everyBars));
  for (let i = 0; i < bars.length; i++) {
    const sec = toSec(bars[i].time);
    let key: string;
    if (period === "bars") key = String(Math.floor(i / n));
    else if (period === "session") {
      // Daily bars have no session inside them: every bar is its own session.
      const newSession =
        typeof bars[i].time !== "number" ||
        i === 0 ||
        sec - toSec(bars[i - 1].time) > SESSION_GAP_SEC;
      key = newSession ? `s${i}` : (prevKey as string);
    } else key = calendarKey(sec, period);
    if (prevKey !== null && key !== prevKey) {
      blocks.push([start, i - 1]);
      start = i;
    }
    prevKey = key;
  }
  blocks.push([start, bars.length - 1]);
  return blocks;
}

export interface ProfileBucket {
  low: number;
  high: number;
  volume: number;
  /** volume ≥ mean + σ·sd of the block's non-empty buckets. */
  hvn: boolean;
}

export interface BlockProfile {
  start: number;
  end: number;
  partial: boolean;
  buckets: ProfileBucket[];
  maxVolume: number;
  poc: number;
  vah: number;
  val: number;
  /** No later bar's range has traded through the POC. */
  naked: boolean;
}

function profileOf(
  bars: BbVolBar[],
  start: number,
  end: number,
  sigma: number
): BlockProfile | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = start; i <= end; i++) {
    if (!((bars[i].volume ?? 0) > 0)) continue;
    lo = Math.min(lo, bars[i].low);
    hi = Math.max(hi, bars[i].high);
    total += bars[i].volume as number;
  }
  if (!(total > 0) || !Number.isFinite(lo)) return null;
  const size = (hi - lo) / PROFILE_BUCKETS || 1;
  const buckets: ProfileBucket[] = Array.from({ length: PROFILE_BUCKETS }, (_, k) => ({
    low: lo + k * size,
    high: lo + (k + 1) * size,
    volume: 0,
    hvn: false,
  }));

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    const vol = b.volume ?? 0;
    if (!(vol > 0)) continue;
    const range = b.high - b.low;
    if (range > 0) {
      for (const k of buckets) {
        const overlap = Math.min(b.high, k.high) - Math.max(b.low, k.low);
        if (overlap <= 0) continue;
        k.volume += vol * (overlap / range);
      }
    } else {
      const k =
        buckets[Math.min(PROFILE_BUCKETS - 1, Math.max(0, Math.floor((b.close - lo) / size)))];
      k.volume += vol;
    }
  }

  let pocIdx = 0;
  for (let k = 1; k < buckets.length; k++)
    if (buckets[k].volume > buckets[pocIdx].volume) pocIdx = k;

  const filled = buckets.map((k) => k.volume).filter((v) => v > 0);
  const m = mean(filled);
  const sd = filled.length > 1 ? stdev(filled, m) : 0;
  if (sd > 0) for (const k of buckets) k.hvn = k.volume >= m + sigma * sd;

  // Value area: grow from the POC toward the heavier neighbour until 70%.
  let vaLo = pocIdx;
  let vaHi = pocIdx;
  let acc = buckets[pocIdx].volume;
  while (acc < total * VALUE_AREA_PCT && (vaLo > 0 || vaHi < buckets.length - 1)) {
    const below = vaLo > 0 ? buckets[vaLo - 1].volume : -1;
    const above = vaHi < buckets.length - 1 ? buckets[vaHi + 1].volume : -1;
    if (above >= below) acc += buckets[++vaHi].volume;
    else acc += buckets[--vaLo].volume;
  }

  const poc = (buckets[pocIdx].low + buckets[pocIdx].high) / 2;
  let naked = true;
  for (let i = end + 1; i < bars.length && naked; i++) {
    if (bars[i].low <= poc && bars[i].high >= poc) naked = false;
  }

  return {
    start,
    end,
    partial: end - start + 1 < MIN_PROFILE_BARS,
    buckets,
    maxVolume: buckets[pocIdx].volume,
    poc,
    vah: buckets[vaHi].high,
    val: buckets[vaLo].low,
    naked,
  };
}

/** One volume profile per block. HVN threshold is `sigma` over bucket volumes. */
export function blockProfiles(
  bars: BbVolBar[],
  period: VpPeriod,
  sigma: number,
  everyBars = 21
): BlockProfile[] {
  if (bars.length === 0) return [];
  const blocks = periodBlocks(bars, resolveVpPeriod(period, bars), everyBars);
  const out: BlockProfile[] = [];
  for (const [s, e] of blocks) {
    const p = profileOf(bars, s, e, sigma);
    if (p) out.push(p);
  }
  return out;
}
