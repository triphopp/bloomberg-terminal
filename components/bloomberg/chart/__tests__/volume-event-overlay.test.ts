import assert from "node:assert/strict";
import { test } from "node:test";

import type { VolumeEvent, VolumeEventType } from "../../lib/volume-events.ts";
import { EVENT_COLOR, type PlacedChip, resolveCollisions } from "../volume-event-overlay.ts";

// Classification is tested in lib/__tests__/volume-events.test.ts — this file
// covers only what the overlay itself decides: which chips survive a collision.

const chip = (x: number, z: number, type: VolumeEventType = "climax", w = 20): PlacedChip => ({
  event: {
    index: Math.round(x),
    time: `2026-01-${String((Math.round(x) % 28) + 1).padStart(2, "0")}`,
    type,
    dir: 1,
    z,
    retSigma: 0,
    retPct: 0,
    closePos: 0.5,
    close: 100,
  } satisfies VolumeEvent,
  x,
  y: 50,
  w,
});

test("chips that do not overlap all survive, in x order", () => {
  const kept = resolveCollisions([chip(300, 2), chip(100, 5), chip(200, 3)]);
  assert.deepEqual(
    kept.map((c) => c.x),
    [100, 200, 300]
  );
});

test("the stronger reading wins a collision", () => {
  // Two chips 5px apart at 20px wide: they overlap. |z| decides, not order.
  const kept = resolveCollisions([chip(100, 1.6), chip(105, 4.2)]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].event.z, 4.2);
});

test("strength is magnitude, so a deep dry-up can beat a mild spike", () => {
  // A z of −3 is as much an event as a z of +3; comparing signed values would
  // let every negative chip lose to every positive one.
  const kept = resolveCollisions([chip(100, 1.7, "breakout"), chip(104, -3.1, "dryUp")]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].event.type, "dryUp");
});

test("vertical position is ignored — two chips at one x still collide", () => {
  // At 9px two chips on different rows at the same x read as one smear.
  const a = { ...chip(100, 2), y: 10 };
  const b = { ...chip(100, 3), y: 200 };
  assert.equal(resolveCollisions([a, b]).length, 1);
});

test("a chip exactly one gap away is kept", () => {
  // 20px wide chips centred 22px apart touch at the default 2px gap; anything
  // wider apart must not be dropped, or a dense chart loses half its labels.
  assert.equal(resolveCollisions([chip(100, 2), chip(123, 3)]).length, 2);
});

test("no collision means no reordering cost — an empty list is empty", () => {
  assert.deepEqual(resolveCollisions([]), []);
});

test("every event type has a colour", () => {
  const types: VolumeEventType[] = [
    "climax",
    "absorption",
    "vacuum",
    "breakout",
    "noDemand",
    "dryUp",
  ];
  for (const t of types) {
    assert.match(EVENT_COLOR[t], /^#[0-9a-f]{6}$/i, `${t} has no usable colour`);
  }
});
