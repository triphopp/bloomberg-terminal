# Sector Allocation — Walk-Forward Study (เขียนก่อนรัน 2026-10-07)

กฎทุกข้อ ค่าทุกตัว และเกณฑ์ตัดสินในไฟล์นี้ถูก freeze ก่อนเห็นผล ถ้าแก้หลังรัน ต้องจดไว้ใน RESULTS.md ว่าแก้อะไร เพราะอะไร

## คำถาม

1. **หุ้นหรือเงินสด** — กฎ trend และกฎ vol ลด drawdown ได้จริงไหม เมื่อเทียบกับการถือหุ้นน้อยลงเฉยๆ ในสัดส่วนเฉลี่ยเท่ากัน
2. **sector ไหน** — momentum, phase ของ cycle, ทิศนโยบาย Fed อันไหนเรียงลำดับผลตอบแทน sector เดือนถัดไปได้
3. **ขนาด tilt** — tilt กี่ pp ให้ active return เท่าไร แลกกับ tracking error เท่าไร (ตารางให้ผู้ใช้เลือก ไม่ใช่ให้ระบบเลือก)

ไม่มีการ fit พารามิเตอร์ กฎมาจากงานที่ตีพิมพ์แล้วและใช้ค่าตามต้นฉบับ ทั้ง sample จึงเป็นการทดสอบกฎที่กำหนดไว้ล่วงหน้า ส่วนช่วงหลังปีตีพิมพ์ของแต่ละกฎคือ out-of-sample แท้

## 1. ข้อมูล

| รายการ | แหล่ง | ช่วง | หมายเหตุ |
|---|---|---|---|
| SPY + 9 sector SPDR (XLK XLF XLV XLI XLY XLP XLE XLB XLU) | Yahoo daily, adjusted (รวมปันผล) | SPY 1993-01, sector 1998-12 | |
| XLRE, XLC | เดียวกัน | 2015-10, 2018-06 | เข้า universe เมื่อมีประวัติครบ 13 เดือน |
| เงินสด | FRED `DTB3` (T-bill 3M รายวัน) | 1990+ | ไม่ถูก revise |
| Growth | FRED Philly `GACDFSA066MSFRBPHI`, Empire `GACDISA066MSFRBNY`, Dallas `BACTSAMFRBDAL` | 1968 / 2001-07 / 2004-06 | ตัวเดียวกับ ISM proxy ของ TAIL MACRO READ; ออกภายในเดือนเดียวกัน |
| Inflation | FRED `PCEPILFE` → YoY | 1990+ | ใช้ค่าของเดือน m−2 ณ สิ้นเดือน m (กันวันประกาศ) |
| นโยบาย | FRED `DFEDTAR` (ถึง 2008-12-15) ต่อด้วย `DFEDTARU` | 1990+ | เป้า Fed funds ไม่ถูก revise |
| NBER recession | FRED `USREC` | | ใช้รายงานผลเท่านั้น ไม่เข้าสัญญาณ |

**ข้อจำกัดที่รู้ก่อนรัน**
- FRED ให้ค่าที่ revise แล้ว ไม่ใช่ค่าที่เห็น ณ วันนั้น (ต้องใช้ ALFRED ถึงจะได้) กระทบ core PCE และ seasonal factor ของ survey ระดับไม่เกิน ~0.1pp
- Sector มีประวัติ 26 ปี = 3 recession (2001, 2008–09, 2020) หลักฐานเรื่อง phase จึงบางโดยโครงสร้าง
- ก่อน 2015/2018 XLF รวม real estate และ XLK/XLY รวมสิ่งที่ย้ายไป XLC
- HY OAS ใช้ไม่ได้: FRED ตัด `BAMLH0A0HYM2` เหลือ 3 ปี (เริ่ม 2023-10) → **ไม่ทดสอบกฎ stress ในรอบนี้** ระบบจริงจึงยังห้ามใส่ตัวเลข haircut จาก stress
- Base ของ sector คือ equal weight ไม่ใช่ market cap (ไม่มีน้ำหนัก sector ย้อนหลังฟรี) วัด active return เทียบ base เดียวกัน

## 2. จังหวะเวลา (กัน lookahead)

- **วันสัญญาณ** = วันทำการสุดท้ายของเดือน ใช้ข้อมูลถึงราคาปิดวันนั้นเท่านั้น
- **วันเทรด** = วันทำการแรกของเดือนถัดไป ที่ราคาปิด (ช้ากว่าสัญญาณ 1 วัน)
- ถือน้ำหนักคงที่ถึงวันเทรดถัดไป (ไม่ rebalance กลางเดือน); NAV คิดรายวันเพื่อวัด drawdown จริง
- ต้นทุน **5 bps ต่อข้าง** บนมูลค่าที่ซื้อขาย

## 3. กฎ (freeze)

### ชั้น 1 — หุ้น (SPY) เทียบเงินสด

| ชื่อ | กฎ | ที่มา |
|---|---|---|
| `T` trend | ถือ SPY เมื่อราคาปิดสิ้นเดือน > ค่าเฉลี่ยราคาปิดสิ้นเดือน 10 เดือนล่าสุด ไม่งั้นเงินสด 100% | Faber 2007 |
| `V` vol | `w = min(1, σ_ref / σ_21d)`; σ_21d = sd ของ log return รายวัน 21 วันล่าสุด × √252; σ_ref = sd เดียวกันจากประวัติทั้งหมดถึงวันสัญญาณ (ขั้นต่ำ 252 วัน) ไม่มี leverage | Moreira & Muir 2017 (ใช้ vol แทน variance ตาม Harvey et al. 2018) |
| `TV` | `w = T × V` | |

Benchmark: `SPY` ถือยาว และ `MIX(x)` = ถือ SPY ในสัดส่วนคงที่เท่ากับค่าเฉลี่ย exposure ของกฎ x ส่วนที่เหลือเป็นเงินสด rebalance ทุกเดือน

### ชั้น 2 — sector (ลงทุนเต็ม 100% ใน sector เพื่อแยกวัดฝีมือเลือก sector)

Universe ณ วันสัญญาณ = sector ที่มีราคาสิ้นเดือนย้อนหลังครบ 13 เดือน

| ชื่อ | Score | ที่มา |
|---|---|---|
| `M` momentum | ผลตอบแทนรวม 12 เดือน ข้ามเดือนล่าสุด (สิ้นเดือน t−1 ÷ สิ้นเดือน t−12 − 1) | Moskowitz & Grinblatt 1999 |
| `C` cycle | +1 ให้ sector ที่ตาราง phase ชี้ ที่เหลือ 0 | ตารางด้านล่าง (ดัดจาก Stovall 1996 / Investment Clock) |
| `P` policy | Fed ผ่อน (การเปลี่ยนเป้าครั้งล่าสุดเป็นการลด): cyclical +1, defensive −1; Fed ตึง: กลับด้าน | Conover et al. 2008 |
| `MC` | ค่าเฉลี่ยของ z(M) และ z(C) | |

**Phase** — g = ค่าเฉลี่ยของ (diffusion index ÷ sd ย้อนหลัง 120 เดือนของตัวเอง, ขั้นต่ำ 24 เดือน) ของ survey ที่มี ณ เดือนนั้น; dg = g − g เมื่อ 3 เดือนก่อน; gap = core PCE YoY − 2.0

| เงื่อนไข | Phase | Sector ที่ได้ +1 |
|---|---|---|
| g < 0, dg > 0 | Recovery | XLY XLF XLI |
| g ≥ 0, dg ≥ 0, gap ≤ 0.4 | Expansion | XLK XLI XLC |
| g ≥ 0, dg ≥ 0, gap > 0.4 | Overheat | XLE XLB |
| g ≥ 0, dg < 0 | Slowdown | XLV XLP XLU |
| g < 0, dg ≤ 0 | Contraction | XLP XLV |

**Policy** — cyclical = XLY XLF XLI XLB XLK; defensive = XLE XLU XLP XLV; XLRE และ XLC = 0 (การจัดกลุ่มเขียนจากความจำของ Conover et al. ยังไม่ได้เปิดต้นฉบับ)

**Score → น้ำหนัก** — z = z-score ข้าม sector, ตัดที่ ±2, ลบค่าเฉลี่ย; `tilt_i = cap × z_i / max(2, max|z|)`; `w_i = 1/N + tilt_i` ค่าหลัก **cap = 5pp**. Base `EW` = 1/N

### ระบบรวม

`SYS` = น้ำหนัก sector ของ `MC` × exposure ของ `TV`, ที่เหลือเงินสด. เทียบ `SPY` และ `MIX(SYS)`

## 4. ตัววัด

- CAGR, vol, Sharpe (หักผลตอบแทนเงินสด, รายเดือน × √12), max drawdown (รายวัน), เดือนที่แย่สุด 12 เดือน, exposure เฉลี่ย, turnover ต่อปี
- **ΔSharpe** เทียบ benchmark ด้วย circular block bootstrap: block 12 เดือน, 5,000 รอบ, seed 20261007 → 95% CI และ P(Δ > 0)
- **IC** = Spearman ระหว่าง score กับผลตอบแทน sector งวดถัดไป ต่อเดือน → ค่าเฉลี่ย, t, % เดือนที่บวก; ส่วนต่าง top 3 − bottom 3
- ตาราง phase × sector: ผลตอบแทนเทียบ EW เฉลี่ยต่อเดือน, t, จำนวนเดือน; ส่วนต่าง "sector ที่ตารางชี้ − ที่เหลือ" ต่อ phase
- ช่วงย่อย: 2000–2009, 2010–2019, 2020–2026 และช่วงหลังปีตีพิมพ์ (Faber ≥ 2007, Conover ≥ 2008, Moreira-Muir ≥ 2017)

## 5. เกณฑ์ตัดสิน (freeze)

ทดสอบ 7 ข้อ (T, V, TV, M, C, P, MC) ที่เกณฑ์ t ≥ 2 คาดว่าผ่านโดยบังเอิญ ~0.35 ข้อ จึงแยกระดับ **STRONG** ที่ t ≥ 2.7 (Bonferroni 7 ข้อ)

### ชั้น 1 (T, V, TV)

| # | เงื่อนไข | ผล |
|---|---|---|
| L1-K1 | Sharpe ≤ Sharpe ของ SPY | DEAD |
| L1-K2 | max drawdown ≥ max drawdown ของ MIX(x) (ลด drawdown ได้ไม่ดีกว่าถือหุ้นน้อยลงเฉยๆ) | DEAD |
| L1-K3 | ช่วงหลังปีตีพิมพ์: Sharpe ≤ SPY | DECAYED |
| ผ่านทั้งสาม และ P(ΔSharpe vs SPY > 0) ≥ 0.90 | | VALID |
| ผ่านทั้งสาม แต่ P < 0.90 | | WEAK |

### ชั้น 2 (M, C, P, MC)

| # | เงื่อนไข | ผล |
|---|---|---|
| L2-K1 | IC เฉลี่ย ≤ 0 | DEAD |
| L2-K2 | active return สุทธิของ tilt 5pp เทียบ EW หลังต้นทุน ≤ 0 | DEAD |
| L2-K3 | IC เฉลี่ยเป็นบวกน้อยกว่า 2 ใน 3 ช่วงย่อย หรือช่วงล่าสุดติดลบ | UNSTABLE |
| ผ่านทั้งสาม และ t(IC) ≥ 2 | | VALID (≥ 2.7 = STRONG) |
| ผ่านทั้งสาม แต่ t(IC) < 2 | | WEAK |

Phase ที่มีน้อยกว่า 24 เดือน = INSUFFICIENT ห้ามใช้ prior ของ phase นั้นในระบบจริง

### ระบบจริงใช้ผลอย่างไร

- VALID → ใช้ได้ ติดป้าย validated
- WEAK / UNSTABLE / DECAYED → แสดงเป็น context ติด `validated: False` ห้ามแปลงเป็นน้ำหนัก
- DEAD → ถอดออก

## 6. Sensitivity (รายงานอย่างเดียว ห้ามใช้เลือกค่า)

SMA 8 / 12 เดือน · vol window 63 วัน · momentum 6-1 และ 12-0 · g เฉลี่ย 3 เดือน · tilt cap 2 / 3 / 8pp · ต้นทุน 0 / 10 / 20 bps · เทรดวันเดียวกับสัญญาณ

## 7. วิธีรัน

```bash
python research/sector_allocation/backtest.py            # ใช้ข้อมูลที่ cache ไว้ (ดึงใหม่ถ้ายังไม่มี)
python research/sector_allocation/backtest.py --refresh  # ดึงข้อมูลใหม่
```

กฎอยู่ใน `backend/analytics/alloc_rules.py` (ตัวเดียวกับที่ระบบจริงจะเรียก), ตัวจำลองและตัววัดใน `backend/analytics/alloc_backtest.py`, test ใน `backend/tests/test_alloc_backtest.py`. ผลออกที่ `research/sector_allocation/out/`
