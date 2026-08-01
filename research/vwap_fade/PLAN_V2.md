# FADE Study v2 — Amendment (เขียนก่อนรัน 2026-07-11)

v1 ตายที่ K1 (56 เทรด IS < 60) โดยไม่ได้แตะ OOS — v2 แก้ปัญหา sample ด้วยการ
ขยาย universe ไม่แตะตรรกะสัญญาณ/exit/split ใดๆ ทั้งสิ้น

## สิ่งที่เปลี่ยนจาก v1 (และเหตุผล)

**1. Universe: 10 → 40 symbols** — เพิ่ม 30 ตัวสภาพคล่องสูงที่**ข้อมูลยังไม่เคยถูกแตะ**:

- Financials: JPM, BAC, GS, MS, V, MA
- Energy: XOM, CVX, COP
- Healthcare: UNH, LLY, JNJ, PFE, MRK
- Consumer: WMT, COST, HD, DIS, NKE, MCD
- Tech เพิ่มเติม: CRM, ORCL, ADBE, AVGO, QCOM, MU, INTC, NFLX
- ETF เพิ่มเติม: IWM, XLF

**2. เกณฑ์ kill เข้มขึ้น** — ชดเชยที่โครงสร้าง grid เคยเห็นข้อมูล 10 ตัวเดิมใน v1:

| เกณฑ์ | v1 | v2 |
|---|---|---|
| K1 เทรด IS ขั้นต่ำ | 60 | **150** |
| K3 เทรด OOS ขั้นต่ำ | 30 | **60** |
| K6 null percentile | > p95 | **> p97.5** |
| K7 OOS profit factor | ≥ 1.10 | **≥ 1.15** |

K2 (IS exp > 0), K4 (OOS exp > 0), K5 (decay ≥ 40%) คงเดิม

**3. ทุกอย่างอื่นคงเดิมเป๊ะ**: เงื่อนไขเข้า L1-L7, grid 3×3 เดิม (ห้ามขยาย),
exit bracket, IS 60% / purge 1 / embargo 3, null 200 รอบ, one-shot OOS

## ข้อจำกัดที่ประกาศไว้ก่อน

- 10 symbols เดิมปนอยู่ใน universe — ผล v2 จึงไม่ "บริสุทธิ์" 100%
  แต่ 75% ของ universe เป็นข้อมูลใหม่ และเกณฑ์ถูกขยับเข้มขึ้นชดเชยแล้ว
- ถ้า v2 ตาย: หยุดสาย hypothesis นี้บน dataset 60 วันปัจจุบันโดยสิ้นเชิง
  ทางเดียวที่เหลือคือรอข้อมูลหมุนหรือเปลี่ยน timeframe (= study ใหม่ทั้งฉบับ)
