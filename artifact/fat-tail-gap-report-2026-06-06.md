# Fat Tail Event — Gap Analysis Report
**Date:** 2026-06-06 (เหตุการณ์เมื่อวาน 2026-06-05)  
**Scope:** ระบบ Bloomberg Terminal ทั้งหมด — 26 routers, 9 views, alert system  
**ผู้ตรวจสอบ:** Claude Sonnet 4.6 (automated full-system audit)

---

## Executive Summary

ระบบปัจจุบัน **วัดได้ดี** ในสภาวะตลาดปกติและ stress ระดับกลาง แต่ **ขาดเครื่องมือหลัก 4 ชุด** ที่จำเป็นสำหรับ fat tail detection ก่อนเกิดเหตุ ได้แก่: (1) Options flow & IV skew, (2) Liquidity metrics, (3) Interbank/funding stress, (4) Network/cascade risk ทำให้ระบบมักตรวจพบ fat tail **หลังจาก** ราคา reprice แล้ว ไม่ใช่ก่อน

---

## 1. สิ่งที่ระบบวัดได้ (และน่าจะ trigger เมื่อวาน)

| Component | Router | ตรวจพบได้หรือไม่ |
|-----------|--------|-----------------|
| VIX spike > 30 | `crisis.py` | ✅ — alert แสดงใน ticker |
| HY spread widening > 5% | `crisis.py` | ✅ — แต่ต้องรอ FRED update (lag หลายชั่วโมง) |
| Yield curve inversion deepening | `macro.py` | ✅ — คำนวณ 10Y−2Y ทุก request |
| Composite risk score RED | `crisis.py` | ✅ — ถ้า 5+ indicators trigger |
| Sector correlation spike → CONVERGENT | `regime.py` | ✅ — 5-min cache, ตรวจจับได้เร็ว |
| Stop loss breach | `alerts.py` | ✅ — แต่เฉพาะ positions ที่ pin ไว้แล้ว |
| Fear & Greed → Extreme Fear | `fear_greed.py` | ✅ — CNN data, 5-min cache |
| ATR-based stop (adaptive VIX) | `stoploss.py` | ✅ — แต่ช้า: ATR smoothed 14 bars |

---

## 2. สิ่งที่ระบบ **ไม่มี** และพลาดไป

### 2.1 Options Implied Volatility Surface & Skew ❌ [HIGH]

**ขาดอะไร:**
- IV surface (strike × expiry grid) ไม่มีเลย
- Put/call skew (25-delta risk reversal) ไม่ได้ติดตาม
- Implied volatility term structure (VIX9D vs VIX vs VIX3M) มีแค่ VIX spot
- Options flow imbalance (delta-adjusted net buying/selling) ไม่มี

**ทำไมสำคัญสำหรับ fat tail:**
- ก่อนเกิด fat tail ตลาด options มักแสดง skew steepening หลายชั่วโมงก่อน underlying move
- Put buying surge = smart money hedging = leading indicator ที่ดีที่สุด
- IV backwardation (front > back) = imminent crash signal ที่ reliable มาก

**สิ่งที่น่าจะเกิดเมื่อวาน:**
ถ้า options skew steep ก่อน event เราไม่มีทางเห็นสัญญาณนั้น ระบบจะตรวจพบ VIX ก็ต่อเมื่อ volatility realized แล้ว (ช้า ~30-60 นาที)

---

### 2.2 Liquidity Metrics ❌ [HIGH]

**ขาดอะไร:**
- Bid-ask spread monitoring (ไม่มีเลย)
- Market depth / order book imbalance (ไม่มี)
- Trading volume anomaly detection (มีแต่ OHLCV ไม่มี alert)
- ETF premium/discount to NAV (สำคัญมากในวิกฤต)
- Block trade / dark pool activity

**ทำไมสำคัญสำหรับ fat tail:**
- Liquidity drying up เกิด **ก่อน** price crash ใน ~50% ของ flash crash events
- Bid-ask spread widening 5-10x เป็น early warning ที่ reliable
- ETF NAV dislocation = sign ว่า market makers ถอนตัว

**สิ่งที่น่าจะเกิดเมื่อวาน:**
ถ้า liquidity drained ก่อน event ระบบเราจะไม่รู้เลยจนกว่า price จะ move

---

### 2.3 Interbank & Funding Stress ❌ [HIGH]

**ขาดอะไร:**
- SOFR/Fed Funds basis (SOFR − EFFR)
- Repo market stress (GC repo rate vs SOFR)
- Commercial paper spreads (A2/P2 vs AA)
- FX basis swaps (USD funding demand ต่างประเทศ)
- TED spread: มีใน crisis.py แต่ข้อมูล FRED **ล่าช้า 1-2 วัน**

**ทำไมสำคัญสำหรับ fat tail:**
- Repo stress เป็น precursor ของ Lehman (2008), March 2020, SVB (2023)
- เมื่อ bank funding stress สูง leverage unwind บังคับขาย = cascade
- FX basis spike แสดงว่า USD liquidity หายจากระบบโลก

**สิ่งที่น่าจะเกิดเมื่อวาน:**
ถ้า event เชื่อมกับ funding stress ระบบจะตรวจพบแค่ผลลัพธ์สุดท้าย (spread widening, VIX) ไม่ใช่ต้นตอ

---

### 2.4 Network / Cascade Risk ❌ [HIGH]

**ขาดอะไร:**
- Contagion model (ไม่มี network graph ของความเชื่อมโยงระหว่างสินทรัพย์)
- Cross-asset correlation cascade detection (ตรวจได้แค่ correlation level ไม่ใช่ velocity)
- Margin call estimator (leverage ในระบบไม่ถูก model)
- CDS network / counterparty exposure map

**ทำไมสำคัญสำหรับ fat tail:**
- Fat tail มักไม่ได้มาจาก asset เดียว แต่จาก cascade ที่ข้าม asset class
- เมื่อ correlation ทุก asset วิ่งหา 1.0 พร้อมกัน = regime shift ที่ VaR model ทำนายไม่ได้

---

### 2.5 Threshold ที่ Static ไม่ Regime-Aware ⚠️ [MEDIUM]

**ปัญหา:**
```
HY OAS > 5%      → ปกติในช่วง recession แต่ aggressive ในช่วง expansion
VIX > 30         → งาน fine ปกติ แต่ในช่วง low-vol regime VIX 20 = extreme
CAPE > 30        → ค่าคงที่ ไม่ปรับตาม interest rate regime
Sector corr > 0.65 → threshold เดียว ไม่ขึ้นกับ time period หรือ volatility
```

**ผลลัพธ์:** ในสภาวะ low-vol ที่ยาวนาน (2024-2025) threshold อาจไม่ trigger จนกว่า stress รุนแรงเกินไปแล้ว

---

### 2.6 VaR Model Limitation ⚠️ [MEDIUM]

**ปัญหา:**
- Gaussian VaR ประเมิน tail loss ต่ำเกินไปในตลาด leptokurtic
- Cornish-Fisher adjustment มีแต่ portfolio-level ไม่มี per-asset
- Historical VaR ใช้ 2 ปีย้อนหลัง — ถ้า 2 ปีที่แล้วไม่มี stress period ก็ไม่ capture ได้
- Monte Carlo อยู่ใน stress scenarios แต่ scenarios เป็น hardcoded (-20%, -40%, -60%)
- ไม่มี Extreme Value Theory (EVT) / Generalized Pareto Distribution สำหรับ true tail

---

### 2.7 Sentiment Lag ⚠️ [MEDIUM]

**ปัญหา:**
- Fear & Greed = backward-looking composite (VIX, momentum, safe-haven flows ที่เกิดแล้ว)
- ไม่มี news NLP / event classification แบบ real-time
- ไม่มี social media sentiment (Reddit WallStreetBets-style crowd positioning)
- ไม่มี COT (Commitment of Traders) — positioning ของ institutional speculators

---

## 3. Timeline: ระบบจะตรวจพบเมื่อไหร่

สมมติ fat tail เริ่มเมื่อวานเวลา T=0:

```
T − 6h    Options skew steepening          ❌ ไม่มีเครื่องมือ
T − 4h    Bid-ask spreads widening          ❌ ไม่มีเครื่องมือ
T − 2h    Repo / funding stress rising       ❌ ไม่มีเครื่องมือ (FRED lag)
T − 1h    Put buying surge                   ❌ ไม่มีเครื่องมือ
T − 30m   VIX term structure backwardation   ❌ ไม่มีเครื่องมือ
T − 0m    EVENT OCCURS
T + 5m    VIX > 30 → crisis.py threshold    ✅ ticker alert
T + 5m    Sector correlation spike           ✅ regime.py (5-min cache)
T + 15m   F&G drops → Extreme Fear          ✅ fear_greed.py
T + 30m   Stop loss breach alerts           ✅ alerts.py (position-based)
T + 4h    HY spread update (FRED)           ✅ แต่ตลาดปรับไปแล้ว
```

**สรุป: ระบบตรวจพบ fat tail ได้เร็วสุดที่ T+5 นาที (หลังเกิดแล้ว) ไม่มีเครื่องมือ pre-event เลย**

---

## 4. สิ่งที่มีแต่ยังทำงานไม่สมบูรณ์

| Component | ปัญหา |
|-----------|-------|
| `risk.py` CVaR | Kupiec backtest คำนวณได้แต่ไม่มี alert ถ้า exception rate สูง |
| `regime.py` MRS | Model retrain ทุก 30 วัน — อาจ stale ในช่วง volatile |
| `alerts.py` | Alert เฉพาะ pinned positions — สินทรัพย์ที่ไม่ได้ pin = blind spot |
| `stoploss.py` | ATR smoothed 14 bars — ช้าเกินไปสำหรับ gap-down overnight |
| `crisis.py` | FRED data lag 1-4 ชั่วโมงในวันทำการ, บางตัว lag 1-2 วัน |

---

## 5. Recommended Additions (Priority Order)

### Priority 1 — ทำได้เร็ว (yfinance มีข้อมูล)

| Feature | Data Source | Implementation |
|---------|-------------|---------------|
| VIX term structure (VIX9D/VIX/VIX3M) | yfinance: `^VIX9D`, `^VIX3M` | router ใหม่ + alert ถ้า backwardation |
| Put/Call ratio | yfinance options chain aggregate | endpoint ใหม่ |
| Volume anomaly alert | yfinance (ปัจจุบัน OHLCV แต่ไม่ alert) | เพิ่ม threshold ใน alerts.py |
| Rolling VaR exception tracker | risk.py มี Kupiec แต่ไม่ save history | เพิ่ม SQLite table |

### Priority 2 — ต้องการ API เพิ่ม

| Feature | Data Source | Implementation |
|---------|-------------|---------------|
| Options IV skew per symbol | CBOE DataShop หรือ Polygon.io options | router ใหม่ |
| CDS spreads | Markit / IHS CDX via broker feed | router ใหม่ |
| Repo / SOFR spread | FRED (SOFR มีแล้ว) + Fed H.15 | เพิ่มใน macro.py |
| Bid-ask spread proxy | yfinance `info` dict (มี `bid`/`ask`) | เพิ่มใน analytics.py |

### Priority 3 — Complex (R&D)

| Feature | Approach |
|---------|----------|
| Extreme Value Theory (EVT) | Generalized Pareto fit บน tail losses |
| Network cascade model | Correlation matrix → Granger causality graph |
| Real-time news NLP | Anthropic API + RSS feeds ที่มีอยู่แล้ว |
| Adaptive thresholds | Rolling z-score of current indicator vs 2y history |

---

## 6. Conclusion

ระบบปัจจุบัน **ออกแบบมาเพื่อ monitoring ในสภาวะปกติและ stress ระดับกลาง** ได้ดีมาก แต่สำหรับ fat tail detection ที่แท้จริง ต้องการ:

1. **Options flow layer** — leading indicator ที่ดีที่สุด ควร prioritize ก่อน
2. **Liquidity monitoring** — bid-ask proxy ทำได้จาก yfinance data ที่มีอยู่แล้ว
3. **Adaptive thresholds** — static thresholds ทำให้ระบบ cry wolf ในบางช่วงและ miss ในช่วงอื่น
4. **Pre-event signals** — ปัจจุบัน 100% reactive, ต้องการ leading indicators

Fat tail ที่เกิดเมื่อวานเป็น reminder ว่า **ระบบที่ดีที่สุดคือระบบที่ตรวจพบก่อนตลาด reprice** ไม่ใช่แค่ alert หลังจาก damage เกิดแล้ว

---

*Report generated: 2026-06-06 | Bloomberg Terminal System Audit v1.0*  
*Routers reviewed: risk, regime, crisis, macro, stoploss, alerts, fear_greed, analytics, allocation, sector*
