/**
 * volume-events.ts — volume as countable events instead of a continuous series.
 *
 * A pane of 250 grey bars is unreadable however well it is normalized: reading
 * it means holding a baseline in your head and comparing bar by bar. What makes
 * volume legible is collapsing it into a handful of *named* events per year,
 * each one a joint statement about participation AND result — because volume
 * alone has no direction and no outcome attached to it.
 *
 * Every rule below is a threshold on three things:
 *
 *   z         robust log-volume z-score (lib/volume-stats.ts) — participation
 *   retSigma  the bar's log return in units of its own trailing return σ — result
 *   range/closePos  how much of the move survived to the close — who won the bar
 *
 * ── The taxonomy ────────────────────────────────────────────────────────────
 *
 *   climax      heavy volume, big move, closing at an extreme. The classic
 *               exhaustion signature — and also the signature of a genuine
 *               breakaway move, which is exactly why this module refuses to
 *               call it either way (see "no forecasts" below).
 *   absorption  heavy volume, compressed range, close in the reversing half:
 *               one side committed and was absorbed by resting orders. The
 *               bar-level trace of hidden accumulation/distribution.
 *   vacuum      a big move on BELOW-normal volume — price travelled because
 *               there was nothing in the way, not because anyone insisted.
 *   breakout    price closes beyond the prior N-bar range WITH participation:
 *               the thing that separates a real break from a drift through.
 *   noDemand    heavy volume, compressed range, and the close went nowhere —
 *               churn. Distinguished from absorption by result: absorption
 *               closes against the move, noDemand closes nowhere at all.
 *   dryUp       a RUN of below-normal volume. The only multi-bar event here,
 *               because one quiet bar is not a fact about anything. This is the
 *               state a volatility expansion tends to come out of.
 *
 * ── No forecasts ────────────────────────────────────────────────────────────
 *
 * `dir` is never a prediction. It says which side owned the bar — for most
 * types the sign of the bar's own return, and for absorption which side held
 * the close. Whether any of these labels precedes anything is a question for
 * the forward-return columns (`forwardReturnPct`) measured against an
 * unconditional baseline, not for a colour on a chip. A label that does not
 * separate from the baseline should be deleted, not stared at.
 *
 * ── Where the label sits matters ────────────────────────────────────────────
 *
 * Churn in the middle of nowhere is usually noise. An absorption at a VWAP
 * band, a naked POC or the prior day's high is a different event from the same
 * bar shape mid-range. This module deliberately does NOT gate on location: it
 * has no access to those levels, and quietly dropping events would hide them.
 * The reader (and any study built on this) should combine the two.
 */

import { MIN_SAMPLES, type VolMode, median, stdev, volumeZ } from "./volume-stats.ts";

/** The fields the classifier reads. Structurally a subset of OhlcvBar. */
export interface EventBar {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type VolumeEventType =
  | "climax"
  | "absorption"
  | "vacuum"
  | "breakout"
  | "noDemand"
  | "dryUp";

export interface VolumeEvent {
  /** Bar index in the array that was classified. */
  index: number;
  time: string | number;
  type: VolumeEventType;
  /**
   * Which side owned the bar — NOT a forecast.
   * climax/vacuum/breakout: the sign of the bar's return.
   * absorption: +1 when the close held the upper half (selling was absorbed).
   * noDemand/dryUp: 0, because nothing was decided.
   */
  dir: 1 | -1 | 0;
  /** Robust log-volume z-score of the bar. */
  z: number;
  /** The bar's log return in units of its trailing return σ. */
  retSigma: number;
  /** The bar's return, in %. */
  retPct: number;
  /** Close position inside the bar: 0 at the low, 1 at the high. */
  closePos: number;
  close: number;
  /** Bars in the run, for `dryUp` only. */
  runLength?: number;
}

export interface VolumeEventConfig {
  /** Baseline window for z, return σ and median range. Sessions when intraday. */
  lookback?: number;
  /** Intraday z mode — see lib/volume-stats.ts. */
  mode?: VolMode;
  /** Prior bars whose high/low a `breakout` close must clear. */
  breakoutBars?: number;
  climaxZ?: number;
  /** Volume bar enough to call absorption. */
  absorptionZ?: number;
  /** Volume bar enough to call a breakout or no-demand "participated in". */
  notableZ?: number;
  /** At or below this z a big move counts as travelling through a vacuum. */
  vacuumZ?: number;
  dryUpZ?: number;
  /** Consecutive dry bars before a run is an event. */
  dryUpRun?: number;
  /** |retSigma| at or above this is a big move. */
  bigMoveSigma?: number;
  /** |retSigma| below this is "went nowhere". */
  flatMoveSigma?: number;
  /** range ≤ this × median range is a compressed bar. */
  rangeCompress?: number;
  /** How far from the middle a close must be to count as "at an extreme". */
  extremeClosePos?: number;
}

const DEFAULTS: Required<Omit<VolumeEventConfig, "mode">> = {
  lookback: 20,
  breakoutBars: 20,
  climaxZ: 2.5,
  absorptionZ: 2,
  notableZ: 1.5,
  vacuumZ: -0.5,
  dryUpZ: -1,
  dryUpRun: 3,
  bigMoveSigma: 2,
  flatMoveSigma: 0.5,
  rangeCompress: 0.9,
  extremeClosePos: 0.25,
};

/** Two-character code drawn on a chart chip and shown in the event table. */
export const EVENT_CODE: Record<VolumeEventType, string> = {
  climax: "CX",
  absorption: "AB",
  vacuum: "VC",
  breakout: "BO",
  noDemand: "ND",
  dryUp: "DU",
};

export const EVENT_NAME: Record<VolumeEventType, string> = {
  climax: "Climax",
  absorption: "Absorption",
  vacuum: "Vacuum",
  breakout: "Breakout",
  noDemand: "No Demand",
  dryUp: "Dry Up",
};

/** One line on what the bar did — deliberately not what it implies. */
export const EVENT_DOC: Record<VolumeEventType, string> = {
  climax:
    "Heavy volume, big move, close at an extreme — exhaustion or breakaway, the bar alone cannot say",
  absorption: "Heavy volume, compressed range, close against the move — one side was absorbed",
  vacuum: "Big move on below-normal volume — price travelled through thin liquidity",
  breakout: "Close beyond the prior range, with participation behind it",
  noDemand: "Heavy volume, compressed range, close went nowhere — churn",
  dryUp: "A run of below-normal volume — the state an expansion tends to start from",
};

// ── Per-bar features ─────────────────────────────────────────────────────────

interface Features {
  z: (number | null)[];
  retSigma: (number | null)[];
  retPct: (number | null)[];
  closePos: number[];
  compressed: boolean[];
  breaksUp: boolean[];
  breaksDown: boolean[];
}

function computeFeatures(
  bars: EventBar[],
  cfg: Required<Omit<VolumeEventConfig, "mode">> & { mode?: VolMode }
): Features {
  const n = bars.length;
  const z = volumeZ(bars, { lookback: cfg.lookback, mode: cfg.mode });
  const retSigma: (number | null)[] = new Array(n).fill(null);
  const retPct: (number | null)[] = new Array(n).fill(null);
  const closePos: number[] = new Array(n).fill(0.5);
  const compressed: boolean[] = new Array(n).fill(false);
  const breaksUp: boolean[] = new Array(n).fill(false);
  const breaksDown: boolean[] = new Array(n).fill(false);

  const logRet: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const p0 = bars[i - 1].close;
    const p1 = bars[i].close;
    if (p0 > 0 && p1 > 0) logRet[i] = Math.log(p1 / p0);
  }

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const range = bar.high - bar.low;
    // A zero-range bar (a limit-locked print) has no close position to read;
    // 0.5 is the only honest answer and it disqualifies the extreme tests.
    closePos[i] = range > 0 ? (bar.close - bar.low) / range : 0.5;

    const priorRanges: number[] = [];
    const priorRets: number[] = [];
    for (let j = Math.max(0, i - cfg.lookback); j < i; j++) {
      const r = bars[j].high - bars[j].low;
      if (r > 0) priorRanges.push(r);
      const lr = logRet[j];
      if (lr != null) priorRets.push(lr);
    }

    if (priorRanges.length >= MIN_SAMPLES) {
      const medRange = median(priorRanges);
      compressed[i] = medRange > 0 && range <= cfg.rangeCompress * medRange;
    }

    const lr = logRet[i];
    if (lr != null) {
      retPct[i] = (Math.exp(lr) - 1) * 100;
      if (priorRets.length >= MIN_SAMPLES) {
        // Centred on zero, not on the sample mean: the question is how big this
        // move is against the symbol's normal move, and a drifting mean would
        // quietly re-baseline that in a trend.
        const sigma = stdev(priorRets, 0);
        if (sigma > 0) retSigma[i] = lr / sigma;
      }
    }

    if (i >= cfg.breakoutBars) {
      let hi = Number.NEGATIVE_INFINITY;
      let lo = Number.POSITIVE_INFINITY;
      for (let j = i - cfg.breakoutBars; j < i; j++) {
        hi = Math.max(hi, bars[j].high);
        lo = Math.min(lo, bars[j].low);
      }
      breaksUp[i] = bar.close > hi;
      breaksDown[i] = bar.close < lo;
    }
  }

  return { z, retSigma, retPct, closePos, compressed, breaksUp, breaksDown };
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * One label per bar, most specific first.
 *
 * The order is a claim about which reading dominates when two fit: a climax is
 * a climax even though its volume also qualifies as absorption-heavy, and a
 * move through a vacuum is about the missing volume rather than about the level
 * it happened to clear.
 */
const PRIORITY: VolumeEventType[] = ["climax", "vacuum", "breakout", "absorption", "noDemand"];

export function classifyVolumeEvents(
  bars: EventBar[],
  config: VolumeEventConfig = {}
): VolumeEvent[] {
  const cfg = { ...DEFAULTS, ...config };
  const f = computeFeatures(bars, cfg);
  const labelled: (VolumeEventType | null)[] = new Array(bars.length).fill(null);
  const events: VolumeEvent[] = [];

  const make = (i: number, type: VolumeEventType, dir: 1 | -1 | 0): VolumeEvent => ({
    index: i,
    time: bars[i].time,
    type,
    dir,
    z: f.z[i] as number,
    retSigma: f.retSigma[i] ?? 0,
    retPct: f.retPct[i] ?? 0,
    closePos: f.closePos[i],
    close: bars[i].close,
  });

  for (let i = 0; i < bars.length; i++) {
    const z = f.z[i];
    if (z == null) continue;
    const rs = f.retSigma[i];
    const big = rs != null && Math.abs(rs) >= cfg.bigMoveSigma;
    const flat = rs != null && Math.abs(rs) < cfg.flatMoveSigma;
    const moveDir: 1 | -1 | 0 = rs == null || rs === 0 ? 0 : rs > 0 ? 1 : -1;
    const atExtreme =
      f.closePos[i] <= cfg.extremeClosePos || f.closePos[i] >= 1 - cfg.extremeClosePos;
    // "Against the move" is the informative close for a compressed bar: the
    // aggressor pushed one way and did not get the close.
    const closeAgainst =
      (moveDir === 1 && f.closePos[i] < 0.5) || (moveDir === -1 && f.closePos[i] > 0.5);

    for (const type of PRIORITY) {
      let hit = false;
      let dir: 1 | -1 | 0 = moveDir;
      switch (type) {
        case "climax":
          hit = z >= cfg.climaxZ && big && atExtreme;
          break;
        case "vacuum":
          hit = z <= cfg.vacuumZ && big;
          break;
        case "breakout":
          hit = z >= cfg.notableZ && (f.breaksUp[i] || f.breaksDown[i]);
          if (hit) dir = f.breaksUp[i] ? 1 : -1;
          break;
        case "absorption":
          hit = z >= cfg.absorptionZ && f.compressed[i] && closeAgainst;
          // The absorbed side, not the bar's direction: a close held in the
          // upper half means selling was absorbed.
          if (hit) dir = f.closePos[i] >= 0.5 ? 1 : -1;
          break;
        case "noDemand":
          hit = z >= cfg.notableZ && f.compressed[i] && flat;
          if (hit) dir = 0;
          break;
      }
      if (hit) {
        labelled[i] = type;
        events.push(make(i, type, dir));
        break;
      }
    }
  }

  // Dry-up runs last: a single quiet bar is not an event, and the run's END is
  // where it becomes actionable (the compression is established by then).
  let runStart = -1;
  for (let i = 0; i <= bars.length; i++) {
    const z = i < bars.length ? f.z[i] : null;
    const dry = z != null && z <= cfg.dryUpZ;
    if (dry) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const end = i - 1;
      const len = end - runStart + 1;
      // Never overwrite a bar that already says something more specific.
      if (len >= cfg.dryUpRun && labelled[end] == null) {
        labelled[end] = "dryUp";
        events.push({ ...make(end, "dryUp", 0), runLength: len });
      }
      runStart = -1;
    }
  }

  events.sort((a, b) => a.index - b.index);
  return events;
}

// ── Forward outcome ──────────────────────────────────────────────────────────

/**
 * Return from an event bar's close to the close `horizon` bars later, in %.
 *
 * The column that decides whether any label above is worth keeping. Null when
 * the horizon runs past the loaded data — which is itself information: the most
 * recent events have no outcome yet, and a table that quietly showed 0 there
 * would bias every eye that read it.
 */
export function forwardReturnPct(bars: EventBar[], index: number, horizon: number): number | null {
  const to = index + horizon;
  if (index < 0 || to >= bars.length) return null;
  const from = bars[index].close;
  const at = bars[to].close;
  if (!(from > 0) || !(at > 0)) return null;
  return (at / from - 1) * 100;
}
