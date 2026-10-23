import assert from "node:assert/strict";
import test from "node:test";
import { PULSE_WINDOWS, buildPulse, netTone } from "../news-pulse.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test("each window has 24 columns", () => {
  for (const w of PULSE_WINDOWS) {
    const p = buildPulse([], { now: NOW, hours: w.hours, bucketHours: w.bucketHours });
    assert.equal(p.starts.length, 24, w.id);
    assert.equal(p.starts[23] + p.bucketMs, NOW);
  }
});

test("headlines land in their hour, oldest column first", () => {
  const p = buildPulse(
    [
      { symbols: ["AMD"], published_at: ago(0.2), sentiment: "NEG" },
      { symbols: ["AMD"], published_at: ago(5.5), sentiment: "POS" },
      { symbols: ["AMD"], published_at: ago(23.9), sentiment: "NEU" },
    ],
    { now: NOW, hours: 24, bucketHours: 1 }
  );
  const amd = p.rows[0];
  assert.deepEqual(amd.cells[23], { n: 1, pos: 0, neg: 1 });
  assert.deepEqual(amd.cells[18], { n: 1, pos: 1, neg: 0 });
  assert.deepEqual(amd.cells[0], { n: 1, pos: 0, neg: 0 });
  assert.deepEqual([amd.n, amd.pos, amd.neg], [3, 1, 1]);
});

test("a headline about two tickers counts on both rows, once each", () => {
  const p = buildPulse(
    [{ symbols: ["AVGO", "BE", "AVGO"], published_at: ago(4), sentiment: "POS" }],
    { now: NOW, hours: 24, bucketHours: 1 }
  );
  assert.deepEqual(
    p.rows.map((r) => [r.symbol, r.n]),
    [
      ["AVGO", 1],
      ["BE", 1],
    ]
  );
});

test("busiest rows first, capped, the rest counted", () => {
  const arts = [
    ...Array.from({ length: 3 }, () => ({
      symbols: ["MU"],
      published_at: ago(1),
      sentiment: "NEG" as const,
    })),
    ...Array.from({ length: 2 }, () => ({
      symbols: ["INTC"],
      published_at: ago(2),
      sentiment: "NEU" as const,
    })),
    { symbols: ["MSFT"], published_at: ago(3), sentiment: "NEU" as const },
  ];
  const p = buildPulse(arts, { now: NOW, hours: 24, bucketHours: 1, maxRows: 2 });
  assert.deepEqual(
    p.rows.map((r) => r.symbol),
    ["MU", "INTC"]
  );
  assert.equal(p.hidden, 1);
  assert.equal(p.maxCell, 3);
});

test("too old, in the future or undated is outside the grid", () => {
  const p = buildPulse(
    [
      { symbols: ["AMD"], published_at: ago(30), sentiment: "NEG" },
      { symbols: ["AMD"], published_at: ago(-1), sentiment: "NEG" },
      { symbols: ["AMD"], published_at: "", sentiment: "NEG" },
    ],
    { now: NOW, hours: 24, bucketHours: 1 }
  );
  assert.equal(p.rows.length, 0);
  assert.equal(p.outside, 3);
});

test("net tone", () => {
  assert.equal(netTone({ n: 4, pos: 3, neg: 1 }), 0.5);
  assert.equal(netTone({ n: 0, pos: 0, neg: 0 }), null);
});
