# Daily Band-Rejection Reversal — Walk-Forward Study (เขียนก่อนรัน 2026-07-11)

## Hypothesis

> **H1**: บนแท่ง daily สัญญาณ "แตะแบนด์ 2σ ของ rolling VWAP + rejection close + volume ผิดปกติ"
> มีข้อมูลทิศทางแบบ **reversal** (ต่างจาก intraday 5m ที่พิสูจน์แล้วว่าไม่มี)

เหตุผลที่ horizon นี้สมควรทดสอบทั้งที่ intraday ตาย:
1. Short-term reversal ระดับ daily/weekly ใน US equities มี literature รองรับยาวนาน
   (Jegadeesh 1990, Lehmann 1990) — ไม่ใช่ pattern ที่เกิดจากการเห็นผลเก่าของเราเอง
2. ที่ 5m ผู้เก็บ edge คือ HFT; ที่ horizon หลายวัน ตัวขับเคลื่อนคือ liquidity provision
   ต่อ institutional flow ซึ่ง decay ช้ากว่า
3. ต้นทุนต่อเทรดเท่าเดิมแต่ expected move ใหญ่ขึ้น ~10 เท่า → กำแพงต้นทุนเตี้ยลงมาก

## 1. ข้อมูล

| รายการ | ค่า |
|---|---|
| Bars | Daily, adjusted (split/dividend), 10 ปี ผ่าน yfinance |
| Universe | 40 symbols เดียวกับ FADE v2 |
| **คำเตือน survivorship bias** | universe คือ large-cap *ปัจจุบัน* — เอียงเข้าหาผู้ชนะ 10 ปีย้อนหลัง ซึ่ง**ช่วยฝั่ง long เกินจริง** ต้องอ่านผล long ด้วยความระแวงเป็นพิเศษ |

## 2. สัญญาณ (แปลงจากชุดเดิมให้เป็น daily — freeze ก่อนรัน)

Features: `vwap20` = rolling 20 วัน volume-weighted mean ของ typical price,
`σ20` แบบ volume-weighted, `ATR14` (Wilder), `medVol20` = median volume 20 วันก่อนหน้า

**LONG** (ทุกข้อที่แท่ง t): `low ≤ vwap20 − 2σ20` · `close > vwap20 − 2σ20` ·
`closePos ≥ 0.55` · `vol ≥ 1.5 × medVol20`
**SHORT**: สมมาตรที่แบนด์บน, `closePos ≤ 0.45`
เข้า: **open ของวัน t+1** · 1 position ต่อ symbol · ไม่ยิงซ้ำระหว่างถือ

## 3. การออก

| ประเภท | นิยาม (LONG; SHORT สมมาตร) |
|---|---|
| Stop | `entry − S×ATR14(t)` — gap ทะลุ fill ที่ open |
| Target | `entry + T×ATR14(t)` — gap ทะลุ fill ที่ open |
| Time | close ของวันที่ **H = 10** หลังเข้า (ตายตัว ไม่อยู่ใน grid) |
| ชนกันในแท่งเดียว | นับเป็น stop (conservative) |

ต้นทุน **3 bps ต่อข้าง** (daily เข้าที่ open, สูงกว่า study เดิมเผื่อ MOO slippage)

## 4. Walk-forward + Purge & Embargo

```
|—— train 504 วันเทรด (~2 ปี) ——|— purge 10 —|— embargo 5 —|—— test 126 วัน (~6 เดือน) ——|
                                                            → เลื่อนไป 126 วัน แล้วทำซ้ำ
```

- **Purge = 10 sessions** = max holding horizon — เทรดที่เข้าท้าย train แล้ว label
  ลากเข้าเขต test ถูกตัดออกโดยโครงสร้าง (ช่องว่างกว้างกว่า horizon)
- **Embargo = 5 sessions** เพิ่ม กัน volatility clustering ข้ามรอยต่อ
- Grid ต่อ fold: `S ∈ {1.0, 1.5, 2.0}` × `T ∈ {1.0, 1.5, 2.0}` เลือกบน **train pooled
  ทุก symbol** ด้วย net expectancy (ต้องมีเทรด train ≥ 100 ไม่งั้นข้าม fold และบันทึก)
- พารามิเตอร์ที่ชนะ → รันบน test ของ fold นั้น**ครั้งเดียว** แล้วเลื่อน
- คาดหวัง ~15-16 folds จากข้อมูล 10 ปี

## 5. Null baseline

ต่อ fold: random entry ใน test window จำนวนเท่ากลยุทธ์ (ต่อ symbol/ฝั่ง),
exit engine + พารามิเตอร์เดียวกับ fold นั้น, 200 รอบ → pooled null distribution

## 6. KILL-LIST (ตัดสินที่ระดับ pooled ข้ามทุก fold)

| # | เงื่อนไขฆ่า |
|---|---|
| K1 | folds ที่ใช้ได้ < 10 |
| K2 | เทรด OOS pooled < 300 |
| K3 | OOS net expectancy ≤ 0 |
| K4 | OOS expectancy ≤ percentile 95 ของ null |
| K5 | OOS profit factor < 1.15 |
| K6 | สัดส่วน folds ที่ expectancy > 0 ≤ 50% (edge ต้องสม่ำเสมอ ไม่ใช่มาจาก fold เดียว) |

**One-shot**: pipeline ทั้งหมดรันครั้งเดียว ผลตายคือตาย บันทึกใน RESULTS.md เสมอ
การแก้ใดๆ = study ใหม่ + ประกาศใน plan ใหม่

## 7. การอ่านผลถ้าผ่าน

ผ่านทุกข้อ = หลักฐานระดับ "ควรทดสอบต่อด้วย universe แบบ point-in-time (แก้ survivorship)
+ โมเดล slippage จริง" — ยังไม่ใช่ระบบพร้อมเงินจริง โดยเฉพาะถ้า edge กระจุกฝั่ง long
ให้สงสัย survivorship ก่อนเสมอ
