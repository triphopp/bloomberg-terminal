# VWAP Band Reversion + Absorption — Backtest Specification

กลยุทธ์ mean-reversion เข้าหา session VWAP บนแท่ง 5 นาที ใช้สามชั้นการตัดสินใจ
ตามที่ออกแบบไว้: **Context** (RVOL) → **Location** (VWAP −2σ) → **Behavior** (absorption/rejection)

Spec นี้เขียนก่อนรัน (pre-registered) — เกณฑ์ตัดสินอยู่ท้ายไฟล์ ห้ามแก้เกณฑ์หลังเห็นผล

---

## 1. ข้อมูล

| รายการ | ค่า |
|---|---|
| Bars | 5 นาที, regular session เท่านั้น (09:30–16:00 ET) |
| ช่วงเวลา | ~55 วันเทรดล่าสุด (เพดาน 60 วันของ Yahoo 5m) |
| Universe | AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA, AMD, SPY, QQQ (แก้ได้ผ่าน `--symbols`) |
| ราคา | ไม่ adjust (ช่วงสั้น ไม่มีนัย) |

## 2. นิยามตัวแปร (คำนวณบนแท่ง 5m)

- **VWAP_t, σ_t** — session-anchored: `VWAP = Σ(tp·vol)/Σvol`, `σ² = Σ(tp²·vol)/Σvol − VWAP²`
  โดย `tp = (H+L+C)/3` reset ทุกเปิด session (สูตรเดียวกับ indicator ในแอป)
- **ATR14** — Wilder ATR ต่อเนื่องข้าม session
- **medVol20, medRange20** — median ของ volume/range จาก 20 แท่ง*ก่อนหน้า* (ไม่รวมแท่งปัจจุบัน)
- **cumRVOL_t** — volume สะสมของวันจนถึงเวลา t ÷ ค่าเฉลี่ยของ volume สะสม ณ เวลาเดียวกัน
  จาก 10 session ก่อนหน้า (baseline shift แล้ว — ไม่มี lookahead)
- **closePos_t** — `(close − low) / (high − low)`; แท่ง range ศูนย์ = 0.5

## 3. เงื่อนไขเข้า LONG (ทุกข้อต้องจริงที่แท่งสัญญาณ t)

| # | ชั้น | เงื่อนไข |
|---|---|---|
| L1 | Location | `low_t ≤ VWAP_t − 2σ_t` — ราคาแตะแบนด์ล่าง |
| L2 | Behavior | `close_t > VWAP_t − 2σ_t` — ปิดกลับเข้าใน (rejection ไม่ใช่ free-fall) |
| L3 | Behavior | `closePos_t ≥ 0.55` — ปิดครึ่งบนของแท่ง (แรงขายถูกรับ) |
| L4 | Behavior | `vol_t ≥ 1.5 × medVol20` — effort ผิดปกติ |
| L5 | Context | `cumRVOL_t ≥ 1.0` — วันนี้มีผู้เล่นไม่น้อยกว่าปกติ |
| L6 | Time | เวลาแท่ง ∈ [10:00, 15:00] ET — เลี่ยง noise ช่วงเปิดและมีเวลาพอให้จบก่อนปิด |
| L7 | State | ไม่มี position ค้างใน symbol นั้น; สูงสุด 2 เทรด/ฝั่ง/วัน/symbol |

**Variant STRICT** เพิ่ม: `range_t ≤ 0.9 × medRange20` ที่แท่ง t หรือ t−1 (absorption compression เต็มนิยาม) — รันทั้งสอง variant เทียบกัน

## 4. เงื่อนไขเข้า SHORT

สมมาตรทุกข้อ: แตะ `VWAP + 2σ`, ปิดกลับใต้แบนด์, `closePos ≤ 0.45`, เงื่อนไขอื่นเหมือนกัน

## 5. การเข้า

- **ราคาเข้า = open ของแท่ง t+1** (ไม่มี lookahead — สัญญาณยืนยันที่ close ของ t)

## 6. เงื่อนไขออก (อันแรกที่เกิดก่อน, เช็คทีละแท่ง u > t+1 รวมแท่งเข้าเอง)

| ลำดับเช็ค | เงื่อนไข | ราคา fill |
|---|---|---|
| 1. Stop | LONG: `low_u ≤ SL` โดย `SL = entry − 1.5×ATR14(t)` | ที่ SL; ถ้า `open_u < SL` (gap ทะลุ) fill ที่ open_u |
| 2. Target | LONG: `high_u ≥ VWAP_u` | ที่ VWAP_u; ถ้า `open_u ≥ VWAP_u` fill ที่ open_u |
| 3. Time stop | แท่ง 15:55 | ที่ close — ไม่ถือข้ามคืน |

- แท่งเดียวกันเกิดทั้ง stop และ target → **นับเป็น stop** (conservative, ไม่รู้ลำดับ intrabar)
- SHORT สมมาตร

## 7. ต้นทุน

- 2 bps ต่อข้าง (4 bps ไป-กลับ) หักจากทุกเทรด — รายงานทั้ง gross และ net
- ไม่โมเดล slippage เพิ่ม (fill ที่ระดับ trigger ตรงๆ) → ผลจริงจะแย่กว่านี้เล็กน้อย ตีความตามนั้น

## 8. Baseline คุม base rate

คำวิจารณ์เดิมของเรา (จากเรื่อง nPOC): ตลาดแกว่ง ราคากลับเข้า VWAP บ่อยอยู่แล้ว —
กำไรอาจมาจาก exit engine ไม่ใช่ signal ดังนั้น:

- **Random-entry control**: จำนวนเทรดเท่ากันต่อ symbol/ฝั่ง จับเวลาเข้าแบบสุ่มจากแท่งที่ผ่านแค่ L6/L7
  ใช้ exit engine เดียวกันทุกประการ ทำซ้ำ 200 รอบ → ได้ null distribution ของ expectancy
- รายงาน percentile ของกลยุทธ์จริงเทียบ null

## 9. Metrics ที่รายงาน

ต่อ symbol และ pooled, แยก long/short: จำนวนเทรด, win rate, avg win/loss (bps),
expectancy (bps/เทรด), profit factor, max consecutive losses, exit breakdown (TP/SL/time)

## 10. เกณฑ์ตัดสิน (กำหนดล่วงหน้า)

ถือว่า "มี edge ควรศึกษาต่อ" เมื่อ **ครบทุกข้อ**:

1. เทรด pooled ≥ 100 เทรด (ต่ำกว่านี้ = ข้อมูลไม่พอ ไม่สรุป)
2. Net expectancy > 0
3. Net expectancy > เปอร์เซ็นไทล์ที่ 95 ของ null distribution
4. Profit factor (net) ≥ 1.15

ไม่ผ่านข้อใดข้อหนึ่ง = ไม่มีหลักฐาน edge → indicator เหล่านี้ยังใช้เป็น**เครื่องมืออ่านบริบท**ได้
แต่ห้ามใช้เป็นสัญญาณ mechanical

## วิธีรัน

```bash
pip install yfinance pandas numpy
python backtest.py                          # universe default, ทั้ง BASE และ STRICT
python backtest.py --symbols AAPL NVDA SPY  # เลือก symbol เอง
python backtest.py --no-baseline            # ข้าม random control (เร็วขึ้น)
```

## ข้อจำกัดที่รู้อยู่แล้ว

- 55 วันเทรดคือ regime เดียว — ผลผ่านเกณฑ์ก็ยังต้องทดสอบ out-of-sample ช่วงอื่นก่อนใช้จริง
- Yahoo 5m มี bad print ประปราย — สคริปต์กรองแท่ง volume ศูนย์/ราคา NaN แล้วแต่ไม่ได้ audit ทุกแท่ง
- ไม่โมเดล partial fill / queue position — สมมติ fill เต็มที่ราคา trigger
