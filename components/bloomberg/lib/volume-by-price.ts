/**
 * Volume by price for STRUCTURE → DEPTH: how much traded at each price since
 * the panel was opened, from the prints themselves — not spread out of candle
 * ranges. Side is not used (most prints carry none), so every print counts.
 *
 * Fed by repeated pulls of "the last N prints". Consecutive pulls overlap, and
 * a print has no id, so a print is counted only as many times as the pull that
 * holds most copies of it (`addPull`). When two pulls do not overlap at all,
 * prints in between were never seen: that is counted as a gap and shown,
 * because a profile with a hole reads the same as one without.
 *
 * Pure: no React, no fetch.
 */

import type { Trade } from "./trade-tape";

export interface VolumeProfile {
  /** price in 1/10000ths → volume. Integer keys: 109.27 and 109.2700001 are one level. */
  levels: Map<number, number>;
  /** print key → times counted, for prints newer than `to − WINDOW_MS`. */
  counted: Map<string, number>;
  from: number | null;
  to: number | null;
  total: number;
  prints: number;
  /** Pulls that did not reach back to the previous one. */
  gaps: number;
}

export interface ProfileRow {
  /** Lower edge of the bucket. */
  price: number;
  volume: number;
  /** Share of the largest bucket, 0..1 — the bar. */
  bar: number;
  poc: boolean;
  /** Inside the smallest run of buckets around the POC holding ≥70% of the volume. */
  value: boolean;
}

const UNIT = 10_000;
const WINDOW_MS = 180_000; // how far back two pulls can overlap; older prints are settled
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100];

export const emptyProfile = (): VolumeProfile => ({
  levels: new Map(),
  counted: new Map(),
  from: null,
  to: null,
  total: 0,
  prints: 0,
  gaps: 0,
});

const key = (x: Trade) => `${x.t}|${x.price}|${x.size}|${x.side}`;

/**
 * A new profile with one pull added (any order). `full` = the pull came back at
 * its size limit, so prints older than its oldest may exist.
 */
export function addPull(held: VolumeProfile, pull: Trade[], full: boolean): VolumeProfile {
  if (!pull.length) return held;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const x of pull) {
    if (x.t < oldest) oldest = x.t;
    if (x.t > newest) newest = x.t;
  }
  // Prints older than the window were counted, or dropped, long ago.
  const floor = held.to == null ? Number.NEGATIVE_INFINITY : held.to - WINDOW_MS;
  const inPull = new Map<string, number>();
  const fresh: Trade[] = [];
  for (const x of pull) {
    if (x.t < floor) continue;
    const k = key(x);
    const n = (inPull.get(k) ?? 0) + 1;
    inPull.set(k, n);
    if (n > (held.counted.get(k) ?? 0)) fresh.push(x);
  }
  if (!fresh.length) return held;

  const levels = new Map(held.levels);
  let total = held.total;
  for (const x of fresh) {
    const level = Math.round(x.price * UNIT);
    levels.set(level, (levels.get(level) ?? 0) + x.size);
    total += x.size;
  }
  const to = held.to == null ? newest : Math.max(held.to, newest);
  const counted = new Map<string, number>();
  const keep = to - WINDOW_MS;
  for (const [k, n] of held.counted)
    if (Number(k.slice(0, k.indexOf("|"))) >= keep) counted.set(k, n);
  for (const [k, n] of inPull) if (n > (counted.get(k) ?? 0)) counted.set(k, n);

  return {
    levels,
    counted,
    from: held.from == null ? oldest : Math.min(held.from, oldest),
    to,
    total,
    prints: held.prints + fresh.length,
    // A full pull that starts after everything held: what lay between is lost.
    gaps: held.gaps + (full && held.to != null && oldest > held.to ? 1 : 0),
  };
}

/** The smallest "round" price step that shows the range in at most `maxRows` rows. */
export function bucketStep(low: number, high: number, maxRows: number): number {
  const span = Math.max(high - low, 0);
  for (const step of STEPS) if (span / step < maxRows) return step;
  return STEPS[STEPS.length - 1];
}

/** Buckets from the highest price down, with the POC and the 70% value area marked. */
export function profileRows(profile: VolumeProfile, maxRows = 24): ProfileRow[] {
  if (!profile.levels.size) return [];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const level of profile.levels.keys()) {
    if (level < low) low = level;
    if (level > high) high = level;
  }
  const step = Math.round(bucketStep(low / UNIT, high / UNIT, maxRows) * UNIT);
  const buckets = new Map<number, number>();
  for (const [level, volume] of profile.levels) {
    const b = Math.floor(level / step) * step;
    buckets.set(b, (buckets.get(b) ?? 0) + volume);
  }
  const first = Math.floor(low / step) * step;
  const last = Math.floor(high / step) * step;
  const rows: ProfileRow[] = [];
  let largest = 0;
  let pocAt = 0;
  for (let b = last; b >= first; b -= step) {
    const volume = buckets.get(b) ?? 0;
    if (volume > largest) {
      largest = volume;
      pocAt = rows.length;
    }
    rows.push({ price: b / UNIT, volume, bar: 0, poc: false, value: false });
  }
  for (const r of rows) r.bar = largest > 0 ? r.volume / largest : 0;
  rows[pocAt].poc = true;

  // Value area: grow from the POC towards whichever neighbour holds more.
  let up = pocAt - 1;
  let down = pocAt + 1;
  let held = rows[pocAt].volume;
  rows[pocAt].value = true;
  while (held < profile.total * 0.7 && (up >= 0 || down < rows.length)) {
    const above = up >= 0 ? rows[up].volume : -1;
    const below = down < rows.length ? rows[down].volume : -1;
    if (above >= below) {
      rows[up].value = true;
      held += above;
      up--;
    } else {
      rows[down].value = true;
      held += below;
      down++;
    }
  }
  return rows;
}
