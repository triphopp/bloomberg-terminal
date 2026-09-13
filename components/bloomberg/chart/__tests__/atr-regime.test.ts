import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATR_REGIME_COLORS,
  ATR_REGIME_PARAMS,
  calcAtrRegime,
  createATR,
  resolveAtrConfig,
  validAtrInputs,
} from "../indicators/atr.ts";
import type { OhlcvBar } from "../types.ts";
import { scaleParamsToBars } from "../windowUnits.ts";

function bars(closes: number[], ranges: number[] = []): OhlcvBar[] {
  return closes.map((close, i) => ({
    time: 1_600_000_000 + i * 86400,
    open: close,
    close,
    high: close + (ranges[i] ?? 2) / 2,
    low: close - (ranges[i] ?? 2) / 2,
  }));
}

const fast = { period: 3, lookback: 5, trendPeriod: 5, slopeBars: 2 };
function sample(direction = 1): OhlcvBar[] {
  return bars(
    Array.from({ length: 80 }, (_, i) => 200 + direction * i * 0.2),
    Array.from({ length: 80 }, (_, i) => (i < 25 ? 8 : i < 50 ? 2 : 20))
  );
}
function present<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}
function near(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test("ATR seeds with mean true range then uses Wilder smoothing, including up/down gaps", () => {
  const data = bars([10, 14.5, 9, 9], [2, 1, 2, 2]);
  const result = calcAtrRegime(data, { period: 3 });
  assert.equal(result[0].atr, null);
  assert.equal(result[1].atr, null);
  // TR = 2, 5, 6.5, 2. ATR seed = 4.5; next = (4.5*2+2)/3.
  near(present(result[2].atr), 4.5);
  near(present(result[3].atr), 11 / 3);
  near(present(result[2].atrPercent), 50);
});

test("baseline uses exactly prior N ATR% values, excluding the current volatility shock", () => {
  const data = sample();
  const result = calcAtrRegime(data, fast);
  const expected = result.slice(45, 50).reduce((s, point) => s + present(point.atrPercent), 0) / 5;
  near(present(result[50].baselinePercent), expected);
  const changed = data.map((point, i) =>
    i === 50 ? { ...point, high: point.close + 70, low: point.close - 70 } : point
  );
  const shocked = calcAtrRegime(changed, fast);
  assert.equal(shocked[50].baselinePercent, result[50].baselinePercent);
  assert.ok(present(shocked[50].atrPercent) > present(result[50].atrPercent));
});

test("low ATR% plus a rising trend is green; high ATR% in the same uptrend is red", () => {
  const result = calcAtrRegime(sample(), fast);
  assert.equal(result[35].uptrend, true);
  assert.equal(result[35].lowVolatility, true);
  assert.equal(result[35].state, "accumulate");
  assert.equal(result[50].uptrend, true);
  assert.equal(result[50].lowVolatility, false);
  assert.equal(result[50].state, "avoid");
});

test("quiet downtrends and volatile downtrends are both red", () => {
  const result = calcAtrRegime(sample(-1), fast);
  assert.equal(result[35].lowVolatility, true);
  assert.equal(result[35].uptrend, false);
  assert.equal(result[35].state, "avoid");
  assert.equal(result[50].lowVolatility, false);
  assert.equal(result[50].state, "avoid");
});

test("trend requires BOTH close above EMA and EMA higher than its past value", () => {
  const down = sample(-1);
  // Small bounce gets close above a fast EMA but leaves it below five bars ago.
  down[40] = { ...down[40], close: 192.6, high: 193.6, low: 191.6 };
  const result = calcAtrRegime(down, { ...fast, trendPeriod: 3, slopeBars: 5 });
  assert.ok(down[40].close > present(result[40].ema));
  assert.ok(present(result[40].ema) < present(result[35].ema));
  assert.equal(result[40].uptrend, false);
  assert.equal(result[40].state, "avoid");
  const flat = calcAtrRegime(bars(Array(80).fill(100)), fast);
  assert.equal(flat[35].uptrend, false); // equality is not an uptrend
  assert.equal(flat[35].state, "avoid");
});

test("full warmup is required; unknown conditions stay gray, not red/green", () => {
  const result = calcAtrRegime(sample());
  assert.equal(result[12].atr, null);
  assert.ok(result[13].atr != null);
  assert.equal(result[62].baselinePercent, null);
  assert.ok(result[63].baselinePercent != null);
  assert.equal(result[62].state, "unknown");
  const slow = calcAtrRegime(sample(), { ...fast, trendPeriod: 50, slopeBars: 10 });
  assert.equal(slow[58].uptrend, null);
  assert.notEqual(slow[59].state, "unknown");
});

test("zero baseline and invalid OHLC never become accumulation; gaps explicitly break the line", () => {
  const flat = bars(Array(80).fill(100), Array(80).fill(0));
  assert.equal(calcAtrRegime(flat, fast)[60].state, "unknown");
  for (const patch of [
    { high: Number.NaN },
    { close: 0 },
    { low: 500 },
    { close: Number.POSITIVE_INFINITY },
  ]) {
    const data = sample().map((bar, i) => (i === 35 ? { ...bar, ...patch } : bar));
    const result = calcAtrRegime(data, fast);
    assert.equal(result[35].atr, null);
    assert.equal(result[35].state, "unknown");
    assert.equal(result[36].atr, null);
    const indicator = createATR(fast);
    const output = indicator.compute(data, indicator.config);
    assert.deepEqual(output[0].data[35], { time: data[35].time });
    assert.deepEqual(output[1].data[35], { time: data[35].time });
    // lightweight-charts connects valued points across whitespace using the
    // preceding point's color. Suppress that segment on both plotted lines.
    assert.equal((output[0].data[34] as { color?: string }).color, "transparent");
    assert.equal((output[1].data[34] as { color?: string }).color, "transparent");
    const reseededIndex = 35 + fast.period;
    assert.equal(
      (output[0].data[reseededIndex] as { color?: string }).color,
      ATR_REGIME_COLORS.unknown
    );
    assert.ok(
      output.every((series) =>
        series.data.every((point) => point.value == null || Number.isFinite(point.value))
      )
    );
  }
});

test("appending future candles never changes prior readings or colors", () => {
  const data = sample();
  const prefix = calcAtrRegime(data.slice(0, 40), fast);
  assert.deepEqual(calcAtrRegime(data, fast).slice(0, 40), prefix);
});

test("price-unit rescaling preserves normalized ATR and regime", () => {
  const data = sample();
  const scaled = data.map((bar) => ({
    ...bar,
    open: bar.open * 100,
    high: bar.high * 100,
    low: bar.low * 100,
    close: bar.close * 100,
  }));
  const first = calcAtrRegime(data, fast);
  const second = calcAtrRegime(scaled, fast);
  for (let i = 0; i < data.length; i++) {
    if (first[i].atrPercent != null)
      near(present(second[i].atrPercent), present(first[i].atrPercent));
    assert.equal(second[i].state, first[i].state);
  }
});

test("factory creates a separate pane with per-point red/green/gray and a matching threshold", () => {
  const data = sample();
  const indicator = createATR(fast);
  const [line, threshold] = indicator.compute(data, indicator.config);
  assert.equal(indicator.type, "pane");
  assert.equal(indicator.id, "atr-regime");
  assert.equal(line.type, "line");
  assert.equal((line.data[35] as { color?: string }).color, ATR_REGIME_COLORS.accumulate);
  assert.equal((line.data[50] as { color?: string }).color, ATR_REGIME_COLORS.avoid);
  assert.equal((line.data[3] as { color?: string }).color, ATR_REGIME_COLORS.unknown);
  const points = calcAtrRegime(data, fast);
  near(present(threshold.data[35].value), present(points[35].thresholdPercent));
  const absolute = createATR({ ...fast, display: "absolute" });
  const absOutput = absolute.compute(data, absolute.config);
  near(present(absOutput[0].data[35].value), present(points[35].atr));
  near(
    present(absOutput[1].data[35].value),
    (present(points[35].thresholdPercent) * data[35].close) / 100
  );
  assert.equal((absOutput[0].data[35] as { color?: string }).color, ATR_REGIME_COLORS.accumulate);
});

test("threshold changes classification, while chart averages stay unchanged", () => {
  const data = sample();
  const loose = calcAtrRegime(data, { ...fast, maxRatio: 3 });
  const strict = calcAtrRegime(data, { ...fast, maxRatio: 0.1 });
  assert.equal(loose[35].state, "accumulate");
  assert.equal(strict[35].state, "avoid");
  assert.equal(loose[35].atr, strict[35].atr);
  assert.equal(loose[35].ema, strict[35].ema);
});

test("input validation, safe defaults, unit conversion and immutable-config caching", () => {
  assert.equal(validAtrInputs({}), true);
  for (const config of [
    { period: 0 },
    { period: 14.5 },
    { lookback: Number.NaN },
    { maxRatio: "" },
    { maxRatio: 4 },
    { display: "foo" },
  ]) {
    assert.equal(validAtrInputs(config), false);
  }
  assert.equal(resolveAtrConfig({ period: Number.NaN }).period, 14);
  const converted = present(
    scaleParamsToBars(
      { period: 14, lookback: 50, trendPeriod: 50, slopeBars: 5, maxRatio: 1 },
      ["period", "lookback", "trendPeriod", "slopeBars"],
      ATR_REGIME_PARAMS,
      "days",
      "1h",
      false
    )
  );
  assert.equal(converted.period, 91);
  assert.equal(converted.lookback, 325);
  assert.equal(converted.slopeBars, 33);
  assert.equal(converted.maxRatio, 1);
  assert.equal(createATR(converted).config.lookback, 325);
  const data = sample();
  assert.equal(calcAtrRegime(data), calcAtrRegime(data));
  assert.notEqual(calcAtrRegime(data, fast), calcAtrRegime(data));
});
