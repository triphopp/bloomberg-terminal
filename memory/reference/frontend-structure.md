# Frontend Structure Reference

**Last updated:** 2026-06-06

> **See also:** [data-shapes.md](data-shapes.md) — TypeScript interfaces + API response shapes | [api-endpoints.md](api-endpoints.md) — all backend endpoints | [architecture.md](architecture.md) — backend file structure | [gotchas.md](gotchas.md) — "Where is X?" lookup + anti-patterns

---

## Component Tree

```
components/bloomberg/
├── layout/
│   ├── bloomberg-terminal.tsx   ← root view router (9 views)
│   ├── terminal-header.tsx      ← top nav bar + view buttons
│   ├── terminal-layout.tsx      ← keyboard shortcut binding wrapper
│   └── terminal-filter-bar.tsx  ← watchlist filter
│
├── views/
│   ├── market-view.tsx          ← MKT: watchlist + chart + global indices + Regime panel
│   ├── news-view.tsx            ← barrel → views/news/index.tsx (kept for the dynamic import path)
│   ├── news/                    ← NEWS view (2026-08-15 redesign)
│   │   ├── index.tsx            ← shell: WATCHLIST | NEWSFEED | SOCIAL tabs + shared Polymarket column
│   │   ├── watchlist-tab.tsx    ← sector rail (click sector → symbol chips) + article stream
│   │   │                          (group: SECTOR/TICKER/TIME · match: NAMED/ALL NEWS · sentiment · source toggles)
│   │   ├── newsfeed-tab.tsx     ← topic newswire (was the FEED tab)
│   │   ├── social-tab.tsx       ← X/YouTube/Reddit/RSS handles
│   │   ├── polymarket-column.tsx← {SYM} IMPLIED ladder + WATCHLIST MARKETS + MACRO SIGNALS + search
│   │   ├── prediction-ladder.tsx← implied distribution panel (CLOSE ABOVE CDF + TOUCH LADDER)
│   │   ├── useWatchlistNews.ts  ← useWatchlistSymbols() (pins atom → localStorage fallback) + React Query
│   │   ├── constants.ts / helpers.ts / types.ts
│   ├── market-movers-view.tsx   ← GMOV: global indices table + heatmap treemap
│   ├── clippings-view.tsx       ← CLIP: Obsidian reader + Ollama AI panel
│   ├── macro-view.tsx           ← MACRO shell (911 ln): dashboard/yield/indicators/fed inline + country/signals imported. (2026-06-10: split, dead MarketQualityTab cluster deleted)
│   ├── macro/shared.tsx         ← SectionHeader (shared across macro tabs)
│   ├── macro/country-tab.tsx    ← CountryMacroTab + World Bank charts + country constants (POPULAR_COUNTRIES, WB_CATEGORIES, fmtWbVal)
│   ├── credit-view.tsx          ← CRDT: 4 tabs (overview/spreads/stress/consumer)
│   ├── stock-view.tsx           ← Equity analysis (9 tabs) — no nav button, via search/heatmap
│   ├── pinned-assets.tsx        ← Pinned assets sidebar
│   ├── rotation-tab.tsx         ← COUNTRY EQUITY ROTATION tab (inside macro-view SIGNALS)
│   ├── sector-tab.tsx           ← SECTOR SELECTION tab (inside macro-view SIGNALS)
│   ├── options-tab.tsx          ← stock-view OPTIONS tab: chain, strategies (10 auto-scan), builder, greeks, vol surface
│   ├── strategy-builder.tsx    ← Strategy Builder: 19 templates, multi-expiry (Calendar/Diagonal), BS payoff, leg editor
│   ├── ui-primitives.tsx        ← shared UI primitives (created, not yet migrated to all views)
│   │
│   └── portfolio/               ← PORT: barrel re-export from portfolio-view.tsx
│       ├── index.tsx            ← PortfolioView shell: account tabs, summary bar, 4 top-level tabs (Alt+1-4) + context-sensitive sub-tab bar
│       ├── types.ts             ← all interfaces; Trade/Dividend expose native currency + additive `*_base` report-currency fields
│       ├── helpers.ts           ← fmt, fmtK, fmtPct, pnlColor, wlColor, groupKey, FLAG
│       ├── constants.ts         ← ALL_COLS, DEFAULT_COLS, DENSE_COLS, TH_SECTORS (34), US_SECTORS (11),
│       │                           GROUP_COLORS, FINANSIA_SUBS, ALLOC_COLORS, SECTOR_COLORS
│       ├── ui/
│       │   ├── AccBadge.tsx     ← AccBadge, WLBadge
│       │   └── SummaryBar.tsx   ← top summary; broker-style total P&L plus secondary ECON FX-inclusive attribution
│       ├── modals/
│       │   ├── SellModal.tsx    ← sell / partial-sell modal
│       │   └── TradeEditModal.tsx ← trade edit modal (17 fields, bulk-patch-sector)
│       └── tabs/
│           ├── OpenPositionsTab.tsx  ← positions table: DENSE, COLS picker, SELL/EDIT, grouped lots, instrument-currency badge + backend-normalized report totals
│           ├── OptionsTab.tsx        ← options positions + live Greeks (Black-Scholes + Gram-Charlier)
│           ├── TradeLogTab.tsx       ← trade history with filter + WLBadge; dated `amount_base`/`pnl_base` display
│           ├── CashTab.tsx           ← cash flow CRUD + currency-aware dividends CRUD + Finansia subs
│           ├── AnalyticsTab.tsx      ← report-currency P&L/allocation/dividend charts (M/Q/Y); broker-style P&L plus ECON FX attribution tooltips
│           ├── BacktestTab.tsx       ← backtest v2 (4 sub-tabs: equity/holdings/distribution/attribution)
│           ├── RiskTab.tsx           ← 2 sub-tabs: OVERVIEW (dense col layout: header/9-stat/VaR+chart+EWS) | OPTIONS risk
│           ├── ThesesTab.tsx         ← barrel → tabs/theses/
│           ├── theses/                ← DB-backed thesis system (CRUD + history)
│           │   ├── index.tsx          ← rail + detail + sub-tabs THESIS|HISTORY|LINKED TRADES|AI
│           │   ├── ThesisRail.tsx     ← grouped category → sub-portfolio → symbol
│           │   ├── ThesisEditor.tsx   ← form + markdown editor/preview
│           │   ├── ThesisTimeline.tsx ← thesis_events feed + manual notes
│           │   ├── markdown.tsx       ← renderMarkdown
│           │   └── types.ts
│           └── ImportTab.tsx         ← Excel drag-drop + manual form (IS OPTION checkbox, VAT field)
│
├── chart/
│   ├── ModularChart.tsx         ← reusable chart container (candle + overlay/pane indicators + event rail). No `createSeriesMarkers` — events are drawn by the rail overlay. `onBarClick(time, ctx)` reports every marker within 2 bars of the click + viewport coords
│   ├── event-rail-overlay.ts    ← CanvasOverlay drawing labelled chips on a fixed row at the bottom of the price pane: `$` dividend, `E+`/`E-`/`E?` earnings, `x10` split, `···N` cluster. `clusterChips()` + `eventChipStyle()` are pure and tested
│   ├── EventDetailPopover.tsx   ← detail card for clicked events: EST vs ACTUAL EPS + BEAT/MISS, dividend amount + yield, split ratio, gap/close/D+1/D+5 reaction. Opens on a list when a cluster is clicked. Closes on Escape or an outside click
│   ├── event-reaction.ts        ← pure helpers: `earningsSession()` (BMO/AMC off `reportedAt`), `findEventBarIndex()` / `placeEvents()` (single placement rule shared by the rail and the card), `computeEventReaction()`. Tested in `__tests__/event-reaction.test.ts`
│   ├── ChartTimeframeBar.tsx    ← period selector (1D/1W/1M/3M/YTD/1Y/5Y/MAX)
│   ├── IndicatorPicker.tsx      ← technical indicator selector (number params + `type:"select"` dropdown params)
│   ├── FearGreedPane.tsx        ← recharts sub-pane (F&G 0–100 + zone bands)
│   ├── PEPane.tsx               ← recharts sub-pane: trailing P/E line + p10/p90 valuation bands + percentile label (consumes /api/stock/pe-history)
│   ├── useChartIndicators.ts    ← indicator/overlay state; exposes vpConfig, showPE via atoms, plus `selectedEvent`/`clearSelectedEvent` for the detail card. Regression arming wins the click when both could claim it
│   ├── indicators/volume-profile.ts ← session+composite VP (gap-based sessions, delta, naked POC, HVN/LVN, VRVP)
│   ├── indicators/rv-core.ts        ← realized-vol math shared by the 3 RV panes: `calcRealizedVol(bars, period, estimator, periodsPerYear)` (cc/parkinson/gk/rs/yz, returns ANNUALISED %), `inferPeriodsPerYear()` (median bar spacing → 252/52/12 or 252×bars-per-session), `rollingPercentRank()`. Tested in `__tests__/rv-core.test.ts`
│   ├── indicators/realized-vol.ts   ← RV pane: 3 windows at once (5/21/63 default, 0 hides a line), estimator select
│   ├── indicators/rv-rank.ts        ← RV percentile rank pane (RV window 21 vs 252-bar lookback), zone-coloured histogram + 50 midline
│   └── indicators/rv-ratio.ts       ← RV(fast)/RV(slow) realized term structure pane, 1.0 reference line, expansion/compression thresholds
│
├── ui/
│   ├── CandlestickChart.tsx     ← custom OHLC candlestick chart
│   ├── market-table.tsx / market-row.tsx / market-section.tsx
│   ├── sparkline.tsx / sparkline-cell.tsx
│   ├── ai-market-analysis.tsx
│   └── general-market-analysis.tsx
│
├── terminal/                    ← command language engine (Lexer→Parser→Registry→Executor)
│   ├── types.ts                 ← Token, AstNode, CommandDef, CommandResult, TerminalCtx
│   ├── lexer.ts                 ← tokenize(raw) → Token[]
│   ├── parser.ts                ← parse(raw) → ParseResult (AstNode | error)
│   ├── validator.ts             ← validate arg count + types
│   ├── registry.ts              ← ALL_COMMANDS, CMD_MAP — 9 nav + 7 setting + 3 info + 10 analysis
│   ├── executor.ts              ← executeAst(ast, ctx, signal) AbortController-safe
│   ├── autocomplete.ts          ← getSuggestions(), isCommandInput() exact-first-word match
│   └── index.ts                 ← public re-exports
│
├── core/
│   ├── bloomberg-button.tsx
│   ├── confirmation-modal.tsx
│   ├── global-search.tsx        ← search overlay (/ or Ctrl+K) — terminal engine + stock search
│   ├── keyboard-shortcuts.tsx   ← shortcuts help panel
│   ├── shortcut-indicator.tsx
│   ├── theme-toggle.tsx
│   └── watchlist.tsx
│
├── hooks/
│   ├── useTerminalUI.ts         ← view navigation handlers
│   ├── useMarketData.ts / useMarketDataQuery.ts
│   ├── useStockData.ts
│   ├── useSectorSelection.ts    ← sector selection signal hook
│   ├── useWatchlistSignals.ts   ← batch daily technical scan for the watchlist
│   ├── useRatesCurve.ts         ← /api/rates → UST + JGB curves for the TICK DATA board (`RateRowData`)
│   ├── useFxTicks.ts            ← /api/fx overview for the TICK DATA FX section (`FxPair`)
│   ├── useAiMarketAnalysis.ts
│   └── index.ts
│
├── atoms/
│   ├── index.ts                 ← Jotai atoms (currentViewAtom + all others)
│   └── terminal-ui.ts
│
└── lib/
    ├── theme-config.ts          ← bloombergColors (dark/light)
    ├── marketData.ts            ← static fallback market data
    ├── market-utils.ts / currency-utils.ts / time-utils.ts
    └── constants.ts             ← shared constants (ALL_COLS etc.)
```

---

## Key Exports per File

| File | Exports |
|------|---------|
| `atoms/index.ts` | `currentViewAtom`, `searchQueryAtom`, `selectedSymbolAtom`, `watchlistAtom`, all view atoms |
| `hooks/useTerminalUI.ts` | `useTerminalUI()` → `{ currentView, handleKeyPress, ... }` |
| `layout/bloomberg-terminal.tsx` | `BloombergTerminal` (default) |
| `layout/terminal-header.tsx` | `TerminalHeader` |
| `portfolio/index.tsx` | `PortfolioView` (default) |
| `portfolio/types.ts` | `Trade`, `Account`, `CashEntry`, `Dividend`, `Summary`, `BacktestMetrics`, `ThesisData`, `OptionPosition` |
| `portfolio/helpers.ts` | `fmt`, `fmtK`, `fmtPct`, `pnlColor`, `wlColor`, `groupKey`, `FLAG`, `Colors` |
| `portfolio/constants.ts` | `ALL_COLS`, `DEFAULT_COLS`, `DENSE_COLS`, `TH_SECTORS` (34), `US_SECTORS` (11), `GROUP_COLORS`, `FINANSIA_SUBS`, `ALLOC_COLORS`, `SECTOR_COLORS`, `BLANK_CASH`, `BLANK_DIV`, `BLANK_FORM`, `STRATEGIES` |
| `portfolio/ui/AccBadge.tsx` | `AccBadge`, `WLBadge` |
| `portfolio/ui/SummaryBar.tsx` | `SummaryBar` |
| `portfolio/tabs/AnalyticsTab.tsx` | `AnalyticsTab` — CAPM card: β HEDGE / HEDGE notional / β REAL / vs IDX / α CAPM / t / R² / N; rf chip เปิดแผงตั้งค่า (override ต่อสกุลใน `localStorage["bloomberg_capm_rf"]`) |
| `portfolio/ui/AllocationBasisCard.tsx` | `AllocationBasisCard`, `AllocRow` — ALLOCATION (OPEN) cost-vs-market card (COST/VALUE/DRIFT modes + rebalance table) |
| `portfolio/tabs/theses/index.tsx` | `ThesesTab` (props: `colors`, `accountId`, `initialSymbol`, `onConsumeInitialSymbol`) |
| `portfolio/tabs/theses/types.ts` | `Thesis`, `ThesisStatus`, `ThesisEvent`, `ThesisLink`, `STATUSES`, `STATUS_COLOR`, `CATEGORIES`, `HORIZONS`, `STRATEGIES` |
| `portfolio/tabs/theses/ThesisRail.tsx` | `ThesisRail` |
| `portfolio/tabs/theses/ThesisEditor.tsx` | `ThesisEditor`, `ThesisDraft`, `emptyDraft`, `draftFrom` |
| `portfolio/tabs/theses/ThesisTimeline.tsx` | `ThesisTimeline` |
| `portfolio/modals/SellModal.tsx` | `SellModal` |
| `portfolio/modals/TradeEditModal.tsx` | `TradeEditModal` |
| `portfolio/tabs/OpenPositionsTab.tsx` | `OpenPositionsTab` (prop `onOpenThesis` → TH / +TH badge jumps to TOOLS → THESES) |
| `portfolio/tabs/RiskTab.tsx` | `RiskTab` |
| `views/market-view.tsx` | `MarketView` (default), `KeyIndicatorsBar` |
| `views/news-view.tsx` | re-export of `views/news/index.tsx` |
| `views/news/index.tsx` | `NewsView` (default) |
| `views/news/watchlist-tab.tsx` | `WatchlistNewsTab` |
| `views/news/newsfeed-tab.tsx` | `NewsFeedTab` |
| `views/news/social-tab.tsx` | `SocialTab` |
| `views/news/polymarket-column.tsx` | `PolymarketColumn`, `ProbBar` |
| `views/news/useWatchlistNews.ts` | `useWatchlistSymbols()`, `useWatchlistNews()` |
| `views/news/prediction-ladder.tsx` | `PredictionLadder` |
| `hooks/useStockPredictions.ts` | `useStockPrediction()`, `useStockPredictionSummaries()`, `probColor()` + prediction types |
| `hooks/useCompanyOutlook.ts` | `useCompanyOutlook()`, `useCompanyXbrl()`, `useCompanyFilings()`, `isUsListing()`, `shortMetric()` |
| `core/company-outlook-panel.tsx` | `CompanyOutlookPanel` (`variant="full"` = stock-view OUTLOOK tab · `"compact"` = NEWS column strip) |
| `views/macro-view.tsx` | `MacroView` (default) |
| `views/rotation-tab.tsx` | `RotationTab` (default) |
| `views/sector-tab.tsx` | `SectorTab` (default) |
| `hooks/useSectorSelection.ts` | `useSectorSelection()` → `{ signal, isLoading, error }` |
| `hooks/useWatchlistSignals.ts` | `useWatchlistSignals(symbols)` → `{ signals, errors, isLoading, refetch }`; types `WatchlistSignal`, `TrendState`, `RsiState`, `MacdState`, `BreakoutState` |
| `lib/constants.ts` | `PYTHON_API` (base URL) |
| `lib/theme-config.ts` | `bloombergColors`, `darkTheme`, `lightTheme` |

---

**Deleted (no longer in codebase):**
- `rmi-view.tsx` + `rmi-chart.tsx` — removed 2026-05-24
- `volatility-view.tsx` — removed 2026-05-21 (still exists as file but not routed)

---

## Global Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `1`–`6` | Navigate views: MKT(1), NEWS(2), GMOV(3), CLIP(4), MACRO(5), CRDT(6) |
| `P` | Portfolio view |
| `C` | *(free — was Crypto until 2026-08-01)* |
| `E` | *(free — was FX until 2026-08-01)* |
| `Alt+1`–`Alt+N` | Switch sub-tab within current view (MACRO 1-7, CRDT 1-4, PORT 1-8, NEWS 1-2) |
| `/` or `Ctrl+K` | Open global search |
| `Esc` / `← ESC` button | Back to market/home |
| `Ctrl+R` | Refresh data |
| `Y` | Toggle %Chg YTD / Daily (non-PORT) or THB/USD (PORT) |
| `Ctrl+Shift+T` | Toggle Area / Candlestick chart |
| `Ctrl+N` | New watchlist |
| `?` (Shift) | Show shortcuts help |
| `i` | Focus heatmap symbol search |

---

## Adding a New View

1. Add atom value in `atoms/index.ts`
2. Add handler in `hooks/useTerminalUI.ts`
3. Add view block in `layout/bloomberg-terminal.tsx`
4. Add nav button in `layout/terminal-header.tsx`


---

## MKT — TICK DATA board (`views/market-view.tsx`)

The right-hand `tickdata` panel is a cross-asset board, not just world indices. Six sections, each
collapsible; collapse state persists in `localStorage["bloomberg_tickdata_sections"]`
(default collapsed: `ratesJP`, `fx` — 35 extra rows on first open is a wall).

Render order top-to-bottom: **RATES · US → RATES · JP → AMERICAS → EMEA → ASIA PACIFIC → FX**
(rates pinned to the top since they're the reason the board grew from 3 sections to 6).

| Section | Source | Row component |
|---------|--------|---------------|
| RATES · US (11 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| RATES · JP (15 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| AMERICAS / EMEA / ASIA PACIFIC | `useMarketDataQuery` → `/api/market-data` | `TickRow` |
| FX (20 pairs) | `useFxTicks` → `/api/fx` | `FxRow` |

Things that will bite:
- **One highlight, one state.** `selectedTickId` lights the row; `selectedLabel` captions the chart.
  They deliberately diverge — clicking a tenor with no `chartSymbol` (7 of 11 UST, all 15 JGB) lights
  the row but must NOT touch `selectedLabel`, or the header reads "US 7Y" over someone else's prices.
- **`upCount`/`downCount` exclude rate rows** — "yield up" means the bond market fell, so mixing them
  into the ▲/▼ tally would count two opposite meanings together. FX rows are included.
- **`fmtQuote(symbol, n)`** decides the unit in the chart panel: `%` for `^IRX/^FVX/^TNX/^TYX`,
  `fmtFxPrice` for `*=X` (5 dp, 3 dp for JPY crosses), `$` otherwise. `/api/stock` serves both
  `EURUSD=X` and `^TNX` directly — verified, no special-casing needed in `useStockHistory`.
