import assert from "node:assert/strict";
import test from "node:test";
import {
  type QuoteLike,
  patchFxPairs,
  patchQuote,
  patchRow,
  patchRowGroups,
} from "../live-quotes.ts";

const round = (n: number | undefined, dp = 6) =>
  Math.round((n ?? Number.NaN) * 10 ** dp) / 10 ** dp;

test("quote: LAST and CHG come from the same tick", () => {
  const q: QuoteLike = {
    regularMarketPrice: 100,
    regularMarketChange: 1,
    regularMarketChangePercent: 1,
    regularMarketPreviousClose: 99,
  };
  const out = patchQuote(q, { price: 102, change: 3, change_pct: 3.0303 });
  assert.equal(out?.regularMarketPrice, 102);
  assert.equal(out?.regularMarketChange, 3);
  assert.equal(out?.regularMarketChangePercent, 3.0303);
  assert.equal(out?.isCurrentSession, true);
});

test("quote: without change fields, CHG is derived from the quote's own previous close", () => {
  const q = {
    regularMarketPrice: 100,
    regularMarketChange: 1,
    regularMarketChangePercent: 1,
    regularMarketPreviousClose: 99,
  };
  const out = patchQuote(q, { price: 99.99 });
  assert.equal(round(out?.regularMarketChange), 0.99);
  assert.equal(round(out?.regularMarketChangePercent, 4), 1);
});

test("quote: same price → same object", () => {
  const q = { regularMarketPrice: 100 };
  assert.equal(patchQuote(q, { price: 100 }), q);
  assert.equal(patchQuote(q, undefined), q);
});

test("row: prev close recovered from value − change; YTD rebased on the year's first close", () => {
  // value 110, change +10 → prev 100; ytd +10% → year start 100
  const r = { symbol: "^DJI", value: 110, change: 10, pctChange: 10, ytd: 10 };
  const out = patchRow(r, { price: 121 });
  assert.equal(out.value, 121);
  assert.equal(round(out.change), 21);
  assert.equal(round(out.pctChange), 21);
  assert.equal(round(out.ytd), 21);
});

test("row groups: untouched payload keeps identity", () => {
  const payload = {
    americas: [{ symbol: "^GSPC", value: 1, change: 0, pctChange: 0 }],
    lastUpdated: "x",
  };
  assert.equal(patchRowGroups(payload, ["americas", "emea"], { "^N225": { price: 5 } }), payload);
  const out = patchRowGroups(payload, ["americas"], { "^GSPC": { price: 2 } });
  assert.notEqual(out, payload);
  assert.equal((out?.americas as { value: number }[])[0].value, 2);
});

test("fx: price and change move together from prevClose", () => {
  const payload = {
    pairs: [{ symbol: "THB=X", price: 33, change: 0, pctChange: 0, prevClose: 33 }],
  };
  const out = patchFxPairs(payload, { "THB=X": { price: 33.33 } });
  assert.equal(out?.pairs[0].price, 33.33);
  assert.equal(round(out?.pairs[0].change ?? 0), 0.33);
  assert.equal(round(out?.pairs[0].pctChange ?? 0), 1);
});
