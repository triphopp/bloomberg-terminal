import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SdTrap,
  type SdZone,
  calcBaseZones,
  calcPivotZones,
  createSdTrapsOverlay,
  createSdZones,
  fillAlpha,
  hexToRgb,
  scanPivotZones,
  trapLabel,
  zoneTag,
} from "../indicators/sd-zones.ts";
import type { OhlcvBar } from "../types.ts";

const CFG = { impulse: 1.5, baseMax: 6, baseRange: 0.7, maxHeight: 1.5, atrPeriod: 3 };

/** [open, high, low, close] rows → bars. */
const bars = (rows: [number, number, number, number][]): OhlcvBar[] =>
  rows.map(([open, high, low, close], i) => ({ time: i, open, high, low, close }));

// ATR(3) ≈ 2 from the warm-up; a 2-bar base of range 0.6; a 5-point rally out of it.
const WARMUP: [number, number, number, number][] = [
  [100, 101, 99, 100],
  [100, 101, 99, 100],
  [100, 101, 99, 99.5], // last warm-up bar is bearish → pattern "DBR"
];
const BASE: [number, number, number, number][] = [
  [99.5, 99.8, 99.2, 99.6],
  [99.6, 99.9, 99.3, 99.7],
];
const RALLY: [number, number, number, number] = [99.7, 104.8, 99.6, 104.6];
const FORMING: [number, number, number, number] = [104.6, 105, 104, 104.5];

test("tight base + ATR-sized rally out of it = one fresh demand zone", () => {
  const zones = calcBaseZones(bars([...WARMUP, ...BASE, RALLY, FORMING]), CFG);
  assert.equal(zones.length, 1);
  const z = zones[0];
  assert.equal(z.kind, "demand");
  assert.equal(z.pattern, "DBR");
  assert.equal(z.start, 3);
  assert.equal(z.created, 5);
  assert.equal(z.proximal, 99.7); // highest body of the base
  assert.equal(z.distal, 99.2); // lowest wick of the base
  assert.equal(z.touches, 0);
  assert.equal(z.end, null);
});

test("the forming last bar never confirms a departure", () => {
  assert.equal(calcBaseZones(bars([...WARMUP, ...BASE, RALLY]), CFG).length, 0);
});

test("a return counts one touch per visit; a close through the distal breaks it", () => {
  const z = calcBaseZones(
    bars([
      ...WARMUP,
      ...BASE,
      RALLY,
      [104.6, 104.8, 99.5, 100], // visit 1 (low 99.5 ≤ 99.7)
      [100, 100.2, 99.4, 99.8], // still inside — same visit
      [99.8, 103, 99.9, 102.8], // out
      [102.8, 103, 99.6, 99.9], // visit 2
      [99.9, 100, 98, 98.5], // close 98.5 < 99.2 → broken
      FORMING,
    ]),
    { ...CFG, reclaimBars: 0, breakBuffer: 0 } // any close through, at once — the wait has its own tests
  )[0];
  assert.equal(z.touches, 2);
  assert.equal(z.end, 10);
});

test("a drop out of the base makes a supply zone", () => {
  const z = calcBaseZones(
    bars([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [99.5, 101, 99, 100.5], // bullish lead-in → "RBD"
      ...BASE,
      [99.7, 99.8, 94.6, 94.8],
      FORMING,
    ]),
    CFG
  )[0];
  assert.equal(z.kind, "supply");
  assert.equal(z.pattern, "RBD");
  assert.equal(z.proximal, 99.5); // lowest body
  assert.equal(z.distal, 99.9); // highest wick
});

test("a quiet stretch longer than baseMax is a range, not a base", () => {
  // ATR(3) shrinks over a quiet stretch, so loosen baseRange to keep every bar a base bar.
  const long = Array.from({ length: 7 }, () => BASE[0]);
  const loose = { ...CFG, baseRange: 1.5 };
  assert.equal(calcBaseZones(bars([...WARMUP, ...long, RALLY, FORMING]), loose).length, 0);
  assert.equal(
    calcBaseZones(bars([...WARMUP, ...long, RALLY, FORMING]), { ...loose, baseMax: 10 }).length,
    1
  );
});

test("a zone taller than maxHeight × ATR is dropped", () => {
  assert.equal(
    calcBaseZones(bars([...WARMUP, ...BASE, RALLY, FORMING]), { ...CFG, maxHeight: 0.1 }).length,
    0
  );
});

// ── pivot mode ──────────────────────────────────────────────────────────────

const PIVOT = { swing: 2.5, legMove: 3, legBars: 10, zoneHeight: 1, flip: true, atrPeriod: 3 };
/** Bars with open = close = c and a 1-point wick each side. */
const flat = (closes: number[]): OhlcvBar[] =>
  closes.map((c, i) => ({ time: i, open: c, high: c + 1, low: c - 1, close: c }));

const FIRST_LOW = [100, 100, 100, 98, 96, 94, 97, 100, 103, 106];
const SECOND_LOW = [103, 100, 97, 94.5, 98, 102, 106];

test("a swing low with a fast leg out of it is a demand box on the pivot bar", () => {
  const zones = calcPivotZones(flat([...FIRST_LOW, 105]), PIVOT);
  const d = zones.filter((z) => z.kind === "demand" && z.flips === 0);
  assert.equal(d.length, 1);
  assert.equal(d[0].start, 5);
  assert.equal(d[0].distal, 93); // pivot low
  assert.equal(d[0].proximal, 94); // pivot body top
  assert.equal(d[0].reactions, 1);
});

test("a second low at the same level joins the box and counts as a second reaction", () => {
  const zones = calcPivotZones(flat([...FIRST_LOW, ...SECOND_LOW, 105]), PIVOT);
  const d = zones.filter((z) => z.kind === "demand" && z.flips === 0);
  assert.equal(d.length, 1);
  assert.equal(d[0].reactions, 2);
  assert.equal(d[0].distal, 93);
  assert.equal(d[0].proximal, 94.5);
});

test("a close through the distal flips demand to supply on that bar", () => {
  const closes = [...FIRST_LOW, ...SECOND_LOW, 100, 94, 88, 87];
  const zones = calcPivotZones(flat(closes), { ...PIVOT, reclaimBars: 0 });
  const d = zones.find((z) => z.kind === "demand" && z.flips === 0);
  const s = zones.find((z) => z.kind === "supply" && z.flips === 1);
  assert.ok(d && s);
  assert.equal(d.end, closes.indexOf(88));
  assert.equal(s.start, d.end);
  assert.equal(s.proximal, 93);
  assert.equal(s.distal, 94.5);
  assert.equal(s.end, null);
});

test("with flip off a break just ends the zone", () => {
  const closes = [...FIRST_LOW, ...SECOND_LOW, 100, 94, 88, 87];
  const zones = calcPivotZones(flat(closes), { ...PIVOT, flip: false });
  assert.equal(zones.filter((z) => z.flips > 0).length, 0);
});

test("a slow drift off the low is not a zone", () => {
  // Same low, but the leg needs 30 ATR to count.
  const zones = calcPivotZones(flat([...FIRST_LOW, 105]), { ...PIVOT, legMove: 30 });
  assert.equal(zones.filter((z) => z.kind === "demand" && z.flips === 0).length, 0);
});

// ── colour + shading ────────────────────────────────────────────────────────

test("hex colours become an rgba() prefix", () => {
  assert.equal(hexToRgb("#26a69a"), "38,166,154");
  assert.equal(hexToRgb("#FFFFFF"), "255,255,255");
});

test("settings: bad colours fall back, strength is clamped, the id never changes", () => {
  const a = createSdZones({ demandColor: "red", supplyColor: "#123456", intensity: 99 });
  assert.equal(a.config.demandColor, "#26a69a");
  assert.equal(a.config.supplyColor, "#123456");
  assert.equal(a.config.intensity, 4);
  assert.equal(a.id, createSdZones({ mode: "base", demandColor: "#000000" }).id);
});

test("shade: pivot darkens per reaction, strength by departure, flat is flat, broken is faint", () => {
  const z = calcPivotZones(flat([...FIRST_LOW, ...SECOND_LOW, 105]), PIVOT).find(
    (x) => x.kind === "demand" && x.flips === 0
  );
  assert.ok(z);
  const once = { ...z, reactions: 1 };
  assert.ok(fillAlpha(z, "auto") > fillAlpha(once, "auto"));
  assert.ok(
    fillAlpha({ ...z, strength: 6 }, "strength") > fillAlpha({ ...z, strength: 2 }, "strength")
  );
  assert.equal(fillAlpha(z, "flat"), fillAlpha(once, "flat"));
  assert.equal(fillAlpha({ ...z, end: 3 }, "auto"), 0.05);
});

// ── breaks: suspect → spring or confirmed break ─────────────────────────────

/** The two-reaction demand zone 93–94.5, then `after` closes. */
const demandAfter = (after: number[], cfg = {}) =>
  calcPivotZones(flat([...FIRST_LOW, ...SECOND_LOW, 100, ...after]), { ...PIVOT, ...cfg });
const original = (zones: ReturnType<typeof calcPivotZones>) =>
  zones.find((z) => z.kind === "demand" && z.flips === 0 && z.start === 5);

test("a close just under the distal is not a break; two in a row are", () => {
  // ATR(3) here is ~4, so 0.25 ATR ≈ 1: a close at 92.8 is only 0.2 under 93.
  const one = original(demandAfter([92.8, 96, 97]));
  assert.ok(one);
  assert.equal(one.pendingSince, null);
  assert.equal(one.springs, 0);
  const two = original(demandAfter([92.8, 92.8, 97, 97])); // last bar = forming;
  assert.ok(two);
  assert.equal(two.springs, 1); // suspected on the 2nd close, reclaimed by 96
});

test("a break reclaimed within reclaimBars is a spring: same side, one more reaction", () => {
  const z = original(demandAfter([88, 90, 95, 98, 97]));
  assert.ok(z);
  assert.equal(z.end, null);
  assert.equal(z.kind, "demand");
  assert.equal(z.springs, 1);
  assert.equal(z.reactions, 3);
  assert.equal(z.pendingSince, null);
});

test("while waiting the zone is suspect, not broken", () => {
  const z = original(demandAfter([88, 89, 88]));
  assert.ok(z);
  assert.equal(z.end, null);
  assert.equal(z.pendingSince, FIRST_LOW.length + SECOND_LOW.length + 1);
});

test("still beyond after reclaimBars: broken on the confirming bar, flipped, reactions kept", () => {
  const first = FIRST_LOW.length + SECOND_LOW.length + 1; // the 88 close
  const zones = demandAfter([88, 87, 86, 85, 84]);
  const d = original(zones);
  assert.ok(d);
  assert.equal(d.end, first + 3);
  const s = zones.find((z) => z.kind === "supply" && z.flips === 1 && z.start === first + 3);
  assert.ok(s);
  assert.equal(s.reactions, d.reactions);
});

test("labels name the state", () => {
  assert.match(zoneTag(original(demandAfter([88, 90, 95, 98, 97])) as SdZone), /spring/);
  assert.match(zoneTag(original(demandAfter([88, 89, 88])) as SdZone), /break\?/);
});

// ── traps: a move through a zone that failed ────────────────────────────────

/** Mirror of FIRST_LOW: a swing high → the supply zone 106–107. */
const FIRST_HIGH = [100, 100, 100, 102, 104, 106, 103, 100, 97, 94];
const BACK_UP = [97, 100, 104]; // returns towards the zone, still under it
const AT = FIRST_HIGH.length + BACK_UP.length; // first bar of each test's own closes

const trapsOf = (data: OhlcvBar[], cfg = {}) =>
  scanPivotZones(data, { ...PIVOT, traps: "both", ...cfg }).traps;
const bull = (t: SdTrap[]) => t.filter((x) => x.side === "bull");
const supplyAfter = (after: number[], cfg = {}) =>
  trapsOf(flat([...FIRST_HIGH, ...BACK_UP, ...after]), cfg);

test("a close over the supply top, back under it on the next bar = a bull trap", () => {
  const data = flat([...FIRST_HIGH, ...BACK_UP, 107.5, 105, 104]);
  const { traps, zones } = scanPivotZones(data, { ...PIVOT, traps: "bull" });
  assert.equal(traps.length, 1);
  const t = traps[0];
  assert.equal(t.side, "bull");
  assert.equal(t.kind, "breakout");
  assert.equal(t.b, AT); // the 107.5 close
  assert.equal(t.f, AT + 1); // the 105 close — the bar it became known
  assert.equal(t.level, 107);
  assert.equal(t.peak, AT);
  // 0.5 over the edge is under the break buffer: the zone never called it an upthrust.
  const supply = zones.find((z) => z.kind === "supply" && z.start === 5);
  assert.ok(supply);
  assert.equal(supply.springs, 0);
});

test("the zones are the same with traps on or off, and off finds none", () => {
  const data = flat([...FIRST_HIGH, ...BACK_UP, 107.5, 105, 104]);
  const off = scanPivotZones(data, PIVOT);
  assert.equal(off.traps.length, 0);
  assert.deepEqual(scanPivotZones(data, { ...PIVOT, traps: "both" }).zones, off.zones);
});

test("back under the edge later than trapBars is not a trap", () => {
  assert.equal(bull(supplyAfter([107.5, 107.6, 105, 104], { trapBars: 1 })).length, 0);
  assert.equal(bull(supplyAfter([107.5, 107.6, 105, 104], { trapBars: 2 })).length, 1);
});

test("a wick through the top that closes back under it is a one-bar trap", () => {
  const data = flat([...FIRST_HIGH, ...BACK_UP]);
  data.push({ time: AT, open: 104, high: 109, low: 103.5, close: 104.5 });
  data.push({ time: AT + 1, open: 103, high: 104, low: 102, close: 103 });
  data.push({ time: AT + 2, open: 102, high: 103, low: 101, close: 102 });
  const t = bull(trapsOf(data));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "wick");
  assert.equal(t[0].b, AT);
  assert.equal(t[0].f, AT);
  assert.equal(t[0].checks.engulf, null); // one bar: nothing to engulf
  // The same wick, but it must reach 2 ATR past the edge: not far enough.
  assert.equal(bull(trapsOf(data, { trapWick: 2 })).length, 0);
});

test("a close inside an ordinary supply zone and out again is a touch, not a trap", () => {
  assert.equal(bull(supplyAfter([106.5, 103, 102], { trapWick: 2 })).length, 0);
});

test("bear is the mirror at a demand zone, and only looked for when asked", () => {
  const data = flat([...FIRST_LOW, 103, 100, 96, 92.5, 95, 96]);
  const at = FIRST_LOW.length + 3; // the 92.5 close, under the 93 low
  const bear = trapsOf(data).filter((t) => t.side === "bear" && t.level === 93);
  assert.equal(bear.length, 1);
  assert.equal(bear[0].kind, "breakout");
  assert.equal(bear[0].b, at);
  assert.equal(bear[0].f, at + 1);
  assert.equal(trapsOf(data, { traps: "bull" }).filter((t) => t.side === "bear").length, 0);
});

// The demand zone 93–94.5 breaks on the fourth close under it and comes back
// as supply 93 (proximal) – 94.5 (distal).
const FLIPPED = [...FIRST_LOW, ...SECOND_LOW, 100, 88, 87, 86, 85];
const reclaims = (data: OhlcvBar[], cfg = {}) =>
  trapsOf(data, { trapWick: 2, ...cfg }).filter((t) => t.kind === "reclaim");

test("a flipped zone: a close back inside, then out the way it came = a failed reclaim", () => {
  const t = reclaims(flat([...FLIPPED, 94, 94, 90, 89]));
  assert.equal(t.length, 1);
  assert.equal(t[0].side, "bull");
  assert.equal(t[0].b, FLIPPED.length); // first close back over 93
  assert.equal(t[0].f, FLIPPED.length + 2); // the 90 close
  assert.equal(t[0].level, 93); // the edge it took back and lost
});

test("a reclaim that holds past trapBars is not a trap, and is not looked for again", () => {
  assert.equal(reclaims(flat([...FLIPPED, 94, 94, 94, 94, 90, 89])).length, 0);
  // In and out in time (a trap), then in and out again: only the first counts.
  assert.equal(reclaims(flat([...FLIPPED, 94, 90, 94, 90, 89])).length, 1);
});

test("checks: weak volume, rejection wick, failing close under the first bar's low", () => {
  const closes = [...FLIPPED, 94, 94, 90, 89];
  const withVolume = (first: number | undefined) =>
    flat(closes).map((b, i) => ({
      ...b,
      volume: first === undefined ? undefined : i === FLIPPED.length ? first : 100,
    }));
  const quiet = reclaims(withVolume(50))[0];
  assert.deepEqual(quiet.checks, { volume: true, wick: true, engulf: true });
  assert.equal(quiet.score, 3);
  assert.equal(quiet.of, 3);
  const loud = reclaims(withVolume(200))[0];
  assert.equal(loud.checks.volume, false);
  assert.equal(loud.score, 2);
  // No volume data: the check is left out of the count, not failed.
  const none = reclaims(withVolume(undefined))[0];
  assert.equal(none.checks.volume, null);
  assert.equal(none.of, 2);
});

test("trap labels name the side, the kind and the checks", () => {
  const t = reclaims(flat([...FLIPPED, 94, 94, 90, 89]))[0];
  assert.equal(trapLabel(t), "BULL TRAP·RECLAIM 2/2");
  assert.equal(trapLabel({ ...t, kind: "breakout", score: 1, of: 3 }), "BULL TRAP 1/3");
  assert.equal(trapLabel({ ...t, side: "bear", kind: "wick", score: 1, of: 1 }), "BEAR TRAP 1/1");
});

// ── traps overlay: which candles are outlined ───────────────────────────────

/** 20 quiet bars for the default ATR(14), then the supply zone and a trap over it. */
const LONG = [...Array.from({ length: 20 }, () => 100), ...FIRST_HIGH.slice(3), ...BACK_UP];
const TRAPPED = flat([...LONG, 107.5, 105, 104]);

test("the overlay outlines the trap's bars, first to failing, and nothing else", () => {
  const overlay = createSdTrapsOverlay(createSdZones({ trapColor: "#112233" }).config);
  assert.ok(overlay?.barBorders);
  const colors = overlay.barBorders(TRAPPED);
  assert.ok(colors);
  assert.deepEqual([...colors.keys()], [LONG.length, LONG.length + 1]);
  assert.equal(colors.get(LONG.length), "#112233");
});

test("traps off = no overlay; trapMin hides a trap with too few checks", () => {
  assert.equal(createSdTrapsOverlay(createSdZones({ traps: "off" }).config), null);
  // No volume on these bars: 2 checks can be measured, so 3 can never be met.
  const strict = createSdTrapsOverlay(createSdZones({ trapMin: 3 }).config);
  assert.equal(strict?.barBorders?.(TRAPPED), null);
});
