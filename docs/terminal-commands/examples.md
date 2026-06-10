# Terminal Command Examples — Use Cases & Recipes

เปิด terminal: กด `/` หรือ `Ctrl+K` จาก view ใดก็ได้

---

## Quick Reference Card

```
/ → เปิด terminal
Tab → autocomplete
Enter → execute
Esc → ปิด
```

---

## 1. Portfolio Risk Check

เช็ค drawdown + vol ของหุ้น portfolio ก่อนตัดสินใจ

```bash
# เช็ค max drawdown แต่ละตัว
drawdown(AAPL, 1y)
drawdown(NVDA, 1y)
drawdown(TSLA, 1y)

# หรือดูพร้อมกันด้วย compare
compare(AAPL, NVDA, TSLA, MSFT, 1y)
```

Output `compare`:
```
COMPARE  [1y]
SYMBOL  RETURN    VOL      SHARPE  DRAWDOWN
NVDA    +184.32%  +36.77%  2.43    -21.43%
AAPL    +28.41%   +24.82%  1.12    -12.18%
MSFT    +22.14%   +22.31%  0.98    -14.62%
TSLA    -8.32%    +61.24%  -0.23   -43.21%
```

---

## 2. Diversification Check

วัดว่า 2 หุ้นในพอร์ตเคลื่อนไหวพร้อมกันแค่ไหน

```bash
# Thai banks — ควร corr สูง (same sector)
corr(SCB.BK, KBANK.BK, 1y)

# Gold vs Tech — ควร corr ต่ำหรือลบ (hedge)
corr(GLD, QQQ, 1y)

# SET vs S&P — global correlation
corr(^SET.BK, ^GSPC, 3y)

# Bitcoin vs Gold — inflation hedge correlation
corr(BTC-USD, GLD, 1y)
```

ถ้า `r > 0.8` → ถือ 2 ตัวไม่ diversify จริง

---

## 3. Benchmark Beta

รู้ว่าหุ้นที่ถือ aggressive/defensive แค่ไหนเทียบ benchmark

```bash
# NVDA vs S&P (default benchmark)
beta(NVDA)

# Thai stock vs SET
beta(SCB.BK, ^SET.BK, 1y)

# Gold — ควร beta ต่ำ/ลบ
beta(GLD, ^GSPC, 5y)

# ถ้าอยาก beta ต่ำกว่า 1 ทั้งพอร์ต
rank(AAPL, MSFT, GLD, XLU, ^GSPC, VOL, 1y)
```

---

## 4. Mean-Reversion Signal (Z-Score)

หาหุ้นที่ราคาเบี่ยงจาก historical mean มาก

```bash
# Z-score สูง = overbought zone
zscore(NVDA, 1y)
zscore(BTC-USD, 1y)

# Z-score ต่ำ = oversold zone (possible entry)
zscore(^SET.BK, 2y)
zscore(GLD, 2y)
```

Rule of thumb:
- `z > 2` → extended, ระวัง
- `z < -2` → depressed, อาจ opportunity

---

## 5. Momentum Filter (RSI)

กรอง overbought/oversold ก่อน entry

```bash
# Default RSI(14)
rsi(AAPL)
rsi(BTC-USD)

# Longer window = smoother signal
rsi(^SET.BK, 21)

# Combine: RSI oversold + z-score low = stronger signal
rsi(GLD)
zscore(GLD, 1y)
```

---

## 6. Risk-Adjusted Performance Ranking

Rank กองทุน/ETF ด้วย Sharpe แทน return ล้วนๆ

```bash
# US sector ETFs — by Sharpe
rank(XLK, XLF, XLE, XLV, XLI, SHARPE, 1y)

# Thai vs Global
rank(^SET.BK, ^GSPC, ^N225, EEM, SHARPE, 3y)

# Crypto comparison
rank(BTC-USD, ETH-USD, SOL-USD, RETURN, 1y)

# Bond vs equity tradeoff
rank(SPY, AGG, GLD, TLT, SHARPE, 5y)
```

---

## 7. Cross-Market Analysis

เปรียบเทียบตลาดหลักทั่วโลก

```bash
# Global indices 6 เดือน
compare(^GSPC, ^N225, ^FTSE, ^SET.BK, ^HSI, 6m)

# Asian markets
compare(^SET.BK, ^HSI, ^KS11, ^STI, 1y)

# EM vs DM
compare(EEM, SPY, VEA, 3y)
```

---

## 8. Sector Rotation Research

ดูว่า sector ไหน outperform ในช่วงนี้

```bash
# US sector ETFs — 3 เดือน
rank(XLK, XLF, XLE, XLV, XLI, XLC, XLY, RETURN, 3m)

# โยก view ไป MACRO เพื่อดู regime
MACRO

# กลับมาเช็ค vol ของ sector
rank(XLK, XLF, XLE, XLV, VOL, 3m)
```

---

## 9. Pre-Trade Checklist

Workflow ก่อนซื้อหุ้นตัวใหม่

```bash
# 1. Return ย้อนหลัง
return(SYMBOL, 1y)

# 2. Vol เทียบ benchmark
vol(SYMBOL, 1y)
vol(^GSPC, 1y)

# 3. Beta
beta(SYMBOL)

# 4. Max drawdown
drawdown(SYMBOL, 2y)

# 5. RSI momentum
rsi(SYMBOL)

# 6. Z-score
zscore(SYMBOL, 1y)

# 7. Correlation กับที่ถืออยู่แล้ว
corr(SYMBOL, EXISTING_HOLDING, 1y)
```

---

## 10. Navigation Shortcuts

```bash
# เปลี่ยน view เร็ว
MKT     → market chart + watchlist
NEWS    → news + social feed
PORT    → portfolio tracker
CRYP    → crypto prices
FX      → forex pairs
MACRO   → macro dashboard

# Settings
ALERT OFF    → ปิด ticker ที่กวนใจ
DARK         → dark mode
LIGHT        → light mode

# Info
REGIME  → market regime summary
PING    → backend health check
HELP    → command list ทั้งหมด
```

---

## 11. Tab Completion Flow

```
cor[Tab] → corr(
corr([Tab] → hint: <A>  (required symbol)
corr(AAPL,[Tab] → hint: <B>  (required symbol)
corr(AAPL,MSFT,[Tab] → period choices: 1m, 3m, 6m...
corr(AAPL,MSFT, 3m[Tab] → corr(AAPL,MSFT, 3m)
[Enter] → execute
```

```
AL[Tab] → ALERT CLEAR
[Tab]   → ALERT OFF
[Tab]   → ALERT ON
[Enter] → execute
```

---

## 12. Error Messages

```bash
# Wrong function name
corel(AAPL, MSFT)
→ ERROR: Unknown function "COREL". Did you mean: corr?

# Too few args
corr(AAPL)
→ ERROR: corr requires 2 args (A, B). Usage: corr(A, B, period?)

# Too many args
vol(AAPL, MSFT, 1y)
→ ERROR: vol takes at most 2 args. Usage: vol(symbol, period?)

# Stock lookup fallback
AAPL → opens stock analysis view (9 tabs)
```

---

## Symbol Formats

| Asset type | Format | Example |
|-----------|--------|---------|
| US stock | TICKER | `AAPL`, `NVDA`, `TSLA` |
| Thai stock | TICKER.BK | `SCB.BK`, `KBANK.BK` |
| US index | ^SYMBOL | `^GSPC`, `^DJI`, `^VIX` |
| Thai index | ^SET.BK | `^SET.BK` |
| Japan index | ^N225 | `^N225` |
| Crypto | COIN-USD | `BTC-USD`, `ETH-USD` |
| Gold | GLD | ETF, หรือ `GC=F` futures |
| Forex | BASE/QUOTE | `EURUSD=X`, `THBUSD=X` |
| ETF | TICKER | `SPY`, `QQQ`, `AGG` |
