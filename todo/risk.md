# Credit Risk, CDS & Economic Crisis Data — Feature Spec

**Version:** 0.2.0  
**Status:** Draft  
**Module:** `data/credit-risk`

---

## 1. Overview

โมดูลนี้รับผิดชอบการดึง จัดเก็บ และแสดงผลข้อมูลความเสี่ยงด้านเครดิต ตราสารหนี้ CDS และตัวชี้วัดวิกฤตเศรษฐกิจ ครอบคลุมตั้งแต่ระดับประเทศ (Sovereign) ไปจนถึงระดับบริษัทรายตัว (Corporate) และบูรณาการเข้ากับ Macro View ที่มีอยู่เดิมใน Bloomberg Terminal

---

## 2. Scope

**In Scope**
- Sovereign default history & current risk indicators (เน้น EM + Thailand)
- Corporate default rates (S&P 500 focus)
- CDS spreads — Sovereign & Corporate
- Fixed income instruments & bond spreads
- Economic crisis early warning indicators
- Crisis alert system with severity classification

**Out of Scope**
- Equity derivatives
- Commodities
- Retail/consumer credit scoring

---

## 3. Data Domains

### 3.1 Sovereign Credit Risk

**Fields**

| Field | Type | Description |
|---|---|---|
| `country_code` | `string (ISO 3166)` | รหัสประเทศ |
| `cds_5y_spread` | `float (bps)` | CDS 5 ปี (basis points) |
| `sovereign_rating` | `string` | Consensus rating จาก Moody's / S&P / Fitch |
| `outlook` | `enum` | Stable / Positive / Negative / Watch |
| `debt_to_gdp` | `float (%)` | หนี้สาธารณะต่อ GDP |
| `external_debt_usd` | `float` | หนี้ต่างประเทศ (USD) |
| `default_history` | `boolean` | เคย default หรือไม่ |
| `last_default_year` | `int \| null` | ปีที่ default ล่าสุด |
| `implied_pd_1y` | `float (%)` | Probability of Default 1 ปี |

**Sources**

| Source | Endpoint / URL | ความถี่ | ฟรี? |
|---|---|---|---|
| World Bank API | `api.worldbank.org/v2/country` | Quarterly | ✅ |
| IMF WEO | `imf.org/en/Publications/WEO` | Semi-annual | ✅ |
| BIS Statistics | `stats.bis.org/api` | Quarterly | ✅ |
| Reinhart-Rogoff Dataset | Harvard Dataverse | Static | ✅ |
| worldgovernmentbonds.com | Scrape | Daily | ✅ |

**Thailand / EM Priority**  
ให้ coverage พิเศษสำหรับประเทศในกลุ่ม ASEAN+3 และ EM ที่นักลงทุนไทยให้ความสนใจ ได้แก่ `TH`, `ID`, `MY`, `VN`, `CN`, `IN`, `BR`, `TR`, `ZA` โดยแสดง CDS spread เทียบ US Treasuries เป็น baseline

---

### 3.2 Corporate Credit Risk

**Fields**

| Field | Type | Description |
|---|---|---|
| `ticker` | `string` | Ticker symbol |
| `credit_rating` | `string` | IG / HY rating |
| `rating_agency` | `enum` | Moodys / SP / Fitch |
| `bond_spread_oas` | `float (bps)` | Option-Adjusted Spread |
| `ytm` | `float (%)` | Yield to Maturity |
| `bankruptcy_status` | `boolean` | สถานะล้มละลาย |
| `bankruptcy_date` | `date \| null` | วันที่ยื่น bankruptcy |
| `chapter` | `enum \| null` | Chapter 7 / 11 (US) |
| `cds_spread` | `float (bps) \| null` | Corporate CDS |
| `altman_z_score` | `float \| null` | Altman Z-Score |

**Sources**

| Source | Endpoint / URL | ความถี่ | ฟรี? |
|---|---|---|---|
| FRED API | `fred.stlouisfed.org/graph/fredgraph` | Daily | ✅ |
| SEC EDGAR (8-K) | `efts.sec.gov/LATEST/search-index` | Real-time | ✅ |
| FINRA TRACE | `finra.org/finra-data/fixed-income` | Daily | ✅ |
| Moody's Default Study | PDF (Annual) | Yearly | ✅ |
| BankruptcyData.com | Scrape | Weekly | ✅ |

---

### 3.3 CDS Market

**Fields**

| Field | Type | Description |
|---|---|---|
| `entity_id` | `string` | Country code หรือ Ticker |
| `entity_type` | `enum` | `sovereign` / `corporate` |
| `tenor` | `enum` | 1Y / 2Y / 3Y / 5Y / 7Y / 10Y |
| `spread_bps` | `float` | CDS spread (basis points) |
| `currency` | `string` | USD / EUR |
| `restructuring` | `enum` | CR / MR / MM / XR |
| `implied_pd` | `float (%)` | Implied Probability of Default |
| `recovery_rate` | `float (%)` | Assumed recovery rate (default 40%) |

**Implied PD Formula**
```
Implied PD (1Y) = CDS Spread / (1 - Recovery Rate)

Example:
  CDS Spread    = 150 bps = 1.50%
  Recovery Rate = 40%
  Implied PD    = 1.50% / 0.60 = 2.50%
```

**Sources**

| Source | ข้อมูล | ฟรี? |
|---|---|---|
| DTCC Trade Repository | Aggregate CDS trade data | ✅ (Weekly) |
| worldgovernmentbonds.com | Sovereign CDS 5Y | ✅ (Scrape) |
| countryeconomy.com | Sovereign CDS Historical | ✅ (Scrape) |
| IHS Markit / S&P Global | Full CDS dataset | 💰 |

---

### 3.4 Bond Spreads & FRED Stress Series

**FRED Series ที่ดึง** — ครอบคลุมทั้ง Bond Spreads และ Crisis Early Warning

| FRED ID | คำอธิบาย | Category | Signal เมื่อ |
|---|---|---|---|
| `BAMLH0A0HYM2` | US High Yield OAS | Corporate Stress | > 500 bps |
| `BAMLC0A0CM` | US Investment Grade OAS | Corporate Stress | > 200 bps |
| `BAMLHE00EHY0D` | EM High Yield OAS | EM Stress | > 600 bps |
| `T10Y2Y` | 10Y–2Y Yield Spread | Recession Signal | < 0 (inversion) |
| `T10Y3M` | 10Y–3M Yield Spread | Recession Signal | < 0 (inversion) |
| `TEDRATE` | TED Spread | Banking Stress | > 100 bps |
| `STLFSI4` | St. Louis Financial Stress Index | System Stress | > 0 |
| `NFCI` | Chicago Fed Financial Conditions | System Stress | > 0 |
| `VIXCLS` | VIX Fear Index | Market Fear | > 30 |
| `T5YIE` | 5Y Breakeven Inflation | Inflation Expectation | — |
| `T10YIE` | 10Y Breakeven Inflation | Inflation Expectation | — |
| `MORTGAGE30US` | 30Y Mortgage Rate | Housing Stress | — |
| `DRCCLACBS` | Credit Card Delinquency | Consumer Stress | — |
| `DRSFRMACBS` | Mortgage Delinquency | Housing Stress | — |

**Per-Bond Fields** (สำหรับ bond-level detail)

| Field | Type | Description |
|---|---|---|
| `isin` | `string` | ISIN code |
| `issuer` | `string` | ผู้ออก |
| `coupon` | `float (%)` | อัตราดอกเบี้ย |
| `maturity_date` | `date` | วันครบกำหนด |
| `ytm` | `float (%)` | Yield to Maturity |
| `duration` | `float` | Modified Duration |
| `oas` | `float (bps)` | Option-Adjusted Spread |
| `rating` | `string` | Credit rating |

---

### 3.5 Historical Crisis Reference

**Datasets**

| Dataset | ช่วงเวลา | แหล่งข้อมูล |
|---|---|---|
| Reinhart-Rogoff | 1800–present | Harvard Dataverse |
| Kaminsky-Reinhart Currency Crises | 1970–2012 | Public |
| IMF Systemic Banking Crises | 1970–2017 | IMF Working Paper |
| Laeven-Valencia Crisis Dataset | 1970–2017 | IMF |
| BIS Credit-to-GDP Gap | 1961–present | BIS Statistics |
| IMF Financial Soundness Indicators | Country-specific | IMF Data API |

**Crisis Classification**
```
Level 0 — Normal       : ไม่มี signal ใดเกิน threshold
Level 1 — Watch        : 1–2 signals เกิน threshold
Level 2 — Warning      : 3–4 signals เกิน threshold
Level 3 — Crisis Alert : 5+ signals เกิน threshold
```

---

## 4. Data Pipeline

### 4.1 Ingestion Flow

```
External Sources
      │
      ▼
[Fetcher Layer]     ← REST API / Scraper / PDF Parser
      │
      ▼
[Normalizer]        ← แปลง format ให้เป็น standard schema
      │
      ▼
[Validator]         ← ตรวจสอบ missing fields, outlier, stale timestamps
      │
      ▼
[Storage Layer]     ← Time-series DB (InfluxDB / TimescaleDB)
      │
      ▼
[Cache Layer]       ← Redis (TTL ตาม update frequency)
      │
      ▼
[API Layer]         ← REST / WebSocket สำหรับ frontend
```

### 4.2 Update Frequency & Cache TTL

| ประเภทข้อมูล | ความถี่อัปเดต | Cache TTL |
|---|---|---|
| CDS Spreads (Scrape) | Daily | 1 hour |
| FRED Stress Series | Daily | 6 hours |
| Bond Spreads | Daily | 6 hours |
| Sovereign Ratings | Weekly | 24 hours |
| Default Rates | Monthly | 7 days |
| SEC EDGAR 8-K | Real-time poll | 15 minutes |
| Historical Crisis Data | Static | No expiry |

---

## 5. API Endpoints

```
GET  /api/v1/credit/sovereign/{country_code}
GET  /api/v1/credit/sovereign/list?sort=cds_5y&order=desc&region=asean
GET  /api/v1/credit/corporate/{ticker}
GET  /api/v1/credit/corporate/defaults?year={year}
GET  /api/v1/cds/sovereign?tenor=5y
GET  /api/v1/cds/corporate/{ticker}?tenor=5y
GET  /api/v1/spreads/series/{fred_id}?from={date}&to={date}
GET  /api/v1/crisis/dashboard
GET  /api/v1/crisis/level                        ← current Level 0–3 + triggered signals
GET  /api/v1/crisis/history?type=banking|currency|sovereign
GET  /api/v1/crisis/analogs?level={level}        ← historical episodes ที่คล้ายกัน
GET  /api/v1/bankruptcy/recent?market=us&limit=50
```

---

## 6. Frontend Design

### 6.1 Components

| Component | คำอธิบาย |
|---|---|
| `<SovereignCDSMap />` | World map แสดง CDS spread ด้วย heatmap (เน้น ASEAN+EM) |
| `<CrisisDashboard />` | Gauge/indicator panel แสดง stress level + triggered signals |
| `<YieldCurveChart />` | Interactive yield curve (multi-country, time slider) |
| `<SpreadTimeSeries />` | Time series chart สำหรับ bond spreads และ FRED stress series |
| `<DefaultRateTable />` | ตาราง default rate ประวัติศาสตร์ แยกตาม rating bucket |
| `<BankruptcyFeed />` | Live feed การยื่น bankruptcy จาก SEC EDGAR |
| `<CreditRatingBadge />` | Badge แสดง rating + outlook + consensus จาก 3 agencies |
| `<HistoricalAnalogs />` | เปรียบเทียบ episode ปัจจุบันกับวิกฤตในอดีต |

### 6.2 Crisis Alert System

**Alert Banner** — แสดง sticky banner เมื่อ Crisis Level ≥ 2 พร้อม:
- รายชื่อ indicators ที่เกิน threshold พร้อมค่าปัจจุบัน vs ค่า threshold
- Link ไปยัง historical analogs ที่คล้ายกัน
- Timestamp ของการ trigger ครั้งล่าสุด
- ปุ่ม Dismiss (hide ชั่วคราว 1 ชั่วโมง, ไม่ suppress จริง)

**Level Color Coding**
```
Level 0 — Normal       → สีปกติ (ไม่แสดง banner)
Level 1 — Watch        → สีเหลือง  #D4A017
Level 2 — Warning      → สีส้ม     #E07A30
Level 3 — Crisis Alert → สีแดง     #CC2222  (กะพริบ)
```

**Push Notification** — พิจารณาแจ้งเตือนเมื่อ level เปลี่ยนแปลง ≥ 1 ระดับ (ยังเปิด question อยู่ — ดู §9)

### 6.3 Integration กับ Terminal ที่มีอยู่

| จุดเชื่อมต่อ | รายละเอียด |
|---|---|
| **Macro View** (มีอยู่แล้ว) | เพิ่ม "CREDIT" sub-tab แสดง HY/IG OAS + TED spread ควบคู่กับ CPI/GDP |
| **Market Heatmap** | เพิ่ม tab "CREDIT" แสดง sovereign CDS ระดับโลกเป็น heatmap tiles |
| **Header bar** | เพิ่มปุ่ม `CRDT` นำทางไปหน้า Credit Risk View |
| **Atom** | เพิ่ม `"credit"` ใน `currentViewAtom` ใน `atoms/index.ts` |
| **Crisis Level badge** | แสดง Level indicator เล็กๆ ในแถบ header ตลอดเวลา (ไม่บุกรุก) |

---

## 7. Implementation Roadmap

### Phase 1 — Foundation (FRED + Spreads)
> เป้าหมาย: แสดง stress indicators ที่ทำงานได้จริงโดยใช้ FRED ที่มีอยู่แล้ว

- [ ] เพิ่ม FRED series ที่ยังไม่มีใน macro (`BAMLH0A0HYM2`, `TEDRATE`, `STLFSI4`, `NFCI`, `VIXCLS`)
- [ ] `<CrisisDashboard />` — gauge panel + Level 0–3 classification
- [ ] Crisis Alert Banner (Level ≥ 2)
- [ ] เพิ่ม "CREDIT" sub-tab ใน Macro View
- [ ] `GET /api/v1/crisis/dashboard` และ `/crisis/level`

### Phase 2 — Sovereign & CDS
> เป้าหมาย: ข้อมูลระดับประเทศ เน้น ASEAN + EM

- [ ] Sovereign CDS scraper (worldgovernmentbonds.com)
- [ ] World Bank API integration (debt/GDP, external debt)
- [ ] `<SovereignCDSMap />` — heatmap โลก
- [ ] Historical crisis dataset loader (Reinhart-Rogoff, IMF)
- [ ] `<HistoricalAnalogs />` — เปรียบเทียบกับวิกฤตในอดีต
- [ ] เพิ่ม tab "CREDIT" ใน Market Heatmap

### Phase 3 — Corporate & Real-time
> เป้าหมาย: ข้อมูล corporate level + near-real-time

- [ ] SEC EDGAR 8-K bankruptcy feed
- [ ] `<BankruptcyFeed />` + `<DefaultRateTable />`
- [ ] Altman Z-Score (คำนวณจาก yfinance financials ที่มีอยู่แล้ว)
- [ ] FINRA TRACE bond data integration
- [ ] `<YieldCurveChart />` multi-country

---

## 8. Dependencies

| Package / Service | การใช้งาน |
|---|---|
| `pandas` / `polars` | Data transformation |
| `beautifulsoup4` | Web scraping (CDS, bankruptcy) |
| `fredapi` | FRED Python wrapper |
| `requests` / `httpx` | HTTP client |
| `pydantic` | Schema validation |
| `yfinance` | Altman Z-Score inputs (มีอยู่แล้ว) |
| TimescaleDB / InfluxDB | Time-series storage (long-term) |
| Redis | Cache layer |
| `recharts` / `d3.js` | Frontend charting |

**หมายเหตุ Phase 1:** ไม่ต้องการ TimescaleDB หรือ Redis เพิ่มเติม — ใช้ FRED cache pattern เดิม (`macro_series.json` per-series disk cache) ก่อน แล้วค่อย migrate ไป time-series DB ใน Phase 2–3

---

## 9. Risks, Limitations & Open Questions

**ความเสี่ยงที่ทราบแล้ว**

| ความเสี่ยง | ผลกระทบ | Mitigation |
|---|---|---|
| Scraping ถูก block | ไม่มีข้อมูล CDS | Rotate user-agent, fallback source |
| FRED rate limit | API timeout | Cache + exponential backoff (pattern เดิม) |
| Data lag (CDS อัปเดตช้า) | ข้อมูลล้าสมัย | แสดง timestamp ชัดเจนในทุก card |
| Sovereign rating subjectivity | ความน่าเชื่อถือ | ใช้ consensus จาก 3 agencies |
| Historical data gaps | Analysis ไม่ครบ | Document gaps ใน UI ด้วย footnote |
| Crisis Level false positive | ผู้ใช้ตื่นตระหนก | Require ≥ 2 signals + ชั้นยืนยันใน UI |

**Open Questions — ต้องตัดสินใจ**

- [ ] ต้องการ real-time CDS หรือ end-of-day เพียงพอ?
- [ ] Crisis Alert ควร push notification ไหม? (Line / email / browser)
- [ ] Altman Z-Score: คำนวณเองจาก yfinance financials หรือดึง pre-computed?
- [ ] จะรองรับ non-USD denominated bonds หรือไม่?
- [ ] ต้องการ backtesting engine สำหรับ crisis signal หรือไม่?
- [ ] Phase 1 ควรใช้ disk cache เดิม หรือลง Redis ตั้งแต่ต้น?

---

## 10. References

- [FRED API Documentation](https://fred.stlouisfed.org/docs/api/fred/)
- [World Bank API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392)
- [IMF Data API](https://datahelp.imf.org/knowledgebase/articles/667681)
- [BIS Statistics API](https://stats.bis.org/api-doc/v1/)
- [SEC EDGAR Full-Text Search](https://efts.sec.gov/LATEST/search-index)
- [Damodaran Data — NYU Stern](https://pages.stern.nyu.edu/~adamodar/)
- [Reinhart-Rogoff Dataset](https://www.hbs.edu/behavioral-finance-and-financial-stability/data)
- [DTCC Trade Repository](https://pddata.dtcc.com/gtr/cftc/cumulative.do)
- [BIS Credit-to-GDP Gap Methodology](https://www.bis.org/publ/work493.htm)
- [IMF Systemic Banking Crises (Laeven-Valencia)](https://www.imf.org/en/Publications/WP/Issues/2018/09/14/Systemic-Banking-Crises-Revisited-46232)
