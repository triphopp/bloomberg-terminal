# Regime v2 — Results (2026-07-12)

> **หมายเหตุหลังรัน (data bug, ไม่กระทบ verdict)**: script ของ study มีบั๊กปฏิทิน —
> แถว NaN จาก union calendar กับ ^VIX ทำให้ feature `trend` (rolling 200) ตายเงียบๆ
> หลัง 2026-05-22 → OOS จริงจบ พ.ค. 2026 แทน ก.ค. (สั้นลง ~6 สัปดาห์จากที่ตั้งใจ)
> ผลทั้งหมดยัง valid บนช่วงที่วัด (2013-11 → 2026-05) — บั๊กนี้**แก้แล้วในเวอร์ชัน
> production** (backend/analytics/regime_v2.py: กรองวันเทรดจริง + ffill)
> ตามกติกา one-shot จึงไม่รัน study ซ้ำ

## Verdict: **USABLE AS RISK DIAL** (ผ่าน T2a, T2b, T3, K0 — ตกเฉพาะ T1)

Walk-forward 26 folds, OOS 3,152 sessions (พ.ย. 2013 → พ.ค. 2026, ~12.5 ปี)

| Test | v1 (corr-only) | **v2 (6-feature + hysteresis)** | เกณฑ์ | Verdict |
|---|---|---|---|---|
| T1 partial ρ / p | +0.044 / 0.299 | +0.083 / **0.148** | p<0.05 | **KILL** (ดีขึ้นแต่ไม่ถึง) |
| T2a DD reduction | 38% | **59%** (−33.7% → −13.8%) | ≥25% | PASS |
| T2b CAGR kept | 27% | **67%** (14.2% → 9.5%) | ≥60% | PASS |
| T3 median run / switches | 8 / 9.5 | **22 / 5.8** | ≥10 / ≤12 | PASS |
| K0 ชนะ v1 ทุกข้อที่ตก | — | ครบ | — | PASS |
| Gate Sharpe | 0.36 | **0.94** (เทียบ B&H 0.86) | — | ดีกว่า B&H |

## Detection lag เทียบ v1

| เหตุการณ์ | v1 | v2 |
|---|---|---|
| COVID crash (peak 19 ก.พ. 2020) | +5 วัน | **อยู่ใน RISK-OFF ตั้งแต่วัน peak** |
| Bear 2022 (peak 3 ม.ค.) | +108 วัน (มิ.ย.) | **26 ม.ค. (~16 วัน)** |
| Tariff crash (2 เม.ย. 2025) | +3 วัน | **อยู่ใน RISK-OFF ก่อนวัน crash** |

หมายเหตุความซื่อสัตย์: วันที่รายงานคือ "วันแรกใน scan window ที่เป็น RISK-OFF+" —
กรณี COVID/tariff ที่ติดตั้งแต่วันแรกแปลว่าโมเดลเข้า RISK-OFF **ก่อน** window เริ่ม
ซึ่งดีถ้าเป็น early warning จริง แต่ก็สะท้อนว่าโมเดลอยู่ใน RISK-OFF บ่อย (33% ของเวลา)
— ส่วนหนึ่งของ "จับเร็ว" คือ base rate ที่สูง ต้องอ่านคู่กับ T2b ที่ยืนยันว่า
ต้นทุนการอยู่นอกตลาด (34%) ไม่แพงเกิน

## สิ่งที่แก้สำเร็จ (เทียบรูรั่ว v1)

1. **Bear ช้าๆ**: credit + breadth + trend อุดรูใหญ่สุดได้จริง — lag 2022 จาก 108 → 16 วัน
2. **CRISIS เฟ้อ**: v1 label CRISIS 25% ของเวลา → v2 เหลือ **2%** (สมกับคำว่า crisis)
   เพราะ standardize ต่อ fold แก้ secular drift + state จัดอันดับด้วย vol แทน corr
3. **Label กระพริบ**: hysteresis K=5 + features ที่ persistent กว่า → median run 8 → 22 วัน

## สิ่งที่ยังทำไม่ได้

**T1**: ยังพยากรณ์ vol ข้างหน้าเกิน trailing vol ไม่ได้อย่างมีนัย (p=0.148) — ดีขึ้น 2 เท่า
แต่ไม่ข้ามเส้น 0.05 ข้อสรุปเดิมคงอยู่: **ใช้เป็น risk dial ได้ อ้างว่า "พยากรณ์" ไม่ได้**

## ขั้นต่อไปที่สมเหตุสมผล

1. Implement v2 ลง backend แทน/คู่กับ CORR-only (features มีท่อข้อมูลอยู่แล้วเกือบครบ)
2. เกณฑ์ pre-registered สำหรับ deploy: ใช้เป็น display + risk dial เท่านั้น
   ห้ามใช้คำว่า forecast ใน UI จนกว่า T1 จะผ่านใน study อนาคต
3. T1 ที่ค้าง: ทางเดียวที่เหลือคือ features ที่ forward-looking กว่านี้
   (VIX term structure จริง, skew, credit OAS) — study ใหม่ถ้าสนใจ
