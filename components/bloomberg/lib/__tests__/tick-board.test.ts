import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TICK_BOARD,
  MAX_ROWS_PER_SECTION,
  type TickBoardPrefs,
  addRow,
  addSection,
  cleanSymbol,
  customSymbols,
  moveRow,
  normalizeSectionOrder,
  normalizeTickBoard,
  removeRow,
  removeSection,
  renameSection,
  toggleHiddenRow,
  toggleHiddenSection,
  visibleRows,
} from "../tick-board.ts";

const empty: TickBoardPrefs = { sections: [], hiddenRows: [], hiddenSections: [] };

test("a board that was never edited starts with one list holding IXG", () => {
  assert.deepEqual(customSymbols(DEFAULT_TICK_BOARD), ["IXG"]);
  assert.equal(DEFAULT_TICK_BOARD.sections[0].label, "MY LIST");
});

test("symbols are upper-cased and anything that is not a ticker is refused", () => {
  assert.equal(cleanSymbol(" ixg "), "IXG");
  assert.equal(cleanSymbol("^move"), "^MOVE");
  assert.equal(cleanSymbol("eurusd=x"), "EURUSD=X");
  assert.equal(cleanSymbol("btc-usd"), "BTC-USD");
  assert.equal(cleanSymbol("a b"), null);
  assert.equal(cleanSymbol("<script>"), null);
  assert.equal(cleanSymbol(""), null);
});

test("add / rename / remove a section", () => {
  let p = addSection(empty, "etf", "c:a");
  assert.deepEqual(p.sections, [{ id: "c:a", label: "ETF", rows: [] }]);
  assert.equal(addSection(p, "   ", "c:b"), p);
  assert.equal(addSection(p, "again", "c:a"), p);
  p = renameSection(p, "c:a", "global etf");
  assert.equal(p.sections[0].label, "GLOBAL ETF");
  assert.equal(renameSection(p, "c:a", ""), p);
  assert.deepEqual(removeSection(p, "c:a").sections, []);
  assert.equal(removeSection(p, "c:zzz"), p);
});

test("rows: add once, keep a label only when it differs, move and remove", () => {
  let p = addSection(empty, "x", "c:a");
  p = addRow(p, "c:a", "ixg");
  p = addRow(p, "c:a", "^MOVE", "MOVE");
  p = addRow(p, "c:a", "PTT.BK", "PTT.BK");
  assert.deepEqual(p.sections[0].rows, [
    { symbol: "IXG" },
    { symbol: "^MOVE", label: "MOVE" },
    { symbol: "PTT.BK" },
  ]);
  assert.equal(addRow(p, "c:a", "IXG"), p, "a duplicate changes nothing");
  assert.equal(addRow(p, "c:a", "not a symbol"), p);
  assert.equal(addRow(p, "c:missing", "SPY"), p);

  p = moveRow(p, "c:a", "PTT.BK", -1);
  assert.deepEqual(customSymbols(p), ["IXG", "PTT.BK", "^MOVE"]);
  assert.equal(moveRow(p, "c:a", "IXG", -1), p, "already first");
  assert.equal(moveRow(p, "c:a", "^MOVE", 1), p, "already last");
  p = removeRow(p, "c:a", "IXG");
  assert.deepEqual(customSymbols(p), ["PTT.BK", "^MOVE"]);
  assert.equal(removeRow(p, "c:a", "IXG"), p);
});

test("a section stops at its row cap", () => {
  let p = addSection(empty, "x", "c:a");
  for (let i = 0; i < MAX_ROWS_PER_SECTION + 5; i++) p = addRow(p, "c:a", `S${i}`);
  assert.equal(p.sections[0].rows.length, MAX_ROWS_PER_SECTION);
});

test("the same symbol in two sections is requested once", () => {
  let p = addSection(addSection(empty, "a", "c:a"), "b", "c:b");
  p = addRow(addRow(p, "c:a", "SPY"), "c:b", "SPY");
  assert.deepEqual(customSymbols(p), ["SPY"]);
});

test("hiding a built-in row or section is a toggle and filters only that section", () => {
  let p = toggleHiddenRow(empty, "volatility", "VIX 1D");
  const rows = [{ id: "VIX 1D" }, { id: "VIX" }];
  assert.deepEqual(visibleRows(p, "volatility", rows), [{ id: "VIX" }]);
  assert.equal(visibleRows(p, "americas", rows), rows, "another section is untouched");
  p = toggleHiddenRow(p, "volatility", "VIX 1D");
  assert.deepEqual(p.hiddenRows, []);
  assert.equal(visibleRows(p, "volatility", rows), rows);

  p = toggleHiddenSection(p, "ratesJP");
  assert.deepEqual(p.hiddenSections, ["ratesJP"]);
  assert.deepEqual(toggleHiddenSection(p, "ratesJP").hiddenSections, []);
});

test("stored prefs are cleaned: bad ids, bad symbols, duplicates and junk are dropped", () => {
  const p = normalizeTickBoard({
    sections: [
      {
        id: "c:a",
        label: "  mine ",
        rows: [{ symbol: "ixg" }, { symbol: "IXG" }, { symbol: "a b" }, null],
      },
      { id: "c:a", label: "dup", rows: [] },
      { id: "fx", label: "not custom", rows: [] },
      { id: "c:b", rows: "nope" },
    ],
    hiddenRows: ["volatility|VIX", "volatility|VIX", 7],
    hiddenSections: ["ratesJP", "bogus"],
  });
  assert.deepEqual(p.sections, [
    { id: "c:a", label: "mine", rows: [{ symbol: "IXG" }] },
    { id: "c:b", label: "LIST", rows: [] },
  ]);
  assert.deepEqual(p.hiddenRows, ["volatility|VIX"]);
  assert.deepEqual(p.hiddenSections, ["ratesJP"]);
  assert.equal(normalizeTickBoard(null), DEFAULT_TICK_BOARD);
  assert.equal(normalizeTickBoard("x"), DEFAULT_TICK_BOARD);
});

test("an emptied board stays empty — the default does not come back", () => {
  assert.deepEqual(normalizeTickBoard({ sections: [] }).sections, []);
});

test("section order keeps saved positions, drops dead ids, appends new ones", () => {
  const p = addSection(addSection(empty, "a", "c:a"), "b", "c:b");
  const order = normalizeSectionOrder(["fx", "c:gone", "c:b", "fx", "americas"], p);
  assert.deepEqual(order.slice(0, 3), ["fx", "c:b", "americas"]);
  assert.equal(order.length, 9);
  assert.ok(order.includes("c:a") && order.includes("ratesUS"));
  assert.equal(normalizeSectionOrder(null, empty).length, 7);
});
