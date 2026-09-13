import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_SAMPLES,
  type VolumeBar,
  madSigma,
  median,
  volumeRatio,
  volumeZ,
} from "../volume-stats.ts";

/** Daily bars from a volume list, dates sequential from 2026-01-01. */
function daily(volumes: (number | undefined)[]): VolumeBar[] {
  return volumes.map((v, i) => ({
    time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    volume: v,
  }));
}

/**
 * Intraday bars: `sessions` sessions of `perSession` bars, 5 minutes apart,
 * with a 20-hour gap between sessions so the session splitter fires.
 * `vol(session, slot)` supplies each bar's volume.
 */
function intraday(
  sessions: number,
  perSession: number,
  vol: (session: number, slot: number) => number
): VolumeBar[] {
  const bars: VolumeBar[] = [];
  const dayStart = Date.UTC(2026, 0, 1, 14, 30) / 1000;
  for (let s = 0; s < sessions; s++) {
    for (let k = 0; k < perSession; k++) {
      bars.push({ time: dayStart + s * 86_400 + k * 300, volume: vol(s, k) });
    }
  }
  return bars;
}

describe("robust statistics", () => {
  it("medians odd and even lengths without mutating the input", () => {
    const xs = [5, 1, 3];
    assert.equal(median(xs), 3);
    assert.deepEqual(xs, [5, 1, 3]);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it("scales MAD to a standard deviation", () => {
    // MAD of [1,2,3,4,5] around 3 is 1 → 1.4826σ
    assert.ok(Math.abs(madSigma([1, 2, 3, 4, 5]) - 1.4826) < 1e-9);
  });
});

describe("volumeZ — daily", () => {
  it("emits nothing until MIN_SAMPLES prior bars exist", () => {
    const z = volumeZ(daily(Array(20).fill(100)), { lookback: 20 });
    for (let i = 0; i < MIN_SAMPLES; i++) assert.equal(z[i], null, `bar ${i}`);
  });

  it("returns null when every prior volume is identical (no scale to speak of)", () => {
    // MAD is 0 and so is σ — there is no dispersion, so no z exists.
    const z = volumeZ(daily(Array(20).fill(100)), { lookback: 20 });
    assert.equal(z[19], null);
  });

  it("scores a spike positive and a lull negative", () => {
    const vols = [100, 120, 90, 110, 95, 130, 85, 105, 115, 100];
    const z = volumeZ(daily([...vols, 1000]), { lookback: 20 });
    assert.ok((z[10] as number) > 3, `spike z was ${z[10]}`);

    const zq = volumeZ(daily([...vols, 20]), { lookback: 20 });
    assert.ok((zq[10] as number) < -2, `lull z was ${zq[10]}`);
  });

  it("keeps the baseline robust: a prior spike must not hide the next one", () => {
    // This is the flaw of a mean baseline. 10 quiet bars, then a 10× spike,
    // then 10 more quiet bars, then a second identical spike. With a mean
    // baseline the second spike reads far tamer than the first; with
    // median/MAD the two are the same event.
    const quiet = [100, 120, 90, 110, 95, 130, 85, 105, 115, 100];
    const bars = daily([...quiet, 1000, ...quiet, 1000]);
    const z = volumeZ(bars, { lookback: 20 });
    const first = z[10] as number;
    const second = z[21] as number;
    assert.ok(Math.abs(second - first) / first < 0.15, `${first} vs ${second}`);

    // The mean-baseline ratio, by contrast, gives away a third of the second
    // spike to the first one; the median baseline barely moves.
    const rMean = volumeRatio(bars, { lookback: 20, baseline: "mean" });
    assert.ok((rMean[21] as number) < 0.75 * (rMean[10] as number), `${rMean[10]} vs ${rMean[21]}`);
    const rMed = volumeRatio(bars, { lookback: 20, baseline: "median" });
    assert.ok((rMed[21] as number) > 0.95 * (rMed[10] as number), `${rMed[10]} vs ${rMed[21]}`);
  });

  it("excludes the current bar from its own baseline", () => {
    // A single bar 10× the rest must not be able to drag its own baseline up.
    const z = volumeZ(daily([...Array(12).fill(100), ...Array(8).fill(110), 1000]), {
      lookback: 20,
    });
    assert.ok((z[20] as number) > 2);
  });
});

describe("volumeRatio", () => {
  it("is 1 when the bar equals its baseline", () => {
    const bars = daily([...[90, 95, 100, 105, 110, 90, 100, 110, 95, 105], 100]);
    const r = volumeRatio(bars, { lookback: 20, baseline: "median" });
    assert.ok(Math.abs((r[10] as number) - 1) < 1e-9, String(r[10]));
  });

  it("median and mean baselines differ exactly where it matters", () => {
    const bars = daily([...[100, 100, 100, 100, 100, 100, 100, 100, 100, 1000], 200]);
    const med = volumeRatio(bars, { lookback: 20, baseline: "median" });
    const avg = volumeRatio(bars, { lookback: 20, baseline: "mean" });
    assert.equal(med[10], 2); // median of prior = 100
    assert.ok((avg[10] as number) < 1.1); // mean was pulled to 190 by the spike
  });

  it("ignores bars with no volume — a symbol with nothing trading reads null", () => {
    const r = volumeRatio(daily(Array(20).fill(0)), { lookback: 20 });
    assert.ok(r.every((v) => v === null));
    const missing = volumeRatio(daily(Array(20).fill(undefined)), { lookback: 20 });
    assert.ok(missing.every((v) => v === null));
  });
});

describe("volumeZ — intraday slotting", () => {
  // Volume is U-shaped within a session: heavy at the open, light mid-session.
  const uShape = (slot: number) => (slot === 0 ? 1000 : slot === 5 ? 800 : 100);

  it("does not flag the open as abnormal", () => {
    // A rolling window would: 1000 against a mid-session baseline of 100 is
    // 10×. Slotted against other opens it is ordinary.
    const bars = intraday(12, 6, (s, k) => uShape(k) * (1 + 0.05 * ((s % 3) - 1)));
    const z = volumeZ(bars, { lookback: 20, mode: "bar" });
    const lastOpen = z[11 * 6];
    assert.ok(lastOpen !== null);
    assert.ok(Math.abs(lastOpen as number) < 2, `open z was ${lastOpen}`);
  });

  it("still flags a genuine spike in one slot", () => {
    const bars = intraday(12, 6, (s, k) =>
      s === 11 && k === 3 ? 2000 : uShape(k) * (1 + 0.05 * ((s % 3) - 1))
    );
    const z = volumeZ(bars, { lookback: 20, mode: "bar" });
    assert.ok((z[11 * 6 + 3] as number) > 3, String(z[11 * 6 + 3]));
  });

  it("slots by session index, so a DST shift does not empty every slot", () => {
    // Sessions 0-5 start at 14:30 UTC, 6-11 at 13:30 — what a US session does
    // across a DST change. Keying on UTC time-of-day would give the later
    // sessions brand-new keys with no history; session-relative indices align.
    const bars: VolumeBar[] = [];
    for (let s = 0; s < 12; s++) {
      const hour = s < 6 ? 14 : 13;
      const start = Date.UTC(2026, 2, 1 + s, hour, 30) / 1000;
      // Volume must vary across sessions or the slot has no dispersion and the
      // null would prove nothing about the key.
      for (let k = 0; k < 6; k++)
        bars.push({ time: start + k * 300, volume: uShape(k) * (1 + 0.03 * (s % 4)) });
    }
    const z = volumeZ(bars, { lookback: 20, mode: "bar" });
    assert.notEqual(z[11 * 6], null, "post-shift open lost its history");
  });

  it("falls back to time-of-day slots on a single 24h session (crypto)", () => {
    // 1h bars with no gap anywhere: there is no session to be relative to, so
    // the same UTC hour on prior days is the comparable set.
    const bars: VolumeBar[] = [];
    const t0 = Date.UTC(2026, 0, 1) / 1000;
    for (let h = 0; h < 24 * 12; h++) {
      const hourOfDay = h % 24;
      bars.push({ time: t0 + h * 3600, volume: hourOfDay === 13 ? 500 : 100 });
    }
    const z = volumeZ(bars, { lookback: 20, mode: "bar" });
    // The 13:00 bar is 5× every other hour, yet compared with other 13:00s it
    // is unremarkable — which is the whole point of slotting.
    const last13 = z[24 * 11 + 13];
    assert.equal(last13, null, "identical history has no dispersion → null, not a spike");
    // And a slot whose history does vary produces a finite reading.
    const varied: VolumeBar[] = bars.map((b, i) => ({
      ...b,
      volume: (b.volume as number) + (i % 7) * 3,
    }));
    assert.notEqual(volumeZ(varied, { lookback: 20, mode: "bar" })[24 * 11 + 13], null);
  });
});

describe('volumeZ — mode "cum"', () => {
  it("reads a partial session honestly while bar mode calls it quiet", () => {
    // 11 full sessions of 6 bars. The 12th session is only 2 bars in, and it is
    // running hot: each bar is 3× its slot's norm.
    const base = (k: number) => (k === 0 ? 1000 : 200) + k;
    const bars: VolumeBar[] = [];
    const dayStart = Date.UTC(2026, 0, 1, 14, 30) / 1000;
    for (let s = 0; s < 11; s++) {
      for (let k = 0; k < 6; k++) {
        bars.push({
          time: dayStart + s * 86_400 + k * 300,
          volume: base(k) * (1 + 0.04 * (s % 5)),
        });
      }
    }
    for (let k = 0; k < 2; k++) {
      bars.push({ time: dayStart + 11 * 86_400 + k * 300, volume: base(k) * 3 });
    }

    const last = bars.length - 1;
    const zBar = volumeZ(bars, { lookback: 20, mode: "bar" })[last] as number;
    const zCum = volumeZ(bars, { lookback: 20, mode: "cum" })[last] as number;
    assert.ok(zBar > 2, `bar-mode z ${zBar}`);
    assert.ok(zCum > 2, `cum-mode z ${zCum}`);

    // The real difference: a session that is hot but whose CURRENT bar is only
    // half printed. Bar mode reports it as below normal; cum mode keeps the
    // session's heat because the baseline is also partial.
    const partial = [...bars];
    partial[last] = { ...partial[last], volume: base(1) * 0.5 };
    const pBar = volumeZ(partial, { lookback: 20, mode: "bar" })[last] as number;
    const pCum = volumeZ(partial, { lookback: 20, mode: "cum" })[last] as number;
    assert.ok(pBar < 0, `bar-mode z on a half-printed bar was ${pBar}`);
    assert.ok(pCum > 1, `cum-mode z on a hot session was ${pCum}`);
  });

  it("is ignored on daily bars, which have no partial-bar problem", () => {
    const vols = [100, 120, 90, 110, 95, 130, 85, 105, 115, 100, 500];
    const a = volumeZ(daily(vols), { lookback: 20, mode: "bar" });
    const b = volumeZ(daily(vols), { lookback: 20, mode: "cum" });
    assert.deepEqual(a, b);
  });
});
