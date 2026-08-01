# FADE Study — Continuation on VWAP-Band Rejection Signals

## ที่มาของ hypothesis (และทำไมต้องระวังตัวเองเป็นพิเศษ)

การศึกษาก่อนหน้า ([vwap_reversion](../vwap_reversion/STRATEGY.md)) พบว่าสัญญาณ mean-reversion
เข้า VWAP ให้ expectancy −21.4 bps และอยู่ที่ **percentile 6 ของ null distribution** —
แย่กว่าการเข้าสุ่มอย่างมีนัย จึงเกิด hypothesis ใหม่:

> **H1**: เมื่อเกิดสัญญาณ reversion (แตะแบนด์ 2σ + ปิด reject กลับเข้าใน + volume ผิดปกติ)
> ราคามีแนวโน้ม**ไปต่อทางเดิม** (continuation) มากกว่ากลับเข้า VWAP —
> ดังนั้นเทรด**สวนสัญญาณเดิม**ควรมี edge บวก

**คำเตือนต่อตัวเอง**: hypothesis นี้เกิดจากการเห็นผลลบของ study เก่า (post-hoc) —
โอกาส overfit สูงกว่าปกติ จึงบังคับโครงสร้าง in-sample / out-of-sample + purge & embargo
+ kill-list ที่เขียนก่อนรัน และ **OOS รันครั้งเดียว** ด้วยพารามิเตอร์ที่ freeze แล้วเท่านั้น

---

## 1. ข้อมูลและการแบ่ง IS / OOS

| รายการ | ค่า |
|---|---|
| Bars | 5m, regular session 09:30–16:00 ET, ~55 วันเทรด |
| Universe | เดียวกับ study เดิม 10 ตัว |
| **In-sample (IS)** | 60% ของ session แรกสุด (ราว 33 วัน) — ใช้เลือกพารามิเตอร์ |
| **Purge** | ตัด 1 session หลังจบ IS ทิ้ง — horizon ของ label คือจบภายในวัน จึง purge เท่า horizon |
| **Embargo** | ตัดเพิ่มอีก 3 sessions — กัน serial correlation ของ regime/volatility clustering รั่วจาก IS เข้า OOS |
| **Out-of-sample (OOS)** | sessions ที่เหลือ (~18 วัน) — แตะครั้งเดียว หลัง freeze พารามิเตอร์ |

หมายเหตุเชิงเทคนิค: เพราะทุกเทรดปิดภายในวัน (ไม่มี label ข้ามคืน) purge 1 วันคือค่าที่ถูกต้อง
ตามนิยาม (purge = ตัด sample ที่ label window ทับรอยต่อ) ส่วน embargo 3 วันเป็น
มาตรการเผื่อ autocorrelation ของ volatility ตามแนว López de Prado

**Features ใช้ rolling window ย้อนหลังเท่านั้น** (RVOL baseline 10 วัน, median 20 แท่ง, ATR) —
OOS อนุญาตให้ window มองย้อนเข้าเขต IS/embargo ได้ เพราะเป็นข้อมูลอดีต ณ เวลาตัดสินใจ
(ไม่ใช่ leakage — leakage คือ "อนาคตรั่วเข้า training" ไม่ใช่ "อดีตรั่วเข้า test")

## 2. สัญญาณเข้า

ใช้เงื่อนไข L1–L7 ของ study เดิม (BASE variant) **ทุกข้อเหมือนเดิมเป๊ะ ห้ามจูน** —
เปลี่ยนเฉพาะทิศ:

- สัญญาณ LONG เดิม (แตะแบนด์ล่าง + reject ขึ้น) → เข้า **SHORT** (เชื่อว่าลงต่อ)
- สัญญาณ SHORT เดิม (แตะแบนด์บน + reject ลง) → เข้า **LONG** (เชื่อว่าขึ้นต่อ)
- ราคาเข้า = open ของแท่ง t+1 (เหมือนเดิม)
- จำกัด 2 เทรด/ฝั่ง/วัน/symbol, ไม่ถือซ้อน (เหมือนเดิม)

## 3. การออก — symmetric ATR bracket

Exit เดิม (target ที่ VWAP) ผูกกับตรรกะ reversion จึงใช้ไม่ได้กับ continuation
ใช้ bracket สมมาตรแทน:

| ประเภท | นิยาม (SHORT; LONG สมมาตร) | Fill |
|---|---|---|
| Stop | `entry + S × ATR14(t)` | ที่ stop; gap ทะลุ fill ที่ open |
| Target | `entry − T × ATR14(t)` | ที่ target; gap ทะลุ fill ที่ open |
| Time | แท่ง 15:55 | ที่ close |

- แท่งเดียวโดนทั้งคู่ → นับเป็น **stop** (conservative)
- ต้นทุน 2 bps/ข้าง เหมือนเดิม

## 4. พารามิเตอร์ที่อนุญาตให้จูนบน IS (grid ปิดตาย 9 จุด)

- `S` (stop) ∈ {1.0, 1.5, 2.0}
- `T` (target) ∈ {1.0, 1.5, 2.0}

เลือกจุดที่ **net expectancy บน IS สูงสุด** โดยต้องมีเทรด IS ≥ 60
(เสมอกัน → เลือกจุดที่เทรดมากกว่า) — เลือก**ชุดเดียวใช้ทุก symbol** (pooled)
ห้ามจูนต่อ symbol, ห้ามแตะเงื่อนไขเข้า, ห้ามเพิ่ม grid หลังเห็นผล

## 5. Null baseline

Random-entry control บน **OOS เท่านั้น**: จำนวนเทรดเท่ากลยุทธ์ต่อ symbol/ฝั่ง,
เวลาเข้าสุ่มจากแท่งที่ผ่านแค่ time filter, exit engine + พารามิเตอร์ freeze ชุดเดียวกัน,
200 รอบ → null distribution ของ expectancy

## 6. KILL-LIST (เขียนก่อนรัน — โดนข้อไหน = ตายทันที ไม่มีอุทธรณ์)

| # | เงื่อนไขฆ่า | จุดเช็ค |
|---|---|---|
| K1 | เทรด IS pooled < 60 | ก่อนเลือกพารามิเตอร์ — sample ไม่พอ ยุติทั้ง study |
| K2 | ทุกจุดใน grid ให้ IS net expectancy ≤ 0 | หลัง grid — hypothesis ตายตั้งแต่ IS, **ไม่รัน OOS** |
| K3 | เทรด OOS pooled < 30 | หลัง OOS — สรุปไม่ได้ |
| K4 | OOS net expectancy ≤ 0 | หลัง OOS |
| K5 | OOS net expectancy < 40% ของ IS expectancy | หลัง OOS — overfit decay เกินรับได้ |
| K6 | OOS expectancy ≤ percentile 95 ของ null | หลัง OOS — ไม่ต่างจากสุ่ม |
| K7 | OOS profit factor < 1.10 | หลัง OOS |

**กติกา one-shot**: OOS รันได้ครั้งเดียว ถ้าตายแล้วอยากแก้อะไรก็ตาม (เงื่อนไข, grid, exit)
ต้องรอข้อมูลใหม่ที่ไม่เคยแตะ (rolling 60 วันของ Yahoo จะหมุนให้เอง ~ทุกเดือน)
ผลไม่ว่าผ่านหรือตาย บันทึกใน RESULTS.md เสมอ — ห้ามลบ study ที่ตาย

## 7. ถ้าผ่านทุกข้อ (แปลว่าอะไร / ไม่แปลว่าอะไร)

ผ่าน = "มีหลักฐานเบื้องต้นควรค่าแก่การทดสอบต่อบน regime อื่น" เท่านั้น
ยังต้อง: ทดสอบข้อมูลยาวกว่า 60 วัน (ต้องหา data feed), ทดสอบ 15m/1h ย้อนหลายปี,
และโมเดล slippage จริงจัง — **ไม่ใช่สัญญาณให้เอาเงินจริงลง**

## วิธีรัน

```bash
python backtest_fade.py                 # ทั้ง pipeline: IS grid → freeze → OOS → null → verdict
python backtest_fade.py --is-only      # รันแค่ IS grid (ดูก่อนว่ารอด K1/K2 ไหม)
```
