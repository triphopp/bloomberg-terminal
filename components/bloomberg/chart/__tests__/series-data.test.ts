import assert from "node:assert/strict";
import { test } from "node:test";

import { setSeriesData, tailStart } from "../series-data.ts";

/**
 * A fake series that applies setData/update the way lightweight-charts does —
 * including rewriting the objects it is handed (LW turns a "YYYY-MM-DD" time
 * into a BusinessDay object and adds `_internal_originalTime`).
 */
function fakeSeries() {
  const mangle = (p: Record<string, unknown>) => {
    p._internal_originalTime = p.time;
    p.time = { mangled: p.time };
  };
  const s = {
    data: [] as { time: number; [k: string]: unknown }[],
    sets: 0,
    updates: 0,
    setData(d: { time: number }[]) {
      s.sets++;
      s.data = d.map((p) => ({ ...p }));
      for (const p of d) mangle(p as unknown as Record<string, unknown>);
    },
    update(p: { time: number }) {
      s.updates++;
      const last = s.data[s.data.length - 1];
      if (last && last.time === p.time) s.data[s.data.length - 1] = { ...p };
      else if (!last || p.time > last.time) s.data.push({ ...p });
      else throw new Error("update() older than last bar");
      mangle(p as unknown as Record<string, unknown>);
    },
  };
  return s;
}

const bars = (n: number, f = 0) =>
  Array.from({ length: n }, (_, i) => ({
    time: i,
    open: i,
    high: i + 1,
    low: i - 1,
    close: i + f,
  }));

test("baseline survives the series rewriting pushed objects", () => {
  const s = fakeSeries();
  setSeriesData(s, bars(20));
  const t = bars(20);
  t[19].close = 99;
  setSeriesData(s, t); // would be a full setData if the baseline were the mangled objects
  assert.equal(s.sets, 1);
  assert.equal(s.updates, 1);
});

test("a tick on the last bar is one update, and the series equals setData's result", () => {
  const s = fakeSeries();
  setSeriesData(s, bars(500));
  const b = bars(500); // new objects, same values — as callers rebuild
  b[499] = { ...b[499], close: 1234 };
  const expected = b.map((p) => ({ ...p }));
  setSeriesData(s, b);
  assert.equal(s.sets, 1);
  assert.equal(s.updates, 1);
  assert.deepEqual(s.data, expected);
});

test("a new bar appends via update; an unchanged array is a no-op", () => {
  const s = fakeSeries();
  const a = bars(100);
  setSeriesData(s, a);
  const b = [...bars(100), { time: 100, open: 1, high: 2, low: 0, close: 1 }];
  const expected = b.map((p) => ({ ...p }));
  setSeriesData(s, b);
  assert.deepEqual(s.data, expected);
  setSeriesData(
    s,
    expected.map((p) => ({ ...p }))
  );
  assert.equal(s.sets, 1);
  assert.equal(s.updates, 1);
});

test("changed history, shorter data, prepended bars, new fields → full setData", () => {
  for (const mutate of [
    (b: ReturnType<typeof bars>) => {
      b[10] = { ...b[10], close: -5 };
      return b;
    },
    (b: ReturnType<typeof bars>) => b.slice(0, -1),
    (b: ReturnType<typeof bars>) => [{ time: -1, open: 0, high: 0, low: 0, close: 0 }, ...b],
    (b: ReturnType<typeof bars>) => b.map((p, i) => (i === 3 ? { ...p, color: "red" } : p)),
    (b: ReturnType<typeof bars>) => [...b.slice(0, -1), { ...b[b.length - 1], time: 999 }],
  ]) {
    const s = fakeSeries();
    setSeriesData(s, bars(50));
    const next = mutate(bars(50));
    const expected = next.map((p) => ({ ...p }));
    setSeriesData(s, next);
    assert.equal(s.sets, 2, `expected a full setData for ${mutate}`);
    assert.deepEqual(s.data, expected);
  }
});

test("randomised: the series always ends up equal to the last array pushed", () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const s = fakeSeries();
  // `cur` is our own pristine copy; each push gets fresh objects (callers
  // rebuild), which the fake then mangles.
  let cur = bars(200);
  setSeriesData(
    s,
    cur.map((p) => ({ ...p }))
  );
  for (let step = 0; step < 3000; step++) {
    const r = rnd();
    let next = cur.map((p) => ({ ...p }));
    if (r < 0.6) next[next.length - 1].close = rnd();
    else if (r < 0.8)
      next.push({ time: next[next.length - 1].time + 1, open: 1, high: 1, low: 1, close: rnd() });
    else if (r < 0.9) next[Math.floor(rnd() * (next.length - 1))].close = rnd();
    else next = next.slice(1);
    setSeriesData(
      s,
      next.map((p) => ({ ...p }))
    );
    assert.deepEqual(s.data, next, `step ${step}`);
    cur = next;
  }
  assert.ok(
    s.updates > s.sets * 3,
    `expected mostly updates (updates ${s.updates}, sets ${s.sets})`
  );
});

test("tailStart edge cases", () => {
  assert.equal(tailStart([], bars(3)), -1);
  assert.equal(tailStart(bars(3), bars(3)), 3);
  assert.equal(tailStart(bars(3), bars(5)), -1);
  assert.equal(tailStart([{ time: 1, value: Number.NaN }], [{ time: 1, value: Number.NaN }]), 1);
  // appended point older than / equal to the last one, or not comparable → setData
  assert.equal(tailStart([{ time: 5 }], [{ time: 5 }, { time: 4 }]), -1);
  assert.equal(tailStart([{ time: 5 }], [{ time: 5 }, { time: 5 }]), -1);
  assert.equal(
    tailStart([{ time: "2026-09-25" }], [{ time: "2026-09-25" }, { time: "2026-09-26" }]),
    1
  );
  assert.equal(
    tailStart([{ time: { year: 2026 } }], [{ time: { year: 2026 } }, { time: { year: 2027 } }]),
    -1
  );
});
