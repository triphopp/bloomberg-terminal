import assert from "node:assert/strict";
import test from "node:test";
import { splitNote, subPortOf, subPortSections, subPortsIn } from "../sub-ports.ts";

test("leading tag only — same rule as backend/sub_port.py", () => {
  assert.equal(subPortOf("Finansia (6065151) | TAKEOVER 2026-02-08"), "6065151");
  assert.equal(subPortOf("Finansia (6065151)\n[SOLD 2026-06-26] @ 188.0 | P&L: 1"), "6065151");
  assert.equal(subPortOf("Dime (TH DIME) | VAT: 61.49"), "TH DIME");
  assert.equal(
    subPortOf("\n[SOLD 2026-06-06] @ 39.1 | est. exit (price-match; was 2026-06-06)"),
    ""
  );
  assert.equal(
    subPortOf("Historical Excel reconciliation; source Dime!96 (dominant lot Dime!78)"),
    ""
  );
  assert.equal(subPortOf("hello | Finansia (6065151)"), "");
  assert.equal(subPortOf(undefined), "");
});

test("splitNote hands the form the tag and the rest", () => {
  assert.deepEqual(splitNote("Finansia (6065151) | buy the dip | VAT: 7"), {
    subPort: "Finansia (6065151)",
    rest: "buy the dip | VAT: 7",
  });
  assert.deepEqual(splitNote("Finansia (6065151)\n[SOLD 2026-06-26] @ 188.0 | P&L: 1"), {
    subPort: "Finansia (6065151)",
    rest: "[SOLD 2026-06-26] @ 188.0 | P&L: 1",
  });
  assert.deepEqual(splitNote("just text"), { subPort: "", rest: "just text" });
});

test("an account with two sub-ports is cut into sections in row order", () => {
  const rows = [
    { id: 1, note: "Finansia (6065151)" },
    { id: 2, note: "Finansia (6065157) | TAKEOVER" },
    { id: 3, note: "Finansia (6065151) | TAKEOVER" },
    { id: 4, note: "" },
  ];
  const s = subPortSections(rows);
  assert.deepEqual(
    s.map((x) => [x.sub, x.rows.map((r) => r.id)]),
    [
      ["6065151", [1, 3]],
      ["6065157", [2]],
      ["", [4]],
    ]
  );
  assert.deepEqual(subPortsIn(rows), ["6065151", "6065157"]);
});

test("a single tag is a label — no sections", () => {
  const rows = [{ note: "Dime (TH DIME)" }, { note: "" }];
  assert.deepEqual(subPortSections(rows), [{ sub: "", rows }]);
});
