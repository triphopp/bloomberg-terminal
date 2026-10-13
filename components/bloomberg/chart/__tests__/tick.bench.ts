/**
 * What one live tick costs the chart's indicators — `npm run bench:chart`.
 *
 * Not a test and not run in CI: wall-clock numbers, printed. For each size it
 * replays live ticks the way the app delivers them (ChartPanel rebuilds every
 * bar object from the cached rows, so no bar keeps its identity) and times:
 *
 *   compute()   the indicator's full output, every point built
 *   + diff      comparing those points with the last push (`setSeriesData`) —
 *               together, what a tick cost every indicator before the columnar
 *               engine, and what a compute-only indicator still pays
 *   engine      the chart's own refill (`refillSeries`): typed columns, the
 *               bars compared once, only the tail built and sent
 *
 * then the same for the "busy set" — EMA 20, EMA 50, SMA, Bollinger, RSI,
 * MACD, volume, ATR regime — which is the figure plans/chart-indicator-engine.md
 * tracks. The series are stand-ins with empty `setData` / `update`: the
 * library's own cost is not what is being measured.
 *
 *   node components/bloomberg/chart/__tests__/tick.bench.ts [bars ...]
 */

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { outlineBars } from "../bar-borders.ts";
import { barColumns, barsDelta } from "../columns.ts";
import { INDICATOR_REGISTRY } from "../indicators/index.ts";
import { fillSeries, indicatorOutputs, refillSeries } from "../refill.ts";
import { type SeriesLike, setSeriesData } from "../series-data.ts";
import type { ChartIndicator, OhlcvBar } from "../types.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

interface Row {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function rows(n: number): Row[] {
  const out: Row[] = [];
  let p = 100;
  const t0 = Date.UTC(1890, 0, 2);
  for (let i = 0; i < n; i++) {
    const o = p;
    p *= 1 + (Math.sin(i * 0.37) * 0.5 + (((i * 7919) % 13) - 6) / 12) * 0.02;
    out.push({
      date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 19),
      open: o,
      high: Math.max(o, p) * 1.004,
      low: Math.min(o, p) * 0.996,
      close: p,
      volume: i % 17 === 0 ? 0 : 1e6 + ((i * 104729) % 23) * 1e5,
    });
  }
  return out;
}

/** As ChartPanel builds `ohlcv`: new objects and new time strings on every change. */
const toBars = (rs: Row[]): OhlcvBar[] =>
  rs.map((q) => ({
    time: q.date.slice(0, 10),
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume ?? undefined,
  }));

/** As chartkit/live-bars.ts folds a quote into the cached history. */
function tick(rs: Row[], k: number): Row[] {
  const last = rs[rs.length - 1];
  const p = last.close * (1 + ((k % 7) - 3) * 1e-4);
  return [
    ...rs.slice(0, -1),
    { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) },
  ];
}

// biome-ignore lint/suspicious/noExplicitAny: a series stand-in takes any point
const fake = (): SeriesLike<any> => ({ setData() {}, update() {} });
const KINDS = ["line", "histogram"] as const;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

interface Timing {
  series: number;
  /** compute(): every point built. */
  compute: number;
  /** setSeriesData on those points. */
  diff: number;
  /** barColumns + barsDelta, once per tick for all indicators. */
  shared: number;
  /** refillSeries for the indicators. */
  engine: number;
  /** The candle series' own push: compared point by point … */
  candle: number;
  /** … and told by the bars' delta where it changed. */
  engineCandle: number;
}

function measure(indicators: ChartIndicator[], n: number, ticks: number): Timing {
  let rs = rows(n);
  const bars = toBars(rs);

  // ── the points path ──
  const pointSeries = new Map<string, SeriesLike<unknown>>();
  const candle = fake();
  const points = (b: OhlcvBar[], t: Timing) => {
    let t0 = performance.now();
    setSeriesData(candle, outlineBars(b, []));
    t.candle += performance.now() - t0;
    for (const ind of indicators) {
      if (b.length < ind.minBars) continue;
      t0 = performance.now();
      const outs = ind.compute(b, ind.config).filter((o) => o.type !== "heatmap");
      const t1 = performance.now();
      for (const o of outs) {
        const key = `${ind.id}/${o.id}`;
        let s = pointSeries.get(key);
        if (!s) {
          s = fake();
          pointSeries.set(key, s);
        }
        setSeriesData(s, o.data);
      }
      t.compute += t1 - t0;
      t.diff += performance.now() - t1;
    }
  };

  // ── the engine path: what ModularChart's refill does ──
  const built = indicators.map((ind) =>
    bars.length < ind.minBars
      ? []
      : indicatorOutputs(ind, bars)
          .filter((o) => o.type !== "heatmap")
          .map((o) => {
            const s = fake();
            fillSeries(s, o, bars);
            return s;
          })
  );
  const engineCandle = fake();
  setSeriesData(engineCandle, outlineBars(bars, []));
  let drawn = bars;
  const engine = (b: OhlcvBar[], t: Timing) => {
    const t0 = performance.now();
    const delta = barsDelta(barColumns(drawn), barColumns(b));
    const t1 = performance.now();
    setSeriesData(engineCandle, outlineBars(b, []), delta);
    const t2 = performance.now();
    for (const [i, ind] of indicators.entries())
      refillSeries(ind, built[i], b, KINDS, undefined, delta);
    t.shared += t1 - t0;
    t.engineCandle += t2 - t1;
    t.engine += performance.now() - t2;
    drawn = b;
  };

  const zero = (): Timing => ({
    series: 0,
    compute: 0,
    diff: 0,
    shared: 0,
    engine: 0,
    candle: 0,
    engineCandle: 0,
  });
  // Each path gets its own bar array per tick, as it would in the app: the
  // column view is cached on the array, and a path must not find it prebuilt.
  const step = (k: number, t: Timing) => {
    rs = tick(rs, k);
    points(toBars(rs), t);
    engine(toBars(rs), t);
  };
  points(bars, zero());
  for (let k = 0; k < 30; k++) step(k, zero()); // warm the JIT
  const samples: Timing[] = [];
  for (let k = 0; k < ticks; k++) {
    // A collection inside a timed tick doubles it; at 50,000 bars a tick
    // allocates enough to bring one on every few ticks, so collect more often.
    if (k % (n >= 50_000 ? 2 : 8) === 0) gc();
    const t = zero();
    step(k + 31, t);
    samples.push(t);
  }
  const mid = (f: (t: Timing) => number) => median(samples.map(f));
  return {
    series: built.reduce((a, b) => a + b.length, 0),
    compute: mid((t) => t.compute),
    diff: mid((t) => t.diff),
    shared: mid((t) => t.shared),
    engine: mid((t) => t.engine),
    candle: mid((t) => t.candle),
    engineCandle: mid((t) => t.engineCandle),
  };
}

const f = (ms: number) =>
  (ms < 0.9995 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`).padStart(9);

const make = (id: string, cfg: Record<string, number | string | boolean> = {}): ChartIndicator => {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === id);
  if (!entry) throw new Error(`no indicator ${id}`);
  return entry.factory(cfg);
};

const BUSY = (): ChartIndicator[] => [
  make("ema", { period: 20 }),
  make("ema", { period: 50 }),
  make("sma"),
  make("bollinger"),
  make("rsi"),
  make("macd"),
  make("volume"),
  make("atr-regime"),
];

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
for (const n of sizes.length ? sizes : [1250, 10_000, 50_000]) {
  const ticks = n >= 50_000 ? 40 : 120;
  console.log(`\n${n.toLocaleString("en-US")} bars — median of ${ticks} ticks`);
  console.log(`  ${"indicator".padEnd(15)} series  compute()     + diff  │   engine`);
  for (const e of INDICATOR_REGISTRY) {
    const r = measure([e.factory({})], n, Math.max(30, ticks / 2));
    const note = e.factory({}).columns
      ? ""
      : r.series
        ? "  (compute only)"
        : "  (no series without its data)";
    console.log(
      `  ${e.id.padEnd(15)} ${String(r.series).padStart(4)}  ${f(r.compute)}  ${f(r.diff)}  │${f(r.engine)}${note}`
    );
  }
  const b = measure(BUSY(), n, ticks);
  const before = b.compute + b.diff;
  const after = b.shared + b.engine;
  console.log(
    `  busy set (${b.series} series)\n    points path  compute ${f(b.compute)} + diff ${f(b.diff)} = ${f(before)}\n    engine       columns + bars delta ${f(b.shared)} + indicators ${f(b.engine)} = ${f(after)}   (${(before / after).toFixed(1)}× less than the points path)\n    candle series push  ${f(b.candle)} compared point by point → ${f(b.engineCandle)} with the bars' delta`
  );
}
