import assert from "node:assert/strict";
import { test } from "node:test";

import { calcIchimoku, createIchimoku, readIchimokuConfig } from "../indicators/ichimoku.ts";
import type { OhlcvBar } from "../types.ts";

/** Deterministic wobble so highs/lows move in both directions. */
function bars(n: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + 10 * Math.sin(i / 7) + i * 0.1;
    out.push({ time: i * 86400, open: c, high: c + 1 + (i % 3), low: c - 1 - (i % 4), close: c });
  }
  return out;
}

const mid = (data: OhlcvBar[], end: number, period: number) => {
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (let j = end - period + 1; j <= end; j++) {
    hi = Math.max(hi, data[j].high);
    lo = Math.min(lo, data[j].low);
  }
  return (hi + lo) / 2;
};

test("lines equal the brute-force midpoints, spans displaced shift − 1 ahead", () => {
  const data = bars(200);
  const cfg = readIchimokuConfig({});
  const r = calcIchimoku(data, cfg);
  assert.equal(r.offset, 25);
  assert.equal(r.spanA.length, 200 + 25);
  for (let i = 0; i < 200; i++) {
    if (i >= 8) assert.ok(Math.abs(r.tenkan[i] - mid(data, i, 9)) < 1e-12);
    else assert.ok(Number.isNaN(r.tenkan[i]));
    if (i >= 25) {
      assert.ok(Math.abs(r.kijun[i] - mid(data, i, 26)) < 1e-12);
      const a = (mid(data, i, 9) + mid(data, i, 26)) / 2;
      assert.ok(Math.abs(r.spanA[i + 25] - a) < 1e-12);
    }
    if (i >= 51) assert.ok(Math.abs(r.spanB[i + 25] - mid(data, i, 52)) < 1e-12);
  }
  // Nothing plotted before the first displaced value.
  for (let p = 0; p < 25 + 25; p++) assert.ok(Number.isNaN(r.spanA[p]));
});

test("compute: series stay on existing bars, chikou is the close shifted back", () => {
  const data = bars(120);
  const ind = createIchimoku({});
  const out = ind.compute(data, ind.config);
  const ids = out.map((s) => s.id);
  assert.deepEqual(ids, [
    "ichimoku-span-a",
    "ichimoku-span-b",
    "ichimoku-tenkan",
    "ichimoku-kijun",
    "ichimoku-chikou",
  ]);
  const times = new Set(data.map((d) => d.time));
  for (const s of out) for (const p of s.data) assert.ok(times.has(p.time));
  const chikou = out[4].data as { time: number; value: number }[];
  assert.equal(chikou.length, 120 - 25);
  assert.equal(chikou[0].time, data[0].time);
  assert.equal(chikou[0].value, data[25].close);
});

test("chikou can be hidden; settings change the instance id", () => {
  const off = createIchimoku({ chikou: "off" });
  assert.equal(off.compute(bars(80), off.config).length, 4);
  assert.notEqual(createIchimoku({ tenkan: 10 }).id, createIchimoku({}).id);
});
