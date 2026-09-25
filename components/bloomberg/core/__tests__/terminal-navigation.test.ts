import assert from "node:assert/strict";
import test from "node:test";
import { viewFromSearch, viewHref } from "../../layout/view-navigation.ts";
import { shortcutKeyMatches } from "../shortcut-key-match.ts";

test("physical number and letter shortcuts survive a Thai keyboard layout", () => {
  assert.equal(shortcutKeyMatches({ key: "ภ", code: "Digit3", shiftKey: false }, "3"), true);
  assert.equal(shortcutKeyMatches({ key: "ค", code: "Digit4", shiftKey: false }, "4"), true);
  assert.equal(shortcutKeyMatches({ key: "้", code: "Digit5", shiftKey: false }, "5"), true);
  assert.equal(shortcutKeyMatches({ key: "ย", code: "KeyP", shiftKey: false }, "p"), true);
  assert.equal(shortcutKeyMatches({ key: "้", code: "KeyH", shiftKey: false }, "h"), true);
  assert.equal(shortcutKeyMatches({ key: "1", code: "Numpad1", shiftKey: false }, "1"), true);
  assert.equal(shortcutKeyMatches({ key: "ภ", code: "Digit4", shiftKey: false }, "3"), false);
});

test("slash and question mark keep their physical-key distinction", () => {
  assert.equal(shortcutKeyMatches({ key: "ฝ", code: "Slash", shiftKey: false }, "/"), true);
  assert.equal(shortcutKeyMatches({ key: "ฦ", code: "Slash", shiftKey: true }, "?"), true);
  assert.equal(shortcutKeyMatches({ key: "ฦ", code: "Slash", shiftKey: true }, "/"), false);
});

test("view URLs restore valid views and reject unknown values", () => {
  assert.equal(viewHref("bonds"), "/?view=bonds");
  assert.equal(viewFromSearch("?view=portfolio"), "portfolio");
  assert.equal(viewFromSearch("?view=heatmap"), "heatmap");
  assert.equal(viewFromSearch("?view=unknown"), null);
});
