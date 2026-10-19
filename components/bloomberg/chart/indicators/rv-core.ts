/**
 * Realized-volatility core math — shared by the RV pane indicators
 * (realized-vol.ts, rv-rank.ts, rv-ratio.ts).
 *
 * Everything here returns ANNUALISED volatility in percent, because that is the
 * only form comparable with an option's implied vol or with another symbol's
 * RV. A raw per-bar sigma of 0.9% means nothing until you know whether the bar
 * is 5 minutes or a week.
 *
 * Five estimators, in rising order of how much of the bar they use:
 *
 *   cc         close-to-close. Zero-mean sum of squared log returns — the
 *              textbook realized variance. Only estimator that reacts to
 *              overnight gaps *and* nothing else; noisiest of the five.
 *   parkinson  high-low range. ~5x more efficient than cc for the same window,
 *              but blind to gaps (it never looks at the previous close) and
 *              biased low when the true path jumps between bars.
 *   gk         Garman-Klass. Range + open-close body. More efficient again,
 *              still gap-blind, and biased low on trending markets.
 *   rs         Rogers-Satchell. Drift-independent — the only single-bar
 *              estimator that stays unbiased when the symbol has a strong
 *              trend, which is why it is the right default for equities.
 *   yz         Yang-Zhang. Overnight variance + open-to-close variance + RS
 *              cross term. Handles both drift and gaps; the most accurate for
 *              daily equity bars, and the one to use when RV is compared to IV.
 *
 * Annualisation factor comes from the bar spacing actually present in the data
 * (see `inferPeriodsPerYear`), so the same indicator config reads sensibly on a
 * 5m chart and a daily one.
 */

import { type BarColumns, barColumns } from "../columns.ts";
import { SortedWindow, rollingMean, rollingVariance } from "../rolling.ts";
import type { OhlcvBar } from "../types";

export type RvEstimator = "cc" | "parkinson" | "gk" | "rs" | "yz";

export const RV_ESTIMATOR_OPTIONS = [
  { value: "cc", label: "Close-to-Close" },
  { value: "parkinson", label: "Parkinson (HL)" },
  { value: "gk", label: "Garman-Klass" },
  { value: "rs", label: "Rogers-Satchell" },
  { value: "yz", label: "Yang-Zhang" },
] as const;

export const RV_ESTIMATOR_SHORT: Record<RvEstimator, string> = {
  cc: "CC",
  parkinson: "PK",
  gk: "GK",
  rs: "RS",
  yz: "YZ",
};

const TRADING_DAYS = 252;
/** Minutes in a US regular session — the yardstick for intraday annualisation. */
const SESSION_MINUTES = 390;

function toSeconds(t: string | number): number {
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? Number.NaN : ms / 1000;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b); // perf-ok: once per compute, ≤200 bar gaps
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How many bars of this data make a year.
 *
 * Derived from the MEDIAN gap between bars, not the first gap: weekends,
 * holidays and the overnight break all produce outlier spacings that would
 * wreck a single-sample estimate.
 *
 * Daily and slower bars are counted in sessions (252/yr). Intraday bars are
 * counted against a 390-minute regular session — a 24h symbol (crypto) really
 * has ~3.7x more bars per day than that, so its annualised RV reads low by
 * ~sqrt(3.7). Detecting that reliably needs the symbol, which an indicator's
 * `compute` never sees; treat intraday crypto RV as relative rather than
 * absolute.
 */
export function inferPeriodsPerYear(data: OhlcvBar[]): number {
  return periodsPerYear(barColumns(data));
}

const ppyCache = new WeakMap<BarColumns, number>();

/** `inferPeriodsPerYear` on the shared column view — once per bar array, however many RV panes read it. */
export function periodsPerYear(bars: BarColumns): number {
  const hit = ppyCache.get(bars);
  if (hit !== undefined) return hit;
  const { times } = bars;
  const gaps: number[] = [];
  let prev = times.length > 0 ? toSeconds(times[0]) : Number.NaN;
  for (let i = 1; i < times.length && gaps.length < 200; i++) {
    const t = toSeconds(times[i]);
    const dt = t - prev;
    prev = t;
    if (Number.isFinite(dt) && dt > 0) gaps.push(dt);
  }
  const ppy = fromMedianGap(median(gaps));
  ppyCache.set(bars, ppy);
  return ppy;
}

function fromMedianGap(dt: number): number {
  if (!Number.isFinite(dt)) return TRADING_DAYS;

  const day = 86_400;
  if (dt >= 20 * day) return 12; // monthly
  if (dt >= 5 * day) return 52; // weekly
  if (dt >= 0.9 * day) return TRADING_DAYS; // daily (incl. weekend-stretched medians)
  const barsPerSession = SESSION_MINUTES / (dt / 60);
  return TRADING_DAYS * barsPerSession;
}

// ── Per-bar variance contributions ───────────────────────────────────────────
//
// Each estimator is expressed as a per-bar quantity so a rolling window is a
// plain moving average of it. Index i is aligned to the bars; entries that need
// a previous bar are NaN at i = 0. Every term is NaN where it is not finite.

const ln = Math.log;

function ccTerms(bars: BarColumns): Float64Array {
  const { close } = bars;
  const out = new Float64Array(bars.length).fill(Number.NaN);
  for (let i = 1; i < out.length; i++) {
    const r = ln(close[i] / close[i - 1]);
    if (Number.isFinite(r)) out[i] = r * r;
  }
  return out;
}

function parkinsonTerms(bars: BarColumns): Float64Array {
  const { high, low } = bars;
  const k = 1 / (4 * Math.LN2);
  const out = new Float64Array(bars.length);
  for (let i = 0; i < out.length; i++) {
    const hl = ln(high[i] / low[i]);
    out[i] = Number.isFinite(hl) ? k * hl * hl : Number.NaN;
  }
  return out;
}

function gkTerms(bars: BarColumns): Float64Array {
  const { open, high, low, close } = bars;
  const c2 = 2 * Math.LN2 - 1;
  const out = new Float64Array(bars.length);
  for (let i = 0; i < out.length; i++) {
    const hl = ln(high[i] / low[i]);
    const co = ln(close[i] / open[i]);
    const v = 0.5 * hl * hl - c2 * co * co;
    out[i] = Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
}

function rsTerms(bars: BarColumns): Float64Array {
  const { open, high, low, close } = bars;
  const out = new Float64Array(bars.length);
  for (let i = 0; i < out.length; i++) {
    const hc = ln(high[i] / close[i]);
    const ho = ln(high[i] / open[i]);
    const lc = ln(low[i] / close[i]);
    const lo = ln(low[i] / open[i]);
    const v = hc * ho + lc * lo;
    out[i] = Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
}

/** Overnight log return, ln(open_t / close_{t-1}). NaN at i = 0. */
function overnightTerms(bars: BarColumns): Float64Array {
  const { open, close } = bars;
  const out = new Float64Array(bars.length).fill(Number.NaN);
  for (let i = 1; i < out.length; i++) {
    const r = ln(open[i] / close[i - 1]);
    if (Number.isFinite(r)) out[i] = r;
  }
  return out;
}

/** Open-to-close log return, ln(close_t / open_t). */
function openCloseTerms(bars: BarColumns): Float64Array {
  const { open, close } = bars;
  const out = new Float64Array(bars.length);
  for (let i = 0; i < out.length; i++) {
    const r = ln(close[i] / open[i]);
    out[i] = Number.isFinite(r) ? r : Number.NaN;
  }
  return out;
}

interface RvTerms {
  /** cc / parkinson / gk / rs: the per-bar variance. yz: Rogers-Satchell. */
  main: Float64Array;
  /** yz only. */
  overnight?: Float64Array;
  openClose?: Float64Array;
}

/**
 * The terms depend on the bars and the estimator, not on the window — an RV
 * pane draws three windows from them, and RV rank / ratio on the same chart
 * read them again. One set per bar array.
 */
const termsCache = new WeakMap<BarColumns, Map<RvEstimator, RvTerms>>();

function rvTerms(bars: BarColumns, estimator: RvEstimator): RvTerms {
  let byEstimator = termsCache.get(bars);
  if (!byEstimator) {
    byEstimator = new Map();
    termsCache.set(bars, byEstimator);
  }
  let terms = byEstimator.get(estimator);
  if (!terms) {
    terms =
      estimator === "yz"
        ? { main: rsTerms(bars), overnight: overnightTerms(bars), openClose: openCloseTerms(bars) }
        : {
            main:
              estimator === "cc"
                ? ccTerms(bars)
                : estimator === "parkinson"
                  ? parkinsonTerms(bars)
                  : estimator === "gk"
                    ? gkTerms(bars)
                    : rsTerms(bars),
          };
    byEstimator.set(estimator, terms);
  }
  return terms;
}

/**
 * Rolling annualised realized volatility, in PERCENT, one slot per bar. NaN
 * during warm-up or wherever a bar's inputs are unusable.
 *
 * Yang-Zhang needs three windowed variances rather than one moving average,
 * so it takes its own branch; the other four are a moving average of their
 * per-bar variance contribution.
 */
export function realizedVol(
  bars: BarColumns,
  period: number,
  estimator: RvEstimator,
  periodsPerYear: number
): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(Number.NaN);
  if (period < 2 || n === 0) return out;
  const ann = Math.sqrt(periodsPerYear) * 100;
  const terms = rvTerms(bars, estimator);

  if (terms.overnight && terms.openClose) {
    // k minimises the variance of the combined estimator (Yang & Zhang 2000).
    const k = 0.34 / (1.34 + (period + 1) / (period - 1));
    const varOn = rollingVariance(terms.overnight, period, 1).variance;
    const varOc = rollingVariance(terms.openClose, period, 1).variance;
    const meanRs = rollingMean(terms.main, period);
    for (let i = 0; i < n; i++) {
      const vOn = varOn[i];
      const vOc = varOc[i];
      const vRs = meanRs[i];
      if (!Number.isFinite(vOn) || !Number.isFinite(vOc) || !Number.isFinite(vRs)) continue;
      const variance = vOn + k * vOc + (1 - k) * vRs;
      if (!(variance > 0)) continue; // RS can go slightly negative on flat bars
      out[i] = Math.sqrt(variance) * ann;
    }
    return out;
  }

  const meanTerms = rollingMean(terms.main, period);
  for (let i = 0; i < n; i++) {
    const variance = meanTerms[i];
    if (!Number.isFinite(variance) || !(variance > 0)) continue;
    out[i] = Math.sqrt(variance) * ann;
  }
  return out;
}

/** NaN → null: the boxed form of a column whose values are never NaN themselves. */
function nullable(values: Float64Array): (number | null)[] {
  const out: (number | null)[] = new Array(values.length);
  for (let i = 0; i < out.length; i++) out[i] = Number.isNaN(values[i]) ? null : values[i];
  return out;
}

/**
 * `realizedVol` of a bar array, boxed: null during warm-up or wherever a
 * bar's inputs are unusable.
 */
export function calcRealizedVol(
  data: OhlcvBar[],
  period: number,
  estimator: RvEstimator,
  periodsPerYear: number
): (number | null)[] {
  return nullable(realizedVol(barColumns(data), period, estimator, periodsPerYear));
}

/**
 * Percentile rank (0–100) of each value within the trailing `lookback` window,
 * counting how many past observations it exceeds. Null until `minObs` prior
 * values exist — a rank over five samples is noise dressed as a percentile.
 */
export function rollingPercentRank(
  values: (number | null)[],
  lookback: number,
  minObs: number
): (number | null)[] {
  const typed = new Float64Array(values.length);
  for (let i = 0; i < typed.length; i++) typed[i] = values[i] ?? Number.NaN;
  return nullable(percentRank(typed, lookback, minObs));
}

/** `rollingPercentRank` on a column: NaN in for "no value", NaN out for "no rank". */
export function percentRank(
  values: ArrayLike<number>,
  lookback: number,
  minObs: number
): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (lookback < 1) return out;
  // Sorted copy of the window for the rank, plus insertion order (a ring) to
  // know which value leaves — O(log k) search + one memmove per bar instead
  // of a linear count and an O(k) `shift()`.
  const sorted = new SortedWindow(lookback);
  const ring = new Float64Array(lookback);
  let ringStart = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const size = sorted.size;
    if (size >= minObs) out[i] = (sorted.countBelow(v) / size) * 100;
    if (size === lookback) {
      sorted.remove(ring[ringStart]);
      ring[ringStart] = v;
      ringStart = (ringStart + 1) % lookback;
    } else {
      ring[(ringStart + size) % lookback] = v;
    }
    sorted.insert(v);
  }
  return out;
}
