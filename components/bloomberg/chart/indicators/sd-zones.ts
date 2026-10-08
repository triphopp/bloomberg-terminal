/**
 * Supply / Demand Zones — light boxes on the price pane where orders are
 * likely still resting. Two ways to find them (`mode`):
 *
 * ── pivot (default) — where a real swing turned ─────────────────────────────
 *   swing      an ATR ZigZag: a high (low) is a pivot once price has come
 *              `swing` × ATR off it. Measured in ATR, not %, so one setting
 *              fits an index and a 5× volatile stock alike.
 *   leg        the move out of the pivot must reach `legMove` × ATR within
 *              `legBars` bars — a turn that drifts away slowly is not a zone.
 *   box        the pivot bar: demand = its low (distal) up to its body top
 *              (proximal); supply = its high down to its body bottom. Capped
 *              at `zoneHeight` × ATR.
 *   merge      a new pivot that lands on a standing zone of the same side (within
 *              0.5 ATR) joins it instead of making a second box; `reactions`
 *              counts the turns. Several turns at one level = a darker box —
 *              the multi-touch levels a trader would draw by hand.
 *   flip       a confirmed break turns demand into supply (and back), up to
 *              MAX_FLIPS times — a level can serve as support, then resistance,
 *              then support again (INTC 98–107, 2026-06 → 09); the break after
 *              that ends it. Reactions carry over: it is the same price level.
 *
 * ── base — Seiden base + departure ──────────────────────────────────────────
 *   base       1..`baseMax` consecutive bars, each range ≤ `baseRange` × ATR.
 *              A longer quiet stretch is a range, not a base — rejected.
 *   departure  the next bar: range ≥ `impulse` × ATR, body ≥ 50% of range,
 *              and it CLOSES beyond the base (above its high / below its low).
 *   demand     departure up   (DBR = came in falling, RBR = came in rising)
 *   supply     departure down (RBD = came in rising,  DBD = came in falling)
 *   edges      demand: proximal = highest body of the base, distal = lowest low;
 *              supply: proximal = lowest body,              distal = highest high.
 *              A zone taller than `maxHeight` × ATR is dropped.
 *   Catches short pauses inside a leg; it misses the big turns (a turn bar is
 *   rarely small, and the move out of it is rarely one bar) — hence pivot.
 *
 * ── breaks (both modes) ─────────────────────────────────────────────────────
 *   suspect    a close beyond the distal edge by ≥ `breakBuffer` × ATR, or
 *              `breakBars` closes in a row beyond it. The box turns dashed
 *              ("break?") — the outcome is not known yet.
 *   spring     price closes back on the zone's side within `reclaimBars` bars:
 *              a failed break (spring under demand, upthrust over supply). The
 *              zone stays its side and counts one more reaction — a level that
 *              shook out the stops and held is stronger, not weaker.
 *   break      still beyond after `reclaimBars` bars: the zone ends on that bar
 *              (and flips, in pivot mode). `reclaimBars` 0 = break at once.
 *   The zone ends on the bar the break is CONFIRMED, not back-dated to the
 *   first close beyond: what was drawn during the wait stays true.
 *
 * ── traps (both modes; `traps` off | bull | both) ───────────────────────────
 *   Where a zone made the crowd wrong. Bull = at a supply zone (buyers caught);
 *   bear = the mirror at a demand zone.
 *   breakout   a close beyond the distal edge, then a close back on the zone's
 *              side within `trapBars` bars of the first one. Looser than a
 *              spring / upthrust (no buffer, one close is enough): every
 *              upthrust is a trap, not the other way round.
 *   wick       one bar: its extreme passes the distal edge by ≥ `trapWick` × ATR,
 *              it closes back on the zone's side, and that wick is ≥ 50% of
 *              its range.
 *   reclaim    a FLIPPED zone only, once: the first close back inside it (the
 *              break "looked false"), then a close out through the proximal
 *              edge again within `trapBars` bars, with no close beyond the
 *              distal edge in between (GULF.BK 2026-09-21 → 24).
 *   A trap is known on the close of the failing bar: the bars before it are
 *   outlined after the fact, and nothing is taken back afterwards.
 *   checks     not part of the definition — counted in the label (n/of), and
 *              `trapMin` hides a trap with fewer:
 *              V  the first bar's volume < its prior 20-bar mean (no volume
 *                 data = not counted)
 *              W  the first or the failing bar has a rejection wick ≥ 50% of
 *                 its range
 *              D  the failing bar closes beyond the first bar's far end (its
 *                 low, for a bull trap) — everyone who took the move is under
 *                 water. Not counted for a one-bar trap.
 *
 * Both: ATR is Wilder's, as of the bar BEFORE each bar. Only closed bars
 * create or change a zone — the last bar is still forming — so nothing here
 * repaints. A touch = a new visit into the zone.
 *
 * One pass, O(N). The only backward walks are bounded by `baseMax` (≤ 10) or
 * run once per pivot over ≤ `legBars` bars; at most MAX_ACTIVE zones per side
 * are tracked as live.
 *
 * Defaults: base 1.2× departure / 0.8× base bar gives ~8–18 zones a year on
 * daily bars (DJI, NVDA, AAPL, PTT.BK, BTC-USD, 2025-10 → 2026-10).
 *
 * Evidence: none yet — a drawing of a widely used discretionary idea, not a
 * tested signal. Read it as context.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { rollingMean } from "../rolling.ts";
import type {
  CanvasOverlay,
  ChartIndicator,
  IndicatorFactory,
  IndicatorParam,
  OhlcvBar,
  OverlayRect,
} from "../types";

export type SdZoneKind = "demand" | "supply";
export type SdPattern = "DBR" | "RBR" | "RBD" | "DBD";
export type SdMode = "pivot" | "base";

export interface SdZone {
  kind: SdZoneKind;
  source: SdMode;
  /** Base mode only. */
  pattern?: SdPattern;
  /** First bar of the box (base start / pivot bar / flip bar). */
  start: number;
  /** Bar on whose close the zone became known. */
  created: number;
  /** Bar whose close broke the distal edge; null while the zone stands. */
  end: number | null;
  proximal: number;
  distal: number;
  /** Visits back into the zone after it was created. 0 = fresh. */
  touches: number;
  /** Pivot mode: swings that turned at this level (merged pivots). Base mode: 1. */
  reactions: number;
  /** Pivot mode: how many breaks this level has changed sides through. 0 = original. */
  flips: number;
  /** Bar of the suspected break while waiting for a reclaim; null otherwise. */
  pendingSince: number | null;
  /** Failed breaks the zone survived (springs / upthrusts). */
  springs: number;
  /** Move out of the zone ÷ ATR — how hard price left. */
  strength: number;
}

/** How a close beyond the distal edge is judged (see the header). */
export interface BreakRule {
  breakBuffer?: number;
  breakBars?: number;
  reclaimBars?: number;
}

export type SdTrapSide = "bull" | "bear";
export type SdTrapKind = "breakout" | "wick" | "reclaim";
export type SdTrapSides = "off" | "bull" | "both";

/** A failed move at a zone (see the header). */
export interface SdTrap {
  /** bull = buyers caught at a supply zone; bear = sellers caught at a demand zone. */
  side: SdTrapSide;
  kind: SdTrapKind;
  /** First bar of the move. */
  b: number;
  /** Bar whose close failed it — the bar the trap became known. Equals `b` for a wick. */
  f: number;
  /** The zone edge that was crossed and lost again. */
  level: number;
  /** Bar of `b..f` with the furthest extreme (highest high for bull) — the label sits on it. */
  peak: number;
  /** null = could not be measured, and is left out of `of`. */
  checks: { volume: boolean | null; wick: boolean; engulf: boolean | null };
  /** Checks that hold / checks that could be measured. */
  score: number;
  of: number;
}

/** Which traps to look for (see the header). Left out = none. */
export interface TrapRule {
  traps?: SdTrapSides;
  trapBars?: number;
  trapWick?: number;
}

export interface SdScan {
  zones: SdZone[];
  traps: SdTrap[];
}

export interface BaseZoneConfig extends BreakRule, TrapRule {
  impulse: number;
  baseMax: number;
  baseRange: number;
  maxHeight: number;
  atrPeriod?: number;
}

export interface PivotZoneConfig extends BreakRule, TrapRule {
  swing: number;
  legMove: number;
  legBars: number;
  zoneHeight: number;
  flip: boolean;
  atrPeriod?: number;
}

const ATR_PERIOD = 14;
const MIN_BODY_RATIO = 0.5;
/** Live zones kept per side; the oldest beyond this stops being tracked. */
const MAX_ACTIVE = 12;
/** Pivot mode: a pivot this close (× ATR) to a standing zone joins it. */
const MERGE_TOL = 0.5;
/** Pivot mode: a merged zone may grow to this many × zoneHeight. */
const MERGE_MAX = 2;
/** Pivot mode: side changes a level may go through before a break ends it. */
const MAX_FLIPS = 2;
const BREAK_BUFFER = 0.25;
const BREAK_BARS = 2;
const RECLAIM_BARS = 3;
const TRAP_BARS = 3;
const TRAP_WICK = 0.25;
/** A rejection wick is at least this share of the bar's range. */
const TRAP_WICK_RATIO = 0.5;
/** Bars of volume a trap's first bar is compared with. */
const TRAP_VOL_BARS = 20;
const TRAP_COLOR = "#e040fb";

/** Wilder ATR; NaN until `period` true ranges exist. */
function wilderAtr(data: OhlcvBar[], period: number): Float64Array {
  const n = data.length;
  const out = new Float64Array(n).fill(Number.NaN);
  let sum = 0;
  let atr = Number.NaN;
  for (let i = 0; i < n; i++) {
    const b = data[i];
    const prevClose = i > 0 ? data[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    if (i < period) {
      sum += tr;
      if (i === period - 1) {
        atr = sum / period;
        out[i] = atr;
      }
    } else {
      atr = (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
  }
  return out;
}

const NONE = -1;
const SPENT = -2;

interface Live {
  zone: SdZone;
  inside: boolean;
  /** Consecutive closes beyond the distal edge. */
  outside: number;
  /** Trap: first bar of the running closes beyond the distal edge, or NONE. */
  beyondFrom: number;
  /** Trap, flipped zone: bar of the first close back inside it; NONE = not yet, SPENT = used. */
  reclaimFrom: number;
}
type LiveSets = Record<SdZoneKind, Live[]>;

const other = (k: SdZoneKind): SdZoneKind => (k === "demand" ? "supply" : "demand");

function track(live: LiveSets, zone: SdZone): void {
  const list = live[zone.kind];
  list.push({ zone, inside: false, outside: 0, beyondFrom: NONE, reclaimFrom: NONE });
  if (list.length > MAX_ACTIVE) list.splice(0, 1);
}

interface TrapSettings {
  bars: number;
  wick: number;
  bull: boolean;
  bear: boolean;
}

interface Rule {
  buffer: number;
  bars: number;
  reclaim: number;
  flip: boolean;
  trap: TrapSettings | null;
}

function readRule(r: BreakRule & TrapRule, flip: boolean): Rule {
  const sides = r.traps ?? "off";
  return {
    buffer: Math.max(0, r.breakBuffer ?? BREAK_BUFFER),
    bars: Math.max(1, Math.round(r.breakBars ?? BREAK_BARS)),
    reclaim: Math.max(0, Math.round(r.reclaimBars ?? RECLAIM_BARS)),
    flip,
    trap:
      sides === "off"
        ? null
        : {
            bars: Math.max(1, Math.round(r.trapBars ?? TRAP_BARS)),
            wick: Math.max(0, r.trapWick ?? TRAP_WICK),
            bull: true,
            bear: sides === "both",
          },
  };
}

type RawTrap = Pick<SdTrap, "side" | "kind" | "b" | "f" | "level">;

/** The wick against the trap's direction is ≥ TRAP_WICK_RATIO of the bar's range. */
function rejects(b: OhlcvBar, bull: boolean): boolean {
  const range = b.high - b.low;
  if (!(range > 0)) return false;
  const wick = bull ? b.high - Math.max(b.open, b.close) : Math.min(b.open, b.close) - b.low;
  return wick / range >= TRAP_WICK_RATIO;
}

/**
 * One closed bar against one standing zone: does a move through it start,
 * fail (a trap), or outlast the window? `beyond` = this bar closed past the
 * distal edge. Reads the zone, never changes it.
 */
function trapStep(
  l: Live,
  side: SdZoneKind,
  b: OhlcvBar,
  i: number,
  ref: number,
  beyond: boolean,
  t: TrapSettings,
  out: RawTrap[]
): void {
  const zn = l.zone;
  const bull = side === "supply";
  const trapSide: SdTrapSide = bull ? "bull" : "bear";

  if (beyond) {
    if (l.beyondFrom === NONE) l.beyondFrom = i;
    // Out through the far edge: no longer a return INTO the zone.
    l.reclaimFrom = SPENT;
    return;
  }

  let caught = false;
  if (l.beyondFrom !== NONE) {
    if (i - l.beyondFrom <= t.bars) {
      out.push({ side: trapSide, kind: "breakout", b: l.beyondFrom, f: i, level: zn.distal });
      caught = true;
    }
    l.beyondFrom = NONE;
  } else if (ref > 0) {
    const past = bull ? b.high - zn.distal : zn.distal - b.low;
    if (past > 0 && past >= t.wick * ref && rejects(b, bull)) {
      out.push({ side: trapSide, kind: "wick", b: i, f: i, level: zn.distal });
      caught = true;
    }
  }
  if (caught) {
    // One label per event: the same bars are not also a failed reclaim.
    l.reclaimFrom = SPENT;
    return;
  }

  if (zn.flips === 0 || l.reclaimFrom === SPENT) return;
  const within = bull ? b.close > zn.proximal : b.close < zn.proximal;
  if (l.reclaimFrom === NONE) {
    if (within) l.reclaimFrom = i;
  } else if (!within) {
    if (i - l.reclaimFrom <= t.bars) {
      out.push({ side: trapSide, kind: "reclaim", b: l.reclaimFrom, f: i, level: zn.proximal });
    }
    l.reclaimFrom = SPENT;
  } else if (i - l.reclaimFrom >= t.bars) {
    // Held inside past the window: whatever happens next is not this trap.
    l.reclaimFrom = SPENT;
  }
}

/** Measure the checks of each trap found (header: V / W / D). */
function finishTraps(data: OhlcvBar[], raw: RawTrap[]): SdTrap[] {
  if (raw.length === 0) return [];
  const vol = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) vol[i] = data[i].volume ?? Number.NaN;
  const mean = rollingMean(vol, TRAP_VOL_BARS);

  return raw.map((r) => {
    const bull = r.side === "bull";
    const first = data[r.b];
    const fail = data[r.f];
    let peak = r.b;
    // perf-ok: bounded by trapBars (≤ 10), once per trap
    for (let k = r.b + 1; k <= r.f; k++) {
      if (bull ? data[k].high > data[peak].high : data[k].low < data[peak].low) peak = k;
    }
    const base = r.b > 0 ? mean[r.b - 1] : Number.NaN;
    const checks: SdTrap["checks"] = {
      volume: Number.isFinite(vol[r.b]) && base > 0 ? vol[r.b] < base : null,
      wick: rejects(first, bull) || rejects(fail, bull),
      engulf: r.b === r.f ? null : bull ? fail.close < first.low : fail.close > first.high,
    };
    let score = 0;
    let of = 0;
    for (const c of [checks.volume, checks.wick, checks.engulf]) {
      if (c === null) continue;
      of++;
      if (c) score++;
    }
    return { ...r, peak, checks, score, of };
  });
}

/**
 * Touch / suspect / reclaim / break every standing zone on closed bar `i`
 * (`ref` = ATR before it). A broken pivot zone with flips to spare comes back
 * as the opposite side, from this bar. Traps found on this bar go to `traps`.
 */
function advance(
  live: LiveSets,
  b: OhlcvBar,
  i: number,
  ref: number,
  rule: Rule,
  zones: SdZone[],
  traps: RawTrap[]
): void {
  const born: SdZone[] = [];
  const breakAt = (list: Live[], z: number, side: SdZoneKind) => {
    const zn = list[z].zone;
    zn.end = i;
    zn.pendingSince = null;
    list.splice(z, 1);
    if (rule.flip && zn.source === "pivot" && zn.flips < MAX_FLIPS) {
      born.push({
        ...zn,
        kind: other(side),
        start: i,
        created: i,
        end: null,
        proximal: zn.distal,
        distal: zn.proximal,
        touches: 0,
        flips: zn.flips + 1,
        pendingSince: null,
        springs: 0,
      });
    }
  };

  for (const side of ["demand", "supply"] as const) {
    const list = live[side];
    for (let z = list.length - 1; z >= 0; z--) {
      const l = list[z];
      const zn = l.zone;
      const beyond = side === "demand" ? b.close < zn.distal : b.close > zn.distal;
      const t = rule.trap;
      if (t && (side === "supply" ? t.bull : t.bear)) {
        trapStep(l, side, b, i, ref, beyond, t, traps);
      }

      if (zn.pendingSince !== null) {
        if (!beyond) {
          // Back on its side in time: a failed break.
          zn.pendingSince = null;
          zn.reactions++;
          zn.springs++;
          l.outside = 0;
          l.inside = true;
        } else if (i - zn.pendingSince >= rule.reclaim) {
          breakAt(list, z, side);
        }
        continue;
      }

      if (beyond) {
        l.outside++;
        const far = ref > 0 && Math.abs(b.close - zn.distal) >= rule.buffer * ref;
        if (far || l.outside >= rule.bars) {
          if (rule.reclaim > 0) zn.pendingSince = i;
          else breakAt(list, z, side);
        }
        continue;
      }

      l.outside = 0;
      const inZone = side === "demand" ? b.low <= zn.proximal : b.high >= zn.proximal;
      if (inZone && !l.inside) zn.touches++;
      l.inside = inZone;
    }
  }
  // After the loop, so a zone born on this bar is not touched by the same bar.
  for (const zn of born) {
    zones.push(zn);
    track(live, zn);
  }
}

// ── base mode ───────────────────────────────────────────────────────────────

export function calcBaseZones(data: OhlcvBar[], cfg: BaseZoneConfig): SdZone[] {
  return scanBaseZones(data, cfg).zones;
}

export function scanBaseZones(data: OhlcvBar[], cfg: BaseZoneConfig): SdScan {
  const n = data.length;
  const zones: SdZone[] = [];
  const traps: RawTrap[] = [];
  const period = cfg.atrPeriod ?? ATR_PERIOD;
  if (n < period + 3) return { zones, traps: [] };

  const atr = wilderAtr(data, period);
  const baseMax = Math.max(1, Math.min(10, Math.round(cfg.baseMax)));
  const live: LiveSets = { demand: [], supply: [] };
  const rule = readRule(cfg, false);
  const lastClosed = n - 2; // data[n - 1] is still forming
  let streak = 0; // consecutive base bars ending at i - 1

  for (let i = 1; i <= lastClosed; i++) {
    const b = data[i];
    const ref = atr[i - 1];
    advance(live, b, i, ref, rule, zones, traps);

    if (!(ref > 0)) {
      streak = 0;
      continue;
    }

    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);

    // ── is this bar a departure out of the base that ends at i - 1? ──
    if (
      streak >= 1 &&
      streak <= baseMax &&
      range >= cfg.impulse * ref &&
      range > 0 &&
      body / range >= MIN_BODY_RATIO
    ) {
      const start = i - streak;
      let hi = Number.NEGATIVE_INFINITY;
      let lo = Number.POSITIVE_INFINITY;
      let bodyHi = Number.NEGATIVE_INFINITY;
      let bodyLo = Number.POSITIVE_INFINITY;
      // perf-ok: bounded by baseMax (≤ 10), not by a window the user can widen
      for (let k = start; k < i; k++) {
        const c = data[k];
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
        const top = Math.max(c.open, c.close);
        const bot = Math.min(c.open, c.close);
        if (top > bodyHi) bodyHi = top;
        if (bot < bodyLo) bodyLo = bot;
      }
      const up = b.close > b.open && b.close > hi;
      const down = b.close < b.open && b.close < lo;
      if (up || down) {
        const kind: SdZoneKind = up ? "demand" : "supply";
        const proximal = up ? bodyHi : bodyLo;
        const distal = up ? lo : hi;
        if (Math.abs(proximal - distal) <= cfg.maxHeight * ref) {
          const before = start > 0 ? data[start - 1] : null;
          const cameRising = before ? before.close >= before.open : up;
          const pattern: SdPattern = up ? (cameRising ? "RBR" : "DBR") : cameRising ? "RBD" : "DBD";
          const zone: SdZone = {
            kind,
            source: "base",
            pattern,
            start,
            created: i,
            end: null,
            proximal,
            distal,
            touches: 0,
            reactions: 1,
            flips: 0,
            pendingSince: null,
            springs: 0,
            strength: range / ref,
          };
          zones.push(zone);
          track(live, zone);
        }
      }
    }

    streak = range <= cfg.baseRange * ref ? streak + 1 : 0;
  }
  return { zones, traps: finishTraps(data, traps) };
}

// ── pivot mode ──────────────────────────────────────────────────────────────

interface Pending {
  p: number;
  kind: SdZoneKind;
  /** Furthest price the leg reached within legBars of the pivot. */
  ext: number;
  atr: number;
}

export function calcPivotZones(data: OhlcvBar[], cfg: PivotZoneConfig): SdZone[] {
  return scanPivotZones(data, cfg).zones;
}

export function scanPivotZones(data: OhlcvBar[], cfg: PivotZoneConfig): SdScan {
  const n = data.length;
  const zones: SdZone[] = [];
  const traps: RawTrap[] = [];
  const period = cfg.atrPeriod ?? ATR_PERIOD;
  if (n < period + 3) return { zones, traps: [] };

  const atr = wilderAtr(data, period);
  const legBars = Math.max(2, Math.min(60, Math.round(cfg.legBars)));
  const live: LiveSets = { demand: [], supply: [] };
  const pending: Pending[] = [];
  const rule = readRule(cfg, cfg.flip);
  const lastClosed = n - 2; // data[n - 1] is still forming

  const pivotPx = (p: number, kind: SdZoneKind) => (kind === "demand" ? data[p].low : data[p].high);
  const legDone = (q: Pending) => Math.abs(q.ext - pivotPx(q.p, q.kind)) >= cfg.legMove * q.atr;

  const place = (q: Pending, i: number) => {
    const pb = data[q.p];
    const a = q.atr;
    const h = cfg.zoneHeight * a;
    let distal: number;
    let proximal: number;
    if (q.kind === "demand") {
      distal = pb.low;
      proximal = Math.min(Math.max(pb.open, pb.close), distal + h);
    } else {
      distal = pb.high;
      proximal = Math.max(Math.min(pb.open, pb.close), distal - h);
    }
    const lo = Math.min(proximal, distal);
    const hi = Math.max(proximal, distal);
    const tol = MERGE_TOL * a;

    for (const l of live[q.kind]) {
      const z = l.zone;
      const zLo = Math.min(z.proximal, z.distal);
      const zHi = Math.max(z.proximal, z.distal);
      if (lo > zHi + tol || hi < zLo - tol) continue;
      const uLo = Math.min(lo, zLo);
      const uHi = Math.max(hi, zHi);
      if (uHi - uLo > MERGE_MAX * h) continue;
      if (q.kind === "demand") {
        z.distal = uLo;
        z.proximal = uHi;
      } else {
        z.distal = uHi;
        z.proximal = uLo;
      }
      z.reactions++;
      z.strength = Math.max(z.strength, Math.abs(q.ext - pivotPx(q.p, q.kind)) / a);
      return;
    }

    const zone: SdZone = {
      kind: q.kind,
      source: "pivot",
      start: q.p,
      created: i,
      end: null,
      proximal,
      distal,
      touches: 0,
      reactions: 1,
      flips: 0,
      pendingSince: null,
      springs: 0,
      strength: Math.abs(q.ext - pivotPx(q.p, q.kind)) / a,
    };
    zones.push(zone);
    track(live, zone);
  };

  /** A pivot confirmed on bar `c`: measure its leg so far, place it or wait. */
  const confirm = (p: number, kind: SdZoneKind, c: number) => {
    const a = atr[p] > 0 ? atr[p] : atr[c - 1];
    if (!(a > 0)) return;
    const stop = Math.min(c, p + legBars);
    let ext = pivotPx(p, kind);
    // perf-ok: once per pivot over ≤ legBars bars — pivots are ≥ swing×ATR apart
    for (let k = p + 1; k <= stop; k++) {
      ext = kind === "demand" ? Math.max(ext, data[k].high) : Math.min(ext, data[k].low);
    }
    const q: Pending = { p, kind, ext, atr: a };
    if (legDone(q)) place(q, c);
    else if (c < p + legBars) pending.push(q);
  };

  // ATR ZigZag state: 1 = rising (tracking the high), −1 = falling, 0 = not yet known.
  let dir = 0;
  let hiIdx = 0;
  let loIdx = 0;

  for (let i = 1; i <= lastClosed; i++) {
    const b = data[i];
    advance(live, b, i, atr[i - 1], rule, zones, traps);

    // Legs still being measured.
    for (let k = pending.length - 1; k >= 0; k--) {
      const q = pending[k];
      q.ext = q.kind === "demand" ? Math.max(q.ext, b.high) : Math.min(q.ext, b.low);
      if (legDone(q)) {
        pending.splice(k, 1);
        place(q, i);
      } else if (i >= q.p + legBars) {
        pending.splice(k, 1);
      }
    }

    if (dir >= 0 && b.high >= data[hiIdx].high) hiIdx = i;
    if (dir <= 0 && b.low <= data[loIdx].low) loIdx = i;
    const ref = atr[i - 1];
    if (!(ref > 0)) continue;
    const thr = cfg.swing * ref;
    if (dir >= 0 && hiIdx < i && data[hiIdx].high - b.low >= thr) {
      confirm(hiIdx, "supply", i);
      dir = -1;
      loIdx = i;
    } else if (dir <= 0 && loIdx < i && b.high - data[loIdx].low >= thr) {
      confirm(loIdx, "demand", i);
      dir = 1;
      hiIdx = i;
    }
  }
  return { zones, traps: finishTraps(data, traps) };
}

// ── settings ────────────────────────────────────────────────────────────────

export type SdShow = "active" | "fresh" | "all";
export const SD_SHOW_OPTIONS: { value: SdShow; label: string }[] = [
  { value: "active", label: "Standing (fresh + tested)" },
  { value: "fresh", label: "Fresh only" },
  { value: "all", label: "All (incl. broken)" },
];
export type SdShade = "auto" | "strength" | "flat";
export const SD_SHADE_OPTIONS: { value: SdShade; label: string }[] = [
  { value: "auto", label: "Reactions (pivot) / touches (base)" },
  { value: "strength", label: "Departure size (×ATR)" },
  { value: "flat", label: "Flat — all the same" },
];
export const SD_TRAP_OPTIONS: { value: SdTrapSides; label: string }[] = [
  { value: "bull", label: "Bull traps (at supply)" },
  { value: "both", label: "Bull + bear traps" },
  { value: "off", label: "Off" },
];
const DEMAND_COLOR = "#26a69a";
const SUPPLY_COLOR = "#ef5350";

export const SD_MODE_OPTIONS: { value: SdMode; label: string }[] = [
  { value: "pivot", label: "Pivot (swing turns)" },
  { value: "base", label: "Base + departure" },
];
const SD_FLIP_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export const SD_ZONE_PARAMS: IndicatorParam[] = [
  { key: "mode", label: "Mode", type: "select", default: "pivot", options: SD_MODE_OPTIONS },
  {
    key: "swing",
    label: "Pivot: swing ≥ ×ATR",
    type: "number",
    default: 2.5,
    min: 1,
    max: 8,
    step: 0.1,
  },
  {
    key: "legMove",
    label: "Pivot: leg ≥ ×ATR",
    type: "number",
    default: 3,
    min: 1,
    max: 12,
    step: 0.5,
  },
  {
    key: "legBars",
    label: "Pivot: leg within bars",
    type: "number",
    default: 10,
    min: 2,
    max: 60,
    step: 1,
  },
  {
    key: "zoneHeight",
    label: "Pivot: box ≤ ×ATR",
    type: "number",
    default: 1,
    min: 0.3,
    max: 3,
    step: 0.1,
  },
  {
    key: "flip",
    label: "Pivot: flip on break",
    type: "select",
    default: "on",
    options: SD_FLIP_OPTIONS,
  },
  {
    key: "impulse",
    label: "Base: departure ≥ ×ATR",
    type: "number",
    default: 1.2,
    min: 1,
    max: 4,
    step: 0.1,
  },
  {
    key: "baseMax",
    label: "Base: max bars",
    type: "number",
    default: 6,
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: "baseRange",
    label: "Base: bar ≤ ×ATR",
    type: "number",
    default: 0.8,
    min: 0.2,
    max: 1.5,
    step: 0.05,
  },
  {
    key: "maxHeight",
    label: "Base: zone ≤ ×ATR",
    type: "number",
    default: 1.5,
    min: 0.5,
    max: 4,
    step: 0.1,
  },
  {
    key: "breakBuffer",
    label: "Break: close beyond ×ATR",
    type: "number",
    default: BREAK_BUFFER,
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: "breakBars",
    label: "Break: or closes beyond",
    type: "number",
    default: BREAK_BARS,
    min: 1,
    max: 5,
    step: 1,
  },
  {
    key: "reclaimBars",
    label: "Break: reclaim within bars",
    type: "number",
    default: RECLAIM_BARS,
    min: 0,
    max: 10,
    step: 1,
  },
  { key: "traps", label: "Traps", type: "select", default: "bull", options: SD_TRAP_OPTIONS },
  {
    key: "trapBars",
    label: "Trap: fails within bars",
    type: "number",
    default: TRAP_BARS,
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: "trapWick",
    label: "Trap: wick beyond ×ATR",
    type: "number",
    default: TRAP_WICK,
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: "trapMin",
    label: "Trap: checks ≥ (V/W/D)",
    type: "number",
    default: 0,
    min: 0,
    max: 3,
    step: 1,
  },
  { key: "trapColor", label: "Trap colour", type: "color", default: TRAP_COLOR },
  { key: "show", label: "Show", type: "select", default: "active", options: SD_SHOW_OPTIONS },
  { key: "demandColor", label: "Demand colour", type: "color", default: DEMAND_COLOR },
  { key: "supplyColor", label: "Supply colour", type: "color", default: SUPPLY_COLOR },
  {
    key: "intensity",
    label: "Fill strength ×",
    type: "number",
    default: 1,
    min: 0.2,
    max: 4,
    step: 0.1,
  },
  { key: "shade", label: "Shade by", type: "select", default: "auto", options: SD_SHADE_OPTIONS },
];

interface SdSettings extends BaseZoneConfig {
  breakBuffer: number;
  breakBars: number;
  reclaimBars: number;
  mode: SdMode;
  swing: number;
  legMove: number;
  legBars: number;
  zoneHeight: number;
  flip: "on" | "off";
  traps: SdTrapSides;
  trapBars: number;
  trapWick: number;
  trapMin: number;
  trapColor: string;
  show: SdShow;
  demandColor: string;
  supplyColor: string;
  intensity: number;
  shade: SdShade;
}

const HEX = /^#[0-9a-f]{6}$/i;

function readConfig(c: Record<string, unknown>): SdSettings {
  const num = (v: unknown, d: number) =>
    v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
  return {
    mode: c.mode === "base" ? "base" : "pivot",
    swing: num(c.swing, 2.5),
    legMove: num(c.legMove, 3),
    legBars: num(c.legBars, 10),
    zoneHeight: num(c.zoneHeight, 1),
    flip: c.flip === "off" ? "off" : "on",
    breakBuffer: num(c.breakBuffer, BREAK_BUFFER),
    breakBars: num(c.breakBars, BREAK_BARS),
    reclaimBars: num(c.reclaimBars, RECLAIM_BARS),
    impulse: num(c.impulse, 1.2),
    baseMax: num(c.baseMax, 6),
    baseRange: num(c.baseRange, 0.8),
    maxHeight: num(c.maxHeight, 1.5),
    traps: c.traps === "off" || c.traps === "both" ? c.traps : "bull",
    trapBars: num(c.trapBars, TRAP_BARS),
    trapWick: num(c.trapWick, TRAP_WICK),
    trapMin: Math.min(3, Math.max(0, Math.round(num(c.trapMin, 0)))),
    trapColor: typeof c.trapColor === "string" && HEX.test(c.trapColor) ? c.trapColor : TRAP_COLOR,
    show: c.show === "fresh" || c.show === "all" ? c.show : "active",
    demandColor:
      typeof c.demandColor === "string" && HEX.test(c.demandColor) ? c.demandColor : DEMAND_COLOR,
    supplyColor:
      typeof c.supplyColor === "string" && HEX.test(c.supplyColor) ? c.supplyColor : SUPPLY_COLOR,
    intensity: Math.min(4, Math.max(0.2, num(c.intensity, 1))),
    shade: c.shade === "strength" || c.shade === "flat" ? c.shade : "auto",
  };
}

export function scanSdZones(data: OhlcvBar[], s: SdSettings): SdScan {
  return s.mode === "base"
    ? scanBaseZones(data, s)
    : scanPivotZones(data, { ...s, flip: s.flip === "on" });
}

export function calcSdZones(data: OhlcvBar[], s: SdSettings): SdZone[] {
  return scanSdZones(data, s).zones;
}

/**
 * The zone overlay and the trap overlay read the same scan: one pass per bar
 * array, shared by whoever asks with the same settings. Keyed on the array's
 * identity on purpose — the pass is O(N) and a tick's new array should rerun it.
 */
const scans = new WeakMap<OhlcvBar[], { key: string; scan: SdScan }>();

function sharedScan(data: OhlcvBar[], s: SdSettings, key: string): SdScan {
  const hit = scans.get(data);
  if (hit && hit.key === key) return hit.scan;
  const scan = scanSdZones(data, s);
  scans.set(data, { key, scan });
  return scan;
}

/** Everything that changes what the scan finds (not how it is drawn). */
function scanKey(s: SdSettings): string {
  return [
    s.mode,
    s.swing,
    s.legMove,
    s.legBars,
    s.zoneHeight,
    s.flip,
    s.impulse,
    s.baseMax,
    s.baseRange,
    s.maxHeight,
    s.breakBuffer,
    s.breakBars,
    s.reclaimBars,
    s.traps,
    s.trapBars,
    s.trapWick,
  ].join("|");
}

// ── overlay ─────────────────────────────────────────────────────────────────

/** "#26a69a" → "38,166,154" (an rgba() prefix). */
export function hexToRgb(hex: string): string {
  const v = Number.parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

/**
 * Fill opacity before the user's strength multiplier:
 *   auto      pivot — darker with every turn at the level; base — lighter with every touch
 *   strength  by how hard price left (×ATR): 1 ATR → faint, 6+ ATR → strongest
 *   flat      every standing box the same
 * A broken box is always faint.
 */
export function fillAlpha(z: SdZone, shade: SdShade): number {
  if (z.end !== null) return 0.05;
  if (shade === "flat") return 0.12;
  if (shade === "strength") return 0.06 + 0.16 * Math.min(1, Math.max(0, (z.strength - 1) / 5));
  if (z.source === "pivot") return 0.1 + 0.04 * Math.min(Math.max(z.reactions, 1) - 1, 3);
  return z.touches === 0 ? 0.14 : z.touches === 1 ? 0.1 : 0.07;
}

export function zoneTag(z: SdZone): string {
  const head =
    z.source === "base"
      ? `${z.pattern ?? ""}${z.touches > 0 ? ` ×${z.touches}` : ""}`
      : `${z.kind === "demand" ? "D" : "S"}${z.reactions > 1 ? ` ×${z.reactions}` : ""}`;
  const marks: string[] = [];
  if (z.flips > 0) marks.push("flip");
  if (z.springs > 0) marks.push(z.kind === "demand" ? "spring" : "upthrust");
  if (z.pendingSince !== null) marks.push("break?");
  return [head, ...marks].join(" ");
}

export function createSdZonesOverlay(config: Record<string, unknown>): CanvasOverlay {
  const cfg = readConfig(config);
  const rgbOf = { demand: hexToRgb(cfg.demandColor), supply: hexToRgb(cfg.supplyColor) };
  // Edges and labels follow the strength too, more gently, so ×0.3 is quiet all over.
  const lineK = Math.sqrt(cfg.intensity);
  const key = scanKey(cfg);

  return {
    id: "sd-zones",
    name: "S/D Zones",
    mode: "full",
    // Under the candles: the boxes are ground, price stays in front.
    zOrder: "bottom",
    width: 0,
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      series: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      _isDark: boolean,
      rect: OverlayRect
    ) {
      if (data.length === 0) return;
      const { zones } = sharedScan(data, cfg, key);
      const ts = chart.timeScale();
      const spacing = ts.options().barSpacing ?? 6;
      ctx.save();
      ctx.font = "9px monospace";
      ctx.textBaseline = "top";

      for (const z of zones) {
        const broken = z.end !== null;
        if (cfg.show === "active" && broken) continue;
        if (cfg.show === "fresh" && (broken || z.touches > 0)) continue;

        const xs = ts.timeToCoordinate(data[z.start].time as Time);
        if (xs === null) continue;
        const left = xs - spacing / 2;
        let right = rect.width;
        if (broken) {
          const xe = ts.timeToCoordinate(data[z.end as number].time as Time);
          if (xe === null) continue;
          right = xe + spacing / 2;
        }
        if (right < 0 || left > rect.width) continue;

        const yA = series.priceToCoordinate(z.proximal);
        const yB = series.priceToCoordinate(z.distal);
        if (yA === null || yB === null) continue;
        const top = Math.min(yA, yB);
        const h = Math.max(1, Math.abs(yB - yA));

        const rgb = rgbOf[z.kind];
        const suspect = z.pendingSince !== null;
        // Half strength while a break is unresolved.
        const fill = Math.min(0.9, fillAlpha(z, cfg.shade) * cfg.intensity * (suspect ? 0.5 : 1));
        ctx.fillStyle = `rgba(${rgb},${fill})`;
        ctx.fillRect(left, top, right - left, h);
        if (suspect) {
          // Outline the whole box: it is the far edge that is in question.
          ctx.strokeStyle = `rgba(${rgb},${Math.min(1, 0.35 * lineK)})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, h - 1);
        }

        // Proximal edge — where a return first meets the zone. Dashed when the
        // zone is broken or is a flipped one (its first life ended in a break).
        ctx.strokeStyle = `rgba(${rgb},${Math.min(1, (broken ? 0.2 : 0.45) * lineK)})`;
        ctx.lineWidth = 1;
        ctx.setLineDash(broken || suspect || z.flips > 0 ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(left, Math.round(yA) + 0.5);
        ctx.lineTo(right, Math.round(yA) + 0.5);
        ctx.stroke();

        if (h >= 11 && right - left > 40) {
          ctx.fillStyle = `rgba(${rgb},${Math.min(1, (broken ? 0.4 : 0.8) * lineK)})`;
          ctx.fillText(zoneTag(z), Math.max(left, 0) + 3, top + 1);
        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    },
  };
}

// ── traps: candle border + label ────────────────────────────────────────────

/** "BULL TRAP 2/3" · "BULL TRAP·RECLAIM 3/3" — n/of = checks that hold / that could be measured. */
export function trapLabel(t: SdTrap): string {
  const head = t.side === "bull" ? "BULL TRAP" : "BEAR TRAP";
  return `${head}${t.kind === "reclaim" ? "·RECLAIM" : ""} ${t.score}/${t.of}`;
}

/**
 * The trap half of the indicator, as its own overlay: it outlines the candles
 * of each trap (`barBorders`, read by ModularChart when it pushes the bars —
 * the border only, so green / red still reads as up / down) and writes the
 * label past their extreme — over the candles, where the zone boxes sit under
 * them. null when traps are off.
 */
export function createSdTrapsOverlay(config: Record<string, unknown>): CanvasOverlay | null {
  const cfg = readConfig(config);
  if (cfg.traps === "off") return null;
  const key = scanKey(cfg);
  const shown = (data: OhlcvBar[]) =>
    sharedScan(data, cfg, key).traps.filter((t) => t.score >= cfg.trapMin);

  return {
    id: "sd-traps",
    name: "S/D Traps",
    mode: "full",
    zOrder: "top",
    width: 0,
    barBorders(data: OhlcvBar[]) {
      const traps = shown(data);
      if (traps.length === 0) return null;
      const out = new Map<number, string>();
      for (const t of traps) for (let k = t.b; k <= t.f; k++) out.set(k, cfg.trapColor);
      return out;
    },
    draw(
      ctx: CanvasRenderingContext2D,
      chart: IChartApi,
      series: ISeriesApi<SeriesType>,
      data: OhlcvBar[],
      isDark: boolean,
      rect: OverlayRect
    ) {
      if (data.length === 0) return;
      const traps = shown(data);
      if (traps.length === 0) return;
      const ts = chart.timeScale();
      ctx.save();
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      // A halo in the surface colour: the label crosses zone boxes and lines.
      ctx.strokeStyle = isDark ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.85)";
      ctx.fillStyle = cfg.trapColor;

      // Newest first, so when two labels would collide the recent one is kept.
      const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (let n = traps.length - 1; n >= 0; n--) {
        const t = traps[n];
        const bar = data[t.peak];
        const bull = t.side === "bull";
        const cx = ts.timeToCoordinate(bar.time as Time);
        const py = series.priceToCoordinate(bull ? bar.high : bar.low);
        if (cx === null || py === null) continue;
        const text = trapLabel(t);
        const half = ctx.measureText(text).width / 2;
        if (cx + half < 0 || cx - half > rect.width) continue;
        // Keep the whole label on the pane when its bar is at an edge.
        const x = Math.min(Math.max(cx, half + 2), Math.max(half + 2, rect.width - half - 2));
        const y = bull ? py - 5 : py + 5;
        const box = { x0: x - half, x1: x + half, y0: bull ? y - 9 : y, y1: bull ? y : y + 9 };
        if (taken.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) {
          continue;
        }
        taken.push(box);
        ctx.textBaseline = bull ? "bottom" : "top";
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
      ctx.restore();
    },
  };
}

// ── indicator (picker entry) ────────────────────────────────────────────────

/**
 * The picker entry. It draws nothing as a series — the boxes come from
 * createSdZonesOverlay, which useChartIndicators adds when this is on — so
 * compute returns no series.
 */
export const createSdZones: IndicatorFactory = (overrides = {}) => {
  const cfg = readConfig(overrides);
  const indicator: ChartIndicator = {
    // One id whatever the settings: the overlay draws one set of boxes, so a
    // re-add with new settings (colour, mode, …) REPLACES rather than stacks.
    id: "sdz",
    name: cfg.mode === "pivot" ? "S/D Zones (pivot)" : "S/D Zones (base)",
    category: "trend",
    type: "overlay",
    description: "Supply / demand zones — swing turns, or a tight base then an ATR-sized departure",
    minBars: ATR_PERIOD + 3,
    params: SD_ZONE_PARAMS.map((p) => ({
      ...p,
      default: (cfg as unknown as Record<string, number | string>)[p.key] ?? p.default,
    })),
    config: { ...cfg },
    compute() {
      return [];
    },
  };
  return indicator;
};
