/**
 * Semantic label vocabulary shared across every indicator's alert labels.
 *
 * A "concept" is the meaning ("oversold"), not the formula (RSI<=30 vs
 * Stochastic %K<=20 vs %B<=0 are three different formulas for the SAME
 * concept). This is what makes "select from meaning" possible in the rule
 * builder and lets the normalizer warn when a rule ANDs together three
 * predicates that are really the same concept measured three ways.
 *
 * See memory/plans/alert-rule-engine.md §8.5.1.
 */

export type LabelConcept =
  | "oversold"
  | "overbought"
  | "exitingOversold"
  | "exitingOverbought"
  | "bullCross"
  | "bearCross"
  | "aboveMid"
  | "belowMid"
  | "aboveZero"
  | "belowZero"
  | "compression"
  | "expansion"
  | "accelerating"
  | "decelerating"
  | "spike"
  | "dryUp"
  | "priceAbove"
  | "priceBelow"
  | "risingSlope"
  | "fallingSlope"
  | "extremeHigh"
  | "extremeLow"
  | "pierceUpper"
  | "pierceLower"
  | "reclaim";

/**
 * `x:<name>` opts a label out of the shared vocabulary for indicators with a
 * genuinely indicator-specific meaning (Volume Profile's `atPOC`, Footprint's
 * `absorption`) — no forced fit into a generic concept.
 */
export type LabelKey = LabelConcept | `x:${string}`;

export interface ConceptMeta {
  name: string;
  nameTh: string;
  /** Groups concepts that tend to be redundant with each other when ANDed
   *  together (plan §8.5.1's "3 conditions, 1 idea" warning). */
  family: "reversion" | "momentum" | "breakout" | "participation" | "regime";
  /** UI hint only (chip color, dropdown order) — never fed into a score. See §8.5.4. */
  defaultPolarity: "bullish" | "bearish" | "neutral";
  doc: string;
}

export const CONCEPT_META: Record<LabelConcept, ConceptMeta> = {
  oversold: {
    name: "Oversold",
    nameTh: "ขายมากเกินไป",
    family: "reversion",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดอยู่ปลายล่างของช่วงค่าปกติ — บอกว่าราคาลงเร็วเทียบกับตัวเอง ไม่ได้บอกว่าจะกลับตัว",
  },
  overbought: {
    name: "Overbought",
    nameTh: "ซื้อมากเกินไป",
    family: "reversion",
    defaultPolarity: "bearish",
    doc: "ตัวชี้วัดอยู่ปลายบนของช่วงค่าปกติ — บอกว่าราคาขึ้นเร็วเทียบกับตัวเอง ไม่ได้บอกว่าจะกลับตัว",
  },
  exitingOversold: {
    name: "Exiting Oversold",
    nameTh: "กำลังหลุดจากขายมากเกินไป",
    family: "reversion",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดตัดขึ้นผ่าน threshold oversold — จังหวะที่มักถูกใช้เป็นสัญญาณเข้าซื้อมากกว่าตัว oversold เอง",
  },
  exitingOverbought: {
    name: "Exiting Overbought",
    nameTh: "กำลังหลุดจากซื้อมากเกินไป",
    family: "reversion",
    defaultPolarity: "bearish",
    doc: "ตัวชี้วัดตัดลงผ่าน threshold overbought",
  },
  bullCross: {
    name: "Bull Cross",
    nameTh: "ตัดขึ้น",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "เส้นเร็วตัดขึ้นเหนือเส้นช้า/ระดับอ้างอิง (MACD/signal, EMA/ราคา, %K/%D)",
  },
  bearCross: {
    name: "Bear Cross",
    nameTh: "ตัดลง",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "เส้นเร็วตัดลงใต้เส้นช้า/ระดับอ้างอิง",
  },
  aboveMid: {
    name: "Above Midline",
    nameTh: "เหนือเส้นกลาง",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดอยู่เหนือเส้นกลางของช่วงค่า (เช่น RSI 50) — momentum bias ไม่ใช่สัญญาณกลับตัว",
  },
  belowMid: {
    name: "Below Midline",
    nameTh: "ใต้เส้นกลาง",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "ตัวชี้วัดอยู่ใต้เส้นกลางของช่วงค่า",
  },
  aboveZero: {
    name: "Above Zero",
    nameTh: "เหนือศูนย์",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดที่ไม่มีขอบเขต (เช่น MACD line) อยู่เหนือ 0",
  },
  belowZero: {
    name: "Below Zero",
    nameTh: "ใต้ศูนย์",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "ตัวชี้วัดที่ไม่มีขอบเขตอยู่ใต้ 0",
  },
  compression: {
    name: "Compression",
    nameTh: "บีบตัว",
    family: "breakout",
    defaultPolarity: "neutral",
    doc: "ความผันผวนบีบแคบผิดปกติเทียบกับตัวเอง — บอกว่าการเคลื่อนไหวใหญ่ใกล้เข้ามา ไม่บอกทิศทาง",
  },
  expansion: {
    name: "Expansion",
    nameTh: "ขยายตัว",
    family: "breakout",
    defaultPolarity: "neutral",
    doc: "ความผันผวนขยายตัวผิดปกติเทียบกับตัวเอง",
  },
  accelerating: {
    name: "Accelerating",
    nameTh: "โมเมนตัมเร่งขึ้น",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "อัตราเปลี่ยนแปลงของตัวชี้วัดเองกำลังเพิ่มขึ้น (เช่น MACD histogram โตขึ้น)",
  },
  decelerating: {
    name: "Decelerating",
    nameTh: "โมเมนตัมเร่งลง",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "อัตราเปลี่ยนแปลงของตัวชี้วัดเองกำลังลดลง",
  },
  spike: {
    name: "Spike",
    nameTh: "พุ่งผิดปกติ",
    family: "participation",
    defaultPolarity: "neutral",
    doc: "ปริมาณ/กิจกรรมพุ่งสูงผิดปกติเทียบกับ baseline ของตัวเอง",
  },
  dryUp: {
    name: "Dry Up",
    nameTh: "เงียบผิดปกติ",
    family: "participation",
    defaultPolarity: "neutral",
    doc: "ปริมาณ/กิจกรรมต่ำผิดปกติเทียบกับ baseline ของตัวเอง",
  },
  priceAbove: {
    name: "Price Above",
    nameTh: "ราคาอยู่เหนือ",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "ราคาปัจจุบันอยู่เหนือเส้นอ้างอิง (EMA/VWAP/Bollinger mid ฯลฯ)",
  },
  priceBelow: {
    name: "Price Below",
    nameTh: "ราคาอยู่ใต้",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "ราคาปัจจุบันอยู่ใต้เส้นอ้างอิง",
  },
  risingSlope: {
    name: "Rising Slope",
    nameTh: "ความชันขึ้น",
    family: "momentum",
    defaultPolarity: "bullish",
    doc: "เส้นอ้างอิงเอง (ไม่ใช่ราคา) กำลังชันขึ้น",
  },
  fallingSlope: {
    name: "Falling Slope",
    nameTh: "ความชันลง",
    family: "momentum",
    defaultPolarity: "bearish",
    doc: "เส้นอ้างอิงเองกำลังชันลง",
  },
  extremeHigh: {
    name: "Extreme High",
    nameTh: "สุดขั้วบน",
    family: "reversion",
    defaultPolarity: "bearish",
    doc: "ตัวชี้วัดแตะ/เกินขอบบนของช่วงค่าปกติ (เช่น %B >= 1, 52w high)",
  },
  extremeLow: {
    name: "Extreme Low",
    nameTh: "สุดขั้วล่าง",
    family: "reversion",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดแตะ/เกินขอบล่างของช่วงค่าปกติ",
  },
  pierceUpper: {
    name: "Pierce Upper Band",
    nameTh: "แทงทะลุกรอบบน",
    family: "breakout",
    defaultPolarity: "neutral",
    doc: "ราคาทะลุกรอบบนของช่องผันผวน (Bollinger upper ฯลฯ) — เกิดได้ทั้งใน breakout และ mean-reversion setup",
  },
  pierceLower: {
    name: "Pierce Lower Band",
    nameTh: "แทงทะลุกรอบล่าง",
    family: "breakout",
    defaultPolarity: "neutral",
    doc: "ราคาทะลุกรอบล่างของช่องผันผวน",
  },
  reclaim: {
    name: "Reclaim",
    nameTh: "กลับเข้ากรอบ",
    family: "breakout",
    defaultPolarity: "neutral",
    doc: "ราคาตัดกลับเข้าเส้นกลาง/กรอบอ้างอิงหลังจากอยู่นอกกรอบ (Bollinger mid, VWAP ฯลฯ)",
  },
};
