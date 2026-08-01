# Flow Toxicity — Overview

Order-flow one-sidedness indicator ใน Bloomberg Terminal chart (pane indicator, category `volume`)

**Source:** [`components/bloomberg/chart/indicators/flow-toxicity.ts`](../../components/bloomberg/chart/indicators/flow-toxicity.ts)
**Registry:** [`components/bloomberg/chart/indicators/index.ts`](../../components/bloomberg/chart/indicators/index.ts)

---

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | เนื้อหา |
|------|---------|
| [README.md](README.md) | ภาพรวม, quick reference, ข้อจำกัดโดยสรุป |
| [calculation.md](calculation.md) | นิยามทางคณิตศาสตร์, การพิสูจน์เอกลักษณ์, edge cases |
| [interpretation.md](interpretation.md) | วิธีอ่านค่า, ตารางตีความพร้อมที่มา, การตั้ง threshold |
| [references.md](references.md) | บรรณานุกรมและความเชื่อมโยงกับวรรณกรรม |

---

## ภาพรวม

Indicator นี้ประมาณว่า **แรงซื้อ-แรงขายในช่วงที่ผ่านมาเอียงไปข้างเดียวมากแค่ไหน** โดยอนุมานจากรูปทรงแท่งเทียน (bar shape) เพราะระบบไม่มี tick-level aggressor data

แสดงผลเป็น 2 ชุดข้อมูลบน pane เดียวกัน:

| ชุด | รูปแบบ | สัญลักษณ์ | ความหมาย |
|-----|--------|-----------|----------|
| **Net Flow** | histogram (เขียว/แดง) | $\lvert N \rvert$ | แรงสุทธิหลังหักล้าง — มีทิศทาง |
| **Toxicity** | เส้นสีม่วง | $T$ | แรงรวมทั้งสองฝั่ง — ไม่มีทิศทาง |

โดยรับประกันทางคณิตศาสตร์ว่า $\lvert N \rvert \le T$ เสมอ (เส้นม่วงอยู่เหนือแท่งเสมอ)

**ช่องว่างระหว่างสองเส้นคือสาระสำคัญ** ไม่ใช่ค่าสัมบูรณ์ของอันใดอันหนึ่ง

---

## Quick Reference

### สูตรหลัก

ให้ $p_i$ = น้ำหนัก volume ที่ normalize แล้ว, $flow_i \in [-1,1]$ = ความเอียงของแท่ง $i$

$$N = \sum_i p_i \cdot flow_i \qquad T = \sum_i p_i \cdot \lvert flow_i \rvert$$

แยกเป็นแรงซื้อ $B$ และแรงขาย $S$ จะได้ $T = B+S$ และ $N = B-S$

### พารามิเตอร์

| Key | Label | Default | Range | ผลต่อการแสดงผล |
|-----|-------|---------|-------|----------------|
| `window` | Window | 50 | 10–200 (step 5) | จำนวนแท่งใน rolling window |
| `hotThreshold` | Hot threshold | 0.15 | 0.05–0.6 (step 0.05) | เกณฑ์ความสว่างของแท่ง (ไม่กระทบเส้นม่วง) |

`minBars` = `window` — ต้องมีข้อมูลครบ `window` แท่งก่อนจึงเริ่มแสดงค่า

### ตารางตีความย่อ

| แท่ง | ช่องว่าง | ความหมาย | ที่มา |
|------|----------|----------|-------|
| สูง | แคบ | ฝั่งเดียวคุมเกม — เทรนด์ชัด | $\min(B,S) \to 0$ |
| เตี้ย | กว้าง | ตีกันหนักแต่หักล้างหมด — chop | $\min(B,S)$ ใหญ่ |
| เตี้ย | แคบ (เส้นม่วงต่ำด้วย) | เงียบจริง | $B+S \to 0$ |
| สูง | กว้าง | **เป็นไปไม่ได้** | อสมการสามเหลี่ยม |

รายละเอียดและการพิสูจน์อยู่ใน [interpretation.md](interpretation.md)

---

## ข้อจำกัดสำคัญ (อ่านก่อนใช้)

1. **ไม่ใช่ VPIN** แม้แนวคิดจะได้แรงบันดาลใจจาก VPIN ของ Easley, López de Prado & O'Hara (2012) แต่ต่างกัน 3 จุด: (ก) ใช้ time bars ไม่ใช่ equal-volume buckets, (ข) classifier เป็น Close Location Value ไม่ใช่ BVC ตามตัวบทความ, (ค) ไม่มีการ normalize ด้วย distribution ของ volume imbalance ดูรายละเอียดใน [references.md](references.md)

2. **`Net Flow` เทียบเท่า Chaikin Money Flow** — เมื่อไม่มี gap ค่านี้เท่ากับ CMF ทุกประการ (ตรวจสอบเชิงตัวเลขแล้ว ต่างกัน $< 10^{-15}$) ไม่ใช่ metric ใหม่

3. **เป็นค่าประมาณจากรูปทรงแท่ง** ไม่ใช่ข้อมูล aggressor side จริง ความแม่นยำต่ำกว่า tick-level classification อย่างมีนัยสำคัญ

4. **`hotThreshold` ยังไม่ได้ calibrate กับข้อมูลจริง** repo ไม่มี OHLCV fixture ค่า default 0.15 มาจากข้อมูลสังเคราะห์เท่านั้น ต้องจูนต่อรายเครื่องมือ/ไทม์เฟรม

5. **ยังไม่ผ่านการ validate ว่ามี predictive power** ใน repo นี้ ([`research/daily_reversal/RESULTS.md`](../../research/daily_reversal/RESULTS.md) ระบุว่าใช้เป็นเครื่องมืออ่าน context/execution cost ไม่ใช่สัญญาณเข้าเทรด) และแม้แต่ VPIN ตัวจริงก็ยังเป็นที่ถกเถียง — ดู Andersen & Bondarenko (2014) ใน [references.md](references.md)

6. **ไม่มีที่ไหนในโค้ดใช้ค่านี้เป็น signal หรือ alert** เป็น chart indicator ล้วนๆ
