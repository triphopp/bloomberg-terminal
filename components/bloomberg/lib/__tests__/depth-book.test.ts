import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPLIT, buildLadder, clampSplit, isDepthSymbol } from "../depth-book.ts";

const L = (price: number, size: number, count: number | null = null) => ({ price, size, count });

describe("buildLadder", () => {
  const book = {
    bids: [L(280.73, 31, 2), L(280.72, 18, 1), L(280.71, 21, 1)],
    asks: [L(280.83, 21, 2), L(280.84, 18, 2)],
  };

  it("pairs levels row by row and leaves the short side empty", () => {
    const { rows } = buildLadder(book);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].bid?.price, 280.73);
    assert.equal(rows[0].ask?.price, 280.83);
    assert.equal(rows[2].ask, null);
  });

  it("scales every bar against the largest size on either side", () => {
    const { rows } = buildLadder(book);
    assert.equal(rows[0].bid?.bar, 1);
    assert.equal(rows[0].ask?.bar, 21 / 31);
    assert.equal(rows[1].bid?.bar, 18 / 31);
  });

  it("reads spread, mid and imbalance off the rows shown", () => {
    const l = buildLadder(book);
    assert.ok(Math.abs((l.spread ?? 0) - 0.1) < 1e-9);
    assert.ok(Math.abs((l.mid ?? 0) - 280.78) < 1e-9);
    assert.ok(Math.abs((l.spreadBps ?? 0) - (0.1 / 280.78) * 10_000) < 1e-6);
    assert.equal(l.bidSize, 70);
    assert.equal(l.askSize, 39);
    assert.equal(l.imbalance, (70 - 39) / 109);
  });

  it("cuts to maxRows before measuring, so a hidden level does not shrink the bars", () => {
    const l = buildLadder({ bids: [L(10, 5), L(9, 500)], asks: [L(11, 4)] }, 1);
    assert.equal(l.rows.length, 1);
    assert.equal(l.rows[0].bid?.bar, 1);
    assert.equal(l.bidSize, 5);
  });

  it("answers nulls, not NaN, for an empty or one-sided book", () => {
    const empty = buildLadder({ bids: [], asks: [] });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.spread, null);
    assert.equal(empty.imbalance, null);
    const oneSided = buildLadder({ bids: [L(10, 0)], asks: [] });
    assert.equal(oneSided.rows[0].bid?.bar, 0);
    assert.equal(oneSided.mid, null);
    assert.equal(oneSided.imbalance, null);
  });
});

describe("isDepthSymbol", () => {
  it("takes US tickers, share classes included", () => {
    for (const s of ["AAPL", "F", "BRK.B", "BF-B", "SPY"]) assert.equal(isDepthSymbol(s), true, s);
  });
  it("refuses what the feed does not carry", () => {
    for (const s of [
      "^DJI",
      "ES=F",
      "JPY=X",
      "BTC-USD",
      "PTT.BK",
      "VOD.L",
      "000300.SS",
      "aapl",
      "",
      null,
    ])
      assert.equal(isDepthSymbol(s), false, String(s));
  });
});

describe("clampSplit", () => {
  it("keeps a share inside the range it can be dragged to", () => {
    assert.equal(clampSplit(0.5), 0.5);
    assert.equal(clampSplit(0), SPLIT.min);
    assert.equal(clampSplit(1), SPLIT.max);
  });
  it("falls back to the initial share for anything that is not a number", () => {
    for (const bad of [Number.NaN, null, undefined, "0.4", {}, Number.POSITIVE_INFINITY])
      assert.equal(clampSplit(bad), SPLIT.initial, String(bad));
  });
});
