import assert from "node:assert/strict";
import test from "node:test";
import { BLANK_FILTER, applyFilter, isFiltered, rangeBounds, yearsOf } from "../ledger-filter.ts";

type Row = { id: string; date: string; amt: number; acct: string; type: string; note: string };
const rows: Row[] = [
  {
    id: "a",
    date: "2025-12-31",
    amt: 1_883_714,
    acct: "finansia",
    type: "DEPOSIT",
    note: "opening balance",
  },
  { id: "b", date: "2026-01-12", amt: 50_000, acct: "dime", type: "DEPOSIT", note: "Dime" },
  {
    id: "c",
    date: "2026-03-28",
    amt: -16_000,
    acct: "finansia",
    type: "WITHDRAW",
    note: "Case Out",
  },
  {
    id: "d",
    date: "2026-07-14",
    amt: -98_834,
    acct: "finansia",
    type: "TRANSFER_OUT",
    note: "to Dime",
  },
  { id: "e", date: "2026-09-25", amt: -6_500, acct: "dime", type: "WITHDRAW", note: "" },
  { id: "f", date: "", amt: 10, acct: "dime", type: "DEPOSIT", note: "undated" },
];
const get = {
  date: (r: Row) => r.date,
  amount: (r: Row) => r.amt,
  account: (r: Row) => r.acct,
  type: (r: Row) => r.type,
  text: (r: Row) => [r.note, r.acct],
};
const TODAY = "2026-09-25";
const ids = (f: Partial<typeof BLANK_FILTER>) =>
  applyFilter(rows, { ...BLANK_FILTER, ...f }, get, TODAY).map((r) => r.id);

test("no filter keeps every row, newest first, undated last", () => {
  assert.deepEqual(ids({}), ["e", "d", "c", "b", "a", "f"]);
  assert.equal(isFiltered(BLANK_FILTER), false);
});

test("type chips: withdrawals only", () => {
  assert.deepEqual(ids({ types: ["WITHDRAW"] }), ["e", "c"]);
});

test("YTD starts on Jan 1 and drops undated rows", () => {
  assert.deepEqual(ids({ range: "YTD" }), ["e", "d", "c", "b"]);
});

test("YEAR and CUSTOM are inclusive on both ends", () => {
  assert.deepEqual(ids({ range: "YEAR", year: "2025" }), ["a"]);
  assert.deepEqual(ids({ range: "CUSTOM", from: "2026-01-12", to: "2026-03-28" }), ["c", "b"]);
});

test("3M counts back from today", () => {
  assert.deepEqual(rangeBounds({ ...BLANK_FILTER, range: "3M" }, TODAY), {
    from: "2026-06-25",
    to: null,
  });
});

test("search needs every word, across fields, any case", () => {
  assert.deepEqual(ids({ q: "case finansia" }), ["c"]);
  assert.deepEqual(ids({ q: "DIME" }), ["e", "d", "b", "f"]);
});

test("min amount uses the size, not the sign", () => {
  assert.deepEqual(ids({ minAmount: 20_000 }), ["d", "b", "a"]);
});

test("account + sort by amount", () => {
  assert.deepEqual(ids({ account: "finansia", sort: "amt_desc" }), ["a", "d", "c"]);
});

test("years menu is newest first and skips undated", () => {
  assert.deepEqual(
    yearsOf(rows, (r) => r.date),
    ["2026", "2025"]
  );
});
