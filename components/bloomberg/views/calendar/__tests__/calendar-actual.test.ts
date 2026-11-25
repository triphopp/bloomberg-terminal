import assert from "node:assert/strict";
import test from "node:test";
import { cellLabel } from "../month.ts";
import type { CalEvent } from "../types.ts";

const macro = (over: Partial<CalEvent>): CalEvent => ({
  id: "macro:GDP:2026-11-25",
  date: "2026-11-25",
  category: "MACRO",
  kind: "GDP",
  title: "GDP",
  symbol: null,
  impact: "medium",
  estimated: false,
  source: "FRED",
  source_url: "",
  detail: "",
  done: false,
  due: false,
  theses: [],
  ref: null,
  tag: null,
  days_until: 0,
  ...over,
});

test("a FRED release that has printed shows its headline figure in the cell", () => {
  const gdp = macro({
    actual: [
      {
        series: "A191RL1Q225SBEA",
        label: "Real GDP q/q saar",
        value: 4.3,
        text: "4.30%",
        prev_text: "2.20%",
        period: "Q3 2026",
      },
    ],
  });
  assert.equal(cellLabel(gdp), "GDP 4.30%");
});

test("a release not printed yet, or not from FRED, shows its kind alone", () => {
  assert.equal(cellLabel(macro({ actual: [] })), "GDP");
  assert.equal(cellLabel(macro({ actual: null })), "GDP");
  assert.equal(cellLabel(macro({ kind: "FOMC", actual: undefined })), "FOMC");
});
