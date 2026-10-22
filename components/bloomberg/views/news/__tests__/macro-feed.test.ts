import assert from "node:assert/strict";
import test from "node:test";
import { coveredByWatchlist, dropLegacyMarketTopic } from "../helpers.ts";

const wl = new Set(["SNDK", "MU", "NVDA"]);

test("a story with no tickers stays", () => {
  assert.equal(coveredByWatchlist({ topic: "general", tickers: [] }, wl), false);
  assert.equal(coveredByWatchlist({ topic: "Fed" }, wl), false);
});

test("a story found by searching a watchlist ticker is WATCHLIST's", () => {
  assert.equal(coveredByWatchlist({ topic: "sndk", tickers: [] }, wl), true);
});

test("hidden only when every ticker is watched", () => {
  assert.equal(coveredByWatchlist({ topic: "economy", tickers: ["MU", "NVDA"] }, wl), true);
  assert.equal(coveredByWatchlist({ topic: "economy", tickers: ["MU", "META"] }, wl), false);
});

test("an empty watchlist hides nothing", () => {
  assert.equal(coveredByWatchlist({ topic: "SNDK", tickers: ["SNDK"] }, new Set()), false);
});

test("the old 'market' topic is dropped, others kept in order", () => {
  assert.deepEqual(dropLegacyMarketTopic(["market", "economy", "Fed", " Market "]), [
    "economy",
    "Fed",
  ]);
});
