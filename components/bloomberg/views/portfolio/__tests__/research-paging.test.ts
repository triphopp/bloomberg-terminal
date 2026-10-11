import assert from "node:assert/strict";
import test from "node:test";
import {
  ROW_H,
  fmtStamp,
  matchesResearch,
  newestFirst,
  pageCount,
  pageOf,
  pageSizeFor,
  pageSlice,
  parseUtc,
} from "../tabs/research/paging.ts";

test("a page holds only whole rows, and at least one", () => {
  assert.equal(pageSizeFor(ROW_H * 10), 10);
  assert.equal(pageSizeFor(ROW_H * 10 + ROW_H - 1), 10);
  assert.equal(pageSizeFor(5), 1);
  assert.equal(pageSizeFor(0), 1);
  assert.equal(pageSizeFor(Number.NaN), 1);
});

test("page count and slices cover every row once", () => {
  const rows = Array.from({ length: 26 }, (_, i) => i);
  assert.equal(pageCount(26, 10), 3);
  assert.equal(pageCount(0, 10), 1);
  assert.equal(pageCount(20, 10), 2);
  const seen = [0, 1, 2].flatMap((p) => pageSlice(rows, p, 10));
  assert.deepEqual(seen, rows);
  assert.deepEqual(pageSlice(rows, 2, 10), [20, 21, 22, 23, 24, 25]);
});

test("the row being read stays on screen when the page size changes", () => {
  // Row 20 opens page 3 of 10-row pages; with 8-row pages it is on page 3 (rows 16–23).
  assert.equal(pageOf(20, 26, 10), 2);
  assert.equal(pageOf(20, 26, 8), 2);
  assert.equal(pageOf(20, 26, 4), 5);
  // A filter that shortens the list pulls the page back inside it.
  assert.equal(pageOf(20, 5, 10), 0);
  assert.equal(pageOf(-3, 26, 10), 0);
  assert.equal(pageOf(0, 0, 10), 0);
});

test("both spellings of the stamp are read as UTC", () => {
  assert.equal(parseUtc("2026-10-09 01:46:55.193")?.toISOString(), "2026-10-09T01:46:55.193Z");
  assert.equal(parseUtc("2026-10-06T18:03:21.975083")?.toISOString(), "2026-10-06T18:03:21.975Z");
  assert.equal(parseUtc("2026-10-06T18:03:21Z")?.toISOString(), "2026-10-06T18:03:21.000Z");
  assert.equal(parseUtc(""), null);
  assert.equal(parseUtc("not a date"), null);
  assert.equal(fmtStamp(null), "—");
  assert.match(fmtStamp("2026-10-09 01:46:55.193"), /^2026-10-0[89] \d\d:\d\d$/);
});

test("newest first compares moments, not text", () => {
  const rows = [
    { title: "a", updated_at: "2026-10-09T01:00:00.000000" },
    { title: "b", updated_at: "2026-10-09 02:00:00.000" },
    { title: "c", updated_at: "2026-10-08T23:00:00.000000" },
  ];
  assert.deepEqual(
    newestFirst(rows).map((r) => r.title),
    ["b", "a", "c"]
  );
  assert.equal(rows[0].title, "a");
});

test("search needs every word, across title, symbol, tags and description", () => {
  const row = {
    title: "HBF vs NAND",
    symbol: "SNDK",
    tags: "memory,flash",
    description: "ต้นทุนต่อบิต",
    updated_at: "",
  };
  assert.ok(matchesResearch(row, ""));
  assert.ok(matchesResearch(row, "sndk hbf"));
  assert.ok(matchesResearch(row, "flash ต้นทุน"));
  assert.ok(!matchesResearch(row, "sndk dram"));
});
