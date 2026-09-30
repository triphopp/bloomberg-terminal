import assert from "node:assert/strict";
import { test } from "node:test";

import {
  caretAfter,
  groupNumber,
  sameNumber,
  sanitizeNumber,
  significantBefore,
  toRawNumber,
} from "../number-input.ts";

test("groups the integer part only, never rounds the fraction", () => {
  assert.equal(groupNumber("1234567.8912"), "1,234,567.8912");
  assert.equal(groupNumber("0.0012345"), "0.0012345");
  assert.equal(groupNumber("-1000"), "-1,000");
  assert.equal(groupNumber("12."), "12.");
  assert.equal(groupNumber("-"), "-");
  assert.equal(groupNumber("999"), "999");
});

test("typed or pasted text becomes a plain number string", () => {
  assert.equal(sanitizeNumber("1,234,567.89"), "1234567.89");
  assert.equal(sanitizeNumber("฿ 441,146.03"), "441146.03");
  assert.equal(sanitizeNumber("1.2.3"), "1.23");
  assert.equal(sanitizeNumber("-5-"), "-5");
  assert.equal(sanitizeNumber("-5", false), "5");
  assert.equal(sanitizeNumber("abc"), "");
});

test("form values of either type round-trip", () => {
  assert.equal(toRawNumber(1e-7), "0.0000001");
  assert.equal(toRawNumber(2436.62), "2436.62");
  assert.equal(toRawNumber("1,000"), "1000");
  assert.equal(toRawNumber(null), "");
});

test("half-typed numbers are not reset by the parent's parsed value", () => {
  assert.ok(sameNumber("12.", 12));
  assert.ok(sameNumber("0.0", ""));
  assert.ok(sameNumber("", 0));
  assert.ok(!sameNumber("123", ""));
});

test("the caret stays after the same digit when commas appear", () => {
  // typed "12345|" → shown "12,345|"
  assert.equal(caretAfter("12,345", significantBefore("12345", 5)), 6);
  // caret after "1234" in "1234|5" → "1,234|5"
  assert.equal(caretAfter("12,345", significantBefore("12345", 4)), 5);
  assert.equal(caretAfter("1,000", 0), 0);
  // a stray letter typed mid-number does not shift the caret
  assert.equal(significantBefore("12a3", 3), 2);
});
