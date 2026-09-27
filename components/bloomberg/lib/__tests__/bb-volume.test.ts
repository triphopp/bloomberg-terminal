import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BbVolBar,
  MIN_PROFILE_BARS,
  RVOL_ABNORMAL,
  RVOL_CAP,
  Z_CAP,
  bbVolumeColumns,
  blockProfiles,
  closeLocation,
  deltaZ,
  periodBlocks,
  resolveVpPeriod,
} from "../bb-volume.ts";

/** Daily bars from 2026-01-01, calendar days (weekends included — irrelevant here). */
function daily(
  n: number,
  vol: (i: number) => number,
  shape?: (i: number) => Partial<BbVolBar>
): BbVolBar[] {
  const out: BbVolBar[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const time = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ time, open: 100, high: 101, low: 99, close: 100.5, volume: vol(i), ...shape?.(i) });
  }
  return out;
}

// Noisy but stable baseline so MAD is non-zero.
const base = (i: number) => 1_000 + ((i * 37) % 11) * 20;

test("spike: only the planted bar crosses the vol σ line", () => {
  const bars = daily(60, (i) => (i === 50 ? 20_000 : base(i)));
  const res = bbVolumeColumns(bars, { mode: "spike", sigma: 2, lookback: 20 });
  assert.equal(res.threshold, 2 / Z_CAP);
  const abnormal = res.columns.filter((c) => c.tier === "abnormal").map((c) => c.index);
  assert.deepEqual(abnormal, [50]);
  const spike = res.columns.find((c) => c.index === 50);
  assert.equal(spike?.frac, 1, "a huge z clips at the band edge");
});

test("spike: σ is the volume's, independent of price moves", () => {
  // Same volume path, wildly different prices — tiers must not change.
  const quiet = daily(60, (i) => (i === 50 ? 20_000 : base(i)));
  const wild = daily(
    60,
    (i) => (i === 50 ? 20_000 : base(i)),
    (i) => ({
      open: 100 + i * 3,
      high: 110 + i * 3,
      low: 90 + i * 3,
      close: 105 + i * 3,
    })
  );
  const tiers = (b: BbVolBar[]) =>
    bbVolumeColumns(b, { mode: "spike", sigma: 2, lookback: 20 }).columns.map((c) => c.tier);
  assert.deepEqual(tiers(quiet), tiers(wild));
});

test("ratio basis: no z — fixed ×normal cut-offs, σ setting ignored", () => {
  const bars = daily(60, (i) => (i === 50 ? 3_000 : i === 52 ? 300 : 1_000));
  // A flat baseline has MAD 0 — the z path can't rank these; the ratio path must.
  for (const sigma of [1, 4]) {
    const res = bbVolumeColumns(bars, { mode: "spike", sigma, lookback: 20, basis: "ratio" });
    assert.equal(res.threshold, RVOL_ABNORMAL / RVOL_CAP);
    const at = (i: number) => res.columns.find((c) => c.index === i);
    assert.equal(at(50)?.tier, "abnormal", "3× normal");
    assert.equal(at(50)?.frac, 3 / RVOL_CAP);
    assert.equal(at(52)?.tier, "dryUp", "0.3× normal");
    assert.equal(at(40)?.tier, "dim");
  }
});

test("spike: no volume, no columns (index / FX / yield)", () => {
  const bars = daily(40, () => 0);
  assert.equal(bbVolumeColumns(bars, { mode: "spike", sigma: 2, lookback: 20 }).columns.length, 0);
});

test("closeLocation: high = +1, low = −1, doji falls back to tick rule", () => {
  const bar = { time: "x", open: 1, high: 2, low: 1, close: 2 };
  assert.equal(closeLocation(bar, null), 1);
  assert.equal(closeLocation({ ...bar, close: 1 }, null), -1);
  const doji = { time: "x", open: 5, high: 5, low: 5, close: 5 };
  assert.equal(closeLocation(doji, 4), 1);
  assert.equal(closeLocation(doji, 6), -1);
  assert.equal(closeLocation(doji, 5), 0);
});

test("delta: side (dir) follows who owned the heavy bar", () => {
  const bars = daily(
    60,
    (i) => (i === 45 || i === 50 ? 20_000 : base(i)),
    (i) =>
      i === 45
        ? { close: 101 } // closed on the high
        : i === 50
          ? { close: 99 } // closed on the low
          : { close: i % 2 ? 100.2 : 99.8 }
  );
  const res = bbVolumeColumns(bars, { mode: "delta", sigma: 2, lookback: 20 });
  const at = (i: number) => res.columns.find((c) => c.index === i);
  assert.equal(at(45)?.tier, "abnormal");
  assert.equal(at(45)?.dir, 1);
  assert.equal(at(50)?.tier, "abnormal");
  assert.equal(at(50)?.dir, -1);
  for (const c of res.columns) assert.ok(c.frac >= 0 && c.frac <= 1);
});

test("deltaZ: null until enough history", () => {
  const z = deltaZ(daily(12, base), 20);
  assert.ok(z.every((v) => v === null));
});

test("rvol: threshold at the 2× line, ratio ≥ 2 is abnormal", () => {
  const bars = daily(40, (i) => (i === 30 ? 3_000 : 1_000));
  const res = bbVolumeColumns(bars, { mode: "rvol", sigma: 2, lookback: 20 });
  assert.equal(res.threshold, 0.5);
  assert.equal(res.columns.find((c) => c.index === 30)?.tier, "abnormal");
  assert.equal(res.columns.find((c) => c.index === 29)?.tier, "dim");
});

test("vol: raw mode has no σ line but still tiers by vol σ", () => {
  const bars = daily(60, (i) => (i === 50 ? 20_000 : base(i)));
  const res = bbVolumeColumns(bars, { mode: "vol", sigma: 2, lookback: 20 });
  assert.equal(res.threshold, null);
  assert.equal(res.columns.find((c) => c.index === 50)?.tier, "abnormal");
  for (const c of res.columns) assert.ok(c.frac >= 0 && c.frac <= 1);
});

test("resolveVpPeriod auto: daily → month, weekly → quarter, 5m → session, 1h → week", () => {
  assert.equal(resolveVpPeriod("auto", daily(30, base)), "month");
  const weekly = Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.UTC(2025, 0, 6) + i * 7 * 86_400_000).toISOString().slice(0, 10),
  }));
  assert.equal(resolveVpPeriod("auto", weekly), "quarter");
  const m5 = Array.from({ length: 30 }, (_, i) => ({ time: 1_700_000_000 + i * 300 }));
  assert.equal(resolveVpPeriod("auto", m5), "session");
  const h1 = Array.from({ length: 30 }, (_, i) => ({ time: 1_700_000_000 + i * 3600 }));
  assert.equal(resolveVpPeriod("auto", h1), "week");
  assert.equal(resolveVpPeriod("quarter", m5), "quarter");
});

test("periodBlocks: month blocks break on the calendar, not on bar count", () => {
  const bars = daily(59, base); // Jan 1 → Feb 28
  assert.deepEqual(periodBlocks(bars, "month"), [
    [0, 30],
    [31, 58],
  ]);
  assert.deepEqual(periodBlocks(daily(50, base), "bars", 21), [
    [0, 20],
    [21, 41],
    [42, 49],
  ]);
});

test("periodBlocks: intraday sessions split on the overnight gap", () => {
  const day = (d: number) =>
    Array.from({ length: 5 }, (_, i) => ({ time: 1_700_000_000 + d * 86_400 + i * 300 }));
  assert.deepEqual(periodBlocks([...day(0), ...day(1)], "session"), [
    [0, 4],
    [5, 9],
  ]);
});

test("blockProfiles: POC at the heavy price, HVN by bucket σ, partial + naked flags", () => {
  // January trades around 100 with one heavy bar at 110; February stays below 105.
  const bars = daily(
    40,
    (i) => (i === 10 ? 50_000 : 1_000),
    (i) =>
      i === 10
        ? { open: 110, high: 110.5, low: 109.5, close: 110 }
        : i < 31
          ? { open: 100, high: 102, low: 98, close: 101 }
          : { open: 100, high: 104, low: 96, close: 99 }
  );
  const [jan, feb] = blockProfiles(bars, "month", 2);
  assert.ok(Math.abs(jan.poc - 110) < 1, `POC ${jan.poc}`);
  assert.ok(jan.buckets.some((b) => b.hvn));
  assert.ok(jan.naked, "no February bar trades through 110");
  assert.equal(jan.partial, false);
  assert.equal(feb.end - feb.start + 1, 9);
  assert.ok(9 < MIN_PROFILE_BARS && feb.partial);
  assert.ok(jan.val <= jan.poc && jan.poc <= jan.vah);
});
