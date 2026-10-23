import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_ITEMS,
  dateInZone,
  readSnapshot,
  reviveQuote,
  writeSnapshot,
} from "../watchlist-snapshot.ts";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

const NOW = Date.UTC(2026, 9, 21, 15, 0);

test("round trip keeps the fetch time of each item", () => {
  const s = memStorage();
  writeSnapshot(s, "quotes", { AAPL: { at: NOW - 1000, data: { p: 1 } } }, NOW);
  assert.deepEqual(readSnapshot(s, "quotes", NOW), { AAPL: { at: NOW - 1000, data: { p: 1 } } });
});

test("a write merges with stored symbols and never replaces a newer item", () => {
  const s = memStorage();
  writeSnapshot(s, "quotes", { A: { at: NOW - 10, data: 1 }, B: { at: NOW - 10, data: 1 } }, NOW);
  writeSnapshot(s, "quotes", { A: { at: NOW - 5, data: 2 }, B: { at: NOW - 50, data: 0 } }, NOW);
  const got = readSnapshot<number>(s, "quotes", NOW);
  assert.equal(got.A.data, 2);
  assert.equal(got.B.data, 1);
});

test("items past the max age, from the future or malformed are dropped", () => {
  const s = memStorage();
  s.setItem(
    `${SNAPSHOT_KEY_PREFIX}signals`,
    JSON.stringify({
      OLD: { at: NOW - SNAPSHOT_MAX_AGE_MS.signals - 1, data: 1 },
      FUT: { at: NOW + 60_000, data: 1 },
      BAD: { data: 1 },
      NUL: { at: NOW, data: null },
      OK: { at: NOW - 1, data: 1 },
    })
  );
  assert.deepEqual(Object.keys(readSnapshot(s, "signals", NOW)), ["OK"]);
});

test("corrupt JSON or no storage reads as empty", () => {
  const s = memStorage();
  s.setItem(`${SNAPSHOT_KEY_PREFIX}quotes`, "{not json");
  assert.deepEqual(readSnapshot(s, "quotes", NOW), {});
  assert.deepEqual(readSnapshot(undefined, "quotes", NOW), {});
});

test("keeps only the newest SNAPSHOT_MAX_ITEMS", () => {
  const s = memStorage();
  const fresh: Record<string, { at: number; data: number }> = {};
  for (let i = 0; i < SNAPSHOT_MAX_ITEMS + 10; i++) fresh[`S${i}`] = { at: NOW - i, data: i };
  writeSnapshot(s, "quotes", fresh, NOW);
  const got = readSnapshot<number>(s, "quotes", NOW);
  assert.equal(Object.keys(got).length, SNAPSHOT_MAX_ITEMS);
  assert.ok(got.S0 && !got[`S${SNAPSHOT_MAX_ITEMS + 5}`]);
});

test("a full storage does not throw", () => {
  const s = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  writeSnapshot(s, "quotes", { A: { at: NOW, data: 1 } }, NOW);
});

test("dateInZone uses the exchange's calendar", () => {
  // 2026-10-21 15:00 UTC = 22:00 Bangkok, 11:00 New York — same date;
  // 2026-10-21 20:00 UTC = 03:00 next day in Bangkok.
  assert.equal(dateInZone(NOW, "America/New_York"), "2026-10-21");
  assert.equal(dateInZone(Date.UTC(2026, 9, 21, 20), "Asia/Bangkok"), "2026-10-22");
  assert.equal(dateInZone(NOW, "Not/AZone"), null);
  assert.equal(dateInZone(NOW, null), null);
});

test("reviveQuote: yesterday's 'current session' is no longer current", () => {
  const q = {
    quoteDate: "2026-10-20",
    exchangeTimezone: "America/New_York",
    isCurrentSession: true,
  };
  assert.equal(reviveQuote(q, NOW).isCurrentSession, false);
  const today = { ...q, quoteDate: "2026-10-21" };
  assert.equal(reviveQuote(today, NOW).isCurrentSession, true);
  const unknown = { quoteDate: "2026-10-21", exchangeTimezone: null, isCurrentSession: true };
  assert.equal(reviveQuote(unknown, NOW).isCurrentSession, false);
  const notCurrent = { ...q, isCurrentSession: false };
  assert.equal(reviveQuote(notCurrent, NOW), notCurrent);
});
