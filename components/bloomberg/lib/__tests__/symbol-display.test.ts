/** Same cases as backend/tests/test_symbol_names.py — the two must agree. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { displayName, displaySymbol } from "../symbol-display.ts";

test("display symbol", () => {
  const cases: [string, string][] = [
    ["^MOVE", "MOVE"],
    ["^VIX", "VIX"],
    ["BH.BK", "BH"],
    ["^SET.BK", "SET"],
    ["AAPL", "AAPL"],
    ["BTC-USD", "BTC-USD"],
    ["ES=F", "ES=F"],
    ["", ""],
  ];
  for (const [symbol, shown] of cases) assert.equal(displaySymbol({ symbol }), shown, symbol);
});

test("display name", () => {
  const cases: [string, string | undefined, string][] = [
    ["BH.BK", "BH_BUMRUNGRAD HOSPITAL", "BUMRUNGRAD HOSPITAL"],
    ["PTT.BK", "PTT_PTT PUBLIC COMPANY", "PTT PUBLIC COMPANY"],
    ["^MOVE", "Northern Trust iBoxx 5-Year Tar", "ICE BofA MOVE Index"],
    ["^VIX", "CBOE Volatility Index", "CBOE Volatility Index"],
    ["AAPL", "Apple Inc.", "Apple Inc."],
    ["AAPL", undefined, ""],
  ];
  for (const [symbol, shortname, shown] of cases) {
    assert.equal(displayName({ symbol, shortname }), shown, symbol);
  }
});

test("backend fields win", () => {
  assert.equal(displaySymbol({ symbol: "^MOVE", display_symbol: "X" }), "X");
  assert.equal(displayName({ symbol: "BH.BK", display_name: "Y" }), "Y");
});
