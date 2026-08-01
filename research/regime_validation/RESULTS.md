# HMM Regime Validation — Results (2026-07-12)

## Verdict: **NOT VALIDATED** — T1 ฆ่า, T2 ผ่านครึ่ง, T3 ฆ่าแบบเฉียด

Walk-forward 36 folds, OOS 4,505 sessions (ส.ค. 2008 → ก.ค. 2026, ~18 ปี)

| Test | ผล | เกณฑ์ | Verdict |
|---|---|---|---|
| T1 incremental vol prediction | partial ρ = +0.044, p = 0.30 (n=214) | ρ>0, p<0.05 | **KILL** |
| T2a DD reduction | 38% (−47.0% → −29.3%) | ≥25% | PASS |
| T2b CAGR retention | **27%** (12.4% → 3.3%) | ≥60% | **KILL** |
| T3 stability | median run 8 sessions, 9.5 switches/yr | run≥10, ≤12/yr | **KILL** (เฉียด) |

## สิ่งที่ model ทำได้จริง (ข่าวดี)

**ตรวจจับ crash เฉียบพลันได้เร็ว**:
- COVID: เข้า RISK-OFF **26 ก.พ. 2020** (5 วันหลังจุดสูงสุด), CRISIS 28 ก.พ. — เร็วพอใช้งานจริง
- Tariff crash 2025: RISK-OFF 7 เม.ย. — จับได้ในสัปดาห์แรก
- และลด MaxDD ได้จริง 38%

## สิ่งที่ทำไม่ได้ (ข่าวร้าย และทำไม)

**1. ไม่มีข้อมูลพยากรณ์เกิน trailing vol (T1)** — คุม trailing vol แล้ว regime เหลือค่า
พยากรณ์ ~ศูนย์ (ρ=0.044) แปลว่า CORR score คือ "vol ที่เกิดไปแล้ว" ในเสื้อผ้าใหม่
ไม่ใช่ leading indicator

**2. Bear ช้าๆ จับไม่ได้** — 2022 bear เริ่ม ม.ค. แต่เข้า RISK-OFF ครั้งแรก **9 มิ.ย. 2022**
(ผ่านไปแล้วครึ่งทาง −20%) และไม่เคยถึง CRISIS เลย — window 63 วันจับได้เฉพาะ
correlation spike เฉียบพลัน ไม่จับ grind-down

**3. อยู่นอกตลาดนานเกินไป (T2b)** — OOS labels เป็น RISK-OFF/CRISIS รวม **46%
ของเวลา** (CRISIS ตัวเดียว 25%) เพราะ threshold คำนวณจากอดีตที่ correlation
เฉลี่ยต่ำกว่า แต่ correlation ตลาดมี secular uptrend → ยุคหลัง label เอียงแดงถาวร
→ gate ถือเงินสดครึ่งชีวิต พลาดขาขึ้น เหลือ CAGR 27% ของ B&H

**4. Label กระพริบ (T3)** — median run 8 วัน สลับบ่อยเกินกว่าจะใช้ตัดสินใจ allocation

## ความหมายเชิงปฏิบัติสำหรับแอป

- **ใช้ได้**: เป็น display/context บน dashboard ("ตลาดกำลัง correlated ผิดปกติ") และ
  alert สำหรับ crash เฉียบพลัน — ตรงนี้มันทำงานจริง
- **ห้ามใช้**: เป็น mechanical allocation gate หรืออ้างว่าพยากรณ์ความเสี่ยงข้างหน้า —
  หลักฐานบอกชัดว่าไม่มีค่าเพิ่มเหนือ trailing vol ธรรมดา

## ทางแก้ที่เป็นไปได้ (ต้องเป็น study ใหม่ + pre-register ใหม่ทั้งหมด)

1. **Hysteresis / minimum dwell**: ต้องอยู่เกิน threshold ต่อเนื่อง N วันถึงเปลี่ยน label —
   แก้ T3 ตรงๆ
2. **Rolling recalibration ของ cuts** (เช่น percentile ของ 5 ปีหลังแทน mean คงที่) —
   แก้ปัญหา secular corr drift ที่ทำให้ CRISIS เฟ้อ 25%
3. **เพิ่ม feature**: corr อย่างเดียวไม่พอ — เสริม trailing vol + breadth เข้า HMM
   (แต่ T1 เตือนว่า vol อาจกลืน corr หมด)
