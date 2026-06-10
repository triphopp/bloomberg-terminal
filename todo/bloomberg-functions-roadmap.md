# Bloomberg Terminal Functions Roadmap

> Reference: [@hamptonism — Guide to the Bloomberg Terminal](https://x.com/hamptonism/status/2013511432823021925)
> Bloomberg Terminal has 15,000+ functions, average user uses only 29.

---

## Status Legend

| Icon | Meaning |
|------|---------|
| Done | มีในแอปแล้ว |
| Upgrade | มีแล้วแต่ยังปรับปรุงได้ |
| Ready | ข้อมูลพร้อม สามารถทำได้ทันที |
| Plan | ต้องเพิ่ม data source / API ใหม่ |
| Skip | ไม่เกี่ยวข้องกับเป้าหมายแอป |

---

## 1. Market Data & Monitoring

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `GMM <GO>` | Global Market Monitor — real-time overview ทุก asset class | **Done** | Heatmap View แสดง Americas/EMEA/Asia Pacific + Key Indicators (VIX, DXY, US10Y, GOLD, WTI, BTC) |
| `IMAP <GO>` | Intraday Market Map — heatmap แสดง performance แต่ละ sector | **Upgrade** | มี heatmap แล้วแต่เป็น index-level; เพิ่ม sector/industry breakdown treemap ได้ |
| `TOP <GO>` | Top News Headlines | **Done** | News View มีอยู่แล้ว + RSS feeds |
| `WEI <GO>` | World Equity Indices | **Done** | Heatmap View tick data table |

### สิ่งที่ทำเพิ่มได้
- **Sector Treemap**: เพิ่ม treemap แบบ finviz-style ที่แสดง sector → industry → stock performance
  - Data: ใช้ Yahoo Finance sector data ผ่าน backend
  - Priority: Medium
  - Complexity: Medium (ใช้ recharts Treemap หรือ d3)

---

## 2. Equity Analysis

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `DES <GO>` | Company Description — overview, financials, contacts | **Upgrade** | Stock View มี quote data; เพิ่ม company profile/description ได้จาก Yahoo Finance API (`/stock/{symbol}/profile`) |
| `FA <GO>` | Financial Analysis — SEC filings, normalized statements, ratios (EV/EBITDA etc.) | **Ready** | Backend มี `/stock/{symbol}/financials` อยู่แล้ว; สร้าง UI สำหรับ Income Statement / Balance Sheet / Cash Flow |
| `GP <GO>` | Price Charts + Technical Indicators (RSI, MACD, EMA) | **Upgrade** | มี chart ใน Heatmap View + Stock View; เพิ่ม technical indicators ได้ (อยู่ใน todo.md เดิม) |
| `RV <GO>` | Relative Valuation — peer comparison | **Ready** | ใช้ Yahoo Finance peer data; สร้าง comparison table (P/E, EV/EBITDA, P/S, ROE) ของ peers |
| `EE <GO>` | Earnings Estimates — consensus forecasts | **Ready** | Yahoo Finance มี earnings estimates data; สร้าง earnings calendar + estimates table |
| `ANR <GO>` | Analyst Recommendations — buy/hold/sell ratings | **Ready** | Yahoo Finance มี analyst data (`/stock/{symbol}/analysis`); สร้าง rating summary + price target chart |
| `WACC <GO>` | Weighted Average Cost of Capital | **Plan** | ต้องคำนวณจาก risk-free rate + beta + market premium + debt ratio; ข้อมูลส่วนใหญ่มีใน Yahoo Finance |

### สิ่งที่ทำเพิ่มได้
- **FA Financial Analysis View**: Tab ใน Stock View แสดง Income/Balance/CashFlow statements แบบ table
  - Data: `/stock/{symbol}/financials` (มีอยู่แล้วใน backend)
  - Priority: **High** — เป็น core function
  - Complexity: Medium

- **ANR Analyst Recommendations**: Panel ใน Stock View แสดง buy/hold/sell distribution + price targets
  - Data: Yahoo Finance analysis endpoint
  - Priority: **High**
  - Complexity: Low

- **RV Peer Comparison**: Table เปรียบเทียบ valuation metrics ของ peers
  - Data: Yahoo Finance similar stocks
  - Priority: Medium
  - Complexity: Medium

- **EE Earnings Calendar**: แสดง upcoming/past earnings + EPS estimates vs actual
  - Data: Yahoo Finance earnings data
  - Priority: Medium
  - Complexity: Low-Medium

---

## 3. Portfolio & Risk Management

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `PORT <GO>` | Portfolio Analytics — VaR, Monte Carlo, stress testing | **Upgrade** | Portfolio View มีอยู่แล้ว; เพิ่ม VaR calculation, correlation matrix, risk metrics ได้ |
| `BTST <GO>` | Backtesting — strategy simulation | **Plan** | ต้องมี historical data + strategy engine; อยู่ใน Killer Features (Strategy-as-Code) |

### สิ่งที่ทำเพิ่มได้
- **Portfolio Risk Metrics**: เพิ่มใน Portfolio View — Sharpe ratio, max drawdown, VaR (historical), correlation heatmap
  - Data: คำนวณจาก historical prices ที่มีอยู่
  - Priority: **High** — อยู่ใน todo เดิม
  - Complexity: Medium-High

- **Monte Carlo Simulation**: แสดง probability cone ของ portfolio value
  - Data: คำนวณ client-side หรือ backend
  - Priority: Medium
  - Complexity: High

---

## 4. Screening & Search

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `EQS <GO>` | Equity Screening — SQL-like queries (P/E < 15 AND ROE > 20%) | **Ready** | สร้าง screener UI ที่ filter ด้วย fundamental metrics; ใช้ Yahoo Finance screener API |

### สิ่งที่ทำเพิ่มได้
- **Equity Screener View**: หน้าใหม่สำหรับ filter หุ้นตาม criteria (Market Cap, P/E, Dividend, Sector, etc.)
  - Data: Yahoo Finance screener endpoint หรือ batch query
  - Priority: **High** — เป็นฟีเจอร์ที่ผู้ใช้ต้องการมาก
  - Complexity: Medium
  - Implementation: เพิ่ม view ใหม่ `screener-view.tsx` + backend endpoint `/screener`

---

## 5. Fixed Income & Macro

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `SOVM <GO>` | Sovereign Debt Monitor — yield curves, CDS spreads, credit ratings | **Upgrade** | Credit View มีอยู่แล้ว; เพิ่ม yield curve chart, CDS data, country comparison |
| `CRPR <GO>` | Credit Ratings | **Upgrade** | อยู่ใน Credit View; เพิ่ม rating history timeline |

### สิ่งที่ทำเพิ่มได้
- **Enhanced Credit View**: เพิ่ม interactive yield curve, sovereign CDS spreads, rating comparison table
  - Data: FRED API สำหรับ yield curves (มี endpoint อยู่), เพิ่ม CDS data source
  - Priority: Medium
  - Complexity: Medium

---

## 6. Volatility & Options

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `OVDV <GO>` | Volatility Surface — 3D implied vol by strike & maturity, skew/smile analysis | **Upgrade** | Volatility View มีอยู่แล้ว; เพิ่ม 3D surface plot, skew chart, term structure |

### สิ่งที่ทำเพิ่มได้
- **3D Volatility Surface**: แสดง implied vol surface (strike x maturity x IV)
  - Data: Options chain data จาก Yahoo Finance
  - Priority: Medium
  - Complexity: High (ต้องใช้ 3D chart library)

- **Options Chain View**: แสดง call/put chain, Greeks, open interest
  - Data: Yahoo Finance options endpoint
  - Priority: Medium
  - Complexity: Medium

---

## 7. Supply Chain & Relationships

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `SPLC <GO>` | Supply Chain Analysis — suppliers, customers, competitors, revenue exposure | **Plan** | ต้อง data source ใหม่; Yahoo Finance มี limited peer data |

### สิ่งที่ทำเพิ่มได้
- **Supply Chain Panel**: แสดงใน Stock View — top suppliers, customers, competitors
  - Data: Limited — Yahoo Finance มี peer list แต่ไม่มี supply chain detail
  - Priority: Low (data limitation)
  - Complexity: Low (ถ้ามี data)

---

## 8. Prediction Markets

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `WSL PREDICT <GO>` | Prediction Market Data — implied probabilities on events | **Plan** | ต้อง API จาก prediction market platforms (Polymarket, Kalshi, etc.) |

### สิ่งที่ทำเพิ่มได้
- **Prediction Markets View**: แสดง implied probabilities จาก prediction markets
  - Data: Polymarket API (free), Kalshi API
  - Priority: Medium — น่าสนใจและเป็น unique feature
  - Complexity: Medium (API integration + UI)

---

## 9. Lifestyle / Social (Skip)

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| `DINE <GO>` | Restaurant Reviews | **Skip** | ไม่เกี่ยวข้อง |
| `POSH <GO>` | Luxury Marketplace | **Skip** | ไม่เกี่ยวข้อง |

---

## 10. Keyboard & UX

| Bloomberg Cmd | Feature | Status | Notes |
|---|---|---|---|
| Color-coded keys | Yellow (sector), Green (action), Red (control) | **Done** | มี keyboard shortcuts + ShortcutsHelp + Global Search (`/` or `Ctrl+K`) |
| `<GO>` command | Execute command | **Upgrade** | Global Search รองรับ command-style input; เพิ่ม Bloomberg-style command parser ได้ |
| Multi-panel workspace | 4 panels พร้อมกัน | **Upgrade** | Heatmap View มี 3-panel customizable; เพิ่ม multi-view workspace ได้ |

### สิ่งที่ทำเพิ่มได้
- **Bloomberg Command Parser**: พิมพ์ `AAPL EE <GO>` ใน search bar → ไปหน้า Stock View + Earnings tab ของ AAPL
  - Priority: **High** — เป็น signature UX ของ Bloomberg
  - Complexity: Medium (parse command → route to view)

- **Multi-View Workspace**: แบ่งหน้าจอเป็น 2-4 panels แสดง views ต่างกัน
  - Priority: Low-Medium
  - Complexity: High

---

## Priority Ranking (Top 10 ที่ควรทำก่อน)

| # | Feature | Bloomberg Cmd | Effort | Impact |
|---|---|---|---|---|
| 1 | Bloomberg Command Parser (`SYMBOL CMD <GO>`) | `<GO>` | Medium | Very High — UX signature |
| 2 | Financial Analysis (Income/Balance/CashFlow) | `FA` | Medium | Very High — core function |
| 3 | Analyst Recommendations + Price Targets | `ANR` | Low | High — ข้อมูลพร้อมใช้ |
| 4 | Equity Screener | `EQS` | Medium | High — ฟีเจอร์ที่ขาด |
| 5 | Earnings Estimates + Calendar | `EE` | Low-Med | High — ข้อมูลพร้อมใช้ |
| 6 | Peer Comparison / Relative Valuation | `RV` | Medium | High — competitive analysis |
| 7 | Sector Treemap (finviz-style) | `IMAP` | Medium | Medium-High — visual impact |
| 8 | Portfolio Risk Metrics (VaR, Sharpe, Drawdown) | `PORT` | Med-High | High — risk management |
| 9 | Enhanced Volatility (3D surface, options chain) | `OVDV` | High | Medium — advanced users |
| 10 | Prediction Markets | `WSL PREDICT` | Medium | Medium — unique differentiator |

---

## ฟีเจอร์ที่มีอยู่แล้วและ map กับ Bloomberg

| Our Feature | Bloomberg Equivalent | Status |
|---|---|---|
| Heatmap View (indices + chart + tick data) | `GMM` + `IMAP` + `GP` | Done |
| Stock View (quote, chart, financials) | `DES` + `GP` | Done |
| News View | `TOP` | Done |
| Market Movers | `MMAP` | Done |
| Volatility View | `OVDV` (partial) | Done |
| Credit View | `CRPR` + `SOVM` (partial) | Done |
| Macro View (US indicators) | `ECST` | Done |
| Portfolio View | `PORT` (partial) | Done |
| PIN Asset (watchlist) | `MOST` / custom monitors | Done |
| Clippings (research notes) | `BIO` / `READ` | Done |
| Keyboard Shortcuts | Color-coded keys | Done |
| Global Search | `<GO>` command | Done |
