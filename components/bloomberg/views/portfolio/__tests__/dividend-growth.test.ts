import assert from "node:assert/strict";
import test from "node:test";
import {
  type DividendRow,
  dividendGrowth,
  growthWindows,
  rollingTtm,
} from "../ui/dividend-growth.ts";

const row = (
  asset: string,
  pay: string,
  dps: number,
  units: number,
  fx = 1,
  currency = "THB"
): DividendRow => ({
  asset,
  ex_date: pay,
  pay_date: pay,
  amount_per_unit: dps,
  total_received: dps * units,
  total_received_base: dps * units * fx,
  currency,
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("TTM and YTD windows: a year each, no gap, 29 Feb falls back", () => {
  assert.deepEqual(growthWindows("TTM", "2026-11-25"), {
    current: { start: "2025-11-26", end: "2026-11-25" },
    prior: { start: "2024-11-26", end: "2025-11-25" },
  });
  assert.deepEqual(growthWindows("YTD", "2026-11-25"), {
    current: { start: "2026-01-01", end: "2026-11-25" },
    prior: { start: "2025-01-01", end: "2025-11-25" },
  });
  assert.equal(growthWindows("YTD", "2028-02-29").prior.end, "2027-02-28");
});

test("bridge parts add up to the change, per asset and in total", () => {
  const rows = [
    // A: same 1,000 units, dividend per unit 1.00 → 1.20  → all DPS
    row("A", "2025-03-10", 1, 1000),
    row("A", "2026-03-10", 1.2, 1000),
    // B: dividend unchanged, 500 → 800 units          → all UNITS
    row("B", "2025-05-01", 2, 500),
    row("B", "2026-05-01", 2, 800),
    // C: USD stock, same dps and units, THB per USD 35 → 33 → all FX
    row("C", "2025-06-01", 0.5, 100, 35, "USD"),
    row("C", "2026-06-01", 0.5, 100, 33, "USD"),
    // D only now, E only before
    row("D", "2026-08-01", 3, 10),
    row("E", "2025-08-01", 4, 10),
  ];
  const g = dividendGrowth(rows, "TTM", "2026-11-25");
  const by = Object.fromEntries(g.assets.map((a) => [a.asset, a]));
  assert.equal(by.A.kind, "DPS_UP");
  assert.ok(close(by.A.dpsEffect, 200) && close(by.A.unitsEffect, 0));
  assert.equal(by.B.kind, "UNITS_UP");
  assert.ok(close(by.B.unitsEffect, 600) && close(by.B.dpsEffect, 0));
  assert.equal(by.C.kind, "FX");
  assert.ok(close(by.C.fxEffect, -100));
  assert.equal(by.D.kind, "NEW");
  assert.equal(by.E.kind, "STOPPED");
  for (const a of g.assets) {
    const parts = a.newEffect + a.stoppedEffect + a.fxEffect + a.unitsEffect + a.dpsEffect;
    assert.ok(close(parts, a.delta), a.asset);
  }
  const b = g.bridge;
  assert.ok(close(b.prior + b.newPayers + b.stopped + b.fx + b.units + b.dps, b.current));
  assert.equal(g.totalPrior, 1000 + 1000 + 1750 + 40);
  assert.equal(g.totalCurrent, 1200 + 1600 + 1650 + 30);
  assert.equal(g.dpsRaised, 1);
  assert.equal(g.dpsHeld, 2);
  assert.equal(g.payersCurrent, 4);
  assert.equal(g.payersPrior, 4);
});

test("mixed change on one asset splits exactly, including FX", () => {
  const g = dividendGrowth(
    [row("X", "2025-02-01", 0.4, 300, 34, "USD"), row("X", "2026-02-01", 0.5, 360, 31, "USD")],
    "TTM",
    "2026-11-25"
  );
  const x = g.assets[0];
  assert.ok(close(x.fxEffect + x.unitsEffect + x.dpsEffect, x.delta));
  assert.ok(close(x.dpsEffect, 31 * 0.1 * 300));
  assert.ok(close(x.unitsEffect, 31 * 60 * 0.5));
});

test("one ex-date paid to two accounts counts the dividend per unit once", () => {
  const g = dividendGrowth(
    [row("A", "2025-03-10", 1, 100), row("A", "2025-03-10", 1, 50), row("A", "2026-03-10", 1, 150)],
    "TTM",
    "2026-11-25"
  );
  const a = g.assets[0];
  assert.equal(a.dpsPrior, 1);
  assert.equal(a.unitsPrior, 150);
  assert.equal(a.kind, "SAME");
});

test("prior window before the first payout is flagged; zero payouts are ignored", () => {
  const g = dividendGrowth(
    [row("Z", "2022-08-25", 0, 10), row("A", "2025-06-01", 1, 10), row("A", "2026-06-01", 1, 20)],
    "TTM",
    "2026-11-25"
  );
  assert.equal(g.firstPayout, "2025-06-01");
  assert.equal(g.priorIncomplete, true);
  assert.equal(g.growthPct, 100);
  assert.equal(dividendGrowth([], "TTM", "2026-11-25").growthPct, null);
});

test("rolling TTM: monthly sums, 12-month window, first 11 points partial", () => {
  const rows = [
    row("A", "2025-01-15", 1, 100),
    row("A", "2025-07-15", 1, 100),
    row("A", "2026-01-15", 1, 120),
  ];
  const pts = rollingTtm(rows, "2026-03-31");
  assert.equal(pts[0].month, "2025-01");
  assert.equal(pts.at(-1)?.month, "2026-03");
  assert.equal(pts.length, 15);
  assert.equal(pts[10].partial, true);
  assert.equal(pts[11].partial, false);
  assert.equal(pts[11].ttm, 200); // 2025-12: Jan + Jul 2025
  assert.equal(pts[12].ttm, 220); // 2026-01: Jan 2025 dropped, Jan 2026 added
  assert.equal(pts[12].paid, 120);
});
