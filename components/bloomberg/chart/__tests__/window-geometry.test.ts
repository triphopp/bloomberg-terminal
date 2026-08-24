import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_WINDOW_H,
  DEFAULT_WINDOW_W,
  MAX_CHART_WINDOWS,
  MAX_REMEMBERED_LAYOUTS,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  TITLE_BAR_H,
  canOpenWindow,
  cascadeOrigin,
  clampWindow,
  hasGeometry,
  nextZ,
  rememberLayout,
  resolveOpenGeometry,
} from "../window-geometry.ts";

const VP = { width: 1280, height: 800 };
const box = { x: 100, y: 100, w: DEFAULT_WINDOW_W, h: DEFAULT_WINDOW_H };

test("clampWindow leaves a window already inside the viewport alone", () => {
  assert.deepEqual(clampWindow(box, VP), box);
});

test("clampWindow keeps the title bar grabbable when dragged off the right edge", () => {
  const out = clampWindow({ ...box, x: 5000 }, VP);
  assert.equal(out.x, VP.width - 80);
});

test("clampWindow keeps the title bar grabbable when dragged off the left edge", () => {
  const out = clampWindow({ ...box, x: -5000 }, VP);
  // At most all but 80px of the window may hang off the left.
  assert.equal(out.x, -box.w + 80);
});

test("clampWindow never lets the title bar go above or below the viewport", () => {
  assert.equal(clampWindow({ ...box, y: -400 }, VP).y, 0);
  assert.equal(clampWindow({ ...box, y: 99999 }, VP).y, VP.height - TITLE_BAR_H);
});

test("clampWindow enforces the minimum size", () => {
  const out = clampWindow({ x: 0, y: 0, w: 10, h: 10 }, VP);
  assert.equal(out.w, MIN_WINDOW_W);
  assert.equal(out.h, MIN_WINDOW_H);
});

test("clampWindow caps size to the viewport but never below the minimum", () => {
  const wide = clampWindow({ x: 0, y: 0, w: 9999, h: 9999 }, VP);
  assert.equal(wide.w, VP.width);
  assert.equal(wide.h, VP.height);

  // Viewport smaller than the minimum (a phone-sized window): the minimum wins,
  // otherwise the window would collapse to nothing.
  const tiny = clampWindow({ x: 0, y: 0, w: 400, h: 400 }, { width: 200, height: 150 });
  assert.equal(tiny.w, MIN_WINDOW_W);
  assert.equal(tiny.h, MIN_WINDOW_H);
  assert.equal(tiny.y, 0);
});

test("cascadeOrigin steps windows diagonally and wraps every 8", () => {
  const a = cascadeOrigin(0, VP);
  const b = cascadeOrigin(1, VP);
  assert.equal(b.x - a.x, 28);
  assert.equal(b.y - a.y, 28);
  assert.deepEqual(cascadeOrigin(8, VP), a);
});

test("cascadeOrigin keeps a new window inside a small viewport", () => {
  const small = { width: 600, height: 400 };
  const out = cascadeOrigin(3, small);
  assert.ok(out.x >= 0 && out.y >= 0);
  assert.ok(out.x <= Math.max(0, small.width - DEFAULT_WINDOW_W - 16));
  assert.ok(out.y <= Math.max(0, small.height - DEFAULT_WINDOW_H - 16));
});

test("nextZ puts a new window above the current top", () => {
  assert.equal(nextZ([]), 1);
  assert.equal(nextZ([{ z: 3 }, { z: 7 }, { z: 5 }]), 8);
});

test("canOpenWindow enforces the cap for new symbols only", () => {
  const full = Array.from({ length: MAX_CHART_WINDOWS }, (_, i) => ({ symbol: `S${i}` }));
  assert.equal(canOpenWindow(full, "AAPL"), false);
  // Re-opening an existing symbol focuses it, so the cap must not block it.
  assert.equal(canOpenWindow(full, "S3"), true);
  assert.equal(canOpenWindow(full.slice(0, 3), "AAPL"), true);
});

test("canOpenWindow normalises case and whitespace, and rejects empty input", () => {
  assert.equal(canOpenWindow([{ symbol: "AAPL" }], "  aapl "), true);
  assert.equal(canOpenWindow([], "   "), false);
});

test("resolveOpenGeometry reuses the geometry a symbol was last left at", () => {
  const remembered = { x: 420, y: 290, w: 640, h: 420 };
  assert.deepEqual(resolveOpenGeometry(remembered, { w: 520, h: 360 }, 3, VP), remembered);
});

test("resolveOpenGeometry clamps a layout remembered on a bigger screen", () => {
  const remembered = { x: 1800, y: 1400, w: 1600, h: 1200 };
  const out = resolveOpenGeometry(remembered, undefined, 0, VP);
  assert.equal(out.w, VP.width);
  assert.equal(out.h, VP.height);
  assert.equal(out.x, VP.width - 80);
  assert.equal(out.y, VP.height - TITLE_BAR_H);
});

test("resolveOpenGeometry falls back to the last used size on a cascaded origin", () => {
  const size = { w: 700, h: 480 };
  const out = resolveOpenGeometry(undefined, size, 1, VP);
  assert.equal(out.w, size.w);
  assert.equal(out.h, size.h);
  // The cascade has to account for the inherited size, not the default one.
  assert.deepEqual({ x: out.x, y: out.y }, cascadeOrigin(1, VP, size));
});

test("cascadeOrigin pulls a bigger window further up and left", () => {
  const small = { width: 800, height: 560 };
  const withDefault = cascadeOrigin(4, small);
  const withBig = cascadeOrigin(4, small, { w: 760, h: 520 });
  assert.ok(withBig.x < withDefault.x || withDefault.x === 0);
  assert.equal(withBig.x, Math.max(0, small.width - 760 - 16));
  assert.equal(withBig.y, Math.max(0, small.height - 520 - 16));
});

test("resolveOpenGeometry falls back to the defaults with nothing remembered", () => {
  const out = resolveOpenGeometry(undefined, undefined, 0, VP);
  assert.equal(out.w, DEFAULT_WINDOW_W);
  assert.equal(out.h, DEFAULT_WINDOW_H);
});

test("hasGeometry only accepts a patch carrying all four fields", () => {
  assert.equal(hasGeometry({ x: 1, y: 2, w: 320, h: 220 }), true);
  assert.equal(hasGeometry({ x: 1, y: 2 }), false);
  assert.equal(hasGeometry({}), false);
});

test("rememberLayout stores a layout and moves a re-saved symbol to the end", () => {
  const r = { x: 1, y: 2, w: 320, h: 220 };
  const one = rememberLayout({}, "AMD", r);
  assert.deepEqual(one, { AMD: r });

  const two = rememberLayout(one, "MSFT", r);
  const three = rememberLayout(two, "AMD", { ...r, x: 99 });
  assert.deepEqual(Object.keys(three), ["MSFT", "AMD"]);
  assert.equal(three.AMD.x, 99);
});

test("rememberLayout drops the oldest entries once the map is full", () => {
  const r = { x: 0, y: 0, w: 320, h: 220 };
  let map: Record<string, typeof r> = {};
  for (let i = 0; i < MAX_REMEMBERED_LAYOUTS + 5; i++) map = rememberLayout(map, `S${i}`, r);
  const keys = Object.keys(map);
  assert.equal(keys.length, MAX_REMEMBERED_LAYOUTS);
  assert.equal(keys[0], "S5");
  assert.equal(keys.at(-1), `S${MAX_REMEMBERED_LAYOUTS + 4}`);
});
