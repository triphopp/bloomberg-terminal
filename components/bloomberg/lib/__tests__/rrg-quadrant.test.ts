import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUADRANTS,
  QUAD_COLOR,
  type QuadrantRow,
  holdingQuadrant,
  quadrantOf,
  quadrantTint,
  sectorQuadrants,
} from "../rrg-quadrant.ts";

const row = (
  id: string,
  name: string,
  kind: string,
  quadrant: QuadrantRow["quadrant"],
  mom_dir: QuadrantRow["mom_dir"] = "up"
): QuadrantRow => ({ id, name, kind, quadrant, mom_dir });

const US = [
  row("XLV", "Health Care (XLV)", "sector", "Leading"),
  row("XLK", "Information Technology (XLK)", "sector", "Lagging", "down"),
  row("SMH", "Semiconductors", "theme", "Improving"),
];
const TH = [
  row("ENERG", "Energy & Utilities", "sector", "Weakening"),
  row("RESOURC", "Resources", "industry", "Leading"),
  row("PF&REIT", "Property Fund & REITs", "sector", "Improving"),
];

describe("sector → quadrant", () => {
  const map = sectorQuadrants(US, TH);

  it("reads a US holding's GICS sector from its SPDR row", () => {
    const q = quadrantOf(map, "Health Care");
    assert.equal(q?.quadrant, "Leading");
    assert.equal(q?.groupId, "XLV");
    assert.equal(q?.market, "US");
    assert.equal(quadrantOf(map, "information technology")?.momDir, "down");
  });

  it("reads a Thai holding's SET code from its sector row", () => {
    assert.equal(quadrantOf(map, "ENERG")?.quadrant, "Weakening");
    assert.equal(quadrantOf(map, "PF&REIT")?.groupName, "Property Fund & REITs");
  });

  it("never matches a theme or an industry group as a sector", () => {
    assert.equal(quadrantOf(map, "Semiconductors"), null);
    assert.equal(quadrantOf(map, "RESOURC"), null);
  });

  it("gives no quadrant to what is not a sector", () => {
    for (const s of ["ETF", "CRYPTO", "Other", "", null, undefined]) {
      assert.equal(quadrantOf(map, s), null);
    }
  });

  it("skips a row whose quadrant is unknown", () => {
    const m = sectorQuadrants([row("XLE", "Energy (XLE)", "sector", null)], []);
    assert.equal(quadrantOf(m, "Energy"), null);
  });
});

describe("holding → quadrant", () => {
  const map = sectorQuadrants(US, [
    ...TH,
    row("CONMAT", "Construction Materials", "sector", "Leading"),
    row("CONS", "Construction Services", "sector", "Lagging"),
  ]);
  const setSectorOf = { TASCO: "CONMAT", PTT: "ENERG" };

  it("places a Thai share by the SET's sector, not the label on its trade", () => {
    const q = holdingQuadrant(map, setSectorOf, "CONS", "TASCO.BK");
    assert.equal(q?.groupId, "CONMAT");
    assert.equal(q?.quadrant, "Leading");
    assert.equal(q?.basis, "SET");
  });

  it("falls back to the label when the SET list lacks the symbol", () => {
    const q = holdingQuadrant(map, setSectorOf, "CONS", "KIOXIA23.BK");
    assert.equal(q?.groupId, "CONS");
    assert.equal(q?.basis, "label");
  });

  it("uses the GICS label for a US holding", () => {
    const q = holdingQuadrant(map, setSectorOf, "Health Care", "LLY");
    assert.equal(q?.groupId, "XLV");
    assert.equal(q?.basis, "label");
  });

  it("gives nothing to an ETF", () => {
    assert.equal(holdingQuadrant(map, setSectorOf, "ETF", "QID"), null);
  });
});

describe("palette", () => {
  it("uses no green and no red — those mean up / down", () => {
    for (const q of QUADRANTS) {
      const n = Number.parseInt(QUAD_COLOR[q].slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d < 0.15) continue; // grey has no hue to confuse
      const h =
        (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
      const hue = (h + 360) % 360;
      const green = hue >= 80 && hue <= 160;
      const red = hue < 20 || hue > 340;
      assert.ok(!green && !red, `${q} ${QUAD_COLOR[q]} hue ${hue.toFixed(0)}`);
    }
  });

  it("tints as rgba", () => {
    assert.equal(quadrantTint("Leading", 0.1), "rgba(34,211,238,0.1)");
  });
});
