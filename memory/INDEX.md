# Bloomberg Terminal — Memory Index

> **Navigation map only — no content here** (memory/AGENTS.md). Last rewritten 2026-09-26.

## Start here

1. [`project_summary.md`](project_summary.md) — how to run, tests, stack, env vars, 61 routers, DB schema, 6 views, known issues, plan list
2. [`AGENTS.md`](AGENTS.md) — writing rules for every file in `memory/` (read before writing)
3. [`reference/gotchas.md`](reference/gotchas.md) — read before investigating a bug
4. `sessions/INDEX.md` — what recent sessions changed (machine-local)
5. Repo root: [`../CLAUDE.md`](../CLAUDE.md) (rules, ports, upstream log, pattern cookbook) · [`../README.md`](../README.md) (user-facing overview)

## โครงสร้าง

```
memory/
├── INDEX.md              ← คุณอยู่ที่นี่
├── AGENTS.md             ← format + workflow rules
├── project_summary.md    ← slim core (tracked)
├── reference/            ← tracked in git
│   ├── architecture.md        data flow, routers, key files, accounting layer, CPU/RAM rules
│   ├── api-endpoints.md       every endpoint + caching + Next.js proxies
│   ├── frontend-structure.md  component tree, exports, shortcuts, TICK DATA board
│   ├── data-shapes.md         response shapes + TS interfaces (frontend hardcodes field names)
│   ├── gotchas.md             error dictionary, anti-patterns, "Where is X?", env var map
│   ├── terminal-commands.md   command mode (heatmap(US), ALERT, VIEW …)
│   └── data-catalog.md        data categories available for analysis
├── plans/                ← ⚠️ gitignored — machine-local (completed/ inside)
├── sessions/             ← ⚠️ gitignored — machine-local (INDEX.md + reports/)
└── reports/              ← ⚠️ gitignored — machine-local risk reports
```

> **`plans/` · `sessions/` · `reports/` are not in git** (`.gitignore` `memory/plans/`, `memory/sessions/`, `memory/reports/`). Each machine has different files, so a link below may point to a file that lives on the other machine — that does not mean it was deleted.

## Rules สำคัญ (ต้องรู้ก่อนแก้ code)

1. อย่า fetch Yahoo จาก Next.js — ผ่าน Python backend เสมอ; proxy ทุกตัว import `PYTHON_API` จาก `lib/constants.ts`
2. อย่า reintroduce `@upstash/redis` · `yahoo-finance2` · top-level scheduler singleton
3. Endpoint ใหม่ → `backend/routers/` → `app.include_router()` ใน `main.py` → proxy `app/api/…` → อัปเดต `reference/api-endpoints.md`
4. View ใหม่ → atom → `useTerminalUI.ts` → `bloomberg-terminal.tsx` (+ `viewHref`) → nav item
5. ห้าม rename Jotai atom values · cache file names · env var names; ห้ามเปลี่ยน response shape โดยไม่อัปเดต `data-shapes.md`
6. Fetch ใหม่ใช้ `requests`/yfinance (ถูก log ใน `logs/upstream.jsonl`) + negative-cache เมื่อ fail
7. แก้ข้อมูลเงินใน DB → สำรองก่อน (`backend/backups/`), ใส่ `_audit_context` reason, ไม่แก้ `trades` ตรงๆ ถ้ามี endpoint/script

## งานที่ยังเปิดอยู่ (plans)

| Plan | สถานะ |
|------|--------|
| [PORT Accounting Ledger](plans/port-accounting-ledger.md) | 🔄 reconstructed preview + checks; no posted journal / read switch |
| [PORT Accounting Subsystems](plans/port-accounting-subsystems.md) | 🔄 S0–S7 preparation; migration/activation pending |
| [PORT Evidence Match](plans/port-evidence-match.md) | 🔄 broker fills ↔ reconstructed trades |
| [Mobile Responsive](plans/mobile-responsive.md) | 🔄 shell nav + MKT first |
| [THESES readability + GRAPHS + sync](plans/theses-readability-and-sync.md) | 🔄 7/7 coded, font file pending |
| [Floating Chart Windows](plans/floating-chart-windows.md) | 🔄 phase 2 (TILE, snap, per-window indicators) |
| [IV SD Heatmap](plans/iv-sd-heatmap.md) · [VP Indicator Upgrade](plans/vp-indicator-upgrade.md) · [P/E History Pane](plans/pe-earnings-visualization.md) · [RSI Scale Modes](plans/rsi-scale-modes.md) | 🔄 code done, visual verify pending |
| [Pane Height Persistence Fix](plans/pane-height-persistence-fix.md) | 📋 planned (🔴 bug) |
| [CIRST](plans/corporate-ir-stress-testing.md) · [CIRST harness](plans/cirst-validation-harness.md) · [RATE STRESS tab](plans/cirst-stock-rate-tab.md) | 📋 planned / partial |
| [Port Redesign](plans/port-redesign.md) · [System Audit 2026-07](plans/system-audit-2026-07/README.md) · [Refactor backlog](plans/refactor-backlog.md) | 🔄 open items |
| [Bloomberg CLI + MCP](plans/bloomberg-cli-mcp.md) | 🔄 MCP server done, CLI not built |
| [Stock analysis nested tab shortcuts](plans/stock-analysis-tab-shortcuts.md) · [Data Source Contract](plans/data-source-contract.md) · [Scaling](plans/scaling/README.md) · [Infra](plans/infra/production-infrastructure.md) | 📋 planned |

Full list with one-line status: `project_summary.md` → "What Could Be Built Next".

## งานล่าสุด (2026-09-23 → 26)

- **2026-09-26 portfolio takeover** — Finansia 6065151/6065157 booked as an in-kind transfer at fair value on 2026-02-08 (commit `20b4294`); TWR start-of-day flows (`840ecaa`); details `reference/gotchas.md` → "A portfolio taken over is a transfer in kind"
- **2026-09-26 2024-25 reconciliation** — workbook `Downloads/Portfolio Reconciliation 2024-2025 v2.xlsx` (price-checked dates, AVCO replay, missing buys, cash books); 20 trades imported
- **2026-09-26 commit split** — the 2026-09-25/26 working tree landed as 17 topic commits `4d6df64..669bbeb` on `feat/port-accounting-ledger`

- [Terminal Navigation Accessibility](plans/completed/terminal-navigation-accessibility.md) — ✅ done 2026-09-26; menu numbering, Thai keyboard shortcuts, browser links; [session](sessions/2026-09-26-terminal-navigation-accessibility.md)
- [MKT Compact Chart Toolbar](plans/completed/mkt-compact-chart-toolbar.md) — ✅ done 2026-09-25; responsive timeframe + indicator controls
- [Multiple Regression Channels](plans/completed/multi-regression-channels.md) — ✅ done 2026-09-25; per-chart REG overlays
- [MKT IV 25Δ skew and curvature](sessions/2026-09-23-iv-smile-wing-metrics.md) — ✅ done 2026-09-23; observed quote metrics under IV smile
- [CFTC COT Positioning](plans/completed/cot-positioning.md) — ✅ done 2026-09-25; TAIL/BOND/MKT/stock/PORT + backtest (WEAK → context only); [session](sessions/2026-09-25-cot-positioning.md); [risks](reports/cot-session-risk-report.md)
- [PORT Accounting Subsystems](plans/port-accounting-subsystems.md) — 🔄 audit + replay/preflight preparation 2026-09-25; [session](sessions/2026-09-25-accounting-foundation.md); migration/activation ยังค้าง
- [PORT 2024-25 history DB backfill](sessions/2026-09-26-portfolio-history-db-backfill.md) — Excel-backed closed trades 20 posted, 145 proposals tracked; [original staging](sessions/2026-09-26-portfolio-history-reconciliation.md) and [bulk-import risk](reports/portfolio-excel-import-risk-report.md)
- [PORT accounting evidence phase](sessions/2026-09-25-accounting-evidence.md) — statement revisions/R3, cash EDIT category/R1/R2; no actual broker statement yet
- [Dime broker execution images](sessions/2026-09-25-dime-broker-execution-evidence.md) — 29 image-cited fills imported as audited evidence; cash/NAV unchanged
- [PORT cash-gap follow-up](sessions/2026-09-25-accounting-cash-gap.md) — user opening/transfer clarification, Dime wallet verification steps, H2 wording fixed; no money rows changed
- [PORT independent review handoff](sessions/reports/portfolio-independent-review-2026-09-25-report.md) — สแนปช็อต/ภาพหลักฐาน/ผลเทียบยอดและวิธีตรวจซ้ำให้ผู้ตรวจสอบภายนอก; source snapshot แยกสำหรับรีวิวโค้ด; [session](sessions/2026-09-25-portfolio-review-handoff.md)
- [PORT review revision 2](sessions/reports/portfolio-independent-review-2026-09-25-r2-report.md) — ยอด Dime หลัง 3 trades ใหม่จาก DB, snapshot ก่อน/หลังพร้อม SHA; ยังไม่มี broker post-trade statement; [session](sessions/2026-09-25-portfolio-review-r2.md)
- [PORT local agent review bundle](sessions/2026-09-25-portfolio-local-agent-review-bundle.md) — 34 source files ใหม่เฉพาะบัญชี, 10 integration paths+hashes, ไม่รวม project/DB; เปิด `backend/backups/portfolio-accounting-new-files-20260925/AGENT-REVIEW.md` บนเครื่อง
- [PORT review-ready staging](sessions/2026-09-25-portfolio-review-ready-staging.md) — `NEW` 34 + `MODIFIED` 11, patch/manifest, guarded apply สำหรับ checkout Git HEAD เดียวกัน; backend 98 tests + tsc ผ่าน
- [PORT Evidence Match](plans/port-evidence-match.md) — 🔄 2026-09-26; broker fills ↔ reconstructed trades, AUDIT → EVIDENCE
- [PORT Accounting Ledger](plans/port-accounting-ledger.md) — 🔄 verified backup + guarded apply + reconstructed stock-card/CHECK preview; ยังไม่สลับ read path
- [Accounting validation risks](reports/accounting-validation-risk-report.md) — H2/C1/N1 remain open; WAL backup and live-only NAV validation fixed
- [BOND view](plans/completed/bond-view.md) — ✅ done 2026-09-25; price vs supply (SEC deals, Treasury auctions, event study); [session](sessions/2026-09-25-bond-view.md)
- [Sector Rotation Map (RRG)](plans/completed/sector-rotation-map.md) — ✅ done 2026-09-25; RRG plot in MKT REGIME → ROT
- [PORT ANALYTICS redesign](plans/completed/port-analytics-redesign.md) — ✅ done 2026-09-25; dashboard + GROWTH view + PORTFOLIO ROTATION
- [Upstream event log (no UI)](plans/completed/upstream-event-log.md) — ✅ done 2026-09-24; log แทน alert bar + EM HY OAS removed
- [FRED timeout hardening](plans/completed/fred-timeout-hardening.md) — ✅ done 2026-09-24; retry + cap + redact api_key
- [Upstream health alerts](plans/completed/upstream-health-alerts.md) — ✅ done 2026-09-24; แจ้งเตือนเมื่อแหล่งข้อมูล/เน็ตมีปัญหา
- [TAIL readability + Yahoo request gate](plans/completed/tail-readability-yahoo-gate.md) — ✅ done 2026-09-24; UI กระชับ + cap Yahoo concurrency app-wide
- [TAIL Real Yields + Energy Crack Spreads](plans/completed/tail-real-yield-energy-spreads.md) — ✅ done 2026-09-24; TIPS decomposition + diesel/gasoline/3-2-1 crack + roll mask
- [TAIL Market Event Classifier](plans/completed/tail-event-classifier.md) — ✅ done 2026-09-24; ชื่อเหตุการณ์ทางการจากช็อกข้ามสินทรัพย์ + MOVE alignment fix
- [Latest Daily Candle Recovery](plans/completed/latest-daily-candle-recovery.md) — ✅ done 2026-09-23; [verification/session](sessions/2026-09-23-latest-daily-candle-recovery.md)
- [Chart history refresh risk](reports/chart-history-refresh-risk-report.md) — กราฟที่เปิดค้างอาจไม่ refetch เมื่อ quoteDate เปลี่ยน
- [Extended-Hours Candle Price Line](plans/completed/extended-hours-candle-price-line.md) — ✅ done 2026-09-23; [verification/session](sessions/2026-09-23-extended-hours-candle-price-line.md)
- [TICK DATA Section Order](plans/completed/tickdata-section-order.md) — ✅ done 2026-09-23; [verification/session](sessions/2026-09-23-tickdata-section-order.md)
- [WATCHLIST Shared Data Optimization](plans/completed/watchlist-shared-data-optimization.md) — ✅ done 2026-09-23; [verification/session](sessions/2026-09-23-watchlist-shared-data-optimization.md)
- [WATCHLIST API Management Study](plans/completed/watchlist-api-management-study.md) — ✅ study done 2026-09-23; implementation ดู WATCHLIST Shared Data Optimization
- [WATCHLIST API report](reports/watchlist-api-management-study-2026-09-23.md) — list เดียวขนาดใหญ่, signals, shared service/queues/retry พร้อม mock evidence
- [WATCHLIST API risks](reports/watchlist-api-management-risk-report.md) — Retry-After, cooldown, negative cache และ consumers ที่โหลดซ้ำ
- [WATCHLIST Optimization Study](plans/completed/watchlist-optimization-study.md) — ✅ study done 2026-09-23; implementation ดู WATCHLIST Shared Data Optimization
- [WATCHLIST study report](reports/watchlist-optimization-study-2026-09-23.md) — คอขวด, measured evidence, multiple lists และ phased roadmap
- [WATCHLIST risk report](reports/watchlist-optimization-risk-report.md) — period fallback, silent caps, stampede, mutation/scope และ frontend500
- [Neocloud three-year accounting review](plans/completed/neocloud-three-year-accounting-review.md) — ✅ done 2026-09-19; รายชื่อเดิมและค้นเพิ่มทั่วโลก พร้อมช่องว่างหลักฐาน
- [Neocloud accounting review — session](sessions/2026-09-19-neocloud-accounting-review.md) — audit trail และ MCP receipts
- [Neocloud accounting report ภาษาไทย](../research/neocloud-audit-2026-09-19/neocloud-accounting-review-th.html) — รายงานฉบับเต็ม 34 โปรไฟล์
- [BBW squeeze audit 2026-09-09](reports/bbw-squeeze-2026-09-09-risk-report.md) — ทบทวน study เดิม: พบ label/benchmark/purge และการตีความผิด; E2 ranking signal ยังอยู่หลังตรวจแก้ cohort

## ต้องการรู้เรื่องอะไร → อ่านที่ไหน

| ต้องการ | ไฟล์ |
|---------|------|
| **SNDK financial review + NAND cycle** — MCP/SEC reconciliation, thesis questions and watch conditions (2026-09-18) | `sessions/reports/sndk-financial-cycle-2026-09-18-report.md` |
| **SNDK financial field mapping risks** — AP/accruals, fiscal dates, margin periods and FCF definitions | `reports/sndk-financial-field-mapping-risk-report.md` |
| **MCP — ให้ agent อ่าน/แก้ THESES + ดึง portfolio/ราคา/ข่าว** (setup Claude Code + Desktop, tools, guard rails) | `../docs/mcp-server.md` |
| **Heatmap tile silent drop** — a throttled quote disappears instead of erroring | `reports/heatmap-tile-silent-drop-risk-report.md` |
| **Windows NEWS API recovery** — stale backend caused DCF/REGIME 404 and SVI 405 ✅ done 2026-09-13 | `plans/completed/windows-news-api-reload.md` |
| **Windows stale-backend risk** — restart Python after pulling backend changes | `reports/windows-news-stale-backend-risk-report.md` |
| **Adaptive DCF Valuation Lab** — multi-model quant DCF ใน NEWS/stock-view ✅ done 2026-09-13 | `plans/completed/dcf-valuation-lab.md` |
| **DCF valuation risks** — currency mismatch, WACC missingness, terminal guard and symbol identity | `reports/dcf-valuation-risk-report.md` |
| **MKT IV Open Interest** — optional OI strike profile ✅ done 2026-09-13 | `plans/completed/mkt-iv-open-interest.md` |
| **MKT IV OI risks** — source missingness, units and dense-grid bars | `reports/mkt-iv-oi-risk-report.md` |
| **MKT SVI Fit and Tenors** — optional Raw SVI and multiple monthly expiries ✅ done 2026-09-13 | `plans/completed/mkt-svi-fit-tenors.md` |
| **MKT SVI Fit risks** — query identity, variance units and slice limitations | `reports/mkt-svi-fit-risk-report.md` |
| **MKT IV Smile** — REGIME IV tab following chart symbol ✅ done 2026-09-13 | `plans/completed/mkt-iv-smile.md` |
| **ATR Accumulation Pane** — optional green/red ATR with volatility + trend definition ✅ done 2026-09-13 | `plans/completed/atr-accumulation-pane.md` |
| **Bollinger Sharpe Fit** — optional Breakout %B grid fit ✅ done 2026-09-13 | `plans/completed/bollinger-sharpe-fit.md` |
| **กฎการเขียน report / format / workflow** | **`AGENTS.md`** |
| วิธี run app (2 terminals, env vars) | `reference/architecture.md` → "Running the app" |
| Tech stack, API endpoints ทั้งหมด, DB schema | `project_summary.md` |
| Keyboard shortcuts (`1`–`5`, `b` `p` `t` `h`, `/`, `y`, `i`, `Alt+N`) | `project_summary.md` → "Global keyboard shortcuts" |
| Key file paths (atoms, hooks, chart) | `reference/architecture.md` → "Key files" |
| วิธีเพิ่ม view / endpoint ใหม่ | `reference/architecture.md` → "Navigation" + "Backend layout" |
| Known bugs / limitations | `project_summary.md` → "Known Issues" |
| อะไร reintroduce ไม่ได้ (CPU/RAM) | `reference/architecture.md` → "CPU/RAM issues resolved" |
| **Dynamic Chart History** (ซูมออก → กราฟโหลด period ถัดไปเอง, viewport ไม่กระโดด; lib `chartkit/`) ✅ done 2026-08-25 | `plans/completed/dynamic-chart-history.md` |
| **Floating Chart Windows** (popup กราฟลอยอิสระหลายตัว: drag/resize/minimize/z-order, cap 10, persist, ข้าม view) ✅ เฟส 1 done 2026-08-24 · เฟส 2 (TILE + snap, indicator แยกต่อหน้าต่าง) ค้าง | `plans/floating-chart-windows.md` |
| **BBW Squeeze Hazard Study** (rank252 < 0.30; model ชนะกฎเดิม +24% บน label E2 แต่ label control E3 พลิกเครื่องหมาย — squeeze = vol mean-reversion ไม่ใช่ breakout) ✅ done 2026-09-09 | `plans/completed/bbw-squeeze-hazard.md` |
| **IV SD Heatmap** (BS lognormal σ-band pane −2σ…+2σ จาก ATM IV mid; occupancy / cheapness; `iv_snapshots` สะสมเอง) 🔄 code done, pixel verify ค้าง | `plans/iv-sd-heatmap.md` |
| **Thesis Notes** (sub-tab NOTES: scenario/risk/catalyst ที่แก้ได้ + L×S + watch date + resolve → NOTE_RESOLVED event) ✅ done 2026-08-31 | `plans/completed/thesis-notes.md` |
| **Thesis System (DB) + Allocation Basis** (thesis เก็บใน SQLite + sync Drive + event log; ALLOCATION (OPEN) cost-vs-market + rebalance sizing) ✅ done 2026-08-15 | `plans/completed/thesis-db-and-allocation-basis.md` |
| **Company OUTLOOK จาก SEC EDGAR** (guidance + คำพูด CEO + งบ as-reported XBRL) ✅ done 2026-08-15 | `plans/completed/company-outlook-edgar.md` |
| **Polymarket stock price ladders** (P(up)/skew รายหุ้น ใน NEWS + คอลัมน์ PM ใน MKT) ✅ done 2026-08-15 | `plans/completed/polymarket-stock-ladder.md` |
| **NEWS watchlist redesign** (7 news sources ต่อหุ้น, แบ่ง sector อัตโนมัติ, Polymarket per-symbol) ✅ done 2026-08-15 | `plans/completed/news-watchlist-redesign.md` |
| งาน GMOV view (ทำเสร็จแล้ว) | `plans/completed/gmov-enhancement.md` |
| **PORT: Sell system + Dividend auto-fill + Y key** (ทำเสร็จแล้ว) | `plans/completed/portfolio-sell-dividend-y-key.md` |
| **PORT Analytics: Dividend M/Q/Y, stacked allocation timeline, currency fix** | ✅ done 2026-06-05 — `plans/completed/analytics-charts-enhancement.md` |
| **Trade Edit System + Sector Standardization** (ทำเสร็จแล้ว) | `plans/completed/trade-edit-and-sector-standard.md` |
| **Option Payoff Simulator** (พรีวิวสดในฟอร์ม ADD + ปุ่ม PAYOFF ในแถว lot; expiry=เลขคณิต client-side, T+0=BS, POP=lognormal; BE จาก sign change, max P/L จาก slope) ✅ done 2026-09-10 | `plans/completed/option-payoff-simulator.md` |
| **Option Edit + Portfolio Cash** (cash derived ที่ `/summary` รวม option ทั้ง realized และ open cost; EDIT option trade + re-match + audit log; cash ที่ SummaryBar/CASH/ANALYTICS) ✅ done 2026-09-10 | `plans/completed/option-edit-and-portfolio-cash.md` |
| **Option Schema Normalization** (contracts/trades/trade_greeks/trade_matches; FIFO partial close; lot เป็น view ไม่ใช่ตาราง; greeks ตอนซื้อ/ขาย; DROP option_positions) ✅ done 2026-09-10 | `plans/completed/option-schema-normalization.md` |
| **Option Greeks + PnL Attribution** (Δ/Γ/Θ ต่อสัญญา + dollar greeks USD; `option_greeks_snapshots` รายวัน → attribution Δ/Γ/Θ/ν/residual ด้วย greeks ต้นงวด; ANALYTICS DERIVATIVES) ✅ done 2026-09-09 | `plans/completed/option-greeks-and-attribution.md` |
| **Options in Portfolio** (premium MV เข้า NAV + delta notional ถ่วง allocation; `portfolio_options.py` เป็น single source; schema exit_price/currency/multiplier; greeks spot bug fix 🔴) ✅ done 2026-09-09 | `plans/completed/options-in-portfolio.md` |
| **Port Redesign** (symbol resolver at-write, sub_portfolios table, currency module, ปิด F06) 🔄 | `plans/port-redesign.md` |
| **Multi-Currency Sub-Portfolio** (instrument ccy authoritative, per-trade rollup, hybrid historical/live FX, ECON attribution) ✅ done 2026-07-14 | `plans/completed/multi-currency-portfolio.md` |
| **Bloomberg CLI + MCP Server** (`bloomberg market/portfolio/mcp`, 13 MCP tools) | `plans/bloomberg-cli-mcp.md` |
| **Portfolio Risk Management System** (VaR/CVaR/Greeks/Stress, RiskTab, Action Log) | `plans/portfolio-risk-system.md` |
| **Corporate IR Stress Testing (CIRST)** (bottom-up firm-level rate shock: EaR → Merton PD → ΔWACC/ΔEV, ES/Euler, IR-Stress Score) 📋 planned | `plans/corporate-ir-stress-testing.md` |
| **CIRST Validation Harness** (5-yr PIT backtest, null models, float-share inference, calibration/IC/DM gates) 📋 planned | `plans/cirst-validation-harness.md` |
| **CIRST RATE STRESS tab** (stock-view sub-tab 5 อัน: EXPOSURE/SCENARIO/DURATION/HISTORY/DIAGNOSTICS — เข้าจาก NEWS, มีตารางทฤษฎี-vs-จริง) 📋 planned | `plans/cirst-stock-rate-tab.md` |
| **Adaptive DCF Valuation Lab** (3-stage FCFF default + growth/FCFE/excess-return/AFFO/cycle adapters; quant assumptions, sensitivity and audit; shared NEWS/stock panel) ✅ done 2026-09-13 | `plans/completed/dcf-valuation-lab.md` |
| **Data Source Contract** (canonical models + OHLCVFrame migration fix + Dividends fix + cache clear) | ✅ Phase A+B partial done — `plans/completed/data-source-contract.md`; Phase B remainder in `plans/data-source-contract.md` |
| **Quant Market State (per-symbol REGIME)** (OHLCV → HMM → regime probability + trend/momentum/volatility score + strategy compatibility; panel ใน NEWS ข้าง RATE STRESS) ✅ done 2026-09-13 | `plans/completed/market-state-regime.md` |
| **Volume Z-Score + Volume Event Classifier** (RVOL baseline mean→median/MAD บน ln(V) + cum-session mode; classifier 6 event types เป็น chip บน price pane + ตาราง fwd return) ✅ done 2026-09-13 | `plans/completed/volume-zscore-events.md` |
| **Pane Height Persistence Fix** (pane ยุบ 0 + drag ไม่ persist ข้าม reload) 📋 | `plans/pane-height-persistence-fix.md` |
| **TICK DATA Consolidation** (RATES·US/JP curve + FX เข้า MKT tick board, ลบ CRYP/FX views) ✅ done 2026-08-01 | `plans/completed/tickdata-rates-fx-consolidation.md` |
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
| **US/JP bond curves** (`/api/rates/curve`, UST 11 tenor FRED + JGB 15 tenor MOF, ทำไม yfinance ใช้ไม่ได้) | `reference/api-endpoints.md` → Rates; shape ใน `reference/data-shapes.md` |
| **TICK DATA board** (7 sections, ยุบและจัดลำดับเองได้, จำลำดับ, bp vs %chg) | `reference/frontend-structure.md` → "MKT — TICK DATA board" |
| **Ctrl+C แล้ว dev:all ขึ้น traceback** | `reference/gotchas.md` → "npm run dev:all dumps a scary traceback" |
| Data catalog — ข้อมูลทั้งหมดที่ดึงได้ 17 หมวด | `reference/data-catalog.md` |
| **SEC Thailand API** — endpoints, key config, One Report structure (old portal closed 2026-06-30) | `reference/api-endpoints.md` → SEC sections |
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
| 6 views — MKT · NEWS · BOND · PORT · TAIL · HMAP + TICK DATA board | `project_summary.md` → "Frontend Views" (also `CLAUDE.md` → Views) |
| session X ทำอะไร / ไฟล์ไหนเปลี่ยน | `sessions/INDEX.md` |
| **OPTIONS Greeks math derivation + bug log** | `reports/options-greeks-math-report.md` |
| **Strategy Builder** (19 templates, multi-expiry Calendar/Diagonal, payoff w/ BS pricing, PoP/E[P&L]/Kelly ranking) | ✅ done 2026-06-08 — `plans/completed/strategy-builder.md` |
| **Regime Calibration math audit** — RMT/MRS verified, 2 critical bugs found + fixed (k_signal→label, conflict detection) | `reports/regime-calibration-math-report.md` |
| **รัน backend unit tests** | `cd backend && python -m pytest tests/ -v` |
| **CI/CD workflow** | `.github/workflows/tests.yml` |
| **Portfolio takeover (in-kind transfer)** — fair value basis, previous owner's cost memo, TAKEOVER strip | `reference/gotchas.md` + `reference/data-shapes.md` → takeover |
| **Dev status strip / stale backend** — RUNNING OLD CODE / BACKEND DOWN | `../CLAUDE.md` + `project_summary.md` → How to Run |
| **Upstream failures (data missing/stale)** | `../CLAUDE.md` → "Data missing / stale" + `python backend/scripts/upstream_report.py` |

> The feature-status table that lived here (frozen 2026-08-01) was removed on 2026-09-26; history is in `plans/completed/` and in `project_summary.md` → Done.
