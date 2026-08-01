# Regime Detection v2 — Multivariate HMM + Hysteresis (เขียนก่อนรัน 2026-07-12)

## Hypothesis

> **H1**: เสริม CORR ด้วย features ที่อุดจุดอ่อนที่วัดได้จาก v1 (vol, VIX, credit,
> breadth, trend) + hysteresis จะทำให้ regime detector ผ่านเกณฑ์ที่ v1 ตก
> (T1 พยากรณ์, T2b CAGR retention, T3 เสถียรภาพ) โดยไม่เสียสิ่งที่ v1 ทำได้
> (T2a ลด DD, crash detection เร็ว)

Baseline ที่ต้องชนะ (ผลจริงจาก [regime_validation](../regime_validation/RESULTS.md)):
T1 p=0.299 · T2a DD −38% · T2b CAGR kept 27% · T3 median run 8 / 9.5 switches/yr

## 1. Features (freeze 6 ตัว ห้ามเพิ่ม/ตัดหลังเห็นผล)

| # | Feature | อุดรูอะไรจาก v1 |
|---|---|---|
| F1 | CORR score 63d (สูตรเดิมของแอปเป๊ะ) | ฐานเดิม |
| F2 | SPY realized vol 21d (annualized) | T1 — เอาตัวที่กลืน corr มาไว้ในโมเดล |
| F3 | VIX close | ความช้า — เป็น implied มองไปข้างหน้า |
| F4 | Credit: 63d %change ของ HYG/IEF ratio | จับ bear ช้าๆ (รูใหญ่สุด — lag 108 วันใน 2022) |
| F5 | Breadth: สัดส่วน sector ETF (9 ตัว) เหนือ 200dma ของตัวเอง | จับ distribution ใต้ผิวน้ำ |
| F6 | Trend: SPY/200dma − 1 | ตัวแบ่ง bull/bear พื้นฐาน |

ข้อมูลครบทุก feature ตั้งแต่ ~2008 (HYG เริ่ม เม.ย. 2007 + 63d warmup)

## 2. โมเดล

- **Multivariate GaussianHMM 4 states** (full covariance, seed 42, n_iter 500) บน
  features ที่ standardize ด้วย **สถิติจาก train เท่านั้น** (point-in-time)
- เรียง state ตามค่าเฉลี่ยมิติ F2 (vol) จากต่ำ→สูง = DIVERGENT, TRENDING, RISK-OFF, CRISIS
- **Labeling แบบ causal**: วัน t ใช้ Viterbi บน window ย้อนหลัง ≤252 วันที่จบที่ t
  แล้วเอา state สุดท้าย — ไม่มี smoothing ที่แอบใช้อนาคต
- **Hysteresis K=5** (fix ล่วงหน้า ไม่จูน): label เปลี่ยนเมื่อ state ใหม่ยืนต่อเนื่อง
  ครบ 5 วันเท่านั้น — ตอบ T3 ตรงๆ

## 3. Walk-forward + Purge & Embargo (harness เดิมจาก v1)

```
train (expanding, เริ่ม 6 ปี) →|— purge 63 —|— embargo 21 —|— test 126 —| → refit
```
- Purge 63 = ความยาว window ที่ยาวสุดใน features (corr63/credit63)
- Embargo 21 = horizon ของ T1 · คาดว่า ~22-24 folds, OOS ~11-12 ปี

## 4. การทดสอบ + KILL-LIST (นิยามเหมือน v1 ทุกประการ)

| # | เงื่อนไข | หมายเหตุ |
|---|---|---|
| T1 | partial Spearman(regime, fwd21 vol \| trailing21 vol) > 0, perm-p < 0.05, n ≥ 150 | เกณฑ์ที่ v1 ตก (p=0.30) |
| T2a | MaxDD reduction ≥ 25% เทียบ B&H (gate: long SPY เมื่อ state ∈ {0,1}, lag 1 วัน, 1bp/ข้าง) | v1 ผ่าน (38%) — ห้ามเสีย |
| T2b | net CAGR ≥ 60% ของ B&H | v1 ตก (27%) |
| T3 | median run ≥ 10 sessions และ ≤ 12 switches/ปี | v1 ตก (8) |
| K0 | ต้องดีกว่า v1 ตัวเลขต่อตัวเลขในทุกข้อที่ v1 ตก | กันกรณี "ผ่านเกณฑ์แต่แย่กว่าของเดิม" |

**Verdict**: FULLY USABLE = ผ่านทุกข้อ · RISK DIAL = ผ่าน T2a+T3+K0 บางส่วน · ไม่งั้น DEAD
**One-shot**: รันครั้งเดียว บันทึก RESULTS.md เสมอ แก้อะไร = study ใหม่

## 5. ความเสี่ยงที่ประกาศก่อน

- 6 มิติ × 4 states × full cov = พารามิเตอร์เยอะ โอกาส overfit สูงกว่า v1 มาก —
  ถ้า state means ต่อ fold ไม่เสถียร (สลับความหมายไปมา) จะรายงานไว้เป็นธงแดง
- ความคาดหวัง realistic: ช่วย T2/T3 มากกว่า T1 (พยากรณ์ vol ล่วงหน้าคือข้อที่ยากสุด)
- OOS สั้นกว่า v1 (~12 ปี vs 18 ปี) เพราะ HYG จำกัด — ครอบคลุม 2022, 2025 แต่ไม่รวม 2008
