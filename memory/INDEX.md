# Bloomberg Terminal — Memory Index

> **อ่านไฟล์นี้ก่อนเสมอ** เพื่อรู้ว่าต้องการข้อมูลอะไร อยู่ที่ไหน

---

## โครงสร้าง

```
memory/
├── INDEX.md                         ← คุณอยู่ที่นี่
├── AGENTS.md                        ← กฎการเขียนรายงาน + format สำหรับทุก agent (อ่านก่อนเขียนไฟล์ใดๆ)
├── project_summary.md               ← ข้อมูลครบทุกอย่าง (อ่านก่อนทุกครั้ง)
│
├── reference/
│   ├── architecture.md             ← stack, data flow, 26 routers, key files, วิธีเพิ่ม view/endpoint
│   ├── api-endpoints.md            ← all endpoints per router + caching strategy + Next.js proxy routes
│   ├── frontend-structure.md       ← full component tree + key exports per file + keyboard shortcuts
│   ├── data-shapes.md              ← API response JSON shapes + TypeScript interfaces (avoid reading routers)
│   ├── gotchas.md                  ← error dictionary + anti-patterns + "Where is X?" lookup + env var map
│   ├── data-catalog.md             ← 17 data categories available for analysis
│   └── terminal-commands.md        ← command mode reference: ALERT/VIEW/DISPLAY/INFO commands + ticker crawl
│
├── plans/
│   ├── completed/analytics-cash-card.md ← ✅ CASH tile + MARKET VALUE split (excl./incl. idle cash) in ANALYTICS Capital Breakdown (done 2026-07-14)
│   ├── completed/cash-transfer-feature.md ← ✅ Linked-pair TRANSFER entry_type in cash_ledger, fixes per-account invested_capital on inter-account moves (done 2026-07-14)
│   ├── system-audit-2026-07/        ← 🔍 Bug audit ทั้งระบบ: fixes/ (F01–F09) + refactor/ (R01–R06) + README tracker [ACTIVE 2026-07-02]
│   ├── completed/analytics-charts-enhancement.md ← ✅ PORT Analytics: Dividend M/Q/Y + stacked bar + currency fix (done 2026-06-05)
│   ├── completed/dcc-correlation-monitor.md ← ✅ EWMA-DCC correlation spike detection + EWS integration + backtest (done 2026-06-06)
│   ├── completed/trade-edit-and-sector-standard.md ← ✅ TradeEditModal + TradePatch 17 fields + bulk-patch-sector (done 2026-05-23)
│   ├── bloomberg-cli-mcp.md         ← Bloomberg CLI + MCP server: bloomberg market/portfolio/sectors + bloomberg mcp (13 tools) [NOT STARTED]
│   ├── data-source-contract.md     ← Canonical response models (QuoteSnapshot, OHLCVFrame ฯลฯ) + plug-and-play provider swap [NOT STARTED]
│   ├── portfolio-risk-system.md     ← Risk Engine: VaR/CVaR/Greeks/Stress + RiskTab + Action Log [PLANNING]
│   ├── refactor-backlog.md          ← technical debt + pending refactors
│   ├── ui-design-system.md          ← Bloomberg UI standardization: design tokens, shared primitives [IN PROGRESS — Step 1 done]
│   ├── threshold-calibration.md             ← Regime threshold calibration: RMT (GEOM) + MRS 4-state HMM (CORR) [NOT STARTED]
│   ├── yield-curve-interpretation-workflow.md ← 5-dimension yield curve interpretation [NOT STARTED]
│   │
│   ├── infra/                       ← Infrastructure & DevOps plans
│   │   ├── load-optimization.md         ← 7-step CPU/RAM fix [steps 5-6 ยังค้าง]
│   │   └── production-infrastructure.md ← Docker, CI/CD, structlog, SQLite→PG, Redis, thread semaphore [NOT STARTED]
│   │
│   └── completed/                   ← ✅ 24 plans ที่ implement เสร็จ 100%
│       ├── algorithmic-fixes.md         ← AF-1~5 done 2026-05-22
│       ├── backtest-v2.md               ← done 2026-05-22
│       ├── chart-data-range.md          ← All 5 steps: MAX period + default 3m + cache TTL 12h + range badge + loading skeleton done 2026-05-29
│       ├── country-equity-rotation.md   ← 3-layer rotation engine (Momentum + Macro Quality + Carry) 14 ETFs + ROTATION tab in Macro view done 2026-05-29
│       ├── data-source-contract.md      ← Canonical models + typed adapter + 6 routers migrated + Phase B bug fixes done 2026-05-29
│       ├── equity-allocation-signal.md  ← 3-layer confluence engine: backend analytics + router + SQLite + ALLOCATION tab in Macro view done 2026-05-29
│       ├── frontend-code-splitting.md   ← all 7 changes done: code-splitting + React.memo + Suspense (2026-05-22) + optimizePackageImports + dead deps removal + prefetch hook + bundle analyzer (2026-05-29)
│       ├── gmov-enhancement.md          ← done 2026-05-22
│       ├── international-sectors.md     ← done 2026-05-22
│       ├── launch-scripts.md            ← done 2026-05-22
│       ├── macro-worldbank-charts.md    ← done 2026-05-20
│       ├── market-quality-framework.md  ← done 2026-05-21
│       ├── market-session-workflow.md   ← done 2026-05-21
│       ├── portfolio-sell-dividend-y-key.md ← done 2026-05-23
│       ├── portfolio-view-refactor.md   ← done 2026-05-23 — 2,610→2 lines, 15 files in portfolio/
│       ├── sector-classification-db.md  ← done 2026-05-22
│       ├── sector-bc-issues.md          ← P1+P2+P3+P6+P7 fixed 2026-05-30 (FRED SSL + disk cache + parallel breadth + HYG-LQD fallback)
│       ├── sector-selection-signal.md   ← 4-layer BC+MOM+VAL+F: backend analytics (5) + router + SECTOR tab in Macro view done 2026-05-29
│       ├── tab-shortcuts-header-slim.md ← Alt+N sub-tab shortcuts + per-view header removal + ← ESC clickable + centerSlot subtitle done 2026-05-30
│       ├── macro-tab-consolidation.md   ← MACRO 9→6 tabs: mktquality+allocation+rotation+sector → SIGNALS split-panel done 2026-05-30
│       ├── strategy-classifier.md       ← done 2026-05-22
│       ├── trade-edit-and-sector-standard.md ← TradePatch 17 fields + bulk-patch-sector + TradeEditModal done 2026-05-23
│       ├── us-sector-rotation.md        ← ⛔ DEPRECATED — merged into sector-selection-signal.md
│       ├── portfolio-cloud-sync.md      ← ✅ PC↔Mac Google Drive sync: JSON snapshots, startup pull, row-LWW + tombstones, SYNC chip, no login (done 2026-06-26)
│       └── view-consolidation.md        ← done 2026-05-21
│
└── sessions/
    ├── INDEX.md                    ← audit trail: ไฟล์ไหนถูกเปลี่ยนเมื่อไหร่
    ├── 2026-05-22-algorithmic-fixes-and-frontend-opt.md
    ├── 2026-05-22-sector-classification-db.md
    ├── 2026-05-21-view-consolidation-and-design-system.md
    ├── 2026-05-21-market-session-display.md
    ├── 2026-05-21-market-quality-framework.md
    ├── 2026-05-20-bar-chart-domain.md
    ├── 2026-05-19-pipeline-refactor.md
    ├── 2026-05-18-bot-statistics.md
    ├── 2026-05-18-all-changes.md
    └── reports/                    ← audit reports
        ├── analytics-charts-risk-assessment.md ← 🔴 F2 cost methodology flaw + O(P×T), F3 partial conversion
        ├── frontend-performance-report.md ← ⚡ Bundle audit: 762KB views, no code-split, 1.1MB initial JS
        ├── production-readiness-report.md ← 🔴 47 gaps for 100k-user deployment (12 critical blockers)
        ├── computation-analysis-report.md ← 🦀 Rust viability: 4 heavy computations + 5 algorithmic fixes + roadmap
        ├── macro-worldbank-charts-report.md
        ├── gmov-enhancement-report.md
        ├── api-test-report.md
        ├── hardcoded-values.md
        └── unit-tests.md
```

---

## ต้องการรู้เรื่องอะไร → อ่านที่ไหน

| ต้องการ | ไฟล์ |
|---------|------|
| **กฎการเขียน report / format / workflow** | **`AGENTS.md`** |
| วิธี run app (2 terminals, env vars) | `reference/architecture.md` → "Running the app" |
| Tech stack, API endpoints ทั้งหมด, DB schema | `project_summary.md` |
| Keyboard shortcuts (1-6, P, C, E, Y, i…) | `project_summary.md` → "Global Keyboard Shortcuts" |
| Key file paths (atoms, hooks, chart) | `reference/architecture.md` → "Key files" |
| วิธีเพิ่ม view / endpoint ใหม่ | `reference/architecture.md` → "Navigation" + "Backend layout" |
| Known bugs / limitations | `project_summary.md` → "Known Issues" |
| อะไร reintroduce ไม่ได้ (CPU/RAM) | `project_summary.md` → "CPU/RAM History" |
| งาน GMOV view (ทำเสร็จแล้ว) | `plans/completed/gmov-enhancement.md` |
| **PORT: Sell system + Dividend auto-fill + Y key** (ทำเสร็จแล้ว) | `plans/completed/portfolio-sell-dividend-y-key.md` |
| **PORT Analytics: Dividend M/Q/Y, stacked allocation timeline, currency fix** | ✅ done 2026-06-05 — `plans/completed/analytics-charts-enhancement.md` |
| **Trade Edit System + Sector Standardization** (ทำเสร็จแล้ว) | `plans/completed/trade-edit-and-sector-standard.md` |
| **Port Redesign** (symbol resolver at-write, sub_portfolios table, currency module, ปิด F06) 🔄 | `plans/port-redesign.md` |
| **Multi-Currency Sub-Portfolio** (instrument ccy authoritative, per-trade rollup, hybrid historical/live FX, ECON attribution) ✅ done 2026-07-14 | `plans/completed/multi-currency-portfolio.md` |
| **Bloomberg CLI + MCP Server** (`bloomberg market/portfolio/mcp`, 13 MCP tools) | `plans/bloomberg-cli-mcp.md` |
| **Portfolio Risk Management System** (VaR/CVaR/Greeks/Stress, RiskTab, Action Log) | `plans/portfolio-risk-system.md` |
| **Data Source Contract** (canonical models + OHLCVFrame migration fix + Dividends fix + cache clear) | ✅ Phase A+B partial done — `plans/completed/data-source-contract.md`; Phase B remainder in `plans/data-source-contract.md` |
| **Analytics Charts Risk Assessment (F2 critical issues)** | `reports/analytics-charts-risk-assessment.md` |
| **Trade Edit + Sector Standardization** (ทำเสร็จแล้ว) | `plans/completed/trade-edit-and-sector-standard.md` |
| **Trade Edit Risk Assessment (11 risks, all fixable)** | `reports/trade-edit-risk-assessment.md` |
| **portfolio-view.tsx Refactor (2,610→2 lines, 15 files)** (ทำเสร็จแล้ว) | `plans/completed/portfolio-view-refactor.md` |
| 4-Layer Market Quality Framework (ทำเสร็จแล้ว) | `plans/completed/market-quality-framework.md` |
| **Equity Allocation Confluence Signal** (3-layer engine, ALLOCATION tab) (ทำเสร็จแล้ว) | `plans/completed/equity-allocation-signal.md` |
| **Country Equity Rotation Signal** (3-layer: Momentum + Macro + Carry, 14 ETFs, ROTATION tab) (ทำเสร็จแล้ว) | `plans/completed/country-equity-rotation.md` |
| **Sector Selection Signal** (4-layer BC+MOM+VAL+F, 11 SPDR ETFs, SECTOR tab in Macro view) | ✅ done 2026-05-29 — `plans/completed/sector-selection-signal.md` (unified); `plans/completed/us-sector-rotation.md` ⛔ DEPRECATED |
| **Chart Data Range** — MAX period + default 3m + cache TTL 12h + range badge + loading skeleton (ทำเสร็จแล้ว) | `plans/completed/chart-data-range.md` |
| **Alt+N Tab Shortcuts + Per-View Header Removal** — `useTabShortcuts` hook, ← ESC clickable, centerSlot subtitle (ทำเสร็จแล้ว) | `plans/completed/tab-shortcuts-header-slim.md` |
| **MACRO SIGNALS Tab Consolidation** — 9→6 tabs, split-panel (Risk+Allocation cards + Sector/Rotation toggle + CB/IPO drawers) (ทำเสร็จแล้ว) | `plans/completed/macro-tab-consolidation.md` |
| **Stock Analysis Nested Tab Shortcuts** (Alt+N outer, Alt+Shift+N inner) | ❌ not started — `plans/stock-analysis-tab-shortcuts.md` |
| **VP Indicator Upgrade** (session timezone fix B1 🔴, visible-range VP, delta profile, naked POC, HVN/LVN, config UI) | 🔄 code-complete, browser verify pending — `plans/vp-indicator-upgrade.md`; audit: `reports/vp-indicator-risk-report.md` |
| **P/E History Pane + EPS Surprise Labels** (`/api/stock/pe-history`, PEPane recharts sub-pane + valuation bands, earnings beat/miss color) | 🔄 code-complete, backend HTTP verified, frontend visual pending — `plans/pe-earnings-visualization.md` |
| Data catalog — ข้อมูลทั้งหมดที่ดึงได้ 17 หมวด | `reference/data-catalog.md` |
| **SEC Thailand API** — endpoints, key config, migration status, One Report structure | `project_summary.md` → "SEC Thailand Open API" |
| International sectors (TH/CN/KR/EU) + sector constituents (ทำเสร็จแล้ว) | `plans/completed/international-sectors.md` |
| Market session (pre/post/after-hours) (ทำเสร็จแล้ว) | `plans/completed/market-session-workflow.md` |
| **Strategy Fit classifier (7 strategies, Gaussian scoring)** (ทำเสร็จแล้ว) | `plans/completed/strategy-classifier.md` |
| **Frontend code splitting & perf** (ทำเสร็จแล้ว) | `plans/completed/frontend-code-splitting.md` |
| **Production infrastructure** (Docker, CI/CD, logging, DB, Redis) | `plans/infra/production-infrastructure.md` |
| **Multi-provider quote registry + failover + header switch** (Phase 0) | ✅ done 2026-06-14 — `plans/scaling/provider-registry.md` |
| **Concurrent-scaling roadmap** (Phase 1 SSE fan-out, Phase 2 WS paid feed) | 📋 planned — `plans/scaling/` (`README.md`, `live-data-transport.md`) |
| **Computation analysis — Rust/native viability** | `reports/computation-analysis-report.md` |
| **Production readiness — 100K users (47 gaps)** | `reports/production-readiness-report.md` |
| **Frontend performance — bundle & rendering audit** | `reports/frontend-performance-report.md` |
| **Algorithmic fixes (5 changes, zero data impact)** (ทำเสร็จแล้ว) | `plans/completed/algorithmic-fixes.md` |
| Technical debt ที่ค้างอยู่ | `plans/refactor-backlog.md` |
| Load optimization steps ที่ค้าง | `plans/infra/load-optimization.md` |
| View consolidation (ลบ GVOL/EQTY, reassign keys) (ทำเสร็จแล้ว) | `plans/completed/view-consolidation.md` |
| UI Design System shared primitives | `plans/ui-design-system.md` + `components/bloomberg/core/ui-primitives.tsx` |
| 9 views — keyboard shortcuts (1-6, P, C, E) | `CLAUDE.md` → "Views" section |
| session X ทำอะไร / ไฟล์ไหนเปลี่ยน | `sessions/INDEX.md` |
| **OPTIONS Greeks math derivation + bug log** | `reports/options-greeks-math-report.md` |
| **Strategy Builder** (19 templates, multi-expiry Calendar/Diagonal, payoff w/ BS pricing, PoP/E[P&L]/Kelly ranking) | ✅ done 2026-06-08 — `plans/completed/strategy-builder.md` |
| **Regime Calibration math audit** — RMT/MRS verified, 2 critical bugs found + fixed (k_signal→label, conflict detection) | `reports/regime-calibration-math-report.md` |
| **รัน backend unit tests** | `cd backend && python -m pytest tests/ -v` |
| **CI/CD workflow** | `.github/workflows/tests.yml` |

---

## Feature Status (อัพเดต 2026-06-02)

| Feature | สถานะ |
|---------|--------|
| Backend 22 routers modular (inc. sec + sec_v2) | ✅ |
| **SEC Thailand API — legacy (old portal)** Fund factsheet + Fund daily + Common | ✅ done 2026-05-29 — `routers/sec.py`, expires 2026-06-30 |
| **SEC Thailand API — Bond v2** (6 endpoints, cursor pagination) | ✅ done 2026-05-29 — `routers/sec_v2.py`, `SEC2_API_KEY` |
| **SEC Thailand API — Fund v2** (21 endpoints: general-info/factsheet/outstanding/daily) | ✅ done 2026-05-29 — `routers/sec_v2.py`, `SEC2_API_KEY` |
| **SEC Thailand API — One Report v1** (23 endpoints, 814 cos in 2023) | ✅ done 2026-05-29 — working; year=Gregorian (2023), language=T/E; 2021–2023 data available |
| **SEC Thailand API — Digital Asset** | ❌ under maintenance by SEC |
| TTLCache migration | ✅ |
| S&P 500 screener | ✅ |
| BOT Statistics API | ✅ |
| Load optimization steps 1-4, 7 | ✅ |
| Load optimization steps 5-6 | ❌ pending |
| Bar chart domain fixes (4 charts) | ✅ done 2026-05-20 |
| GMOV: Y key fix | ✅ done 2026-05-22 |
| GMOV: Sector cluster view | ✅ done 2026-05-22 — SectorColumn + intl tabs (US/TH/CN/KR/EU) |
| GMOV: Heatmap sub-tiles | ✅ done 2026-05-22 — nested treemap with sector-stocks endpoint |
| Market session badge + pre/post price | ✅ done 2026-05-21 |
| Sector classification DB (yfinance + Wikipedia) | ✅ done 2026-05-22 — backend + proxies complete, data not yet seeded |
| International sectors (TH/CN/KR/EU) | 🔄 ready to seed — run POST /api/sectors/fetch per index |
| Dynamic symbol lists (SQLite) | 📋 planned |
| Data Source Adapter Layer | 🔄 Phase A done (models + typed adapter + 6 routers migrated) |
| Tests | ✅ backend/tests/test_greeks.py (58 tests, 58 pass) — `cd backend && python -m pytest tests/ -v` |
| Market Quality Framework — 4 layers | ✅ done 2026-05-21 |
| View Consolidation (12→10→9 views) | ✅ — GVOL/EQTY removed 2026-05-21; RMI removed 2026-05-24; keys reordered (CLIP=4, MACRO=5, CRDT=6, PORT=P) |
| UI Design System — ui-primitives.tsx | 🔄 in progress — Step 1 done (primitives created), 7 views + header remain (market-view is reference impl) |
| UI Design System — news/clippings audit | ✅ done 2026-05-21 — both already well-aligned |
| Macro — World Bank Charts | ✅ done 2026-05-20 |
| **Backtest v2** (trades-based, multi-currency, stack chart) | ✅ done 2026-05-22 — `routers/backtest_v2.py` + 3 proxy routes + BacktestTab v2 (4 sub-tabs: equity/holdings/distribution/attribution) |
| **PORT: sub-account grouping** (Finansia 3 sub-accts, Dime, InnovestX) | ✅ done 2026-05-22 — OpenPositionsTab collapsible groups + GROUP_COLORS |
| **PORT: Cash/Dividend CRUD** (add/edit/delete) | ✅ done 2026-05-22 — PUT+DELETE endpoints in portfolio_v2.py + inline forms |
| **PORT: Dividend reinvestment fields** | ✅ done 2026-05-22 — reinvested_amount, reinvest_asset, reinvest_price, reinvest_units |
| **PORT: DB seeded** — Finansia 3 sub-accts (14 positions) | ✅ done 2026-05-22 — price_entry corrected to "Bought" prices |
| **PORT: DB seeded** — Dime (6 positions, USD) | ✅ done 2026-05-22 — THB→USD converted at rate 32.65 |
| **PORT: DB seeded** — Cash flow (55 entries) | ✅ done 2026-05-22 — 2024-01 ถึง 2026-04 |
| **PORT: DB seeded** — Dividends (23 entries) | ✅ done 2026-05-22 — Finansia + Dime |
| **THESES tab fix** | ✅ done 2026-05-22 — frontend เรียก `?symbol=` query param แทน path param |
| **BTC-USD symbol fix** | ✅ done 2026-05-22 — `_get_yf_symbol()` รองรับ symbol ที่มี `-` แล้ว (InnovestX) |
| **Launch scripts** (bloomberg start/stop/status) | ✅ done 2026-05-22 — `scripts/bloomberg.ps1` + `.sh` + installer ทั้งสองฝั่ง |
| **PORT: price fetch optimization** | ✅ done 2026-05-22 — batch `yf.download()` + TTLCache 60s (ราคา) / 120s (THB rate) แทน 21 calls แยก |
| **PORT: OpenPositionsTab redesign** | ✅ done 2026-05-22 — fixed toolbar + scrollable table zone, sticky group headers, DENSE mode (18px rows), COLS picker (11 columns), filter by symbol/sector, `cellMap` pattern |
| **Strategy Fit tab** (STRATEGY FIT — 7-strategy Gaussian classifier) | ✅ done 2026-05-22 — `stock-view.tsx`: 6 math functions + StrategyFitTab (4 UI sections) + split-normal kernel + Cornish-Fisher SR_adj |
| **PORT: Sell / Partial Sell system** | ✅ done 2026-05-23 — `portfolio_v2.py` POST /sell + modal in OpenPositionsTab |
| **PORT: Dividend auto-fill** (suggest จาก yfinance + open position) | ✅ done 2026-05-23 — `portfolio_v2.py` GET /dividend-suggestions + DIV SUGGEST button |
| **PORT: Y key context-aware** (THB↔USD เฉพาะหน้า PORT, YTD/Daily ที่อื่น) | ✅ done 2026-05-23 — `bloomberg-terminal.tsx`: Y checks `currentView !== "portfolio"` |
| **PORT: portfolio-view.tsx refactor** (2,610→2 lines, split into 15 files in `portfolio/`) | ✅ done 2026-05-23 — tsc 0 errors, barrel re-export pattern, types/helpers/constants/ui/modals/tabs |
| **PORT Analytics: Dividend M/Q/Y toggle** | ✅ done 2026-05-23 — `AnalyticsTab`: M/Q/Y buttons + `divPeriod` state |
| **PORT Analytics: Allocation stacked bar** (F2) | ✅ done 2026-06-05 — `plans/completed/analytics-charts-enhancement.md` |
| **PORT: Trade Edit System** (modal + bulk sector endpoint + sector standardization) | ✅ done 2026-05-23 — expanded TradePatch (17 fields) + bulk-patch-sector endpoint + TradeEditModal + EDIT buttons in OpenPositions + TradeLog |
| **PORT: Sector standard (SET/GICS)** — TH 34 codes + US GICS 11 | ✅ done 2026-06-02 — `constants.ts` TH_SECTORS (AGRI/FOOD/FASHION/HOME/PERSON/MEDIA/COMM/HELTH/TOURISM/BANK/FIN/INSUR/AUTO/ENERG/PETRO/MINE/PACK/PAPER/STEEL/HARDW/CONS/CONMAT/PFUND/PROP/ICT/ETRON/TRANS/PROF/ETF/DW/WARRANT/BOND/CRYPTO/Other) + US GICS 11 sectors |
| **PORT: Option manual import** (checkbox + Long/Short + Call/Put + VAT) | ✅ done 2026-06-02 — `ImportTab.tsx`: IS OPTION? checkbox → DIR toggle (Long/Put) + TYPE toggle (Call/Put) + sector auto-encode `"Option — Long Call"` + W/L/P→Open/Exercised/Expired + VAT field (auto 7% button) |
| **PORT: Position merge + lot expansion** | ✅ done 2026-06-02 — `OpenPositionsTab.tsx`: `mergePositions()` groups same symbol+account → weighted avg entry + total vol + summed PnL; click ▶ to see individual lots with EDIT/SELL |
| **PORT Risk: VaR/CVaR multi-period** (1D/1W/1M/3M/6M) | ✅ done 2026-06-02 — `RiskTab.tsx` horizon selector, √T scaling (Basel); `risk.py` unchanged (1D only, frontend scales) |
| **PORT Risk: Parity duplicate-symbol bug fix** | ✅ done 2026-06-02 — `risk.py` `get_risk_parity_allocation`: was `if yf_sym not in symbols` (skip duplicates) → now `sym_value_map` aggregates all lots → BUY quantity now correct |
| **PORT Risk: Rebalance shares calculation** | ✅ done 2026-06-02 — `risk.py` + `RiskTab.tsx`: rebalance actions now show ±X.XX shares + current price; backend fetches live price and returns `shares_change = trade_value / current_price` |
| **PORT Risk: Chart axis all labels** | ✅ done 2026-06-02 — `RiskTab.tsx`: `interval={0}` on all YAxis in risk contribution + parity bar charts; height increased to `assets.length * 22` |
| **OPTIONS: Position tracking + Greeks** | ✅ done 2026-06-03 — `backend/greeks.py` (BS+GC Adj), `backend/providers/` (abstract provider layer), `routers/options.py` CRUD+Greeks endpoints, PORT OPTIONS tab, RiskTab OPTIONS RISK subtab |
| **OPTIONS: Gram-Charlier fat-tail Greeks (Adj)** | ✅ done 2026-06-03 — Q3/Q4 Corrado-Su, finite-diff all Greeks, `estimate_moments()` from 252d history; bug fix: Q3 d2→d1 2026-06-03 |
| **OPTIONS: Provider abstraction layer** | ✅ done 2026-06-03 — `backend/providers/base_options.py` (abstract) + `yahoo_options.py`; swap provider 1 line in `routers/options.py:26` |
| **OPTIONS: DataFreshness badge** | ✅ done 2026-06-03 — `~15m delay` tooltip on every delayed data point in OPTIONS tab + RiskTab |
| **PORT Analytics: Y key P&L currency fix** (F3) | ✅ done 2026-06-05 — `plans/completed/analytics-charts-enhancement.md` |
| **Portfolio Risk System** (VaR/CVaR/Greeks/Stress, RiskTab, Action Log) | 🔄 partial done 2026-06-02 — RiskTab exists (`routers/risk.py`): VaR/CVaR/Stress/Parity/Sizing; multi-period VaR (1D-6M) + parity bug fix done |
| **Equity Allocation Confluence Signal** (3-layer: A=sentiment, B=flow, C=structural) | ✅ done 2026-05-29 — `backend/analytics/` (5 modules) + `routers/allocation.py` (3 endpoints) + SQLite `allocation_signals` + ALLOCATION tab in Macro view |
| **Country Equity Rotation Signal** (3-layer: M=momentum, Q=macro quality, C=carry, 14 ETFs) | ✅ done 2026-05-29 — `backend/analytics/country_rotation.py` + `routers/country_rotation.py` (3 endpoints) + SQLite `country_rotation_scores` + ROTATION tab in Macro view |
| **Sector Selection Signal** (4-layer: BC+MOM+VAL+F, 11 SPDR ETFs, SECTOR tab) | ✅ done 2026-05-29 — plan at `plans/completed/sector-selection-signal.md`; `backend/analytics/` (5 modules) + `routers/sector.py` (4 endpoints) + SQLite `sector_signals` + SECTOR tab in Macro view |
| **Chart Data Range** — MAX period + default 3m + cache TTL 12h + range badge + loading skeleton | ✅ done 2026-05-29 — `plans/completed/chart-data-range.md` |
| **Alt+N Tab Shortcuts** — `useTabShortcuts` hook (MACRO/CRDT/PORT/NEWS), tab hint `⌥N`, AltGr-safe | ✅ done 2026-05-30 — `hooks/useTabShortcuts.ts` + 4 views wired |
| **Per-View Header Removal** — ลบ inner header ทุก view, subtitle → terminal-header centerSlot, ← ESC clickable | ✅ done 2026-05-30 — `terminal-header.tsx` + `bloomberg-terminal.tsx` + 8 views |
| **MACRO SIGNALS Tab** — 9→6 tabs; mktquality+allocation+rotation+sector → split-panel SIGNALS; CB+IPO drawers | ✅ done 2026-05-30 — `signals-tab.tsx` + `macro-view.tsx` |
| **Stock Analysis Nested Tab Shortcuts** (Alt+N outer, Alt+Shift+N inner) | ❌ not started — `plans/stock-analysis-tab-shortcuts.md` |
| **Regime Threshold Calibration** — RMT (k_signal/MP bound) สำหรับ GEOM + MRS 4-state HMM สำหรับ CORR + confidence % + 20d transition probs | ❌ not started — `plans/threshold-calibration.md` |
| Yield Curve Interpretation (5-dimension) | ❌ not started — planning |
| View-aware queries (don't fetch inactive views) | ❌ not started |
| Cache race condition fix (cache stampede) | ❌ not started |
| **Frontend: code splitting** (next/dynamic 9 views) | ✅ done 2026-05-22 — `bloomberg-terminal.tsx` lines 35-44: 9 lazy views + MarketView eager — plan moved to `completed/` |
| **Frontend: React.memo + Suspense + skeleton** | ✅ done 2026-05-22 — memo() ทุก view, `<Suspense>` wrap renderView(), ViewSkeleton CSS tokens |
| **Frontend: inline styles → constants** | 🔄 partial done 2026-05-22 — ViewSkeleton only; full extraction deferred (low ROI) |
| **Frontend: optimizePackageImports** (27 radix-ui + lucide-react + recharts) | ✅ done 2026-05-29 — `next.config.mjs` + `output: "standalone"` |
| **Frontend: bundle analyzer** (`@next/bundle-analyzer`) | ✅ done 2026-05-29 — `withBundleAnalyzer()` wrapper + `pnpm analyze` script |
| **Frontend: dead deps removal** (`@upstash/redis` + `yahoo-finance2`) | ✅ done 2026-05-29 — zero source imports, removed from `package.json` + lockfile + `serverExternalPackages` |
| **Frontend: view prefetch hook** (`useViewPrefetch`) | ✅ done 2026-05-29 — `prefetch()` + `prefetchOnHover()` (200ms debounce) + `prefetchTier1()` (requestIdleCallback) integrated in `bloomberg-terminal.tsx` |
| **Bloomberg CLI** (`bloomberg market/quote/portfolio/sectors/db/config`) | ❌ not started — plan at `plans/bloomberg-cli-mcp.md` |
| **Bloomberg MCP Server** (`bloomberg mcp`, 13 tools — Claude Desktop integration) | ❌ not started — plan at `plans/bloomberg-cli-mcp.md` |
| **Infra: Docker + docker-compose** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| **Infra: structlog → replace print()** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| **Infra: except: pass → logger + circuit breaker** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| **Infra: CI/CD GitHub Actions** | ✅ done 2026-06-03 — `.github/workflows/tests.yml`: backend pytest + frontend tsc on push/PR |
| **Infra: SQLite → PostgreSQL** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| **Infra: in-memory cache → Redis** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| **Infra: ThreadPoolExecutor semaphore + timeout** | ❌ not started — plan at `plans/infra/production-infrastructure.md` |
| Frontend view file splits (portfolio-view done) | 🔄 partial — portfolio/ done 2026-05-23, other views still monolithic |
| Type safety (remove `as any`) | 📋 low priority |
| **Algorithmic fixes — AF-1** (sorted→rolling pointer, portfolio backtest) | ✅ done 2026-05-22 — `portfolio.py`: pre-sort once O(S·K log K), pointer advance O(1) amortized |
| **Algorithmic fixes — AF-2** (O(M×T)→sweep-line, holdings timeline) | ✅ done 2026-05-22 — `backtest_v2.py`: by_entry sorted + active_trades set |
| **Algorithmic fixes — AF-3** (O(B×N)→bisect, histogram buckets) | ✅ done 2026-05-22 — `backtest_v2.py`: `bisect.bisect_left` replaces linear scan |
| **Algorithmic fixes — AF-4** (15-pass→single-pass, sector aggregates) | ✅ done 2026-05-22 — `market.py`: `_single_pass_aggregates()` helper |
| **Algorithmic fixes — AF-5** (useMemo 4-layer, GridTradingTab + StrategyFitTab) | ✅ done 2026-05-22 — `stock-view.tsx`: prices→stats→gridParams→sim→suit, calcHurst ไม่ rerun บน slider drag |
| **Computation optimization — Phase 3 Rust/WASM** (hurst-rs, grid-sim-rs, strategy-rs) | 📋 planned — only if AF-1~5 insufficient |

---

## Rules สำคัญ (ต้องรู้ก่อนแก้ code)

1. **อย่า fetch Yahoo Finance จาก Next.js** — ต้องผ่าน Python backend เสมอ
2. **อย่า reintroduce** `@upstash/redis` · `yahoo-finance2` · top-level scheduler singleton
3. **Endpoint ใหม่** → สร้างใน `backend/routers/` → `app.include_router()` ใน `main.py`
4. **View ใหม่** → atom → `useTerminalUI.ts` → `bloomberg-terminal.tsx` → `terminal-header.tsx`
5. **ห้าม rename** Jotai atom values · cache file names · env var names (cascade breakage)
6. **ห้ามเปลี่ยน API response shape** — frontend จะพัง
