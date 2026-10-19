/**
 * Generated bars for the engine tests and the tick benchmark — deterministic,
 * and deliberately awkward: gaps, zero-volume bars, a feed with no volume at
 * all, flat stretches, broken prints.
 */

import type { OhlcvBar } from "../types.ts";

export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 4294967296;
  };
}

export interface BarOpts {
  seed?: number;
  /** "daily" = "YYYY-MM-DD" strings; "intraday" = UNIX seconds, 5-minute bars in 78-bar sessions. */
  times?: "daily" | "intraday";
  /** Price level the walk starts at. */
  level?: number;
  /** "some" = a zero every 17th bar; "none" = the field is absent; "zero" = always 0. */
  volume?: "some" | "none" | "zero" | "all";
  /** Fraction of bars whose prices are replaced by NaN. */
  nan?: number;
  /** Fraction of bars that repeat the previous close exactly (zero range). */
  flat?: number;
}

export function makeBars(n: number, opts: BarOpts = {}): OhlcvBar[] {
  const { seed = 1, times = "daily", level = 100, volume = "some", nan = 0, flat = 0 } = opts;
  const rnd = lcg(seed);
  const out: OhlcvBar[] = [];
  let p = level;
  const day0 = Date.UTC(1890, 0, 2);
  const sec0 = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const time =
      times === "daily"
        ? new Date(day0 + i * 86_400_000).toISOString().slice(0, 10)
        : sec0 + Math.floor(i / 78) * 86_400 + (i % 78) * 300;
    const open = p;
    const still = rnd() < flat;
    if (!still) p *= 1 + (rnd() - 0.5) * 0.04;
    const hi = still ? p : Math.max(open, p) * (1 + rnd() * 0.01);
    const lo = still ? p : Math.min(open, p) * (1 - rnd() * 0.01);
    const bar: OhlcvBar = { time, open, high: hi, low: lo, close: p };
    const v = 1e6 + Math.floor(rnd() * 23) * 1e5;
    if (volume === "all") bar.volume = v;
    else if (volume === "some") bar.volume = i % 17 === 0 ? 0 : v;
    else if (volume === "zero") bar.volume = 0;
    if (rnd() < nan) {
      bar.open = Number.NaN;
      bar.high = Number.NaN;
      bar.low = Number.NaN;
      bar.close = Number.NaN;
    }
    out.push(bar);
  }
  return out;
}

/** A spread of datasets that between them reach every branch of the indicators. */
export function datasets(): { name: string; bars: OhlcvBar[] }[] {
  return [
    { name: "empty", bars: [] },
    { name: "1 bar", bars: makeBars(1) },
    { name: "13 bars", bars: makeBars(13, { seed: 3 }) },
    { name: "40 bars", bars: makeBars(40, { seed: 4 }) },
    { name: "daily 700", bars: makeBars(700, { seed: 5 }) },
    { name: "daily 2600, every bar has volume", bars: makeBars(2600, { seed: 6, volume: "all" }) },
    { name: "intraday 1900", bars: makeBars(1900, { seed: 7, times: "intraday" }) },
    { name: "no volume field", bars: makeBars(600, { seed: 8, volume: "none" }) },
    { name: "volume always 0", bars: makeBars(300, { seed: 9, volume: "zero" }) },
    { name: "high price level", bars: makeBars(900, { seed: 10, level: 50_000 }) },
    { name: "flat stretches", bars: makeBars(800, { seed: 11, flat: 0.3 }) },
    { name: "all flat", bars: makeBars(260, { seed: 12, flat: 1 }) },
    { name: "broken prints (NaN)", bars: makeBars(900, { seed: 13, nan: 0.02 }) },
    {
      name: "intraday, broken prints",
      bars: makeBars(700, { seed: 14, nan: 0.03, times: "intraday" }),
    },
  ];
}

/**
 * The next state of a live chart: the last bar moved (as chartkit/live-bars.ts
 * moves it), or a new bar opened. Closed bars are rebuilt as NEW objects —
 * ChartPanel maps the cached rows into fresh bars on every change, so nothing
 * downstream may rely on bar identity.
 */
export function tickBars(bars: readonly OhlcvBar[], rnd: () => number, append = false): OhlcvBar[] {
  const out = bars.map((b) => ({ ...b }));
  const last = out[out.length - 1];
  if (!last) return out;
  const price = (Number.isFinite(last.close) ? last.close : 100) * (1 + (rnd() - 0.5) * 0.01);
  if (!append) {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    return out;
  }
  const time =
    typeof last.time === "number"
      ? last.time + 300
      : new Date(Date.parse(last.time) + 86_400_000).toISOString().slice(0, 10);
  out.push({ time, open: price, high: price, low: price, close: price, volume: 0 });
  return out;
}
