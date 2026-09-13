/**
 * volume-stats.ts — turning raw volume into a number that means something.
 *
 * Raw volume is a level in a unit with no reference scale: its distribution is
 * log-normal, it trends, and intraday it is U-shaped. On a chart the eye can
 * only read "tall vs short relative to what is on screen", so the same bar
 * changes meaning when the zoom changes. Both functions here answer the one
 * question that survives a zoom: *is this participation abnormal for this bar,
 * for this symbol?*
 *
 * ── Why median/MAD on ln(V), not mean/σ on V ────────────────────────────────
 *
 *   ln   — volume is log-normal, so ln(V) is roughly normal and a z-score on it
 *          is interpretable. On raw V the skew puts every spike at z ≈ 4-8 and
 *          the number stops discriminating.
 *   med  — the median has a 50% breakdown point, the mean has 0%. With a mean
 *          baseline one earnings spike raises the baseline for the whole
 *          lookback, so the NEXT spike reads as ordinary: significant events
 *          get hidden by significant events. This is the flaw that made the
 *          volume pane feel uninformative.
 *   MAD  — ×1.4826 makes it a consistent estimator of σ under normality, so the
 *          z it produces is comparable with an ordinary z-score.
 *
 * A z-score also travels across symbols, which a ratio does not: "RVOL 2" on a
 * mega-cap and on an illiquid small cap are different events, because the two
 * have different volume variance. z = 2.5 is the same statement about both.
 *
 * ── Intraday baselines: slot, not window ────────────────────────────────────
 *
 * A rolling window over intraday bars flags every open as abnormal. The
 * baseline for 10:05 must be other 10:05s, so bars are slotted:
 *
 *   multi-session data → slot = bar index since the session's first bar.
 *     Timezone- and DST-proof (a US session is 13:30 UTC in summer and 14:30 in
 *     winter — keying on UTC time-of-day silently empties every slot for a
 *     whole lookback after each DST change), and an early close still aligns
 *     from the open.
 *   single-session data → slot = UTC time-of-day. This is the 24h case (crypto),
 *     where there is no session gap to split on and no DST to break the key.
 *
 * Sessions are split on a >4h gap, the same rule and constant the VWAP
 * indicator resets on (chart/indicators/vwap.ts).
 *
 * ── mode: "bar" vs "cum" ────────────────────────────────────────────────────
 *
 * "bar" compares one bar's volume against the same slot in prior sessions.
 * "cum" compares the session's volume SO FAR against how much had traded by
 * the same slot in prior sessions. The live last bar of an open session is
 * always partial, so in "bar" mode it reads as quiet right up until it closes
 * — the trap routers/watchlist_signals.py documents at its `rvol` return. In
 * "cum" mode a partial bar is compared against a partial baseline, so the
 * reading is honest while the session is still running.
 *
 * Daily and weekly bars have no slots and no intraday partiality, so they use a
 * trailing window and ignore `mode`.
 */

/** The fields these functions read. Structurally a subset of OhlcvBar. */
export interface VolumeBar {
  /** "YYYY-MM-DD" for daily/weekly; UNIX seconds for intraday. */
  time: string | number;
  volume?: number;
}

export type VolBaseline = "median" | "mean";
export type VolMode = "bar" | "cum";

export interface VolStatsOpts {
  /** Prior bars (daily) or prior sessions (intraday) the baseline is built from. */
  lookback: number;
  /** Baseline statistic for `volumeRatio`. Ignored by `volumeZ`, which is always robust. */
  baseline?: VolBaseline;
  /** Intraday only: compare the bar, or the session's cumulative volume so far. */
  mode?: VolMode;
}

/** Gap that separates two sessions. Same value as vwap.ts's SESSION_GAP_SEC. */
export const SESSION_GAP_SEC = 4 * 60 * 60;

/**
 * Prior observations required before a reading is emitted.
 *
 * 8 rather than the 3 the old intraday path accepted: a median (let alone a
 * MAD) over 3 points is noise wearing a statistic's clothes. The cost is that
 * the first ~8 sessions of an intraday chart read null, which is honest.
 */
export const MIN_SAMPLES = 8;

/** MAD → σ under normality. */
const MAD_TO_SIGMA = 1.4826;

/**
 * Smallest dispersion (in log-volume units) that counts as a scale.
 *
 * Not merely a guard against dividing by zero: when the history is one repeated
 * value, floating-point error leaves σ at ~1e-16 rather than exactly 0, and
 * dividing by that turns a one-share difference into a z of 1e15. 1e-6 in ln
 * space is a volume spread of 0.0001% — below it there is no scale to measure
 * against and the honest reading is none.
 */
const MIN_SIGMA = 1e-6;

// ── Robust statistics ────────────────────────────────────────────────────────

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function madSigma(values: number[], center?: number): number {
  if (values.length === 0) return Number.NaN;
  const c = center ?? median(values);
  return MAD_TO_SIGMA * median(values.map((v) => Math.abs(v - c)));
}

/** Sample standard deviation. Used only as the fallback when MAD collapses to 0. */
export function stdev(values: number[], center?: number): number {
  if (values.length < 2) return Number.NaN;
  const c = center ?? mean(values);
  const ss = values.reduce((s, v) => s + (v - c) * (v - c), 0);
  return Math.sqrt(ss / (values.length - 1));
}

// ── Slotting ─────────────────────────────────────────────────────────────────

export function isIntraday(bars: VolumeBar[]): boolean {
  return bars.length > 0 && typeof bars[0].time === "number";
}

/**
 * Per-bar slot key, and the per-bar observation each slot's history is built
 * from. Returns null for a bar with no usable volume — a symbol that quotes a
 * level with nothing trading behind it (VIX, a yield, an FX cross) has volume 0
 * on every bar and must produce no reading at all rather than a fabricated one.
 */
interface Slotted {
  /** Slot key per bar, or -1 for the trailing-window (daily) case. */
  slot: number[];
  /** Observation per bar: the bar's volume, or the session's cumulative volume. */
  obs: (number | null)[];
}

function slotBars(bars: VolumeBar[], mode: VolMode): Slotted {
  const slot: number[] = new Array(bars.length).fill(-1);
  const obs: (number | null)[] = new Array(bars.length).fill(null);

  if (!isIntraday(bars)) {
    for (let i = 0; i < bars.length; i++) {
      const v = bars[i].volume ?? 0;
      obs[i] = v > 0 ? v : null;
    }
    return { slot, obs };
  }

  // Session boundaries first: whether slots are session-relative depends on
  // there being more than one session in the loaded range.
  const sessionStart: boolean[] = new Array(bars.length).fill(false);
  let sessions = 0;
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].time as number;
    const prev = i > 0 ? (bars[i - 1].time as number) : null;
    if (prev === null || t - prev > SESSION_GAP_SEC) {
      sessionStart[i] = true;
      sessions++;
    }
  }
  const bySessionIndex = sessions > 1;

  let indexInSession = 0;
  let cum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (sessionStart[i]) {
      indexInSession = 0;
      cum = 0;
    }
    slot[i] = bySessionIndex ? indexInSession : (bars[i].time as number) % 86_400;
    const v = bars[i].volume ?? 0;
    if (v > 0) cum += v;
    if (mode === "cum") {
      // A slot with no trade at all carries the session's running total from the
      // previous bar, which is the honest answer to "how much has traded by
      // now" — unlike bar mode, where a zero-volume bar has nothing to say.
      obs[i] = cum > 0 ? cum : null;
    } else {
      obs[i] = v > 0 ? v : null;
    }
    indexInSession++;
  }

  return { slot, obs };
}

/**
 * For each bar, the prior comparable observations its baseline is built from —
 * most recent last, capped at `lookback`.
 *
 * Daily: the prior `lookback` bars. Intraday: the same slot in prior sessions.
 * The current bar is never included, so a spike can never dilute its own
 * baseline (the reason watchlist_signals.py shifts by one).
 */
function priorObservations(bars: VolumeBar[], opts: VolStatsOpts): (number[] | null)[] {
  const mode: VolMode = isIntraday(bars) ? (opts.mode ?? "bar") : "bar";
  const { slot, obs } = slotBars(bars, mode);
  const lookback = Math.max(1, Math.floor(opts.lookback));
  const out: (number[] | null)[] = new Array(bars.length).fill(null);

  if (!isIntraday(bars)) {
    for (let i = 0; i < bars.length; i++) {
      if (obs[i] == null) continue;
      const hist: number[] = [];
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        const v = obs[j];
        if (v != null) hist.push(v);
      }
      out[i] = hist;
    }
    return out;
  }

  const history = new Map<number, number[]>();
  for (let i = 0; i < bars.length; i++) {
    const key = slot[i];
    const v = obs[i];
    if (v == null) continue;
    const hist = history.get(key);
    out[i] = hist ? hist.slice(-lookback) : [];
    if (hist) hist.push(v);
    else history.set(key, [v]);
  }
  return out;
}

// ── Public readings ──────────────────────────────────────────────────────────

/**
 * Robust log-volume z-score: how many σ this bar's participation sits above the
 * typical bar of its kind. Comparable across symbols and timeframes.
 *
 * Rough reading: |z| < 1 ordinary · 1.5 notable · 2 abnormal · 3 an event.
 */
export function volumeZ(bars: VolumeBar[], opts: VolStatsOpts): (number | null)[] {
  const mode: VolMode = isIntraday(bars) ? (opts.mode ?? "bar") : "bar";
  const { obs } = slotBars(bars, mode);
  const priors = priorObservations(bars, opts);
  const out: (number | null)[] = new Array(bars.length).fill(null);

  for (let i = 0; i < bars.length; i++) {
    const v = obs[i];
    const hist = priors[i];
    if (v == null || hist == null || hist.length < MIN_SAMPLES) continue;

    const logs = hist.map((h) => Math.log(h));
    const center = median(logs);
    let sigma = madSigma(logs, center);
    // MAD collapses to 0 when more than half the history is one repeated value
    // — routine in an illiquid name whose volume prints in round lots. σ still
    // has something to say there; when it does not, there is genuinely no scale
    // and the honest output is null rather than ±Infinity.
    if (!(sigma >= MIN_SIGMA)) sigma = stdev(logs, mean(logs));
    if (!(sigma >= MIN_SIGMA)) continue;

    out[i] = (Math.log(v) - center) / sigma;
  }
  return out;
}

/**
 * Classic relative volume: this bar's volume over a baseline of comparable
 * prior bars. Keeps the familiar unit ("2× normal") — the `baseline` choice is
 * what makes it trustworthy.
 */
export function volumeRatio(bars: VolumeBar[], opts: VolStatsOpts): (number | null)[] {
  const mode: VolMode = isIntraday(bars) ? (opts.mode ?? "bar") : "bar";
  const { obs } = slotBars(bars, mode);
  const priors = priorObservations(bars, opts);
  const stat = opts.baseline === "mean" ? mean : median;
  const out: (number | null)[] = new Array(bars.length).fill(null);

  for (let i = 0; i < bars.length; i++) {
    const v = obs[i];
    const hist = priors[i];
    if (v == null || hist == null || hist.length < MIN_SAMPLES) continue;
    const base = stat(hist);
    if (!(base > 0)) continue;
    out[i] = v / base;
  }
  return out;
}
