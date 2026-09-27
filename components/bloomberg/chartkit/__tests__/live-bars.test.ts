import assert from "node:assert/strict";
import test from "node:test";
import { type LiveHistory, applyTickToBars } from "../live-bars.ts";

const bar = (date: string, c: number) => ({ date, open: c, high: c, low: c, close: c, volume: 10 });

// AAPL, New York (EDT, UTC−4), hourly bars starting at :30.
const nyHourly: LiveHistory = {
  interval: "1h",
  utc_offset_min: -240,
  quotes: [bar("2026-09-25T14:30:00", 100), bar("2026-09-25T15:30:00", 101)],
};

test("tick inside the last hourly bar moves its close/high/low only", () => {
  // 15:45 NY = 19:45 UTC
  const out = applyTickToBars(nyHourly, { price: 103, ts: Date.UTC(2026, 8, 25, 19, 45) });
  assert.equal(out.quotes.length, 2);
  assert.deepEqual(out.quotes[1], { ...nyHourly.quotes[1], close: 103, high: 103 });
});

test("next session's open starts a new bar on the same :30 grid", () => {
  // Mon 09:31 NY = 13:31 UTC, three days later
  const out = applyTickToBars(nyHourly, { price: 99, ts: Date.UTC(2026, 8, 28, 13, 31) });
  assert.equal(out.quotes.length, 3);
  assert.equal(out.quotes[2].date, "2026-09-28T09:30:00");
  assert.equal(out.quotes[2].open, 99);
});

test("a frame older than the last bar is ignored", () => {
  const out = applyTickToBars(nyHourly, { price: 50, ts: Date.UTC(2026, 8, 25, 18, 0) });
  assert.equal(out, nyHourly);
});

test("daily bars use the exchange-local date, not UTC", () => {
  // Bangkok (UTC+7): 2026-09-26 09:30 local is still 2026-09-26 02:30 UTC,
  // and 2026-09-26 06:00 local is 2026-09-25 23:00 UTC — local date wins.
  const bkk: LiveHistory = { interval: "1d", utc_offset_min: 420, quotes: [bar("2026-09-25", 30)] };
  const same = applyTickToBars(bkk, { price: 31, ts: Date.UTC(2026, 8, 25, 8, 0) });
  assert.equal(same.quotes.length, 1);
  assert.equal(same.quotes[0].close, 31);
  const next = applyTickToBars(bkk, { price: 32, ts: Date.UTC(2026, 8, 26, 3, 0) });
  assert.equal(next.quotes.length, 2);
  assert.equal(next.quotes[1].date, "2026-09-26");
});

test("unchanged price returns the same object", () => {
  const h: LiveHistory = { interval: "1d", utc_offset_min: 0, quotes: [bar("2026-09-26", 84000)] };
  assert.equal(applyTickToBars(h, { price: 84000, ts: Date.UTC(2026, 8, 26, 3) }), h);
});

test("no offset = cannot place the tick = untouched", () => {
  const h: LiveHistory = { interval: "1d", utc_offset_min: null, quotes: [bar("2026-09-26", 1)] };
  assert.equal(applyTickToBars(h, { price: 2, ts: Date.UTC(2026, 8, 26, 3) }), h);
});

test("weekly: moves the current week, leaves a new week to the refetch", () => {
  const wk: LiveHistory = { interval: "1wk", utc_offset_min: 0, quotes: [bar("2026-09-21", 10)] };
  assert.equal(applyTickToBars(wk, { price: 11, ts: Date.UTC(2026, 8, 24) }).quotes[0].close, 11);
  assert.equal(applyTickToBars(wk, { price: 11, ts: Date.UTC(2026, 8, 29) }), wk);
});
