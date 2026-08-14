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
  const s = [...xs].sort((a, b) => a - b);
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
  const gaps: number[] = [];
  for (let i = 1; i < data.length && gaps.length < 200; i++) {
    const dt = toSeconds(data[i].time) - toSeconds(data[i - 1].time);
    if (Number.isFinite(dt) && dt > 0) gaps.push(dt);
  }
  const dt = median(gaps);
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
// plain moving average of it. Index i is aligned to data[i]; entries that need
// a previous bar are NaN at i = 0.

const ln = Math.log;

function ccTerms(data: OhlcvBar[]): number[] {
  const out = new Array<number>(data.length).fill(Number.NaN);
  for (let i = 1; i < data.length; i++) {
    const r = ln(data[i].close / data[i - 1].close);
    if (Number.isFinite(r)) out[i] = r * r;
  }
  return out;
}

function parkinsonTerms(data: OhlcvBar[]): number[] {
  const k = 1 / (4 * Math.LN2);
  return data.map((b) => {
    const hl = ln(b.high / b.low);
    return Number.isFinite(hl) ? k * hl * hl : Number.NaN;
  });
}

function gkTerms(data: OhlcvBar[]): number[] {
  const c2 = 2 * Math.LN2 - 1;
  return data.map((b) => {
    const hl = ln(b.high / b.low);
    const co = ln(b.close / b.open);
    const v = 0.5 * hl * hl - c2 * co * co;
    return Number.isFinite(v) ? v : Number.NaN;
  });
}

function rsTerms(data: OhlcvBar[]): number[] {
  return data.map((b) => {
    const hc = ln(b.high / b.close);
    const ho = ln(b.high / b.open);
    const lc = ln(b.low / b.close);
    const lo = ln(b.low / b.open);
    const v = hc * ho + lc * lo;
    return Number.isFinite(v) ? v : Number.NaN;
  });
}

/** Overnight log return, ln(open_t / close_{t-1}). NaN at i = 0. */
function overnightTerms(data: OhlcvBar[]): number[] {
  const out = new Array<number>(data.length).fill(Number.NaN);
  for (let i = 1; i < data.length; i++) {
    const r = ln(data[i].open / data[i - 1].close);
    if (Number.isFinite(r)) out[i] = r;
  }
  return out;
}

/** Open-to-close log return, ln(close_t / open_t). */
function openCloseTerms(data: OhlcvBar[]): number[] {
  return data.map((b) => {
    const r = ln(b.close / b.open);
    return Number.isFinite(r) ? r : Number.NaN;
  });
}

/** Sample variance about the window mean, over exactly `period` values ending at i. */
function rollingSampleVar(values: number[], period: number, i: number): number {
  if (period < 2 || i < period - 1) return Number.NaN;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const v = values[j];
    if (!Number.isFinite(v)) return Number.NaN;
    sum += v;
  }
  const mean = sum / period;
  let ss = 0;
  for (let j = i - period + 1; j <= i; j++) ss += (values[j] - mean) ** 2;
  return ss / (period - 1);
}

/** Plain mean over exactly `period` values ending at i (any NaN ⇒ NaN). */
function rollingMean(values: number[], period: number, i: number): number {
  if (period < 1 || i < period - 1) return Number.NaN;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const v = values[j];
    if (!Number.isFinite(v)) return Number.NaN;
    sum += v;
  }
  return sum / period;
}

/**
 * Rolling annualised realized volatility, in PERCENT, aligned to `data`.
 * Null during warm-up or wherever a bar's inputs are unusable.
 *
 * Yang-Zhang needs three windowed variances rather than one moving average,
 * so it takes its own branch; the other four are a moving average of their
 * per-bar variance contribution.
 */
export function calcRealizedVol(
  data: OhlcvBar[],
  period: number,
  estimator: RvEstimator,
  periodsPerYear: number
): (number | null)[] {
  const n = data.length;
  const out = new Array<number | null>(n).fill(null);
  if (period < 2 || n === 0) return out;
  const ann = Math.sqrt(periodsPerYear) * 100;

  if (estimator === "yz") {
    const on = overnightTerms(data);
    const oc = openCloseTerms(data);
    const rs = rsTerms(data);
    // k minimises the variance of the combined estimator (Yang & Zhang 2000).
    const k = 0.34 / (1.34 + (period + 1) / (period - 1));
    for (let i = 0; i < n; i++) {
      const vOn = rollingSampleVar(on, period, i);
      const vOc = rollingSampleVar(oc, period, i);
      const vRs = rollingMean(rs, period, i);
      if (!Number.isFinite(vOn) || !Number.isFinite(vOc) || !Number.isFinite(vRs)) continue;
      const variance = vOn + k * vOc + (1 - k) * vRs;
      if (!(variance > 0)) continue; // RS can go slightly negative on flat bars
      out[i] = Math.sqrt(variance) * ann;
    }
    return out;
  }

  const terms =
    estimator === "cc"
      ? ccTerms(data)
      : estimator === "parkinson"
        ? parkinsonTerms(data)
        : estimator === "gk"
          ? gkTerms(data)
          : rsTerms(data);

  for (let i = 0; i < n; i++) {
    const variance = rollingMean(terms, period, i);
    if (!Number.isFinite(variance) || !(variance > 0)) continue;
    out[i] = Math.sqrt(variance) * ann;
  }
  return out;
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
  const out = new Array<number | null>(values.length).fill(null);
  const window: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (window.length >= minObs) {
      let below = 0;
      for (const w of window) if (w < v) below++;
      out[i] = (below / window.length) * 100;
    }
    window.push(v);
    if (window.length > lookback) window.shift();
  }
  return out;
}
