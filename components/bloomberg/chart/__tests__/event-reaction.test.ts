import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeEventReaction,
  daysPastLastBar,
  earningsSession,
  findEventBarIndex,
  placeEvents,
} from "../event-reaction.ts";
import type { ChartEventMarker, OhlcvBar } from "../types.ts";

// Daily bars with a deliberate gap: 2026-03-04 is missing, standing in for a
// market holiday an event can land on.
const daily: OhlcvBar[] = [
  { time: "2026-03-02", open: 100, high: 101, low: 99, close: 100 },
  { time: "2026-03-03", open: 100, high: 102, low: 99, close: 101 },
  { time: "2026-03-05", open: 105, high: 110, low: 104, close: 108 },
  { time: "2026-03-06", open: 108, high: 112, low: 107, close: 111 },
  { time: "2026-03-09", open: 111, high: 113, low: 110, close: 112 },
  { time: "2026-03-10", open: 112, high: 114, low: 111, close: 113 },
  { time: "2026-03-11", open: 113, high: 118, low: 112, close: 117 },
  { time: "2026-03-12", open: 117, high: 120, low: 116, close: 119 },
];

const earnings = (time: string, reportedAt?: string): ChartEventMarker => ({
  time,
  type: "earnings",
  label: "E",
  reportedAt,
});

// ── earningsSession ────────────────────────────────────────────────────────
//
// A report released after the close cannot move that day's bar. Getting this
// wrong measures the reaction against a bar that priced nothing.

test("a late-afternoon stamp is after the close", () => {
  assert.equal(earningsSession("2026-03-05 16:30"), "AMC");
  assert.equal(earningsSession("2026-03-05 21:05"), "AMC");
});

test("a morning stamp is before the open", () => {
  assert.equal(earningsSession("2026-03-05 07:00"), "BMO");
});

test("midday and missing stamps stay unknown rather than guessing", () => {
  assert.equal(earningsSession("2026-03-05 13:00"), "UNKNOWN");
  assert.equal(earningsSession(undefined), "UNKNOWN");
  assert.equal(earningsSession("2026-03-05"), "UNKNOWN");
});

// ── findEventBarIndex ──────────────────────────────────────────────────────

test("an event on a trading day resolves to that bar", () => {
  assert.equal(findEventBarIndex(daily, earnings("2026-03-05")), 2);
});

test("an event on a non-trading day resolves forward to the next bar", () => {
  // 2026-03-04 has no bar — the news gets priced on the 5th.
  assert.equal(findEventBarIndex(daily, earnings("2026-03-04")), 2);
});

test("an event past the loaded range has no bar", () => {
  assert.equal(findEventBarIndex(daily, earnings("2026-04-01")), -1);
});

test("an event just before the window opens is pulled onto the first bar", () => {
  // 2026-02-28 is a Saturday ahead of a Monday open — close enough to be real.
  assert.equal(findEventBarIndex(daily, earnings("2026-02-28")), 0);
});

test("an event well before the loaded range is dropped, not stacked on bar 0", () => {
  // Unbounded forward resolution put an entire dividend history — 20 years of
  // quarterly payments — onto the first candle of a 3M chart.
  assert.equal(findEventBarIndex(daily, earnings("2026-01-01")), -1);
  assert.equal(findEventBarIndex(daily, earnings("2004-05-06")), -1);
});

test("an empty series has no bar to resolve to", () => {
  assert.equal(findEventBarIndex([], earnings("2026-03-05")), -1);
});

const intraday: OhlcvBar[] = [
  { time: 1_772_000_000, open: 1, high: 1, low: 1, close: 1 },
  { time: 1_772_003_600, open: 1, high: 1, low: 1, close: 1 },
];

const atTime = (time: number): ChartEventMarker => ({ time, type: "earnings", label: "E" });

test("intraday bars take the closest bar, not the next one", () => {
  assert.equal(findEventBarIndex(intraday, atTime(1_772_003_500)), 1);
  assert.equal(findEventBarIndex(intraday, atTime(1_772_000_100)), 0);
});

test("an intraday event more than a day from any bar is dropped", () => {
  assert.equal(findEventBarIndex(intraday, atTime(1_600_000_000)), -1);
});

// ── placeEvents ────────────────────────────────────────────────────────────

test("placement keeps in-range events and reports their bar index", () => {
  const placed = placeEvents([earnings("2026-03-04"), earnings("2026-03-06")], daily);
  assert.deepEqual(
    placed.map((p) => [p.time, p.barIdx]),
    [
      ["2026-03-05", 2],
      ["2026-03-06", 3],
    ]
  );
});

test("years of pre-history do not pile onto the first bar", () => {
  // COST carries ~120 dividends back to 2004. Unbounded forward resolution put
  // every one of them onto bar 0 of a 3M chart, which the rail would then draw
  // as a single "···120" chip jammed against the left edge.
  const old = ["2004-05-06", "2010-08-04", "2020-01-01", "2025-11-10"].map((t) => earnings(t));
  assert.equal(placeEvents(old, daily).length, 0);
});

test("an event past the right edge is kept as upcoming, anchored on the last bar", () => {
  // The market has not reached 2026-05-01, so no bar can host it. Dropping it
  // here is what hid every declared-but-unpaid dividend and every scheduled
  // report from the rail.
  const [p] = placeEvents([earnings("2026-05-01")], daily);
  assert.equal(p.future, true);
  assert.equal(p.time, "2026-03-12");
  assert.equal(p.barIdx, daily.length - 1);
  assert.equal(p.daysAhead, 50);
});

test("an event too far out is dropped rather than crowding the right edge", () => {
  assert.equal(placeEvents([earnings("2027-06-01")], daily).length, 0);
});

test("upcoming events come out in date order, after the placed ones", () => {
  const placed = placeEvents(
    [earnings("2026-06-01"), earnings("2026-04-01"), earnings("2026-03-05")],
    daily
  );
  assert.deepEqual(
    placed.map((p) => [p.marker.time, p.future ?? false]),
    [
      ["2026-03-05", false],
      ["2026-04-01", true],
      ["2026-06-01", true],
    ]
  );
});

test("an upcoming event has no price reaction to report", () => {
  const r = computeEventReaction(daily, earnings("2026-05-01"));
  assert.equal(r.closeOnEvent, null);
  assert.equal(r.gapPct, null);
  assert.equal(r.fiveDayPct, null);
});

test("days past the last bar is zero for anything inside the range", () => {
  assert.equal(daysPastLastBar(daily, earnings("2026-03-05")), 0);
  assert.equal(daysPastLastBar(daily, earnings("2026-03-12")), 0);
  assert.equal(daysPastLastBar(daily, earnings("2026-03-13")), 1);
});

// ── computeEventReaction ───────────────────────────────────────────────────

test("a before-open report is measured from the previous close", () => {
  // Event bar is 2026-03-05; baseline is the 3rd's close of 101.
  const r = computeEventReaction(daily, earnings("2026-03-05", "2026-03-05 07:00"));
  assert.ok(r.gapPct !== null && Math.abs(r.gapPct - (105 / 101 - 1) * 100) < 1e-9);
  assert.ok(r.sameDayPct !== null && Math.abs(r.sameDayPct - (108 / 101 - 1) * 100) < 1e-9);
  assert.ok(r.nextDayPct !== null && Math.abs(r.nextDayPct - (111 / 101 - 1) * 100) < 1e-9);
  assert.ok(r.fiveDayPct !== null && Math.abs(r.fiveDayPct - (119 / 101 - 1) * 100) < 1e-9);
  assert.equal(r.closeOnEvent, 108);
});

test("an after-close report shifts the whole window one bar right", () => {
  // Reported after the close on the 5th: the market reacts on the 6th, and the
  // baseline is the 5th's own close of 108 — not the 3rd's.
  const r = computeEventReaction(daily, earnings("2026-03-05", "2026-03-05 16:30"));
  assert.ok(r.gapPct !== null && Math.abs(r.gapPct - (108 / 108 - 1) * 100) < 1e-9);
  assert.ok(r.sameDayPct !== null && Math.abs(r.sameDayPct - (111 / 108 - 1) * 100) < 1e-9);
  assert.ok(r.nextDayPct !== null && Math.abs(r.nextDayPct - (112 / 108 - 1) * 100) < 1e-9);
  // Only four bars follow, so D+5 has nothing to read.
  assert.equal(r.fiveDayPct, null);
  // closeOnEvent stays the report day's close — it is what a dividend yields off.
  assert.equal(r.closeOnEvent, 108);
});

test("an event on the first bar has no baseline close", () => {
  const r = computeEventReaction(daily, earnings("2026-03-02", "2026-03-02 07:00"));
  assert.equal(r.gapPct, null);
  assert.equal(r.nextDayPct, null);
  // The close is still known even when the reaction cannot be measured.
  assert.equal(r.closeOnEvent, 100);
});

test("an event outside the loaded range reports nothing at all", () => {
  const r = computeEventReaction(daily, earnings("2026-04-01"));
  assert.equal(r.closeOnEvent, null);
  assert.equal(r.gapPct, null);
});

test("a dividend is never treated as after-close", () => {
  // Only earnings carry a session; a dividend ex-date prices on its own bar.
  const div: ChartEventMarker = {
    time: "2026-03-05",
    type: "dividend",
    label: "D",
    dividend: 0.5,
    // A stamp that would read as AMC if the type were ignored.
    reportedAt: "2026-03-05 16:30",
  };
  const r = computeEventReaction(daily, div);
  assert.equal(r.closeOnEvent, 108);
  assert.ok(r.sameDayPct !== null && Math.abs(r.sameDayPct - (108 / 101 - 1) * 100) < 1e-9);
});
