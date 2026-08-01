# HMM Regime Detection — Validation Study (เขียนก่อนรัน 2026-07-12)

## สิ่งที่กำลัง validate

Pipeline จริงของแอป (backend/analytics/regime_calibration.py):
1. คำนวณ **CORR score** = ค่าเฉลี่ย |correlation| ของ sector ETF returns บน rolling window 63 วัน
2. เทรน **4-state Gaussian HMM** บนอนุกรม score → ได้ state means
3. Label ตลาด ณ วันใดๆ ด้วย **threshold cut** ที่ midpoint ระหว่าง state means
   (ไม่มี HMM inference ตอน runtime — HMM ใช้แค่หาจุดตัด)
4. Labels: DIVERGENT → TRENDING → RISK-OFF → CRISIS

## คำถาม "ใช้งานได้จริงไหม" แตกเป็น 3 claims ที่วัดได้

| Claim | คำถาม | ทำไมสำคัญ |
|---|---|---|
| **T1 พยากรณ์ความเสี่ยง** | regime วันนี้บอก vol ของ 21 วันข้างหน้า **เกินกว่า**ที่ trailing vol บอกอยู่แล้วหรือไม่ | ถ้าไม่เกิน = regime เป็นแค่ vol เมื่อวานแต่งตัวใหม่ ไม่มีค่าเพิ่ม |
| **T2 ใช้เป็น risk gate** | ถือ SPY เฉพาะ DIVERGENT/TRENDING, ถือเงินสดใน RISK-OFF/CRISIS — ลด drawdown ได้จริงโดยไม่ฆ่าผลตอบแทนหรือไม่ | นี่คือ use case จริงของ regime dial |
| **T3 เสถียรภาพ** | label กระพริบไปมาจนใช้ไม่ได้หรือไม่ | regime ที่สลับทุก 3 วันไม่มีประโยชน์เชิงปฏิบัติ |

## 1. ข้อมูล

- Sector ETFs 9 ตัวที่มีครบตั้งแต่ปี 2000: XLK XLF XLV XLE XLI XLY XLP XLU XLB
  (**ต่างจากแอปที่ใช้ 11 ตัวจาก 2018** — จำเป็นเพื่อให้มีประวัติยาวพอ validate;
  โครงสร้าง score เหมือนกันทุกประการ ประกาศ deviation นี้ไว้ก่อน)
- SPY เป็นตัวแทนตลาดสำหรับ T1/T2 · ข้อมูล ~25 ปี (2000–ปัจจุบัน) · adjusted daily

## 2. Walk-forward + Purge & Embargo

```
train: score ทั้งหมดถึงวัน T₀ →|— purge 63 —|— embargo 21 —|— test 126 วัน —| → refit
```

- Initial train 8 ปี (~2016 sessions) → คาดว่า ~30+ folds ครอบคลุม OOS ~15 ปี
- **Purge 63 sessions** = ความยาว rolling window ของ score — score ใน test แรกๆ
  ห้ามแชร์ return window กับ score ท้าย train
- **Embargo 21 sessions** เพิ่ม = horizon ของ label T1
- ทุก fold: เทรน HMM ใหม่ (4 states, full cov, seed 42, สเปคเดียวกับแอป) →
  threshold cuts จาก state means → label OOS ด้วย cuts นั้น **ห้ามใช้ข้อมูลอนาคต**

## 3. นิยามการทดสอบและเกณฑ์ฆ่า (pre-registered)

### T1 — Incremental vol prediction
- Sample: จุด**ไม่ทับซ้อน**ทุก 21 sessions ใน OOS: (regime 0-3, trailing 21d vol, forward 21d vol ของ SPY)
- สถิติ: **partial Spearman** ระหว่าง regime กับ forward vol โดยคุม trailing vol
  (residualize ranks) · p-value จาก circular-permutation 1,000 รอบ
- **ฆ่าเมื่อ**: partial ρ ≤ 0 หรือ p ≥ 0.05 หรือ sample < 150 จุด

### T2 — Risk gate บน SPY
- Position: long SPY เมื่อ label(t−1) ∈ {DIVERGENT, TRENDING}, เงินสด (0%) เมื่อ
  RISK-OFF/CRISIS · lag 1 วัน · ต้นทุน 1 bp ต่อข้างต่อการสลับ
- เทียบ buy & hold บนช่วง OOS เดียวกัน
- **ผ่านเมื่อครบทั้งสอง**: (a) MaxDD ลดลง ≥ 25% เทียบ B&H, (b) net CAGR ≥ 60% ของ B&H
  (regime gate มีหน้าที่ลดหางเสี่ยง ไม่ใช่เพิ่มผลตอบแทน — แต่ถ้าจ่ายผลตอบแทนเกิน 40% ทิ้ง = แพงเกินไป)

### T3 — เสถียรภาพ label
- **ฆ่าเมื่อ**: median run length < 10 sessions หรือสลับ regime > 12 ครั้ง/ปี

### Verdict รวม
- **"ใช้งานได้"** = T1 และ T3 ผ่าน และ T2 ผ่านอย่างน้อยเงื่อนไข (a) MaxDD
- รายงานแยกราย claim เสมอ — regime model อาจ "ใช้ได้เป็น risk dial แต่ไม่ใช่ signal"
- Descriptive เพิ่มเติม (ไม่มีเกณฑ์ฆ่า): วันแรกที่เข้า CRISIS รอบ COVID (มี.ค. 2020),
  bear 2022, tariff crash (เม.ย. 2025) — วัด detection lag

## One-shot rule เดิม: รันครั้งเดียว บันทึกผลใน RESULTS.md ไม่ว่าออกทางไหน
