/**
 * A pane indicator that draws nothing gets no pane — otherwise it is an empty
 * band across the chart (Volume on ^MOVE, an index with no volume).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createRSI } from "../indicators/index.ts";
import { createVolume } from "../indicators/volume.ts";
import { indicatorOutputs, outputsDrawAnything } from "../refill.ts";
import { makeBars } from "./fixtures.ts";

test("volume on bars with no volume draws nothing", () => {
  for (const volume of ["zero", "none"] as const) {
    const bars = makeBars(120, { volume });
    assert.equal(outputsDrawAnything(indicatorOutputs(createVolume(), bars)), false, volume);
  }
});

test("volume on bars with volume draws", () => {
  const bars = makeBars(120, { volume: "some" });
  assert.equal(outputsDrawAnything(indicatorOutputs(createVolume(), bars)), true);
});

test("RSI draws on bars with no volume", () => {
  const bars = makeBars(120, { volume: "zero" });
  assert.equal(outputsDrawAnything(indicatorOutputs(createRSI(), bars)), true);
});
