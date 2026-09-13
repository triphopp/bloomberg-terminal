import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOLLINGER_DEVIATION_GRID,
  BOLLINGER_PERIOD_GRID,
  bollingerPercentB,
  calcBollingerStats,
  evaluateBollingerBreakout,
  fitBollingerSharpe,
  resolveBollingerParameters,
} from "../bollinger-fit.ts";
import { createBollingerB } from "../indicators/bollinger-b.ts";
import { createBollingerBands } from "../indicators/bollinger.ts";
import type { OhlcvBar } from "../types.ts";

function bars(closes: number[]): OhlcvBar[] {
  return closes.map((close, i) => ({
    time: 1_600_000_000 + i * 86400,
    open: i ? closes[i - 1] : close,
    close,
    high: Math.max(i ? closes[i - 1] : close, close),
    low: Math.min(i ? closes[i - 1] : close, close),
  }));
}

function sample(n = 801): OhlcvBar[] {
  return bars(
    Array.from(
      { length: n },
      (_, i) => 100 + i * 0.015 + 12 * Math.sin(i / 6) + 4 * Math.sin(i / 2.1)
    )
  );
}

function present<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

function near(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test("grid contains all 209 requested pairs including quarter-sigma endpoints", () => {
  assert.deepEqual(
    BOLLINGER_PERIOD_GRID,
    Array.from({ length: 19 }, (_, i) => 10 + i * 5)
  );
  assert.deepEqual(
    BOLLINGER_DEVIATION_GRID,
    Array.from({ length: 11 }, (_, i) => 1 + i / 4)
  );
});

test("population BB statistics and unbounded %B match hand calculations", () => {
  const s = calcBollingerStats(bars([1, 2, 3, 4, 5]), 5);
  assert.deepEqual(s.middle, [null, null, null, null, 3]);
  near(present(s.deviation[4]), Math.sqrt(2));
  near(bollingerPercentB(5, 3, Math.sqrt(2), 2), (5 - (3 - 2 * Math.sqrt(2))) / (4 * Math.sqrt(2)));
  assert.equal(bollingerPercentB(150, 100, 10, 2), 1.75);
  assert.equal(bollingerPercentB(50, 100, 10, 2), -0.75);
  assert.equal(bollingerPercentB(100, 100, 0, 2), 0.5);
});

test("breakout executes at NEXT open, excludes entry gap, includes held gaps and exit fees", () => {
  const data = bars([...Array(10).fill(100), 140, 220, 90, 100]);
  data[11].open = 200;
  data[13].open = 85;
  const result = evaluateBollingerBreakout(data, 10, 1, 10, 14, 10);
  const factors = [1, (0.999 * 220) / 200, 90 / 220, (85 / 90) * 0.999];
  result.returns.forEach((r, i) => near(r, factors[i] - 1));
  near(result.totalReturn, factors.reduce((a, b) => a * b, 1) - 1);
  assert.equal(result.trades, 1);
  const mean = result.returns.reduce((a, b) => a + b, 0) / 4;
  const sd = Math.sqrt(result.returns.reduce((s, r) => s + (r - mean) ** 2, 0) / 3);
  near(present(result.sharpe), mean / sd);
});

test("window-end liquidation charges the second side and includes flat bars", () => {
  const data = bars([...Array(10).fill(100), 140, 160]);
  const result = evaluateBollingerBreakout(data, 10, 1, 10, 12, 5);
  assert.equal(result.returns[0], 0);
  near(result.returns[1], (160 / 140) * 0.9995 ** 2 - 1);
  assert.equal(result.bars, 2);
  assert.equal(result.trades, 1);
});

test("short, flat, invalid prices, unordered dates and bad costs are unavailable", () => {
  assert.match(present(fitBollingerSharpe(sample(200)).reason), /201 bars/);
  const flat = fitBollingerSharpe(bars(Array(250).fill(100)));
  assert.equal(flat.status, "unavailable");
  assert.equal(flat.candidates, 209);
  assert.equal(flat.best, null);
  for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const data = sample();
    data[120].open = bad;
    assert.match(present(fitBollingerSharpe(data).reason), /finite positive/);
  }
  const data = sample();
  data[121].time = data[120].time;
  assert.match(present(fitBollingerSharpe(data).reason), /ordered/);
  for (const cost of [-1, Number.NaN, 101])
    assert.equal(fitBollingerSharpe(sample(), cost).status, "unavailable");
});

test("winner maximizes eligible training Sharpe on a common evaluation window", () => {
  const data = sample();
  const fit = fitBollingerSharpe(data);
  assert.equal(fit.status, "ok");
  assert.equal(fit.candidates, 209);
  assert.equal(fit.trainStart, 100);
  assert.equal(fit.split, 590);
  assert.equal(fit.end, 800);
  let eligible = 0;
  for (const n of BOLLINGER_PERIOD_GRID) {
    for (const k of BOLLINGER_DEVIATION_GRID) {
      const score = evaluateBollingerBreakout(data, n, k, 100, 590, 5);
      assert.equal(score.bars, 490);
      if (score.trades < 3 || score.sharpe == null) continue;
      eligible++;
      assert.ok(present(present(fit.best).train.sharpe) >= score.sharpe);
    }
  }
  assert.equal(fit.eligible, eligible);
  assert.equal(present(fit.holdout).bars, 210);
});

test("holdout price changes never influence chosen parameters or training scores", () => {
  const data = sample();
  const original = fitBollingerSharpe(data);
  const changed = data.map((bar, i) =>
    i < original.split ? { ...bar } : { ...bar, open: 1000 + i, close: 500 + i * (i % 2 ? 1 : 2) }
  );
  const after = fitBollingerSharpe(changed);
  assert.deepEqual(after.best, original.best);
  assert.equal(after.eligible, original.eligible);
  assert.notEqual(present(after.holdout).totalReturn, present(original.holdout).totalReturn);
});

test("newest candle is excluded even if it is still changing or invalid", () => {
  const data = sample();
  const first = fitBollingerSharpe(data);
  const changed = data.map((b) => ({ ...b }));
  changed[800].open = Number.NaN;
  changed[800].close = 9e12;
  assert.deepEqual(fitBollingerSharpe(changed), first);
});

test("zero-variance or no-trade strategy has unavailable Sharpe, never Infinity", () => {
  const result = evaluateBollingerBreakout(bars(Array(220).fill(100)), 20, 2, 100, 220, 0);
  assert.equal(result.sharpe, null);
  assert.equal(result.trades, 0);
  assert.equal(result.totalReturn, 0);
});

test("manual mode preserves n/k; fitted n is bars even with large DAYS-scaled manual period", () => {
  const data = sample();
  const settings = { period: 1560, stdDev: 2.75, fitMode: "manual" };
  assert.deepEqual(resolveBollingerParameters(data, settings), {
    period: 1560,
    stdDev: 2.75,
    fit: null,
  });
  const fitted = resolveBollingerParameters(data, { ...settings, fitMode: "sharpe" });
  assert.ok(BOLLINGER_PERIOD_GRID.includes(fitted.period));
  assert.equal(settings.period, 1560);
  assert.equal(resolveBollingerParameters(data, settings).stdDev, 2.75);
  const unavailable = resolveBollingerParameters(sample(40), {
    period: 25,
    stdDev: 2.25,
    fitMode: "sharpe",
  });
  assert.equal(unavailable.period, 25);
  assert.equal(present(unavailable.fit).status, "unavailable");
});

test("BB overlay and %B use the same fitted bands; manual defaults stay 20/2", () => {
  const data = sample();
  const bb = createBollingerBands({ fitMode: "sharpe" });
  const percent = createBollingerB({ fitMode: "sharpe" });
  const output = bb.compute(data, bb.config);
  const bOutput = percent.compute(data, percent.config);
  const upper = output[0].data as { time: number; value: number }[];
  const lower = output[2].data as { time: number; value: number }[];
  const bLine = bOutput[0].data as { time: number; value: number }[];
  assert.equal(bLine.length, upper.length);
  const byTime = new Map(data.map((bar) => [bar.time, bar.close]));
  bLine.forEach((point, i) =>
    near(
      point.value,
      (present(byTime.get(point.time)) - lower[i].value) / (upper[i].value - lower[i].value)
    )
  );
  const manual = createBollingerBands();
  assert.equal(manual.config.period, 20);
  assert.equal(manual.config.stdDev, 2);
  assert.equal(manual.config.fitMode, "manual");
  const m = manual.compute(data, manual.config)[1].data as { value: number }[];
  near(m[0].value, data.slice(0, 20).reduce((s, b) => s + b.close, 0) / 20);
});

test("cache is scoped to the dataset and cost assumptions", () => {
  const data = sample();
  assert.equal(fitBollingerSharpe(data), fitBollingerSharpe(data));
  assert.notEqual(fitBollingerSharpe(data, 0), fitBollingerSharpe(data, 5));
  assert.notEqual(fitBollingerSharpe(sample()), fitBollingerSharpe(data));
});

test("a negative best Sharpe is reported honestly instead of replaced with zero", () => {
  const data = bars(Array.from({ length: 801 }, (_, i) => 100 + 0.1 * Math.sin(i / 3)));
  const fit = fitBollingerSharpe(data, 100);
  assert.equal(fit.status, "ok");
  assert.ok(present(present(fit.best).train.sharpe) < 0);
});
