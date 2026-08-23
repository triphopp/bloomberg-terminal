import assert from "node:assert/strict";
import { test } from "node:test";

import type { IndicatorRegistryEntry } from "../types.ts";
import { type SpecCtx, type SpecParams, specParamsKey } from "../windowUnits.ts";

const CTX: SpecCtx = { unit: "bars", interval: "1d", isCrypto: false };

/** A pane entry shaped like sd-heatmap: a select, a duration, a plain number. */
const ENTRY = {
  id: "sd-heatmap",
  name: "IV SD Heatmap",
  category: "volatility",
  type: "pane",
  description: "",
  defaultParams: [
    { key: "mode", label: "Mode", type: "select", default: "cheapness" },
    { key: "sigmaBasis", label: "Sigma quoted per", type: "select", default: "horizon" },
    { key: "horizonDays", label: "Horizon", type: "number", default: 30 },
  ],
  factory: (() => null) as unknown as IndicatorRegistryEntry["factory"],
} as unknown as IndicatorRegistryEntry;

const spec = (params?: SpecParams["params"]): SpecParams => ({ params });
const key = (params?: SpecParams["params"]) => specParamsKey(spec(params), ENTRY, CTX);

test("a changed setting produces a different key", () => {
  // The regression this locks down: pane replacement was decided on the derived
  // instance id, which sd-heatmap's factory holds constant — so every settings
  // change on it was read as "identical, nothing to do" and the picker's
  // controls silently did nothing once the indicator was on the chart.
  assert.notEqual(key({ sigmaBasis: "daily" }), key({ sigmaBasis: "horizon" }));
  assert.notEqual(key({ mode: "occupancy" }), key({ mode: "cheapness" }));
  assert.notEqual(key({ horizonDays: 60 }), key({ horizonDays: 30 }));
});

test("omitted params and explicitly-default ones compare equal", () => {
  // The picker submits the full set; a spec stored earlier may carry less.
  assert.equal(key(), key({ mode: "cheapness", sigmaBasis: "horizon", horizonDays: 30 }));
});

test("key order does not matter", () => {
  assert.equal(
    key({ mode: "occupancy", horizonDays: 60 }),
    key({ horizonDays: 60, mode: "occupancy" })
  );
});

test("an unknown param still counts — it is a setting the factory may read", () => {
  assert.notEqual(key({ rvWindow: 21 }), key());
});

test("duration params are compared AFTER the days→bars conversion", () => {
  // Same stored number, different meaning per interval: 30 days is 30 daily bars
  // but 30 * 26 five-minute ones, and the two must not compare equal.
  const scalable = { ...ENTRY, timeScalableParams: ["horizonDays"] } as IndicatorRegistryEntry;
  const daily = specParamsKey(spec({ horizonDays: 30 }), scalable, {
    ...CTX,
    unit: "days",
  });
  const intraday = specParamsKey(spec({ horizonDays: 30 }), scalable, {
    ...CTX,
    unit: "days",
    interval: "5m",
  });
  assert.notEqual(daily, intraday);
});
