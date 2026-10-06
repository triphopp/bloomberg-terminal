# Data Sources — หาข้อมูลที่นี่ก่อนออกไปข้างนอก

**อัปเดตล่าสุด:** 2026-10-06 (เพิ่ม §3.2 inference benchmark และ methodology; §3.3 earnings-call transcript)
**ใช้เมื่อ:** ต้องหาข้อมูลอะไรก็ตาม — ตัวเลขมหภาค ประเทศ ดอกเบี้ย บริษัท ข่าว — ก่อนค้นเว็บ
**ใช้กับ:** ทุก agent (Claude, Codex, DeepSeek, …) ทั้งใน repo และผ่าน MCP
**ส่งผ่าน MCP:** ไฟล์นี้คือแหล่งเดียว — MCP `bloomberg-terminal` อ่านไฟล์นี้ตอนเรียก ให้บริการเป็น tool `get_data_sources` และ resource `spec://data-sources` (แก้ไฟล์แล้วมีผลทันที)

---

## 0. ลำดับการหา — ห้ามข้ามขั้น

| ขั้น | ที่ไหน | ทำไม |
|---|---|---|
| **1** | **MCP tools** (§1) | ผ่าน backend แล้ว — cache, negative-cache, `upstream_health` log, มี `source` ให้อ้างอิง |
| **2** | **Backend endpoints ที่มีอยู่แล้ว** (§2) — `curl http://127.0.0.1:9317/...` | ข้อมูลอยู่ในระบบแล้วแต่ยังไม่มี MCP tool |
| **3** | **External API ฟรีในรายการ** (§3 ไม่ต้องมี key → §4 ต้องมี key) | ผ่านการทดสอบแล้ว รู้ endpoint / ข้อจำกัด / กับดัก |
| **4** | ค้นเว็บ (WebSearch / WebFetch) | ท้ายสุดเท่านั้น — และถ้าเจอแหล่งใหม่ที่ใช้ได้ **เพิ่มลงไฟล์นี้** (§7) |

กฎที่ใช้ร่วมกับ MCP instructions: **free first**, **ทุกตัวเลขต้องมีแหล่ง + วันที่ของข้อมูล**, ห้าม scrape เว็บ paywall / ห้ามเลี่ยง rate limit.

---

## 1. MCP tools (`bloomberg-terminal`) — ขั้นแรกเสมอ

| ต้องการ | Tool |
|---|---|
| Quote, งบการเงิน, balance sheet, ข้อมูลบริษัท | `get_stock_data` |
| ราคาย้อนหลัง OHLCV | `get_price_history` |
| ข่าวรายหุ้น (7 แหล่ง) | `get_news` |
| SEC filings (10-K/10-Q/20-F/8-K) | `get_filings` |
| Fundamentals แหล่งรอง (ต้องเทียบ SEC) | `get_fiscal_data` |
| ความสนใจการค้นหา / trending | `get_google_trends` · `get_trending_searches` |
| พอร์ต · เทรด | `get_positions` · `get_trades` |
| สิ่งที่เคยค้นและจดไว้แล้ว | `zettel_search` · `zettel_by_source` · `graph_list` |
| สเปควิเคราะห์พื้นฐาน | `get_fundamental_spec` |

> ค้น `zettel_search` ก่อนเสมอ — ข้อมูลที่เคยหาแล้วพร้อมแหล่งอาจอยู่ใน knowledge base แล้ว

---

## 2. Backend endpoints ที่มีแล้ว (ยังไม่มี MCP tool) — base `http://127.0.0.1:9317`

ใช้ `127.0.0.1` ไม่ใช่ `localhost` (Python ช้า ~2s ต่อ call — ดู `gotchas.md`)

### มหภาคสหรัฐ / ตลาดดอกเบี้ย
| Endpoint | ได้อะไร | แหล่งต้นทาง | เวลาตอบ |
|---|---|---|---|
| `/api/macro` | Fed rate/stance, curve 10Y−2Y/10Y−3M, regime, CPI/NFP/PCE/GDP prints, ISM proxy | FRED | ~11s (cold) |
| `/api/macro/calendar` | ปฏิทิน FOMC/SEP/CPI/NFP/PCE/GDP/PPI/Retail/JOLTS/Claims + วันตามกฎ (option expiry, VIX settlement, ISM, FOMC minutes, EIA รายสัปดาห์) | FRED / Fed / คำนวณ | ~2s |
| `/api/rates/curve` | UST 11 tenor + JGB 15 tenor | FRED + MOF Japan | เร็ว |
| `/api/bonds/decomposition` | 10Y = expected real + breakeven + term premium (ACM) | NY Fed ACM | เร็ว |
| `/api/bonds/overview` · `/supply` · `/issuance` | credit leg, auctions, corporate issuance | FRED, fiscaldata, SEC EFTS | |
| `/api/crisis` | crisis level L0–3, STL FSI/NFCI, IG/HY OAS, breakeven, delinquency | FRED | ~6s |
| `/api/tail-risk/signals` · `/macro-context` · `/vix-term` | risk composite, market events, VIX term | FRED / CBOE | |
| `/api/cot/snapshot` · `/history` · `/basis` | CFTC positioning (weekly, as-of Tue) | CFTC | เร็ว |
| `/api/fear-greed/history` | CNN Fear & Greed | CNN | เร็ว |
| `/api/polymarket/signals` | ความน่าจะเป็นจากตลาดทำนาย (Fed, recession, …) | Polymarket | ~5s |

### ประเทศ / ธนาคารกลาง / global
| Endpoint | ได้อะไร | แหล่งต้นทาง |
|---|---|---|
| `/api/sovereign/list` · `/api/sovereign/{CC}` | 40 ประเทศ (รหัส **ISO-2**: `TH` ไม่ใช่ `THA`) — GDP, growth, CPI, ว่างงาน, หนี้/GDP, fiscal, CA/GDP, FDI, reserves (เดือน), ext debt, credit/GDP + risk score | World Bank WDI (รายปี) |
| `/api/sovereign/compare?countries=TH,US&indicator=<key>` | เทียบตัวชี้วัดเดียวข้ามประเทศ (key ตาม `_WB_INDICATORS` ใน `routers/sovereign.py`) | World Bank — cold ~30s |
| `/api/central-banks/rates` · `/{bank}/rate` · `/{bank}/fx` | ดอกเบี้ยนโยบายหลายธนาคารกลาง | ECB, BoE, BoJ, BoC, RBA, SNB, Norges, SARB, CBR, Bundesbank, BdE, OeNB |
| `/api/central-banks/ecb/hicp` · `/ecb/yield-curve` | เงินเฟ้อ + yield curve ยูโร | ECB |
| `/api/central-banks/eurostat/energy-prices` · `/renewables` | ราคาพลังงาน EU | Eurostat |
| `/api/macro/global-yields` | 2/10/30Y หลายประเทศ + Δ1D | หลายแหล่ง |
| `/api/country-rotation/scores` | จัดอันดับประเทศ (country ETFs) | yfinance |

### ไทย
| Endpoint | ได้อะไร | หมายเหตุ |
|---|---|---|
| `/api/bot/rates` · `/rates/policy` · `/rates/interbank` | ดอกเบี้ยนโยบาย ธปท. + ข่าว กนง., interbank | ✅ |
| `/api/bot/auctions` | ประมูลพันธบัตร ธปท./รัฐบาล | ✅ |
| `/api/bot/statistics/search?keyword=` → `/series?category=` → `/observations?series_code=` | **ฐานสถิติ ธปท. ทั้งหมด** (GDP, BOP, สินเชื่อ, เงินเฟ้อ …) | ✅ ค้น "GDP" ได้หลายร้อย series |
| `/api/bot/fx/daily` · `/fx/monthly` | ค่าเงินบาทอ้างอิง | ❌ 403 — token ยังไม่ได้ subscribe API ตัวนี้ที่ BOT portal (ใช้ `/api/central-banks/.../fx` หรือ yfinance `THB=X` แทน) |
| `/api/bot/rates/thb-implied` · `/swap-point` | THB implied / swap point | ⚠️ ตอบ 200 แต่ค่าเป็น `null` |
| `/api/sec/...` · `/api/sec/v2/...` | ก.ล.ต.: กองทุน (NAV, พอร์ต, ค่าธรรมเนียม), หุ้นกู้, One Report (56-1), สินทรัพย์ดิจิทัล | ต้องมี `SEC_*` keys (มีแล้ว) |

### บริษัท
| Endpoint | ได้อะไร |
|---|---|
| `/api/company/filings/{symbol}` · `/xbrl/{symbol}` · `/outlook/{symbol}` | SEC filings + XBRL facts |
| `/api/fiscal/{kind}/{symbol}` · `/api/fiscal/transcript/...` | Fiscal.ai (มีโควตารายวัน `FISCAL_AI_DAILY_LIMIT`) |

---

## 3. External API ฟรี — ไม่ต้องมี key (ขั้นที่ 3)

ถ้าจะเขียนโค้ดดึงจริง → ทำเป็น backend endpoint (`requests` เพื่อให้ `upstream_health` เห็น + negative cache) อย่าให้ frontend ยิงตรง

| แหล่ง | Base URL | ข้อมูลเด่นสำหรับภาพรวม | ตัวอย่าง query | หมายเหตุ |
|---|---|---|---|---|
| **IMF SDMX** ⭐ | `https://api.imf.org/external/sdmx/2.1` | 102 datasets: **WEO** (GDP, CPI, หนี้/GDP, CA, ว่างงาน + ประมาณการ 2 ปี), CPI รายเดือน, BOP, IIP, **COFER**, FSI, GFS, IRFCL, ER, REO รายภูมิภาค (APDREO) | `/data/IMF.RES,WEO/THA.NGDP_RPCH.A?startPeriod=2025` + header `Accept: application/vnd.sdmx.data+csv;version=1.0.0` | ~1.5s. ประเทศใช้ **ISO-3**. ผลมี `PUBLICATION_DATE`, `LATEST_ACTUAL_ANNUAL_DATA`, `SUGGESTED_CITATION` — ใช้อ้างอิงได้เลย. รายชื่อ dataset: `/dataflow/all/all/latest` (Accept JSON) |
| **World Bank v2** | `https://api.worldbank.org/v2` | WDI, หนี้ต่างประเทศ (IDS), ธรรมาภิบาล (WGI), ~70 sources | `/country/THA/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrv=5` | รายปี ช้ากว่าจริง 1 ปี. WGI ต้องระบุ `source=` ให้ถูก (รายชื่อ `/sources?format=json`) |
| **BIS** | `https://stats.bis.org/api/v2` | ดอกเบี้ยนโยบายทุกประเทศ, **credit-to-GDP gap**, debt service ratio, ราคาอสังหา, สินเชื่อข้ามพรมแดน | `/data/dataflow/BIS/WS_CBPOL/1.0/M.TH?lastNObservations=2&format=csv` | สัญญาณเตือนวิกฤตสินเชื่อ |
| **OECD SDMX** | `https://sdmx.oecd.org/public/rest` | **Composite Leading Indicators**, แรงงาน, Economic Outlook | `/data/OECD.SDD.STES,DSD_STES@DF_CLI/USA.M.LI...AA...H?lastNObservations=2&format=csvfilewithlabels` | มี rate limit ต่อชั่วโมง — cache นาน |
| **Eurostat** | `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data` | HICP, GDP, แรงงาน EU | `/prc_hicp_manr?geo=EA&coicop=CP00&lastTimePeriod=2` | JSON-stat |
| **ECB Data API** | `https://data-api.ecb.europa.eu/service` | ดอกเบี้ย, yield curve, HICP | `/data/FM/B.U2.EUR.4F.KR.DFR.LEV?lastNObservations=1&format=csvdata` | มีใน backend แล้ว (§2) |
| **US Treasury Fiscal Data** | `https://api.fiscaldata.treasury.gov/services/api/fiscal_service` | หนี้สาธารณะ, auctions, งบรัฐบาลกลาง | | มีใน backend แล้ว (bonds) |
| **UN Comtrade** (preview) | `https://comtradeapi.un.org/public/v1/preview` | ส่งออก/นำเข้ารายคู่ค้า รายสินค้า | `/C/A/HS?reporterCode=764&period=2024&flowCode=X&cmdCode=TOTAL` (764 = ไทย) | จำกัดจำนวนแถว |
| **Our World in Data** | `https://ourworldindata.org/grapher/<chart>.csv` | ข้อมูลระยะยาว (ประชากร, พลังงาน, GDP per capita) | `/gdp-per-capita-worldbank.csv?csvType=filtered` | เป็นข้อมูลรวบรวม — อ้างแหล่งต้นทางที่ OWID ระบุ |
| **BLS v2** | `https://api.bls.gov/publicAPI/v2` | CPI, การจ้างงานสหรัฐ | `/timeseries/data/CUUR0000SA0?latest=true` | ไม่มี key = 25 req/วัน |
| **DBnomics** (สำรอง) | `https://api.db.nomics.world/v22` | รวม >80 หน่วยงาน | `/series/IMF/WEO:latest/THA.NGDP_RPCH.pcent_change?observations=1` | ⚠️ `WEO:latest` = 2025-04 (ช้ากว่า IMF 1 รอบ) — ใช้เมื่อต้นทางล่มเท่านั้น |
| **SEC EDGAR** | `https://data.sec.gov` · `efts.sec.gov` | filings, XBRL companyfacts | | มีใน backend + MCP แล้ว — ต้องส่ง User-Agent พร้อมอีเมลติดต่อ |

### 3.1 เอเชีย — ข่าวภาษาท้องถิ่น / เงินของนักลงทุนแต่ละประเทศ (ทดสอบ 2026-09-30)

board/forum ทุกแหล่ง **ต้องตรวจ ToS ก่อนใช้**

| แหล่ง | Base URL / ตัวอย่าง | ได้อะไร | หมายเหตุ |
|---|---|---|---|
| Google News RSS (JP/KR/HK/CN) | `news.google.com/rss/search?q=<คำ>&hl=ja&gl=JP&ceid=JP:ja` · `hl=ko&gl=KR&ceid=KR:ko` · `hl=zh-HK&gl=HK&ceid=HK:zh-Hant` · **`hl=zh-CN&gl=CN&ceid=CN:zh-Hans`** | พาดหัวภาษาท้องถิ่น | ✅ · ฉบับ zh-CN = สื่อจีนแผ่นดินใหญ่ (新浪财经, 东方财富, 华尔街见闻) |
| **Naver (KR)** | `m.stock.naver.com/api/news/stock/005930?pageSize=5&page=1` | ข่าวรายหุ้นเกาหลี (JSON) | ✅ |
| **Naver investor trend (KR)** ⭐ | `m.stock.naver.com/api/stock/005930/trend?pageSize=5` | **ต่างชาติ/สถาบัน/รายย่อย ซื้อสุทธิรายหุ้นรายวัน** + % ต่างชาติถือ | ✅ ข้อมูล flow รายหุ้นที่ดีที่สุดในเอเชียที่หาได้ฟรี |
| **JPX investor type (JP)** | `jpx.co.jp/markets/statistics-equities/investor-type/` → `stock_1_w_*.xlsx` | ต่างชาติ/รายย่อย/สถาบัน ซื้อขายสุทธิ **ระดับตลาด** รายสัปดาห์ | ✅ ไฟล์ Excel |
| **JPX margin (JP)** | `jpx.co.jp/markets/statistics-equities/margin/` → `YYYYMMDD_mtdaily.xlsx` | ยอด margin รายวัน | ✅ |
| **HKEX Stock Connect** | `hkex.com.hk/eng/csm/DailyStat/data_tab_daily_YYYYMMDDe.js` | **Southbound ซื้อ/ขายแยก** รายวัน (เงินจีนเข้าหุ้นฮ่องกง) | ✅ · Northbound มีแค่ turnover รวม ไม่แยกซื้อ/ขาย |
| Eastmoney search (CN) | `search-api-web.eastmoney.com/search/jsonp?...` | ข่าวภาษาจีนแผ่นดินใหญ่ | ❌ match ทีละตัวอักษร แล้วคืน 0 ทุกคำค้น แม้ 茅台 (2026-10-01) — ใช้ Google News zh-CN แทน |
| Eastmoney datacenter (CN) | `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL` | ยอด margin หุ้น A รายวัน | ✅ |
| Kabutan (JP) | `kabutan.jp/stock/news?code=7203` | ข่าวรายหุ้นญี่ปุ่น (HTML) | ✅ 200 · ตรวจ ToS ก่อน parse |
| Naver 종목토론 (KR) | `m.stock.naver.com/front-api/discussion/list?discussionType=domesticStock&itemCode=005930` | กระทู้รายย่อย | ✅ 200 · ตรวจ ToS ก่อน |

---

### 3.2 หน่วยความจำ / AI hardware (ทดสอบ 2026-10-02)

| แหล่ง | URL / ตัวอย่าง | ได้อะไร | หมายเหตุ |
|---|---|---|---|
| **Artificial Analysis provider benchmarks** | `https://artificialanalysis.ai/models/gpt-oss-120b/providers` · `https://artificialanalysis.ai/methodology/endpoint-accuracy-index` | ความเร็ว, first chunk, ราคา, accuracy index และวิธีวัด | ตรวจ 2026-10-06; dynamic snapshot ต้องระบุวันที่/บริบท ตัวเลข summary/table อาจไม่ตรงกัน; index ไม่ใช่ probability of success และไม่ใช่ hardware-only quality test |
| **Baseten engineering benchmarks** | `https://www.baseten.co/blog/how-we-made-the-fastest-gpt-oss-on-nvidia-gpus-60-percent-faster/` | Speculative decoding และ workload/hardware configuration | บทความ 2025-10-24 ตรวจ 2026-10-06; vendor benchmark ใช้ทดสอบคำอ้างเชิงสถาปัตยกรรม ไม่ใช่ matched-SLA TCO |
| **SEC XBRL companyfacts** (inventory/COGS) | `data.sec.gov/api/xbrl/companyfacts/CIK0002023554.json` (SNDK) · `CIK0000723125` (MU) · `CIK0001652044` (GOOGL) | `InventoryNet` + `CostOfGoodsAndServicesSold` รายไตรมาส → คำนวณ DIO ได้ทันที | ✅ ต้องส่ง User-Agent พร้อมอีเมล · ไตรมาส 4 ต้องลบยอดสะสม 9 เดือนออกจากปีเต็ม |
| **SK hynix บน EDGAR** | CIK `0002120882` (SKHY) · F-1 `000119312526280172/d32785df1.htm` | งบ IFRS (inventory, cost of sales รายปี + Q1/26) · 6-K รายเหตุการณ์ | ⚠️ XBRL มีแค่ namespace `ffd` ไม่มี `us-gaap` — ต้อง grep HTML · 6-K ส่วนใหญ่เป็นประกาศย่อย ไม่ใช่งบ |
| **NVIDIA หน้าสเปกผลิตภัณฑ์** | `nvidia.com/en-us/data-center/vera-rubin-nvl72/` · `/gb300-nvl72/` | HBM/LPDDR ต่อ GPU/ชั้นวาง · โรงงาน 100 MW = 40K GPU = fast memory 42 PB | ✅ WebFetch อ่านได้ · ตัวเลขเป็น "up to" (เพดาน) |
| **Micron prepared remarks (PDF)** | `s25.q4cdn.com/621799436/files/doc_financials/2026/q4/Q4-FY26-Prepared-Remarks.pdf` | ไทม์ไลน์โรงงาน, bit growth อุตสาหกรรม | WebFetch คืน binary → บันทึกไฟล์แล้วใช้ `pypdf` แยกข้อความ |
| **Yahoo estimates = S&P Global MI** | `help.yahoo.com/kb/finance-for-web/SLN2310.html` | ยืนยันว่าคอนเซนซัสใน `get_stock_data(estimates/analyst)` มาจาก S&P Global Market Intelligence | ใช้ตอบว่า "คอนเซนซัสมาจากใคร" |

### 3.3 อ่านเนื้อหน้าเว็บ (ทดสอบ 2026-10-05)

| แหล่ง | Endpoint | ได้อะไร | ผล |
|---|---|---|---|
| Stock Analysis earnings transcripts | `https://stockanalysis.com/stocks/{symbol}/transcripts/` | บันทึกคำพูด CEO/CFO และ Q&A พร้อมวันที่ call | ✅ CBRS Q2/2026 ตรวจ 2026-10-06; เป็น transcript ที่ผู้เผยแพร่ถอดคำพูด ควรเทียบ guidance ตัวเลขกับ 8-K/IR ที่เป็นเอกสารบริษัท |
| Jina Reader | `https://r.jina.ai/<url>` (header `Accept: text/plain`) | เนื้อหน้าเว็บเป็น markdown — หน้า JavaScript และ PDF ด้วย | ✅ ไม่ต้องมี key · ❌ บล็อก `news.google.com` · paywall (WSJ, Barron's) ไม่ผ่าน · ใช้ผ่าน `backend/web_reader.py::read_page` (ลองดึงตรงก่อน แล้วค่อย fallback) |
| Google News link → URL จริง | `web_reader.resolve_news_link(url)` | URL ของสำนักข่าวจากลิงก์ `news.google.com/rss/articles/<id>` | ✅ ~1 วินาที/ลิงก์ |
| ค้นเว็บทั่วไปแบบไม่มี key | DuckDuckGo / Brave / Yahoo HTML, Bing RSS | — | ❌ ทุกเจ้าบล็อก script หรือคืนผลไม่ตรง — ใช้ §4 Tavily/Brave |

## 4. ฟรีแต่ต้องมี key

| แหล่ง | สถานะในระบบ | ข้อมูล |
|---|---|---|
| **Tavily / Brave Search** | ⬜ ยังไม่มี key — ใส่ `TAVILY_API_KEY` หรือ `BRAVE_API_KEY` ใน `backend/.env` (free tier) | ค้นเว็บทั่วไปสำหรับ NEWS → ASK (`web_search` tool) — ไม่มี key ก็ยังค้นข่าว + เปิดอ่านหน้าเว็บได้ |
| **ธปท. (BOT API Portal)** | ✅ มี `BOT_*_TOKEN` ใน `backend/.env` — rates / auctions / statistics ใช้ได้; **FX ยังไม่ได้ subscribe** | ข้อมูลเศรษฐกิจไทยทั้งหมด → ใช้ผ่าน §2 |
| **FRED** | ✅ `FRED_API_KEY` | series สหรัฐเกือบทั้งหมด — ผ่าน §2 |
| **ก.ล.ต. (SEC TH)** | ✅ `SEC_*` keys | กองทุน, หุ้นกู้, One Report — ผ่าน §2 |
| **Fiscal.ai** | ✅ `FISCAL_AI_API_KEY` (โควตารายวัน) | fundamentals, transcripts — ผ่าน MCP |
| **Alpha Vantage** | ✅ `ALPHA_VANTAGE_API_KEY` | ราคา / fundamentals สำรอง |
| EIA | ⚠️ `EIA_API_KEY` ยังไม่ตั้ง — ใช้ `DEMO_KEY` (10 ครั้ง/ชม.) | น้ำมัน สต๊อก พลังงานสหรัฐ — มีแล้วที่ `/api/tail-risk/oil` (สต๊อก crude/gasoline/distillate/Cushing/SPR, กำลังผลิต, refinery util, demand รายสัปดาห์ เทียบ 5 ปี) |
| BEA / Census | ❌ ยังไม่มี | GDP สหรัฐละเอียด, ค้าปลีก |
| FAO | ❌ ยังไม่มี (401) | อาหาร / เกษตรโลก |

---

## 5. หาอะไร → ไปที่ไหน (ลัด)

| คำถาม | ที่แรก | สำรอง |
|---|---|---|
| GDP / เงินเฟ้อ / หนี้ / ดุลบัญชีเดินสะพัด **+ ประมาณการ** ของประเทศ | IMF SDMX WEO | World Bank (`/api/sovereign`) |
| โครงสร้างประเทศระยะยาว (reserves, FDI, ext debt, credit/GDP) | `/api/sovereign/{CC}` | World Bank v2 ตรง |
| ภาพรวมเศรษฐกิจไทยล่าสุด (รายเดือน/ไตรมาส) | `/api/bot/statistics/*` | IMF SDMX (CPI, QNEA) |
| ดอกเบี้ยนโยบาย | `/api/central-banks/rates` · `/api/bot/rates` | BIS WS_CBPOL |
| วัฏจักรเศรษฐกิจ / leading indicator | OECD CLI | `/api/macro` (ISM proxy) |
| ความเสี่ยงสินเชื่อ / ฟองสบู่ | `/api/crisis` (US) | BIS credit gap / DSR / property |
| ทุนสำรองโลก / สกุลเงินทุนสำรอง | IMF COFER | — |
| การค้าระหว่างประเทศรายคู่ค้า | UN Comtrade | IMF IMTS |
| Yield / curve | `/api/rates/curve` · `/api/macro/global-yields` | ECB / FRED |
| Positioning / sentiment | `/api/cot/*` · `/api/fear-greed` · `/api/polymarket/signals` | — |
| ข้อมูลบริษัท | MCP `get_stock_data` · `get_filings` | `/api/company/*` · Fiscal.ai |

---

## 6. กับดักที่เจอแล้ว

- **IMF DataMapper** (`imf.org/external/datamapper/api/v1`) — ส่ง User-Agent แบบเบราว์เซอร์ → 403 (Akamai); ใช้ได้กับ UA ปกติแต่ช้า ~10s และคืนทุกประเทศ → **ใช้ IMF SDMX แทน**
- **รหัสประเทศไม่เหมือนกัน** — backend `/api/sovereign` = ISO-2 (`TH`), IMF / World Bank ตรง = ISO-3 (`THA`), UN Comtrade = ตัวเลข M49 (`764`)
- **FRED series ที่ถูกลบ** ถูก retry ซ้ำไม่รู้จบถ้าไม่ negative-cache (เคสจริง `BAMLHE00EHY0D`, ดู `CLAUDE.md`)
- **ข้อมูลรายปีของ World Bank ช้ากว่า 1 ปี** — ตัวเลขปีล่าสุดอาจยังว่าง; ระบุปีของข้อมูลทุกครั้ง
- **WEO ออกปีละ 2 รอบ** (เม.ย. + ต.ค.) — ระบุ vintage (`PUBLICATION_DATE`) ทุกครั้งที่อ้างประมาณการ
- **openai.com/index/* และ datacenterdynamics.com → 403** กับ WebFetch (ตรวจ 2026-10-02) — ใช้ข่าวแจกของคู่สัญญาแทน (nvidianews.nvidia.com, AMD 8-K บน EDGAR)
- **หนังสือชี้ชวน Anthropic ยังเป็นแบบลับ** — ไม่อยู่บน EDGAR (ตรวจ 2026-10-02); ตัวเลขที่เห็นมาจาก Reuters/Fortune ที่ได้อ่านฉบับรั่ว → แหล่งรอง
- ข้อมูลมีปัญหา/ช้า/หาย → อ่าน `logs/upstream.jsonl` ก่อน (`python backend/scripts/upstream_report.py`)

---

- **KKP (ธนาคารของ Dime) เรทแลกเงิน** `bank.kkpfg.com/en/exchange-rates` — ข้อมูลจริงมาจาก `/Utility/GetExchangeRate?date=YYYY-MM-DD&lang=th` (17 รอบ/วัน, TT buy/sell) แต่ **403 จาก bot protection เมื่อเรียกจาก backend/curl** (ตรวจ 2026-09-30) — ห้ามพยายามเลี่ยง; เปิดดูในเบราว์เซอร์ได้อย่างเดียว. และ **ไม่ใช่เรทที่ Dime ใช้แสดงยอด**: 2026-09-30 Dime app = 33.55 ต่อ USD ขณะที่ KKP รอบ 17 ของ 29 ก.ย. = 33.45/33.74

- **Bing News RSS `mkt=zh-CN`** คืน HTML (ภาษาไทยตาม locale เครื่อง) ไม่ใช่ RSS — ใช้ Eastmoney แทนสำหรับข่าวจีนแผ่นดินใหญ่
- **Northbound Stock Connect** ไม่มีตัวเลขซื้อ/ขายสุทธิรายวันแล้ว (HKEX ให้แค่ turnover) — อย่าหาต่อ
- **Eastmoney 股吧 `gbapi`** ตอบ 200 แต่ list ว่างด้วย parameter แบบง่าย — ยังไม่ได้หา parameter ที่ถูก
- **Baidu Index** (ความสนใจการค้นหาในจีน) ต้อง login — ไม่มีตัวแทนฟรีของ Google Trends สำหรับจีนแผ่นดินใหญ่

---

## 7. เพิ่มแหล่งใหม่

เจอแหล่งใหม่ที่ฟรีและใช้ได้ → เพิ่มแถวใน §3 หรือ §4 พร้อม: base URL, ตัวอย่าง query ที่ยิงผ่านจริง, ข้อจำกัด (key / rate limit / ความถี่), วันที่ทดสอบ. แหล่งที่เลิกใช้ได้ → ย้ายไป §6 พร้อมเหตุผล อย่าลบเงียบ.
