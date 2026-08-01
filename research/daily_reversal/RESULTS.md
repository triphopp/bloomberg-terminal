# Daily Band-Rejection Reversal — Results (2026-07-11)

## Verdict: **DEAD** — โดน K3, K4, K5, K6 พร้อมกัน (ผ่านแค่เกณฑ์ปริมาณข้อมูล K1, K2)

Walk-forward 15 folds / ~7.5 ปีของ OOS / 1,231 เทรด OOS — ข้อมูลพอเหลือเฟือ
คำตอบจึงหนักแน่น: **สัญญาณนี้ไม่มีข้อมูลทิศทางแม้ที่ horizon รายวัน**

## ตัวเลขหลัก (pooled OOS)

| | รวม | Long | Short |
|---|---|---|---|
| เทรด | 1,231 | 616 | 615 |
| Net expectancy | −17.0 bps | +9.2 bps | −43.2 bps |
| Profit factor | 0.90 | 1.05 | 0.76 |
| Folds บวก | 7/15 | | |

Null baseline (random entry, exits เดียวกัน): mean = −18.8 bps, p95 = −0.4 bps
→ กลยุทธ์ (−17.0) อยู่**กลาง null distribution พอดี** — แยกจากการเข้าสุ่มไม่ได้เลย

## การตีความ

1. **ฝั่ง long ที่ดูบวก (+9.2) อย่าหลงดีใจ** — ตรงกับคำเตือน survivorship ใน PLAN §1 เป๊ะ:
   universe คือผู้ชนะ 10 ปีย้อนหลังในทศวรรษกระทิง random long ก็ได้ drift แบบเดียวกัน
   และต่อให้เชื่อ ก็ยัง PF 1.05 ไม่ผ่านเกณฑ์อยู่ดี
2. **ความแปรปรวนข้าม fold รุนแรง** (+108.7 ถึง −201.1 bps) — ผลของ fold ใดๆ
   เป็นเรื่อง regime ล้วนๆ นี่คือเหตุผลที่ K6 (fold consistency) ต้องอยู่ใน kill-list
   ถ้าดูแค่ fold 1/6/10 จะหลงคิดว่ามีระบบเทพ
3. **Grid ที่ walk-forward เลือกไม่เสถียร** (สลับไปมาทุก fold, บาง fold เลือกทั้งที่
   train เป็นลบเพราะเป็นจุดเดียวที่ n ≥ 100) — สัญญาณของ noise-fitting ชัดเจน

## ข้อสรุปสายงานวิจัยนี้ทั้งหมด (3 studies, 2 timeframes, 2 ทิศทาง)

| Study | Timeframe | ทิศ | ผล |
|---|---|---|---|
| vwap_reversion | 5m | ตามสัญญาณ (revert) | −21.4 bps, p6 ของ null |
| vwap_fade v1/v2 | 5m | สวนสัญญาณ | K1 → K2 dead in-sample |
| daily_reversal | 1d, 10 ปี walk-forward | ตามสัญญาณ (revert) | −17.0 bps, กลาง null |

**Pattern "แตะแบนด์ 2σ + rejection + volume ผิดปกติ" ไม่มีค่าเชิงพยากรณ์ทิศทาง
บนหุ้น US สภาพคล่องสูง ทั้ง 5 นาทีและรายวัน ทั้งตามและสวน** — ปิดสายนี้

## สถานะ: ปิด — สิ่งที่เหลืออยู่คือความรู้

indicator ชุดที่สร้าง (VWAP bands, RVOL, Toxicity, Absorption) ใช้เป็นเครื่องมือ
อ่านบริบท/execution ได้ (เช่น เลี่ยงไล่ราคาที่ +2σ เพราะ *ต้นทุน* ไม่ใช่เพราะ *ทำนายได้*)
แต่มีหลักฐานสามชั้นแล้วว่าห้ามใช้เป็นสัญญาณเข้า mechanical

ถ้าจะล่า edge บนหุ้นต่อ ทิศที่ literature ยังพอรองรับและไม่ใช่ pattern ตำรา retail:
cross-sectional (เทียบหุ้นกับหุ้น ไม่ใช่หุ้นกับตัวเอง), event-driven (earnings drift,
index rebalance), หรือกลับไปสนามที่มี structural edge จริงอย่าง options VRP
