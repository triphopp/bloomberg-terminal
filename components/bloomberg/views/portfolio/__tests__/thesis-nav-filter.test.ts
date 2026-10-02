import assert from "node:assert/strict";
import test from "node:test";
import {
  NAV_DEFAULT,
  facet,
  filterTheses,
  groupTheses,
  kindOf,
  matchesQuery,
  sectorOf,
} from "../tabs/theses/nav-filter.ts";

// biome-ignore lint/suspicious/noExplicitAny: a thesis row with only the fields the filter reads
const T = (o: Record<string, unknown>): any => ({
  id: o.symbol,
  title: "",
  status: "draft",
  updated_at: "2026-10-01",
  ...o,
});

const book = [
  T({ symbol: "INTC", title: "CPU:GPU 1:1", sector_eff: "Information Technology" }),
  T({ symbol: "ORCL", category: "credit", sector_eff: "Information Technology" }),
  T({ symbol: "TH-RATES", kind: "macro", tags: "thailand, rates", updated_at: "2026-10-02" }),
  T({ symbol: "GOLD", kind: "commodity" }),
  T({ symbol: "V", category: "GROWTH", sector: "Financials", status: "active" }),
];
const symbols = (list: { symbol: string }[]) => list.map((t) => t.symbol);

test("kind falls back to the old category, then to equity", () => {
  assert.deepEqual(book.map(kindOf), ["equity", "credit", "macro", "commodity", "equity"]);
  assert.equal(sectorOf(book[4]), "Financials");
});

test("every word of the query must match, across fields, # optional", () => {
  assert.equal(matchesQuery(book[2], "rates thailand"), true);
  assert.equal(matchesQuery(book[2], "#rates macro"), true);
  assert.equal(matchesQuery(book[2], "rates japan"), false);
  assert.equal(matchesQuery(book[0], "information"), true);
});

test("filters combine; counts drive the pending and unread toggles", () => {
  const counts = { INTC: { pending: 2, watch: 0, alert: 0, unread: 0 } };
  assert.deepEqual(
    symbols(filterTheses(book, { ...NAV_DEFAULT, sector: "Information Technology" })).sort(),
    ["INTC", "ORCL"]
  );
  assert.deepEqual(symbols(filterTheses(book, { ...NAV_DEFAULT, kind: "commodity" })), ["GOLD"]);
  assert.deepEqual(symbols(filterTheses(book, { ...NAV_DEFAULT, status: "active" })), ["V"]);
  assert.deepEqual(symbols(filterTheses(book, { ...NAV_DEFAULT, onlyPending: true }, counts)), [
    "INTC",
  ]);
  assert.deepEqual(filterTheses(book, { ...NAV_DEFAULT, onlyUnread: true }, counts), []);
});

test("sort: latest edit first by default, owed work first on request", () => {
  assert.equal(filterTheses([...book], NAV_DEFAULT)[0].symbol, "TH-RATES");
  const counts = { V: { pending: 0, watch: 0, alert: 1, unread: 0 } };
  assert.equal(filterTheses([...book], { ...NAV_DEFAULT, sort: "work" }, counts)[0].symbol, "V");
});

test("groups keep a fixed order: default kinds, then the user's own", () => {
  assert.deepEqual(
    groupTheses(book, "kind").map(([k]) => k),
    ["equity", "credit", "macro", "commodity"]
  );
  assert.deepEqual(
    groupTheses(book, "sector").map(([k, v]) => [k, v.length]),
    [
      ["Financials", 1],
      ["Information Technology", 2],
      ["", 2],
    ]
  );
  assert.deepEqual(facet(book, kindOf), [
    ["commodity", 1],
    ["credit", 1],
    ["equity", 2],
    ["macro", 1],
  ]);
});
