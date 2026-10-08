import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Trade, mergeTape, tapeTotals } from "../trade-tape.ts";

const T = (t: number, price: number, size: number, side: Trade["side"] = "B"): Trade => ({
  t,
  price,
  size,
  side,
});

describe("mergeTape", () => {
  it("puts new prints on top, newest first", () => {
    const held = [T(300, 10, 5), T(100, 10, 1)];
    const out = mergeTape(held, [T(200, 10.01, 2, "S"), T(400, 10.02, 3)]);
    assert.deepEqual(
      out.map((x) => x.t),
      [400, 300, 200, 100]
    );
  });

  it("does not add what it already holds — the request and the stream overlap", () => {
    const held = [T(300, 10, 5), T(200, 10, 2, "S")];
    const out = mergeTape(held, [T(200, 10, 2, "S"), T(300, 10, 5), T(301, 10, 7)]);
    assert.deepEqual(
      out.map((x) => x.t),
      [301, 300, 200]
    );
  });

  it("keeps two equal prints when a feed really has two", () => {
    const twice = [T(100, 10, 100), T(100, 10, 100)];
    assert.equal(mergeTape([], twice).length, 2);
    assert.equal(mergeTape(twice, twice).length, 2); // the same two again: still two
    assert.equal(mergeTape([T(100, 10, 100)], twice).length, 2); // one held, the feed has two
  });

  it("returns the same array when nothing is new, so nothing re-renders", () => {
    const held = [T(300, 10, 5)];
    assert.equal(mergeTape(held, []), held);
    assert.equal(mergeTape(held, [T(300, 10, 5)]), held);
  });

  it("gives each print an identity that survives later merges", () => {
    const first = mergeTape([], [T(100, 10, 1), T(100, 10, 1)]);
    assert.equal(new Set(first.map((x) => x.id)).size, 2); // equal prints, two rows
    const second = mergeTape(first, [T(200, 10, 2), T(100, 10, 1)]);
    assert.deepEqual(
      second.slice(1).map((x) => x.id),
      first.map((x) => x.id)
    );
    assert.ok(!first.some((x) => x.id === second[0].id));
  });

  it("drops the oldest past the cap", () => {
    const out = mergeTape([T(3, 1, 1), T(2, 1, 1), T(1, 1, 1)], [T(4, 1, 1)], 3);
    assert.deepEqual(
      out.map((x) => x.t),
      [4, 3, 2]
    );
  });
});

describe("tapeTotals", () => {
  it("adds each side, and the difference", () => {
    const totals = tapeTotals([T(3, 10, 200, "B"), T(2, 10, 395, "S"), T(1, 10, 50, "N")]);
    assert.deepEqual(totals, { buy: 200, sell: 395, neutral: 50, delta: -195, since: 1, count: 3 });
  });

  it("is zeros, not NaN, for an empty tape", () => {
    assert.deepEqual(tapeTotals([]), {
      buy: 0,
      sell: 0,
      neutral: 0,
      delta: 0,
      since: null,
      count: 0,
    });
  });
});
