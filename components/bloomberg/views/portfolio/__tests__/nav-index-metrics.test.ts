import assert from "node:assert/strict";
import test from "node:test";
import { indexRiskMetrics, runningDrawdownPct } from "../ui/nav-index-metrics.ts";

test("underwater series resets at a new high and preserves missing benchmark dates", () => {
  const values = runningDrawdownPct([100, 120, 90, null, 110, 130, 117]);
  assert.deepEqual(values.slice(0, 2), [0, 0]);
  assert.equal(values[2], -25);
  assert.equal(values[3], null);
  assert.ok(Math.abs((values[4] as number) - -8.333333333333332) < 1e-10);
  assert.equal(values[5], 0);
  assert.ok(Math.abs((values[6] as number) - -10) < 1e-10);
});

test("worst plotted underwater point equals max drawdown KPI", () => {
  const levels = [100, 120, 90, 110, 105];
  const underwater = runningDrawdownPct(levels).filter((v): v is number => v !== null);
  assert.equal(-Math.min(...underwater), indexRiskMetrics(levels).maxDrawdownPct);
});

test("max drawdown uses the previous peak, including a recovery", () => {
  const metrics = indexRiskMetrics([100, 120, 90, 110, 105]);
  assert.equal(metrics.maxDrawdownPct, 25);
  assert.ok(metrics.stdAnnualPct !== null && metrics.stdAnnualPct > 0);
});

test("annualized standard deviation uses sample daily returns, not index levels", () => {
  const metrics = indexRiskMetrics([100, 110, 99]); // returns +10%, then -10%
  assert.ok(metrics.stdAnnualPct !== null);
  assert.ok(Math.abs(metrics.stdAnnualPct - Math.sqrt(0.02 * 252) * 100) < 1e-10);
  assert.equal(metrics.maxDrawdownPct, 10);
});

test("missing benchmark and short series display unavailable values", () => {
  assert.deepEqual(indexRiskMetrics([null, null]), {
    maxDrawdownPct: null,
    stdAnnualPct: null,
  });
  assert.deepEqual(indexRiskMetrics([100, 95]), {
    maxDrawdownPct: 5,
    stdAnnualPct: null,
  });
  assert.equal(indexRiskMetrics([null, 100, 110, 99]).maxDrawdownPct, 10);
});
