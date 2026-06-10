# Data Catalog — Bloomberg Terminal

> ไฟล์นี้สรุปข้อมูลทุกหมวดที่ระบบดึงได้ เพื่อใช้วางแผน Data Analysis
> แต่ละหมวดระบุ: endpoint · fields · granularity · ความถี่ · ข้อจำกัด

---

## หมวดที่ 1 — Global Market Indices

**Endpoint:** `GET /api/market-data`
**Source:** yfinance
**Cache:** 60s

| Field | Type | ตัวอย่าง |
|-------|------|---------|
| symbol | string | `^GSPC`, `^N225` |
| name | string | `S&P 500` |
| price | float | `5234.18` |
| change | float | `+12.3` |
| pctChange | float | `+0.24` |
| ytd | float | `+8.4` |
| region | string | `Americas` / `EMEA` / `Asia` |

**ครอบคลุม 19 indices:**
- Americas: S&P500, NASDAQ, DOW, Russell 2000, TSX, Bovespa, MXX
- EMEA: FTSE, DAX, CAC40, AEX, SMI, IBEX, FTSEMIB, SET (ไทย)
- Asia: Nikkei, Hang Seng, SSE, KOSPI, ASX

---

## หมวดที่ 2 — Sector & Asset Heatmap

**Endpoint:** `GET /api/heatmap?group={group}`
**Source:** yfinance (ETFs + futures)
**Cache:** 60s

**Groups ที่มี:**

| group | สิ่งที่อยู่ใน tiles |
|-------|-------------------|
| `sectors` | 11 US sectors (XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLB, XLU, XLRE, XLC) |
| `commodities` | Gold, Silver, Oil (WTI/Brent), NatGas, Copper, Wheat, Corn, Soybeans |
| `bonds` | US 2Y/10Y/30Y yield, TIP, HYG, LQD, AGG |
| `indicators` | VIX, Dollar Index (DXY), Bitcoin, Gold/USD ratio |

**Fields per tile:**
```
id, name, price, pctChange, ytd, size (market cap weight)
```

---

## หมวดที่ 3 — Individual Stock Data

**Source:** yfinance
**Cache:** quote 60s · history 5min · financials 1hr

### 3a. Quote (Real-time)
**Endpoint:** `GET /api/stock/quote/{symbol}`
```
price, open, high, low, close, volume, marketCap,
pctChange, pe, eps, dividendYield, 52wHigh, 52wLow,
shortName, sector, industry, country
```

### 3b. OHLCV History
**Endpoint:** `GET /api/stock/history/{symbol}?period={period}`
**Periods:** `1d` · `1w` · `1m` · `3m` · `ytd` · `1y` · `5y`
```
date, open, high, low, close, volume
```

### 3c. Financials
**Endpoint:** `GET /api/stock/financials/{symbol}`
```
Income Statement: revenue, grossProfit, operatingIncome, netIncome, ebitda
Cash Flow: operatingCF, capex, freeCashFlow
(quarterly + annual, ~4-8 periods)
```

### 3d. Analyst Ratings
**Endpoint:** `GET /api/stock/analyst/{symbol}`
```
strongBuy, buy, hold, sell, strongSell counts
targetPriceMean, targetPriceHigh, targetPriceLow
```

### 3e. S&P 500 Screener
**Endpoint:** `GET /api/screener/sp500`
```
symbol, name, sector, price, pctChange, ytd,
marketCap, pe, forwardPE, dividendYield
(~500 stocks)
```

---

## หมวดที่ 4 — Options Market

**Source:** yfinance
**Cache:** realtime

### 4a. Options Chain
**Endpoint:** `GET /api/options?symbol={symbol}&expiry={date}`
```
strike, expiry, type (call/put),
lastPrice, bid, ask, volume, openInterest,
impliedVolatility, delta, gamma, theta, vega (ถ้ามี)
```

### 4b. IV Surface
**Endpoint:** `GET /api/options/surface?symbol={symbol}`
```
strike, expiry, impliedVolatility
(matrix: strikes × expiry dates)
```

---

## หมวดที่ 5 — FX (Forex)

**Source:** yfinance
**Cache:** 60s

### 5a. Overview 20 pairs
**Endpoint:** `GET /api/fx`
```
symbol (e.g. EURUSD=X), rate, change, pctChange, ytd
```
**Pairs:** EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD, USD/CNY, USD/THB, USD/SGD, USD/KRW, USD/INR, USD/BRL, USD/MXN, USD/ZAR, USD/TRY, USD/RUB, EUR/GBP, EUR/JPY, GBP/JPY

### 5b. FX History
**Endpoint:** `GET /api/fx/history/{symbol}?period={period}`
```
date, open, high, low, close, volume
```

---

## หมวดที่ 6 — Cryptocurrency

**Source:** yfinance + Binance
**Cache:** overview 60s

### 6a. Overview 20 coins
**Endpoint:** `GET /api/crypto`
```
symbol, name, price, change, pctChange, ytd,
marketCap, volume24h
```
**Coins:** BTC, ETH, BNB, XRP, ADA, SOL, DOT, DOGE, AVAX, MATIC, LINK, UNI, LTC, BCH, XLM, ATOM, ALGO, VET, FIL, TRX

### 6b. Crypto History
**Endpoint:** `GET /api/crypto/history/{symbol}?period={period}`
```
date, open, high, low, close, volume
```

### 6c. Order Footprint (Binance)
**Endpoint:** `GET /api/crypto/footprint?symbol={symbol}&interval={tf}`
```
timestamp, price_level, buy_volume, sell_volume,
delta (buy-sell), candle_open, candle_close
```
> ข้อมูล microstructure — ใช้วิเคราะห์ buy/sell pressure รายราคา

---

## หมวดที่ 7 — Macro Economics (FRED)

**Source:** FRED API + Alpha Vantage (fallback)
**Cache:** 5min mem + disk (1d–30d TTL ตาม release frequency)

**Endpoint:** `GET /api/macro`

**Series ที่ดึงได้ (เลือกได้):**

| หมวด | Series | Frequency |
|------|--------|-----------|
| Growth | Real GDP, GDP Growth Rate | Quarterly |
| Inflation | CPI YoY, Core CPI, PCE, PPI | Monthly |
| Labor | Unemployment Rate, Non-Farm Payrolls, Job Openings | Monthly |
| Rates | Fed Funds Rate, 2Y/10Y/30Y Treasury Yield | Daily/Monthly |
| Yield Curve | 10Y-2Y Spread, 10Y-3M Spread | Daily |
| Money Supply | M2, M1 | Monthly |
| Housing | Housing Starts, Existing Home Sales | Monthly |
| Leading | PMI Manufacturing, PMI Services, Consumer Sentiment | Monthly |
| Trade | Trade Balance, Current Account | Monthly/Quarterly |

**Fields per series:**
```
date, value, series_id, name, units, frequency
```

---

## หมวดที่ 8 — Credit & Stress Indicators

**Source:** FRED API
**Cache:** 5min
**Endpoint:** `GET /api/crisis`

**Output:** `crisis_level` (0–3) + raw signal values

| Indicator | ความหมาย |
|-----------|---------|
| HY Spread (ICE BofA) | High Yield bond spread vs Treasury |
| IG Spread | Investment Grade spread |
| VIX | Equity volatility fear gauge |
| 10Y-2Y Yield Curve | Recession signal (negative = inversion) |
| TED Spread | Interbank vs T-Bill (bank stress) |
| MOVE Index | Bond market volatility |
| Financial Conditions Index | Chicago Fed FCI |

**Fields:** `date, value, signal_name, crisis_contribution`

---

## หมวดที่ 9 — Sovereign / Country Data (World Bank)

**Source:** World Bank Development Indicators
**Cache:** disk (persistent)
**Endpoints:** `GET /api/sovereign/list` · `GET /api/sovereign/{country_code}`

**Indicators per country:**

| หมวด | Indicators |
|------|-----------|
| Growth | GDP (current USD), GDP Growth %, GDP per Capita |
| Inflation | CPI Inflation %, PPI |
| Fiscal | Govt Debt % GDP, Budget Balance % GDP |
| External | Current Account % GDP, FX Reserves |
| Labor | Unemployment %, Labor Force Participation |
| Social | Population, Gini Coefficient, Human Development |
| Trade | Exports/Imports % GDP, Trade Balance |

**Granularity:** Annual (World Bank release)
**Countries tracked:** ~20-30 major economies

---

## หมวดที่ 10 — Central Banks

**Source:** ECB, BOE, BOC, Norges Bank, Bundesbank, SNB, BOJ, SARB, CBR, RBA, Eurostat (scraped/API)
**Cache:** 5min mem + 4hr disk
**Endpoints:** `/api/central-banks/*`

| Data | Endpoint | Fields |
|------|----------|--------|
| Policy Rates (all banks) | `/api/central-banks/rates` | bank_id, rate, date, next_meeting |
| ECB HICP (Euro CPI) | `/api/central-banks/ecb/hicp` | date, value, country |
| ECB Yield Curve | `/api/central-banks/ecb/yield-curve` | maturity, rate, date |
| Bundesbank CPI | `/api/central-banks/bundesbank/inflation` | date, value |
| EU Energy Prices | `/api/central-banks/eurostat/energy-prices` | date, country, price_per_kwh |
| EU Renewable Share | `/api/central-banks/eurostat/renewables` | date, country, share_pct |

**Banks:** ECB · BOE · BOC · Norges · SNB · BOJ · SARB · CBR · RBA

---

## หมวดที่ 11 — Bank of Thailand (BOT)

**Source:** BOT API (IBM API Connect)
**Cache:** 5min mem + 1-4hr disk

### 11a. Bond Auction Results
**Endpoint:** `GET /api/bot/auctions?start_period=&end_period=`
> ⚠️ max 31 วันต่อ request
```
auction_date, instrument_type (Govt Bond/T-Bill/BOT Bond),
series, coupon_rate, avg_yield, bid_cover_ratio, offered_amount
```

### 11b. Interest Rates
**Endpoint:** `GET /api/bot/rates?type={type}`

| type | ข้อมูล |
|------|--------|
| `policy` | Policy Rate + MPC decision text |
| `interbank` | O/N, T/N, Call rates: WAVG, min, max |
| `thb-implied` | THB Implied Rates ONSHORE/OFFSHORE หลาย tenors |
| `swap-point` | FX Swap Points bid/offer (1M, 3M, 6M) |

### 11c. Statistics (389 categories)
**Endpoint:** `GET /api/bot/statistics/*`
```
categories list, series within category,
observations (time series) with date + value
```
> ครอบคลุมข้อมูลเศรษฐกิจไทยเกือบทุกมิติ: Monetary (FM), Economic (EC), Price Statistics (PS)

---

## หมวดที่ 12 — Prediction Markets (Polymarket)

**Source:** Polymarket Gamma API (3,000 active markets)
**Cache:** signals 5min · pool 10min

**Endpoint:** `GET /api/polymarket/signals`

**Signal types:**

| type | ความหมาย | ตัวชี้วัด |
|------|---------|---------|
| `fed_rate` | Fed rate cut/hike probability | implied probability % |
| `inflation` | Inflation outlook | CPI target probability |
| `recession` | US recession probability | % within 12 months |
| `global_rates` | Global rate direction | ECB, BOE, BOJ outlook |
| `trade` | Trade war / tariff risk | policy probability |
| `economy` | Macro shock risk | soft/hard landing |
| `crypto` | Crypto regulatory/price | BTC price milestone |
| `election` | Election outcomes | candidate win probability |

**Fields:** `type, probability, market_title, volume_usd, liquidity, last_updated`

---

## หมวดที่ 13 — ETF Data

**Source:** yfinance
**Cache:** 1hr
**Endpoint:** `GET /api/etf/{symbol}`

```
info: name, category, totalAssets, expenseRatio, inceptionDate
holdings: [{symbol, name, holdingPercent}] (top ~25)
sectorWeights: [{sector, weight}]
countryWeights: [{country, weight}]
```

---

## หมวดที่ 14 — Portfolio (Personal)

**Source:** SQLite `portfolio.db`
**Endpoint:** `/api/portfolio/db/*`

```
transactions: symbol, type, shares, price, date, commission, notes
holdings (computed): symbol, avg_cost, shares, current_price,
                     market_value, unrealized_pnl, pnl_pct
backtest: cumulative returns vs benchmark (any symbol)
```

---

## หมวดที่ 15 — Watchlist / Pins

**Source:** SQLite
**Endpoint:** `/api/pins/*`

```
groups: name, color
assets: symbol, comment, buy_target, sell_target,
        price_at_pin, priority (1-3), tags[]
```

---

## หมวดที่ 16 — Research Notes (Obsidian)

**Source:** Markdown files บน Google Drive (G:)
**Endpoints:** `/api/clippings` · `/api/portfolio/theses` · `/api/portfolio/research`

```
clippings: filename, title, tags, source_url, created_at, content (full MD)
theses: filename, title, content (investment thesis documents)
sources: filename, title, content (research articles)
```
**AI processing:** Ollama SSE stream (summarize / translate / custom prompt)

---

## หมวดที่ 17 — News

**Source:** Facebook pages via RSSHub / Graph API
**Cache:** 5min
**Endpoint:** `GET /api/news/facebook`

```
page_name, post_text, post_url, published_at, likes, comments
```

---

## สรุปภาพรวม — Data Map สำหรับ Analysis

```
Bloomberg Terminal Data
│
├── PRICE DATA (Real-time / Historical)
│   ├── Equities       → หมวด 1 (indices), 3 (stocks), 13 (ETFs)
│   ├── Fixed Income   → หมวด 2 (bonds heatmap), 7 (yield curves), 11 (BOT bonds)
│   ├── FX             → หมวด 5, 11b (THB rates)
│   └── Crypto         → หมวด 6 (overview + footprint)
│
├── MACRO / FUNDAMENTAL
│   ├── US Macro       → หมวด 7 (FRED series)
│   ├── Global Macro   → หมวด 9 (World Bank sovereign)
│   ├── Central Banks  → หมวด 10 (policy rates + ECB data)
│   └── Thailand       → หมวด 11 (BOT — rates, auctions, 389 stat series)
│
├── RISK / SENTIMENT
│   ├── Stress signals → หมวด 8 (VIX, spreads, crisis level 0-3)
│   ├── Options IV     → หมวด 4 (surface, chain)
│   └── Market odds    → หมวด 12 (Polymarket probabilities)
│
├── MICROSTRUCTURE
│   └── Order flow     → หมวด 6c (Binance buy/sell volume per price level)
│
└── QUALITATIVE / ALTERNATIVE
    ├── Research notes → หมวด 16 (Obsidian MD files)
    ├── News           → หมวด 17 (Facebook posts)
    └── Portfolio      → หมวด 14, 15 (personal positions + watchlist)
```

---

## ข้อจำกัดที่ต้องรู้ก่อนทำ Analysis

| ข้อจำกัด | หมวดที่กระทบ |
|---------|------------|
| yfinance ข้อมูลบาง field เป็น `null` สำหรับหุ้นนอก US | 3, 6, 13 |
| FRED ต้องการ API key — ไม่มีแล้วได้ empty | 7, 8 |
| BOT max 31 วันต่อ request | 11a |
| BOT FX (Stat-ExchangeRate) ยัง 403 | 11 |
| Polymarket cold start ~15s | 12 |
| World Bank ข้อมูลล่าช้า 1-2 ปี (annual release) | 9 |
| Binance footprint เป็น tick data — ขนาดใหญ่ | 6c |
| Obsidian files อยู่บน Google Drive G: — ต้อง mount | 16 |
