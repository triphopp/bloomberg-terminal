# Analysis Functions — Reference

ทุกฟังก์ชันคำนวณจาก **log-returns ของ adjusted daily closes** ผ่าน yfinance  
ผลลัพธ์แสดงใน overlay ทันที — ไม่เปลี่ยน view

---

## Period Values

| ค่าที่พิมพ์ | ความหมาย | yfinance param |
|------------|---------|----------------|
| `5d` | 5 วันทำการ | `5d` |
| `1m` | 1 เดือน | `1mo` |
| `3m` | 3 เดือน | `3mo` |
| `6m` | 6 เดือน | `6mo` |
| `1y` | 1 ปี | `1y` |
| `2y` | 2 ปี | `2y` |
| `5y` | 5 ปี | `5y` |

Default period แต่ละฟังก์ชันระบุในส่วนนั้นๆ

---

## corr — Pearson Correlation

**Syntax:**
```
corr(A, B)
corr(A, B, period)
```

**Aliases:** `cor`

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| A | symbol | ✓ | — |
| B | symbol | ✓ | — |
| period | period | ✗ | `3m` |

**คำนวณ:**

```
log_returns_A = ln(close_A[t] / close_A[t-1])
log_returns_B = ln(close_B[t] / close_B[t-1])

# align บน common trading days
r = Pearson_r(log_returns_A, log_returns_B)
t_stat = r * sqrt(n-2) / sqrt(1 - r²)
p_value = 2 * (1 - CDF_normal(|t_stat|))
```

**Output:**
```
CORR  AAPL / MSFT  [3m]
0.8721
n=63  p-value=0.0000
```

**ตีความ r:**
| ค่า r | ความหมาย |
|-------|---------|
| 0.9 – 1.0 | Strong positive |
| 0.7 – 0.9 | Moderate positive |
| 0.3 – 0.7 | Weak positive |
| -0.3 – 0.3 | No correlation |
| -0.7 – -0.3 | Weak negative |
| < -0.7 | Strong negative |

**ตัวอย่าง:**
```
corr(AAPL, MSFT)           → correlation 3m (default)
corr(^SET.BK, ^GSPC, 1y)   → SET vs S&P 500 1 ปี
corr(GLD, BTC-USD, 6m)     → Gold vs Bitcoin 6 เดือน
cor(SCB.BK, BBL.BK, 3m)    → alias ก็ได้
```

---

## beta — Beta vs Benchmark

**Syntax:**
```
beta(asset)
beta(asset, benchmark)
beta(asset, benchmark, period)
```

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| asset | symbol | ✓ | — |
| benchmark | symbol | ✗ | `^GSPC` |
| period | period | ✗ | `1y` |

**คำนวณ (OLS regression):**

```
ra = log_returns(asset)
rb = log_returns(benchmark)

β = Cov(ra, rb) / Var(rb)
α = mean(ra) - β * mean(rb)
R² = Pearson_r(ra, rb)²
```

**Output:**
```
BETA  NVDA vs ^GSPC  [1y]
1.7823
α=0.00041  R²=0.621  n=252
```

**ตีความ β:**
| ค่า β | ความหมาย |
|-------|---------|
| > 1.5 | Aggressive — เคลื่อนไหวมากกว่า benchmark |
| 1.0 – 1.5 | Above average |
| 0.5 – 1.0 | Defensive |
| < 0.5 | Low correlation / very defensive |
| < 0 | Inverse — เคลื่อนตรงข้าม |

**ตัวอย่าง:**
```
beta(NVDA)                  → vs S&P 500 1y (default)
beta(SCB.BK, ^SET.BK, 1y)   → Thai bank vs SET
beta(GLD, ^GSPC, 3y)        → Gold beta (ควรต่ำ)
beta(TSLA, ^GSPC, 6m)       → Tesla beta ล่าสุด
```

---

## vol — Annualised Volatility

**Syntax:**
```
vol(symbol)
vol(symbol, period)
```

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| period | period | ✗ | `1y` |

**คำนวณ:**

```
log_ret = ln(close[t] / close[t-1])
daily_σ = std(log_ret, ddof=1)
ann_σ = daily_σ * sqrt(252)     # 252 วันทำการต่อปี
```

**Output:**
```
VOL  AAPL  [1y]
+24.82%
daily_σ=+1.563%  n=252
```

**ตีความ annualised vol:**
| ระดับ | ช่วง | ตัวอย่าง |
|-------|------|---------|
| Very low | < 10% | Bonds, Gold (stable period) |
| Low | 10–20% | Large-cap mature stocks |
| Medium | 20–35% | Tech stocks, ETFs |
| High | 35–60% | Small-cap, crypto-adjacent |
| Very high | > 60% | Crypto, volatile growth |

**ตัวอย่าง:**
```
vol(AAPL)               → Apple 1y vol
vol(BTC-USD, 1y)        → Bitcoin vol (ควรสูง)
vol(^VIX, 3m)           → Vol of VIX itself
vol(GLD, 5y)            → Gold long-term vol
```

---

## return — Total Return

**Syntax:**
```
return(symbol)
return(symbol, period)
```

**Aliases:** `ret`

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| period | period | ✗ | `1y` |

**คำนวณ:**

```
return = (close[-1] - close[0]) / close[0]
```

> ใช้ adjusted closes — รวม dividends และ splits แล้ว

**Output:**
```
RETURN  NVDA  [1y]
+184.32%
2024-06-06 → 2025-06-06  (462.50 → 1315.72)
```

**ตัวอย่าง:**
```
return(AAPL, 1y)        → Apple 1-year return
return(^SET.BK, 6m)     → SET ครึ่งปีหลัง
ret(BTC-USD, 3m)        → Bitcoin 3-month alias
return(GLD, 5y)         → Gold 5-year
```

---

## drawdown — Maximum Drawdown

**Syntax:**
```
drawdown(symbol)
drawdown(symbol, period)
```

**Aliases:** `dd`

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| period | period | ✗ | `1y` |

**คำนวณ:**

```
for each t:
    running_peak = max(close[0..t])
    drawdown[t]  = (running_peak - close[t]) / running_peak

max_drawdown = max(drawdown)
trough_date  = date ที่ max_drawdown เกิดขึ้น
```

**Output:**
```
DRAWDOWN  TSLA  [1y]
-43.21%
trough: 2024-11-22
```

**ตัวอย่าง:**
```
drawdown(TSLA, 1y)       → Tesla worst drop ปีที่ผ่านมา
drawdown(^SET.BK, 5y)    → SET ย้อนหลัง 5 ปี
dd(AAPL, 6m)             → alias dd
```

---

## sharpe — Sharpe Ratio

**Syntax:**
```
sharpe(symbol)
sharpe(symbol, period)
```

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| period | period | ✗ | `1y` |

**Risk-free rate:** 4.3% ต่อปี (US 3-month T-bill proxy — อัปเดตใน `analytics.py` ตัวแปร `_RF_ANNUAL`)

**คำนวณ:**

```
ann_return = mean(log_ret) * 252
ann_vol    = std(log_ret, ddof=1) * sqrt(252)
rf_daily   = (1 + rf_annual)^(1/252) - 1   # approximate: rf_annual

Sharpe = (ann_return - rf_annual) / ann_vol
```

**Output:**
```
SHARPE  NVDA  [1y]
2.431
ann_ret=+89.43%  ann_vol=+36.77%  rf=4.3%
```

**ตีความ Sharpe:**
| ค่า Sharpe | ความหมาย |
|-----------|---------|
| > 2.0 | Excellent |
| 1.0 – 2.0 | Good |
| 0.5 – 1.0 | Acceptable |
| 0.0 – 0.5 | Poor |
| < 0 | Worse than risk-free |

**ตัวอย่าง:**
```
sharpe(NVDA, 1y)          → NVDA Sharpe ปีนี้
sharpe(^SET.BK, 3y)       → SET Sharpe 3 ปี
sharpe(GLD, 5y)           → Gold risk-adjusted return
```

---

## zscore — Price Z-Score

**Syntax:**
```
zscore(symbol)
zscore(symbol, period)
```

**Aliases:** `zs`

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| period | period | ✗ | `1y` |

**คำนวณ (บน closing prices, ไม่ใช่ returns):**

```
μ = mean(close)        # mean ตลอด period
σ = std(close, ddof=1)
z = (close[-1] - μ) / σ
```

**Output:**
```
ZSCORE  AAPL  [1y]
1.83σ  (EXTENDED)
cur=211.82  μ=183.41  σ=15.51
```

**Label:**
| z-score | Label |
|---------|-------|
| z > 2σ | EXTENDED (overbought-ish) |
| z < -2σ | DEPRESSED (oversold-ish) |
| -2σ ≤ z ≤ 2σ | NORMAL |

> ⚠️ Z-score เทียบกับ historical mean ไม่ใช่ fundamental value — ใช้เป็น signal complement เท่านั้น

**ตัวอย่าง:**
```
zscore(GLD, 5y)          → Gold vs 5-year mean
zscore(^VIX, 1y)         → VIX spike detection
zs(BTC-USD, 1y)          → alias
```

---

## rsi — Relative Strength Index

**Syntax:**
```
rsi(symbol)
rsi(symbol, window)
```

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbol | symbol | ✓ | — |
| window | number | ✗ | `14` |

**คำนวณ (Wilder smoothing):**

```
delta = diff(close)
gains  = max(delta, 0)
losses = max(-delta, 0)

# Initial average (simple)
avg_gain = mean(gains[0:window])
avg_loss = mean(losses[0:window])

# Wilder smoothing (EMA α=1/window)
for i in window..:
    avg_gain = (avg_gain * (window-1) + gains[i]) / window
    avg_loss = (avg_loss * (window-1) + losses[i]) / window

RS  = avg_gain / avg_loss
RSI = 100 - 100 / (1 + RS)
```

> ใช้ข้อมูลย้อนหลัง 6 เดือนเสมอ — ให้ Wilder smoothing มีเวลา converge

**Output:**
```
RSI  TSLA  [14]
31.2  (OVERSOLD)
Oversold zone
```

**Zones:**
| RSI | Zone |
|-----|------|
| ≥ 70 | OVERBOUGHT |
| ≤ 30 | OVERSOLD |
| 30–70 | NEUTRAL |

**ตัวอย่าง:**
```
rsi(AAPL)               → RSI(14) default
rsi(BTC-USD, 21)        → RSI(21) longer window
rsi(^SET.BK)            → SET index RSI
```

---

## compare — Side-by-Side Table

**Syntax:**
```
compare(A, B, C, ...)
compare(A, B, C, period)
```

**Aliases:** `cmp`

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbols... | symbol (1–8) | ✓ | — |
| period | period | ✗ | `1y` |

**คำนวณ:** รวม return + vol + sharpe + drawdown สำหรับทุก symbol

**Output:**
```
COMPARE  [1y]
SYMBOL  RETURN    VOL      SHARPE  DRAWDOWN
NVDA    +184.32%  +36.77%  2.43    -21.43%
AAPL    +28.41%   +24.82%  1.12    -12.18%
MSFT    +22.14%   +22.31%  0.98    -14.62%
TSLA    -8.32%    +61.24%  -0.23   -43.21%
```

> Sort: return descending อัตโนมัติ

**ตัวอย่าง:**
```
compare(AAPL, MSFT, NVDA, GOOGL, 1y)
compare(^SET.BK, ^GSPC, ^N225, 6m)        → cross-market
compare(GLD, BTC-USD, SLV, 1y)            → commodity comparison
cmp(SCB.BK, KBANK.BK, BBL.BK, 1y)         → Thai banks
```

---

## rank — Sorted Ranking

**Syntax:**
```
rank(A, B, C, ...)
rank(A, B, C, METRIC, period)
```

**Parameters:**
| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| symbols... | symbol (1–8) | ✓ | — |
| METRIC | RETURN\|VOL\|SHARPE\|DRAWDOWN | ✗ | `RETURN` |
| period | period | ✗ | `1y` |

> METRIC พิมพ์เป็น uppercase เหมือน symbol — system ตรวจจาก word ที่ตรงกับ metric names

**Sort order:**
- `RETURN`, `SHARPE` → descending (higher = better)
- `VOL` → descending (higher vol listed first — ใช้ filter หุ้นที่ volatile)
- `DRAWDOWN` → ascending (น้อยที่สุด = drawdown น้อยสุด = listed first)

**Output:**
```
RANK by SHARPE  [1y]
#  SYMBOL  RETURN    VOL      SHARPE  DRAWDOWN
1  NVDA    +184.32%  +36.77%  2.43    -21.43%
2  AAPL    +28.41%   +24.82%  1.12    -12.18%
3  MSFT    +22.14%   +22.31%  0.98    -14.62%
4  TSLA    -8.32%    +61.24%  -0.23   -43.21%
```

**ตัวอย่าง:**
```
rank(AAPL, MSFT, NVDA, TSLA, SHARPE, 1y)   → by Sharpe
rank(AAPL, MSFT, NVDA, TSLA, VOL, 1y)      → by volatility
rank(AAPL, MSFT, NVDA, RETURN, 6m)         → by 6-month return
rank(AAPL, MSFT, NVDA, DRAWDOWN)           → by lowest drawdown
```

---

## stat — Full Statistical Profile

**Syntax:**
```
stat(SYMBOL)
stat(SYMBOL, period)
stats(SYMBOL, period)     ← alias
```

Default period: `1y`

รวมสถิติทั้งหมดของหุ้นตัวเดียวในคำสั่งเดียว แบ่งเป็น 3 กลุ่ม

### กลุ่มที่ 1 — Descriptive (คำนวณบน log returns)

| Metric | ความหมาย |
|--------|---------|
| Observations | จำนวน return ที่ใช้ (n) |
| Mean daily / annual | ผลตอบแทนเฉลี่ย (annual = daily × 252) |
| Std dev daily | ส่วนเบี่ยงเบนมาตรฐานรายวัน |
| Volatility (ann) | daily σ × √252 |
| Skewness | ความเบ้ — ติดลบ = หางซ้ายยาว (เสี่ยงร่วงแรง) |
| Excess kurtosis | ความโด่งส่วนเกินเทียบ normal — > 1 = fat tails |
| Min / Max | return วันที่แย่สุด / ดีสุด |
| P25 / Median / P75 | ควอร์ไทล์ |

### กลุ่มที่ 2 — Risk

| Metric | สูตร / ความหมาย |
|--------|----------------|
| VaR 95% | percentile ที่ 5 ของ return (historical, ไม่ใช่ parametric) |
| CVaR 95% | ค่าเฉลี่ยของ return ที่แย่กว่า VaR — Expected Shortfall |
| Max drawdown | peak-to-trough สูงสุด พร้อมวันที่ trough |
| Sharpe (ann) | `(annual_return − rf) / annual_vol`, rf = 4.3% |
| Sortino (ann) | เหมือน Sharpe แต่หารด้วย downside deviation |
| Downside dev | σ ของเฉพาะ return ที่ต่ำกว่า rf (annualised) |

### กลุ่มที่ 3 — Diagnostic Tests

ทดสอบสมมติฐานทางสถิติที่ metric อื่นๆ พึ่งพาอยู่ **รันบน return series ไม่ใช่ price levels**

| Test | ทดสอบอะไร | อ่านผลยังไง |
|------|-----------|------------|
| **Jarque-Bera** | return แจกแจงแบบ normal ไหม | `NON-NORMAL` = ไม่ปกติ (พบเกือบทุกหุ้น) → VaR แบบ parametric จะประเมินความเสี่ยงต่ำเกินจริง |
| **ADF** | series stationary ไหม | `STATIONARY` = ผ่าน ใช้ correlation/regression ได้ตามปกติ `NON-STATIONARY` = ระวัง spurious correlation |
| **Ljung-Box** | มี autocorrelation ไหม (lag 1-10) | `AUTOCORRELATED` = return วันนี้ทำนายจากเมื่อวานได้บางส่วน → ขัดกับ random walk |
| **ARCH-LM** | มี volatility clustering ไหม | `VOL CLUSTERING` = ความผันผวนเกาะกลุ่ม → correlation ที่วัดช่วงตลาดผันผวนจะสูงเกินจริง |

**หมายเหตุ:** diagnostic tests จะถูกข้ามถ้า n < 30 (แสดง `n/a` พร้อมเหตุผล) เพราะผลจากตัวอย่างเล็กไม่มีความหมาย

**Output:**
```
STAT  AAPL  [1y]   2025-07-29 → 2026-07-28   last=245.12  ret=+18.34%
METRIC              VALUE           NOTE
── DESCRIPTIVE (log returns) ──
Observations        250
Mean (daily)        +0.07%
Volatility (ann)    +24.79%
Skewness            0.012           symmetric
Excess kurtosis     1.970           fat tails vs normal
── RISK ──
VaR 95% (daily)     -2.05%          worst 5% threshold
CVaR 95% (daily)    -3.28%          mean loss beyond VaR
Max drawdown        -13.80%         2026-04-07
Sharpe (ann)        1.778
── DIAGNOSTICS (on returns) ──
Jarque-Bera         NON-NORMAL      JB=37.9 p=0.0000 — normality
ADF                 STATIONARY (1%) t=-14.851 lag=0 crit5%=-2.873 — stationarity
Ljung-Box           NO AUTOCORR     Q=6.8 p=0.7431 lags=10 — autocorrelation
ARCH-LM             HOMOSKEDASTIC   LM=11.3 p=0.3320 lags=10 — vol clustering
```

**ตัวอย่าง:**
```
stat(AAPL)              → สถิติเต็ม 1 ปี (default)
stat(^GSPC, 5y)         → S&P 500 5 ปี — จะเห็น VOL CLUSTERING ชัด
stat(BTC-USD, 6m)       → Bitcoin — excess kurtosis สูงมาก
stat(SCB.BK, 2y)        → หุ้นไทย
```

**การนำไปใช้กับ corr():**
รัน `stat()` กับทั้งสอง symbol ก่อนเชื่อผลจาก `corr()` — ถ้าตัวใดตัวหนึ่งขึ้น `NON-STATIONARY` หรือ `VOL CLUSTERING` ค่า correlation ที่ได้อาจไม่เสถียรและสูงเกินจริง

**หมายเหตุเชิงเทคนิค:** ADF / Ljung-Box / ARCH-LM เขียนเองด้วย numpy + scipy (backend ไม่มี `statsmodels` เป็น dependency) โดยผ่านการ validate เทียบกับ `statsmodels` แล้วว่าให้ผลตรงกันทุกตำแหน่งทศนิยมที่แสดง ทั้งบนข้อมูลสังเคราะห์และข้อมูลตลาดจริง

---

## ข้อจำกัด

| ประเด็น | รายละเอียด |
|---------|-----------|
| Data source | yfinance daily adjusted closes เท่านั้น |
| ADF ใช้ constant ไม่มี trend | เหมาะกับ return; ถ้าเอาไปใช้กับ price levels ควรใช้ trend spec |
| Diagnostic ต้องการ n ≥ 30 | period สั้น (`5d`, `1m`) จะไม่แสดงผลทดสอบ |
| ไม่มี intraday | vol/RSI ใช้ end-of-day — ไม่ใช่ tick data |
| Risk-free rate | hardcode 4.3% — ไม่ใช่ live T-bill rate |
| Sharpe ลำเอียงกับ period สั้น | น้อยกว่า 60 วัน — ตีความระวัง |
| yfinance rate limit | หลาย request พร้อมกัน อาจช้า — cache 5 นาที |
| Symbol SET | ใช้ suffix `.BK` เช่น `SCB.BK`, `^SET.BK` |
