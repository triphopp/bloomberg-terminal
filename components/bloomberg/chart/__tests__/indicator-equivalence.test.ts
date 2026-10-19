/**
 * No drawn value may change.
 *
 * Every indicator moved onto typed columns (chart/columns.ts, kernels.ts,
 * series-columns.ts) is held here to the implementation it replaced: the
 * files in ./legacy are the indicators as they stood before the move, byte for
 * byte apart from import paths (./legacy/README.md). For each, on a spread of
 * generated bars and configs, `compute()` must return the same series with the
 * same points — `deepStrictEqual`, so the same bits: NaN where the old code
 * sent NaN, −0 where it sent −0, the same colour on the same bar.
 *
 * The alert scanner's Python mirror (backend/alerts/operands.py) is checked
 * against these numbers; holding them fixed is what keeps the two in step.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { INDICATOR_REGISTRY } from "../indicators/index.ts";
import type { ChartIndicator, IndicatorFactory, IndicatorRegistryEntry } from "../types.ts";
import { datasets } from "./fixtures.ts";
import { createAbsorption } from "./legacy/absorption.ts";
import { createATR } from "./legacy/atr.ts";
import { createBollingerB } from "./legacy/bollinger-b.ts";
import { createBollingerWidth } from "./legacy/bollinger-width.ts";
import { createBollingerBands } from "./legacy/bollinger.ts";
import { createEMA } from "./legacy/ema.ts";
import { createFearGreed } from "./legacy/fear-greed.ts";
import { createFlowToxicity } from "./legacy/flow-toxicity.ts";
import { createIchimoku } from "./legacy/ichimoku.ts";
import { createMACD } from "./legacy/macd.ts";
import { createRealizedVol } from "./legacy/realized-vol.ts";
import { createRSI } from "./legacy/rsi.ts";
import { createRVRank } from "./legacy/rv-rank.ts";
import { createRVRatio } from "./legacy/rv-ratio.ts";
import { createRVOL } from "./legacy/rvol.ts";
import { createSMA } from "./legacy/sma.ts";
import { createStochastic } from "./legacy/stochastic.ts";
import { createVolume } from "./legacy/volume.ts";
import { createVWAP } from "./legacy/vwap.ts";

/** Registry id → the factory as it was before the columnar engine. */
const LEGACY: Record<string, IndicatorFactory> = {
  ema: createEMA,
  sma: createSMA,
  ichimoku: createIchimoku,
  macd: createMACD,
  rsi: createRSI,
  stochastic: createStochastic,
  "atr-regime": createATR,
  bollinger: createBollingerBands,
  "bollinger-b": createBollingerB,
  "bb-width": createBollingerWidth,
  "realized-vol": createRealizedVol,
  "rv-rank": createRVRank,
  "rv-ratio": createRVRatio,
  volume: createVolume,
  vwap: createVWAP,
  rvol: createRVOL,
  "flow-toxicity": createFlowToxicity,
  absorption: createAbsorption,
  "fear-greed": createFearGreed,
};

type Config = Record<string, number | string | boolean>;

/** Defaults, every numeric param at its smallest and largest, every select option, a few odd ones. */
function configsFor(e: IndicatorRegistryEntry): Config[] {
  const out: Config[] = [{}];
  const min: Config = {};
  const max: Config = {};
  for (const p of e.defaultParams) {
    if (p.type === "number") {
      if (p.min != null) min[p.key] = p.min;
      if (p.max != null) max[p.key] = p.max;
    } else if (p.type === "select" && p.options) {
      for (const o of p.options) out.push({ [p.key]: String(o.value) });
    } else if (p.type === "boolean") {
      out.push({ [p.key]: !p.default });
    }
  }
  if (Object.keys(min).length) out.push(min, max);
  const extra: Record<string, Config[]> = {
    ema: [{ period: 1 }, { period: 50 }, { period: 200 }],
    sma: [{ period: 1 }, { period: 200 }],
    macd: [
      { fast: 26, slow: 12, signal: 9 },
      { fast: 5, slow: 5, signal: 2 },
    ],
    stochastic: [
      { kPeriod: 5, dPeriod: 3, smooth: 1 },
      { kPeriod: 21, dPeriod: 7, smooth: 5 },
    ],
    bollinger: [
      { period: 10, stdDev: 1.5 },
      { fitMode: "sharpe", fitCostBps: 0 },
    ],
    "bollinger-b": [{ period: 10, stdDev: 1.5 }],
    "bb-width": [{ period: 10, stdDev: 1, lookback: 20 }],
    "atr-regime": [
      { period: 3, lookback: 5, trendPeriod: 5, slopeBars: 2 },
      { display: "absolute", maxRatio: 3 },
    ],
    "realized-vol": [
      { fast: 0, slow: 21, long: 0, estimator: "cc" },
      { fast: 2, slow: 3, long: 4, estimator: "gk" },
    ],
    "rv-rank": [{ period: 5, lookback: 30, estimator: "rs" }],
    "rv-ratio": [{ fast: 2, slow: 3, estimator: "parkinson" }],
    rvol: [
      { scale: "z", mode: "cum", baseline: "mean" },
      { lookback: 5, mode: "cum" },
    ],
    ichimoku: [{ tenkan: 3, kijun: 5, senkou: 8, shift: 1 }],
  };
  return [...out, ...(extra[e.id] ?? [])];
}

/** Fear & Greed draws a fetched series, not the bars: give both sides the same one. */
function withRuntimeConfig(ind: ChartIndicator, times: (string | number)[]): ChartIndicator {
  if (ind.id !== "fear-greed") return ind;
  const preloadedData = times
    .filter((_, i) => i % 3 !== 0)
    .map((t, i) => ({
      time: typeof t === "number" ? new Date(t * 1000).toISOString().slice(0, 10) : t,
      value: (i * 37) % 101,
    }));
  return { ...ind, config: { ...ind.config, preloadedData } };
}

const DATA = datasets();

for (const [id, legacyFactory] of Object.entries(LEGACY)) {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === id);
  test(`indicator ${id}: compute() equals the pre-columnar implementation`, () => {
    assert.ok(entry, `registry entry ${id}`);
    for (const cfg of configsFor(entry)) {
      const was = legacyFactory(cfg);
      const now = entry.factory(cfg);
      assert.equal(now.id, was.id);
      assert.equal(now.name, was.name);
      assert.equal(now.minBars, was.minBars);
      assert.deepStrictEqual(now.config, was.config);
      for (const { name, bars } of DATA) {
        const times = bars.map((b) => b.time);
        const a = withRuntimeConfig(was, times);
        const b = withRuntimeConfig(now, times);
        assert.deepStrictEqual(
          b.compute(bars, b.config),
          a.compute(bars, a.config),
          `${id} ${JSON.stringify(cfg)} on "${name}"`
        );
      }
    }
  });
}

test("every columnar indicator in the registry has a legacy reference", () => {
  const missing = INDICATOR_REGISTRY.filter((e) => e.factory({}).columns && !LEGACY[e.id]).map(
    (e) => e.id
  );
  assert.deepEqual(missing, []);
});
