import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Trade } from "../trade-tape.ts";
import { addPull, bucketStep, emptyProfile, profileRows } from "../volume-by-price.ts";

const T = (t: number, price: number, size: number, side: Trade["side"] = "N"): Trade => ({
  t,
  price,
  size,
  side,
});

describe("addPull", () => {
  it("adds every print at its price, whatever its side", () => {
    const p = addPull(
      emptyProfile(),
      [T(3, 10.01, 100, "B"), T(2, 10.01, 50, "S"), T(1, 10.0, 30)],
      false
    );
    assert.equal(p.levels.get(100_100), 150);
    assert.equal(p.levels.get(100_000), 30);
    assert.deepEqual([p.total, p.prints, p.from, p.to], [180, 3, 1, 3]);
  });

  it("counts the overlap of two pulls once", () => {
    const first = addPull(emptyProfile(), [T(3, 10, 1), T(2, 10, 2), T(1, 10, 4)], false);
    const second = addPull(first, [T(5, 10, 8), T(4, 10, 16), T(3, 10, 1), T(2, 10, 2)], false);
    assert.equal(second.total, 31);
    assert.equal(second.prints, 5);
    assert.equal(addPull(second, [T(5, 10, 8), T(4, 10, 16)], false), second); // nothing new: same object
  });

  it("keeps equal prints as many times as a pull holds them", () => {
    const twice = [T(1, 10, 100), T(1, 10, 100)];
    const p = addPull(emptyProfile(), twice, false);
    assert.equal(p.total, 200);
    assert.equal(addPull(p, twice, false).total, 200);
    assert.equal(addPull(p, [...twice, T(1, 10, 100)], false).total, 300); // a third one is new
  });

  it("flags a full pull that does not reach back to what is held", () => {
    const p = addPull(emptyProfile(), [T(1_000, 10, 1)], true);
    assert.equal(p.gaps, 0); // the first pull has nothing before it to miss
    assert.equal(addPull(p, [T(9_000, 10, 1), T(5_000, 10, 1)], true).gaps, 1);
    assert.equal(addPull(p, [T(9_000, 10, 1), T(1_000, 10, 1)], true).gaps, 0); // it overlaps
    assert.equal(addPull(p, [T(9_000, 10, 1)], false).gaps, 0); // not full: nothing was cut off
  });

  it("does not count again a print replayed from before the overlap window", () => {
    const p = addPull(emptyProfile(), [T(1_000, 10, 5)], false);
    const later = addPull(p, [T(1_000_000, 10, 7)], false);
    assert.equal(addPull(later, [T(1_000, 10, 5)], false), later);
  });

  it("treats float noise as one price level", () => {
    const p = addPull(emptyProfile(), [T(1, 0.1 + 0.2, 1), T(2, 0.3, 1)], false);
    assert.equal(p.levels.size, 1);
  });
});

describe("profileRows", () => {
  const p = addPull(
    emptyProfile(),
    [T(1, 10.0, 10), T(2, 10.01, 60), T(3, 10.02, 20), T(4, 10.04, 10)],
    false
  );

  it("lists every bucket from the top down, empty ones included", () => {
    const rows = profileRows(p);
    assert.deepEqual(
      rows.map((r) => [r.price, r.volume]),
      [
        [10.04, 10],
        [10.03, 0],
        [10.02, 20],
        [10.01, 60],
        [10.0, 10],
      ]
    );
  });

  it("marks the POC and scales the bars to it", () => {
    const rows = profileRows(p);
    assert.deepEqual(
      rows.filter((r) => r.poc).map((r) => r.price),
      [10.01]
    );
    assert.equal(rows[3].bar, 1);
    assert.equal(rows[2].bar, 20 / 60);
  });

  it("grows the value area from the POC to 70% of the volume", () => {
    // 60 at the POC, then the larger neighbour (20 above) → 80 of 100.
    assert.deepEqual(
      profileRows(p)
        .filter((r) => r.value)
        .map((r) => r.price),
      [10.02, 10.01]
    );
  });

  it("widens the buckets rather than exceed the row limit", () => {
    const wide = addPull(emptyProfile(), [T(1, 100, 5), T(2, 103.99, 7), T(3, 100.24, 1)], false);
    const rows = profileRows(wide, 20);
    assert.ok(rows.length <= 20, String(rows.length));
    assert.equal(rows[rows.length - 1].price, 100);
    assert.equal(rows[rows.length - 1].volume, 6); // 100.00 and 100.24 share the 0.25 bucket
    assert.equal(
      rows.reduce((s, r) => s + r.volume, 0),
      13
    );
  });

  it("is empty for an empty profile", () => {
    assert.deepEqual(profileRows(emptyProfile()), []);
  });
});

describe("bucketStep", () => {
  it("picks the smallest round step that fits", () => {
    assert.equal(bucketStep(109.2, 109.35, 24), 0.01);
    assert.equal(bucketStep(109, 110, 24), 0.05);
    assert.equal(bucketStep(1060, 1072, 24), 1);
    assert.equal(bucketStep(10, 10, 24), 0.01);
  });
});
