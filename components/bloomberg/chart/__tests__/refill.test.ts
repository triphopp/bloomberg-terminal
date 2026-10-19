/**
 * The tick path: columns in, `update()` for the tail when that is enough,
 * `setData` otherwise — and whichever it was, the series must hold exactly the
 * points a full recompute would give it.
 *
 * The series here is a stand-in that behaves the way lightweight-charts does:
 * `update()` replaces the last point or adds a newer one and THROWS on an older
 * time; both calls rewrite the objects they are handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type BarColumns, barColumns, barsDelta } from "../columns.ts";
import { INDICATOR_REGISTRY } from "../indicators/index.ts";
import { type SeriesOutput, fillSeries, indicatorOutputs, refillSeries } from "../refill.ts";
import {
  firstItemDiff,
  hasPoint,
  isCausal,
  itemAt,
  lastItemSlot,
  seriesPoints,
  toSeriesOutput,
} from "../series-columns.ts";
import { setSeriesColumns, setSeriesData } from "../series-data.ts";
import type { ChartIndicator, OhlcvBar, SeriesColumns } from "../types.ts";
import { lcg, makeBars, tickBars } from "./fixtures.ts";

type Point = { time: string | number; value?: number; color?: string };

function fakeSeries() {
  const mangle = (p: Record<string, unknown>) => {
    p._internal_originalTime = p.time;
    p.time = { mangled: p.time };
  };
  const s = {
    data: [] as Point[],
    sets: 0,
    updates: 0,
    setData(d: Point[]) {
      s.sets++;
      s.data = d.map((p) => ({ ...p }));
      for (const p of d) mangle(p as unknown as Record<string, unknown>);
    },
    update(p: Point) {
      s.updates++;
      const last = s.data[s.data.length - 1];
      if (last && last.time === p.time) s.data[s.data.length - 1] = { ...p };
      else if (!last || p.time > last.time) s.data.push({ ...p });
      else throw new Error(`update() older than last bar: ${p.time} <= ${last.time}`);
      mangle(p as unknown as Record<string, unknown>);
    },
  };
  return s;
}

const line = (values: number[], extra: Partial<SeriesColumns> = {}): SeriesColumns => ({
  id: "t",
  label: "t",
  type: "line",
  values: Float64Array.from(values),
  from: 0,
  emit: "all",
  ...extra,
});

const N = Number.NaN;

// ── columns ⇄ points ─────────────────────────────────────────────────────────

test("seriesPoints: every emit rule, whitespace, colours, and a start slot", () => {
  const times = [10, 20, 30, 40, 50];
  assert.deepStrictEqual(seriesPoints(line([1, N, 3, 4, 5], { from: 1 }), times), [
    { time: 20, value: N },
    { time: 30, value: 3 },
    { time: 40, value: 4 },
    { time: 50, value: 5 },
  ]);
  assert.deepStrictEqual(seriesPoints(line([1, N, 3, N, 5], { emit: "valued" }), times), [
    { time: 10, value: 1 },
    { time: 30, value: 3 },
    { time: 50, value: 5 },
  ]);
  assert.deepStrictEqual(
    seriesPoints(line([1, N, 3, N, 5], { emit: Uint8Array.from([0, 1, 1, 0, 0]) }), times),
    [
      { time: 20, value: N },
      { time: 30, value: 3 },
    ]
  );
  assert.deepStrictEqual(
    seriesPoints(
      line([N, 2, N, 4, 5], {
        emit: "valued",
        whitespace: true,
        from: 1,
        colors: Uint8Array.from([0, 1, 0, 0, 1]),
        palette: ["a", "b"],
      }),
      times
    ),
    [
      { time: 20, value: 2, color: "b" },
      { time: 30 },
      { time: 40, value: 4, color: "a" },
      { time: 50, value: 5, color: "b" },
    ]
  );
  assert.deepStrictEqual(seriesPoints(line([1, 2, 3, 4, 5]), times, 3), [
    { time: 40, value: 4 },
    { time: 50, value: 5 },
  ]);
  assert.deepStrictEqual(seriesPoints(line([1, 2, 3, 4, 5], { from: 9 }), times), []);
  assert.deepStrictEqual(seriesPoints(line([]), []), []);
});

test("toSeriesOutput keeps the series' own fields and nothing else", () => {
  const out = toSeriesOutput(
    line([1, 2], {
      color: "#fff",
      lineWidth: 2,
      priceScaleId: "x",
      colors: new Uint8Array(2),
      palette: ["a"],
    }),
    [1, 2]
  );
  assert.deepStrictEqual(out, {
    id: "t",
    label: "t",
    type: "line",
    color: "#fff",
    lineWidth: 2,
    priceScaleId: "x",
    data: [
      { time: 1, value: 1, color: "a" },
      { time: 2, value: 2, color: "a" },
    ],
  });
});

test("itemAt / hasPoint / lastItemSlot agree with seriesPoints", () => {
  const rnd = lcg(11);
  for (let round = 0; round < 300; round++) {
    const n = Math.floor(rnd() * 12);
    const values = Array.from({ length: n }, () => (rnd() < 0.3 ? N : rnd()));
    const mode = Math.floor(rnd() * 3);
    const s = line(values, {
      from: Math.floor(rnd() * 4),
      emit:
        mode === 0
          ? "all"
          : mode === 1
            ? "valued"
            : Uint8Array.from(values, () => (rnd() < 0.5 ? 1 : 0)),
      whitespace: rnd() < 0.3,
      ...(rnd() < 0.5
        ? { colors: Uint8Array.from(values, () => (rnd() < 0.5 ? 1 : 0)), palette: ["a", "b"] }
        : {}),
    });
    const times = values.map((_, i) => i * 10);
    const items = times.map((_, i) => itemAt(s, times, i));
    assert.deepStrictEqual(
      seriesPoints(s, times),
      items.filter((p) => p !== null)
    );
    assert.equal(
      lastItemSlot(s, n),
      items.findLastIndex((p) => p !== null)
    );
    for (let i = 0; i < n; i++) {
      assert.equal(hasPoint(s, i), items[i] !== null && "value" in (items[i] as object));
    }
  }
});

test("firstItemDiff: first slot that differs in value, mask or colour; NaN equals NaN", () => {
  const a = line([N, 1, 2, N, 4]);
  assert.equal(firstItemDiff(a, line([N, 1, 2, N, 4]), 5), 5);
  assert.equal(firstItemDiff(a, line([N, 1, 2, N, 9]), 5), 4);
  assert.equal(firstItemDiff(a, line([N, 1, 2, 3, 4]), 5), 3);
  assert.equal(firstItemDiff(a, line([N, 1, 2, N, 4, 5]), 5), 5);
  assert.equal(firstItemDiff(line([0]), line([-0]), 1), 0, "+0 and −0 are different points");
  const m = (bits: number[]) => line([1, 2, 3], { emit: Uint8Array.from(bits) });
  assert.equal(firstItemDiff(m([1, 1, 1]), m([1, 0, 1]), 3), 1);
  const c = (idx: number[]) =>
    line([1, 2, 3], { colors: Uint8Array.from(idx), palette: ["a", "b"] });
  assert.equal(firstItemDiff(c([0, 0, 1]), c([0, 0, 0]), 3), 2);
  // Slots before `from` are not part of the series.
  assert.equal(firstItemDiff(line([7, 1, 2], { from: 1 }), line([8, 1, 2], { from: 1 }), 3), 3);
});

// ── barsDelta ────────────────────────────────────────────────────────────────

test("barsDelta: a tick, a new bar, and everything that must be setData", () => {
  const base = makeBars(50, { seed: 2 });
  const cols = (b: OhlcvBar[]): BarColumns => barColumns(b);
  const rnd = lcg(5);

  const ticked = tickBars(base, rnd);
  assert.deepEqual(pick(barsDelta(cols(base), cols(ticked))), { tail: true, sameUntil: 49 });
  const appended = tickBars(base, rnd, true);
  assert.deepEqual(pick(barsDelta(cols(base), cols(appended))), { tail: true, sameUntil: 50 });
  const same = base.map((b) => ({ ...b }));
  assert.deepEqual(pick(barsDelta(cols(base), cols(same))), { tail: true, sameUntil: 50 });

  const edited = base.map((b, i) => (i === 20 ? { ...b, close: b.close * 1.01 } : { ...b }));
  assert.deepEqual(pick(barsDelta(cols(base), cols(edited))), { tail: true, sameUntil: 20 });
  const volume = base.map((b, i) => (i === 7 ? { ...b, volume: 123 } : { ...b }));
  assert.equal(barsDelta(cols(base), cols(volume)).sameUntil, 7);

  const not = (next: OhlcvBar[], why: string) =>
    assert.equal(barsDelta(cols(base), cols(next)).tail, false, why);
  not([{ ...base[0], time: "1800-01-01" }, ...base], "history prepended");
  not(base.slice(0, -1), "a bar removed");
  not(base.slice(1), "a bar dropped from the front");
  not([...appended, ...tickBars(appended, rnd, true).slice(-1)], "two bars added");
  not([...base.slice(0, -1), { ...base[49], time: "2999-01-01" }], "last bar changed its time");
  not([...base, { ...base[49] }], "appended bar is not newer");
  not([...base, { ...base[49], time: 99 }], "appended time of another kind");
  not(makeBars(50, { seed: 3, times: "intraday" }), "another time axis");
  assert.equal(barsDelta(cols([]), cols(base)).tail, false, "nothing was drawn before");

  // A broken print is the same broken print on the next tick.
  const broken = base.map((b, i) => (i === 10 ? { ...b, close: Number.NaN } : { ...b }));
  assert.equal(barsDelta(cols(broken), cols(tickBars(broken, rnd))).sameUntil, 49);
});

const pick = (d: { tail: boolean; sameUntil: number }) => ({
  tail: d.tail,
  sameUntil: d.sameUntil,
});

// ── setSeriesColumns ─────────────────────────────────────────────────────────

/** Bars whose only purpose is to carry `n` ascending times and a known delta. */
function axis(n: number, lastClose = 0): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i,
    open: 1,
    high: 1,
    low: 1,
    close: i === n - 1 ? lastClose : 1,
  }));
}

test("a tick on the last bar is one update; a new bar one or two; no change none", () => {
  for (const causal of [false, true]) {
    const s = fakeSeries();
    let bars = barColumns(axis(100));
    let cols = line(Array.from({ length: 100 }, (_, i) => i));
    setSeriesColumns(s, cols, bars);
    assert.deepEqual([s.sets, s.updates], [1, 0]);

    const push = (values: number[], lastClose: number) => {
      const next = barColumns(axis(values.length, lastClose));
      cols = line(values);
      setSeriesColumns(s, cols, next, barsDelta(bars, next), causal);
      bars = next;
      assert.deepStrictEqual(s.data, seriesPoints(cols, next.times));
    };

    const v = Array.from({ length: 100 }, (_, i) => i);
    v[99] = 1234;
    push(v, 1);
    assert.deepEqual([s.sets, s.updates], [1, 1], `causal=${causal}: tick`);

    push([...v, 7], 2); // a new bar; the old last bar's close moved with it (axis())
    assert.equal(s.sets, 1);
    assert.ok(s.updates >= 2 && s.updates <= 3, `causal=${causal}: append`);

    const before = s.updates;
    push([...v, 7], 2);
    assert.deepEqual([s.sets, s.updates], [1, before], `causal=${causal}: unchanged`);
  }
});

test("without a delta, or with one for other bars, it is setData", () => {
  const s = fakeSeries();
  const a = barColumns(axis(20));
  const b = barColumns(axis(20, 5));
  const c = barColumns(axis(20, 6));
  const values = Array.from({ length: 20 }, (_, i) => i);
  setSeriesColumns(s, line(values), a);
  setSeriesColumns(s, line(values), b);
  assert.equal(s.sets, 2, "no delta");
  setSeriesColumns(s, line(values), c, barsDelta(a, c));
  assert.equal(s.sets, 3, "delta from bars that are not the ones on screen");
  setSeriesColumns(s, line(values), barColumns(axis(20, 7)), barsDelta(c, a));
  assert.equal(s.sets, 4, "delta to bars that are not the ones being drawn");
});

test("a changed earlier point, a lost last point, a new layout → setData", () => {
  const start = () => {
    const s = fakeSeries();
    const bars = barColumns(axis(30));
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    setSeriesColumns(s, line(values, { emit: "valued" }), bars);
    return { s, bars, values };
  };
  const step = (mutate: (v: number[]) => SeriesColumns, causal = false) => {
    const { s, bars, values } = start();
    const next = barColumns(axis(30, 9));
    const cols = mutate([...values]);
    setSeriesColumns(s, cols, next, barsDelta(bars, next), causal);
    assert.deepStrictEqual(s.data, seriesPoints(cols, next.times));
    return s;
  };

  const valued = { emit: "valued" } as const;
  assert.equal(step((v) => line(v.with(10, -5), valued)).sets, 2, "history");
  assert.equal(step((v) => line(v.with(29, N), valued)).sets, 2, "last point gone");
  assert.equal(step((v) => line(v, { emit: "all" })).sets, 2, "emit rule changed");
  assert.equal(step((v) => line(v, { emit: "valued", from: 3 })).sets, 2, "warm-up moved");
  assert.equal(
    step((v) => line(v, { emit: "valued", colors: new Uint8Array(30), palette: ["a"] })).sets,
    2,
    "gained colours"
  );
  // The last point changing is an update either way.
  assert.equal(step((v) => line(v.with(29, 99), valued)).sets, 1);
  assert.equal(step((v) => line(v.with(29, 99), valued), true).sets, 1);
});

test("a causal series is not looked at before the first changed bar", () => {
  // The flag is a promise. A series that breaks it shows what the promise
  // buys: slot 3 changed and nothing was sent for it.
  const s = fakeSeries();
  const bars = barColumns(axis(10));
  setSeriesColumns(s, line([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), bars);
  const next = barColumns(axis(10, 4));
  setSeriesColumns(s, line([0, 1, 2, -3, 4, 5, 6, 7, 8, 90]), next, barsDelta(bars, next), true);
  assert.deepEqual([s.sets, s.updates], [1, 1]);
  assert.equal(s.data[3].value, 3);
  assert.equal(s.data[9].value, 90);

  // Unless a closed bar changed too — then it is compared like any other.
  const edited = axis(10, 4);
  edited[2] = { ...edited[2], close: 77 };
  const third = barColumns(edited);
  const cols = line([0, 1, -2, -3, 4, 5, 6, 7, 8, 90]);
  setSeriesColumns(s, cols, third, barsDelta(next, third), true);
  assert.equal(s.sets, 2);
  assert.deepStrictEqual(s.data, seriesPoints(cols, third.times));
});

test("whitespace: the last item turning to whitespace and back is an update", () => {
  const s = fakeSeries();
  let bars = barColumns(axis(8));
  const mk = (v: number[]) => line(v, { emit: "valued", whitespace: true });
  setSeriesColumns(s, mk([N, N, 3, 4, 5, 6, 7, 8]), bars);
  for (const [i, values] of [
    [N, N, 3, 4, 5, 6, 7, N],
    [N, N, 3, 4, 5, 6, 7, 1],
  ].entries()) {
    const next = barColumns(axis(8, i + 2));
    const cols = mk(values);
    setSeriesColumns(s, cols, next, barsDelta(bars, next));
    bars = next;
    assert.deepStrictEqual(s.data, seriesPoints(cols, next.times));
  }
  assert.deepEqual([s.sets, s.updates], [1, 2]);
});

test("randomised: the series always equals the columns last pushed", () => {
  const rnd = lcg(7);
  for (const causal of [false, true]) {
    const s = fakeSeries();
    let n = 120;
    let values = Array.from({ length: n }, () => (rnd() < 0.1 ? N : rnd()));
    let closes = Array.from({ length: n }, () => 1);
    const build = () => {
      const bars = barColumns(
        closes.map((close, i) => ({ time: i, open: 1, high: 1, low: 1, close }))
      );
      return { bars, cols: line(values, { emit: "valued" }) };
    };
    let cur = build();
    setSeriesColumns(s, cur.cols, cur.bars);
    for (let step = 0; step < 3000; step++) {
      const r = rnd();
      values = [...values];
      closes = [...closes];
      if (r < 0.6) {
        // tick: the last bar and the last value move (sometimes to "no point")
        closes[n - 1] = rnd();
        values[n - 1] = rnd() < 0.1 ? N : rnd();
      } else if (r < 0.8) {
        closes.push(rnd());
        values.push(rnd() < 0.2 ? N : rnd());
        n++;
      } else if (r < 0.9) {
        // a closed bar is corrected, and the series with it
        const i = Math.floor(rnd() * (n - 1));
        closes[i] = rnd();
        values[i] = rnd();
      } else if (n > 5) {
        values = values.slice(1);
        closes = closes.slice(1);
        n--;
      }
      const next = build();
      setSeriesColumns(s, next.cols, next.bars, barsDelta(cur.bars, next.bars), causal);
      cur = next;
      assert.deepStrictEqual(s.data, seriesPoints(cur.cols, cur.bars.times), `step ${step}`);
    }
    assert.ok(s.updates > s.sets * 2, `mostly updates (updates ${s.updates}, sets ${s.sets})`);
  }
});

// ── The candle series ────────────────────────────────────────────────────────

test("candle series: the bars' delta stands in for the point-by-point comparison", () => {
  const rnd = lcg(13);
  const s = fakeSeries();
  let bars = makeBars(200, { seed: 51 });
  const push = (next: OhlcvBar[], pushed: OhlcvBar[] = next) => {
    setSeriesData(s, pushed as never[], barsDelta(barColumns(bars), barColumns(next)));
    bars = next;
    assert.deepStrictEqual(s.data, pushed);
  };
  setSeriesData(s, bars as never[]);
  push(tickBars(bars, rnd));
  push(tickBars(bars, rnd, true));
  push(bars.map((b) => ({ ...b })));
  assert.deepEqual([s.sets, s.updates], [1, 2], "a tick, a new bar, an identical array");

  push(bars.map((b, i) => (i === 50 ? { ...b, close: b.close + 1 } : { ...b })));
  assert.equal(s.sets, 2, "a closed bar changed");
  push([{ ...bars[0], time: "1800-01-01" }, ...bars]);
  assert.equal(s.sets, 3, "history prepended");

  // An overlay marks a bar: what is pushed is no longer the bars array, so the
  // delta does not apply and the points are compared as before.
  const next = tickBars(bars, rnd);
  const marked = next.map((b, i) => (i === 7 ? { ...b, borderColor: "#f00" } : b));
  push(next, marked);
  assert.equal(s.sets, 4, "a bar gained a border");
  const again = tickBars(next, rnd);
  push(
    again,
    again.map((b, i) => (i === 7 ? { ...b, borderColor: "#f00" } : b))
  );
  assert.equal(s.sets, 4, "same mark, last bar moved: an update, found by comparing");
});

// ── Every columnar indicator, through the chart's own refill ─────────────────

const KINDS = ["line", "histogram"] as const;

/** What the chart holds for one indicator: a series per output, in order. */
function build(indicator: ChartIndicator, bars: OhlcvBar[]) {
  if (bars.length < indicator.minBars) return [];
  return indicatorOutputs(indicator, bars).map((output: SeriesOutput) => {
    const s = fakeSeries();
    fillSeries(s, output, bars);
    return s;
  });
}

/** The points a full recompute gives each series — the old path's answer. */
function expected(indicator: ChartIndicator, bars: OhlcvBar[]): Point[][] {
  if (bars.length < indicator.minBars) return [];
  return indicator.compute(bars, indicator.config).map((o) => o.data as Point[]);
}

type Event = "tick" | "append" | "volume" | "break" | "mend" | "edit" | "prepend" | "same";

function apply(bars: OhlcvBar[], event: Event, rnd: () => number): OhlcvBar[] {
  if (event === "tick") return tickBars(bars, rnd);
  if (event === "append") return tickBars(bars, rnd, true);
  const out = bars.map((b) => ({ ...b }));
  const last = out[out.length - 1];
  if (event === "volume") last.volume = (last.volume ?? 0) + 1e5 + Math.floor(rnd() * 1e5);
  else if (event === "break") last.high = Number.NaN;
  else if (event === "mend") last.high = Math.max(last.open, last.close, last.low);
  else if (event === "edit") {
    const i = Math.floor(rnd() * (out.length - 1));
    out[i].close *= 1.01;
    out[i].high = Math.max(out[i].high, out[i].close);
  } else if (event === "prepend") {
    const t = out[0].time;
    out.unshift({
      ...out[0],
      time:
        typeof t === "number"
          ? t - 300
          : new Date(Date.parse(t) - 86_400_000).toISOString().slice(0, 10),
    });
  }
  return out;
}

const SCRIPT: Event[] = [
  ...Array<Event>(6).fill("tick"),
  "append",
  "tick",
  "volume",
  "tick",
  "break",
  "tick",
  "mend",
  "append",
  "append",
  "tick",
  "same",
  "edit",
  "tick",
  "prepend",
  "tick",
  "append",
  ...Array<Event>(8).fill("tick"),
];

const STARTS: { name: string; bars: () => OhlcvBar[] }[] = [
  { name: "daily 400", bars: () => makeBars(400, { seed: 21 }) },
  { name: "intraday 330", bars: () => makeBars(330, { seed: 22, times: "intraday" }) },
  { name: "no volume yet", bars: () => makeBars(260, { seed: 23, volume: "none" }) },
  { name: "short history", bars: () => makeBars(45, { seed: 24, volume: "all" }) },
  { name: "broken prints", bars: () => makeBars(300, { seed: 25, nan: 0.02 }) },
];

const columnar = INDICATOR_REGISTRY.filter((e) => e.factory({}).columns);

for (const entry of columnar) {
  test(`refill ${entry.id}: after every tick the series hold a full recompute`, () => {
    const configs: Record<string, number | string | boolean>[] = [{}];
    if (entry.id.startsWith("bollinger")) configs.push({ fitMode: "sharpe" });
    if (entry.id === "ichimoku") configs.push({ shift: 3, tenkan: 3, kijun: 5, senkou: 8 });
    if (entry.id === "atr-regime") configs.push({ period: 3, lookback: 5, trendPeriod: 5 });
    for (const cfg of configs) {
      let indicator = entry.factory(cfg);
      for (const start of STARTS) {
        const rnd = lcg(entry.id.length * 131 + start.name.length);
        let bars = start.bars();
        if (indicator.id === "fear-greed") {
          const preloadedData = bars.map((b, i) => ({
            time:
              typeof b.time === "number"
                ? new Date(b.time * 1000).toISOString().slice(0, 10)
                : b.time,
            value: (i * 37) % 101,
          }));
          indicator = { ...indicator, config: { ...indicator.config, preloadedData } };
        }
        let series = build(indicator, bars);
        let rebuilt = 0;
        for (const [step, event] of SCRIPT.entries()) {
          const next = apply(bars, event, rnd);
          const delta = barsDelta(barColumns(bars), barColumns(next));
          if (!refillSeries(indicator, series, next, KINDS, undefined, delta)) {
            series = build(indicator, next); // the chart rebuilds on a structural change
            rebuilt++;
          }
          bars = next;
          assert.deepStrictEqual(
            series.map((s) => s.data),
            expected(indicator, bars),
            `${entry.id} ${JSON.stringify(cfg)} on "${start.name}", step ${step} (${event})`
          );
        }
        assert.ok(rebuilt <= 3, `${entry.id} on "${start.name}": ${rebuilt} rebuilds`);
      }
    }
  });
}

// Two indicators are not causal for reasons the script above rarely reaches.
// Each gets the case that makes it repaint, to show the compared path follows.

test("realized vol: a new bar that changes the inferred bar spacing rescales every point", () => {
  // 252 periods a year while the median gap is under five days, 52 once it is not.
  const day = 86_400;
  const gaps = [1, 1, 1, 1, 1, 1, 7, 7, 7, 7, 7];
  let t = 1_700_000_000;
  const rnd = lcg(17);
  let bars: OhlcvBar[] = gaps.map((g, i) => {
    t += g * day;
    const close = 100 + i + rnd();
    return { time: t, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1e6 };
  });
  const rv = INDICATOR_REGISTRY.find((e) => e.id === "realized-vol")?.factory({
    fast: 2,
    slow: 3,
    long: 4,
    estimator: "cc",
  });
  assert.ok(rv);
  const series = build(rv, bars);
  const firstPoint = () => series[0].data[0].value as number;
  const before = firstPoint();
  let rescaled = false;
  for (let k = 0; k < 3; k++) {
    const last = bars[bars.length - 1];
    const next = [
      ...bars.map((b) => ({ ...b })),
      { ...last, time: (last.time as number) + 7 * day, close: last.close + 1 },
    ];
    const delta = barsDelta(barColumns(bars), barColumns(next));
    assert.ok(refillSeries(rv, series, next, KINDS, undefined, delta));
    bars = next;
    assert.deepStrictEqual(
      series.map((s) => s.data),
      expected(rv, bars)
    );
    rescaled ||= firstPoint() !== before;
  }
  assert.ok(rescaled, "the spacing never flipped — the test no longer exercises the repaint");
  assert.ok(series[0].sets >= 2, "a rescale of every point is a setData");
});

test("Bollinger with fitted parameters: a closed bar that moves the fit redraws the bands", () => {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === "bollinger");
  assert.ok(entry);
  const fit = entry.factory({ fitMode: "sharpe" });
  const rnd = lcg(29);
  // A longer history revealed a bar at a time, with a tick between new bars.
  const history = makeBars(800, { seed: 77, volume: "all" });
  let shown = 420;
  let bars = history.slice(0, shown);
  const series = build(fit, bars);
  const labelOf = () => fit.compute(bars, fit.config)[0].label;
  const first = labelOf();
  let refits = 0;
  for (let k = 0; k < 400; k++) {
    const next =
      k % 2 === 1 ? history.slice(0, ++shown).map((b) => ({ ...b })) : tickBars(bars, rnd);
    const delta = barsDelta(barColumns(bars), barColumns(next));
    assert.ok(refillSeries(fit, series, next, ["line"], undefined, delta));
    const was = labelOf();
    bars = next;
    if (labelOf() !== was) refits++;
    assert.deepStrictEqual(
      series.map((s) => s.data),
      expected(fit, bars),
      `step ${k}`
    );
  }
  assert.ok(refits > 0, `the fit never moved from ${first} — the test no longer exercises a refit`);
  assert.ok(series[0].sets > 1, "a refit is a setData");
  assert.ok(series[0].updates > series[0].sets, "and between refits, updates");
});

test("a causal indicator sends a tick as updates only — no setData, no scan", () => {
  const flagged = columnar.map((e) => e.factory({})).filter(isCausal);
  assert.deepEqual(
    flagged.map((i) => i.id).sort(),
    [
      "bb-20-2",
      "bb-b-20-2",
      "bb-width-20-2",
      "ema-20",
      "macd-12-26-9",
      "rsi-14",
      "sma-20",
      "stoch-14-3-3",
      "volume",
      "vwap",
    ],
    "the causal set changed — every member must hold: slot i depends on bars 0..i only"
  );
  const rnd = lcg(3);
  for (const indicator of flagged) {
    let bars = makeBars(500, { seed: 31, volume: "all" });
    const series = build(indicator, bars);
    for (let k = 0; k < 20; k++) {
      const next = tickBars(bars, rnd, k % 5 === 4);
      // Keep volume on the new bar so the volume pane has a point to send.
      next[next.length - 1].volume = 1e6;
      const delta = barsDelta(barColumns(bars), barColumns(next));
      assert.ok(refillSeries(indicator, series, next, KINDS, undefined, delta));
      bars = next;
    }
    for (const s of series) {
      assert.equal(s.sets, 1, `${indicator.id}: setData after the first fill`);
      assert.ok(
        s.updates >= 20 && s.updates <= 40,
        `${indicator.id}: ${s.updates} updates in 20 ticks`
      );
    }
  }
  // Fitted Bollinger parameters read every closed bar: not causal.
  const fit = INDICATOR_REGISTRY.find((e) => e.id === "bollinger")?.factory({ fitMode: "sharpe" });
  assert.equal(fit && isCausal(fit), false);
});

test("indicators that only have compute() go through setSeriesData, labels included", () => {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === "zigzag");
  assert.ok(entry);
  const zigzag: ChartIndicator = entry.factory({ labels: "on" });
  assert.equal(zigzag.columns, undefined);
  let bars = makeBars(300, { seed: 41 });
  const outputs = indicatorOutputs(zigzag, bars).filter((o) => o.type === "line");
  const series = outputs.map((o) => {
    const s = fakeSeries();
    fillSeries(s, o, bars);
    return s;
  });
  const labels: unknown[][] = outputs.map(() => []);
  const labelers = outputs.map((o, i) =>
    "labels" in o && o.labels
      ? {
          setLabels(l: unknown[]) {
            labels[i] = l;
          },
        }
      : null
  );
  const rnd = lcg(9);
  for (let k = 0; k < 10; k++) {
    const next = tickBars(bars, rnd, k % 3 === 2);
    const delta = barsDelta(barColumns(bars), barColumns(next));
    if (!refillSeries(zigzag, series, next, ["line"], labelers, delta)) break;
    bars = next;
    const want = zigzag.compute(bars, zigzag.config).filter((o) => o.type === "line");
    assert.deepStrictEqual(
      series.map((s) => s.data),
      want.map((o) => o.data)
    );
    want.forEach((o, i) => o.labels && assert.deepStrictEqual(labels[i], o.labels));
  }
});
