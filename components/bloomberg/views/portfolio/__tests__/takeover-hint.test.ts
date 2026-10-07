import assert from "node:assert/strict";
import test from "node:test";
import { transferCostHint } from "../takeover-hint.ts";

const px = (n: number) => `฿${n.toFixed(2)}`;
const qty = (n: number) => n.toLocaleString("en-US");

const moved = (volume: number, original: number, entry = 13.9) => ({
  acquisition_type: "TRANSFER_IN",
  original_price_entry: original,
  transfer_price_entry: 13.9,
  price_entry: entry,
  date_entry: "2026-02-08",
  volume,
});
const bought = (volume: number, price: number) => ({
  acquisition_type: null,
  original_price_entry: null,
  transfer_price_entry: null,
  price_entry: price,
  date_entry: "2026-05-04",
  volume,
});

test("a bought lot has no hint — only transfers are explained", () => {
  assert.equal(transferCostHint([bought(100, 17.5)], px, qty), null);
  assert.equal(transferCostHint([], px, qty), null);
  // A transfer row the old cost was never recorded for says nothing rather than ฿0.00.
  assert.equal(transferCostHint([{ ...moved(100, 0), original_price_entry: null }], px, qty), null);
});

test("one transferred lot: old cost first, then the transfer", () => {
  assert.equal(
    transferCostHint([moved(13600, 20.03)], px, qty),
    "Previous owner's cost ฿20.03 — transferred in 2026-02-08 at ฿13.90"
  );
});

test("the transfer price is the memo one, not an entry price a later sale re-averaged", () => {
  assert.match(transferCostHint([moved(100, 20.03, 15.2)], px, qty) ?? "", /at ฿13\.90$/);
});

test("several transferred lots: volume-weighted old cost and each lot", () => {
  assert.equal(
    transferCostHint([moved(13600, 20.03), moved(4400, 21.05)], px, qty),
    [
      "Previous owner's cost ฿20.28 (average of 2 lots)",
      "13,600 × ฿20.03 — transferred in 2026-02-08 at ฿13.90",
      "4,400 × ฿21.05 — transferred in 2026-02-08 at ฿13.90",
    ].join("\n")
  );
});

test("a row that also holds bought lots says how many were transferred", () => {
  assert.equal(
    transferCostHint([moved(1000, 20), bought(500, 17)], px, qty),
    [
      "Previous owner's cost ฿20.00 (1 of 2 lots were transferred in)",
      "1,000 × ฿20.00 — transferred in 2026-02-08 at ฿13.90",
    ].join("\n")
  );
});
