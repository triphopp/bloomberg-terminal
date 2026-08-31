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
│           ├── theses/                ← DB-backed thesis system (CRUD + notes + history)
│           │   ├── index.tsx          ← rail + detail + sub-tabs THESIS|NOTES|HISTORY|LINKED TRADES|AI
│           │   ├── ThesisRail.tsx     ← grouped category → sub-portfolio → symbol (+ open-note badge "3N")
│           │   ├── ThesisEditor.tsx   ← form + markdown editor/preview
│           │   ├── ThesisNotes.tsx    ← standing scenarios/risks/catalysts: kind filter, L×S score, watch date, resolve
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
│   ├── TimeframeRow.tsx         ← THE timeframe control, shared by the MKT panel and every chart window: period buttons (invalid ones for the current interval greyed) + `IntervalPicker` — the TF dropdown, listing all nine intervals with a `→period` hint on the ones that would move the range. `trailing` slot carries the row's right-hand controls (chart type, POP, window buttons). Was defined inline in market-view; a popped-out chart had a nine-button row instead until it moved here
│   ├── useAnchoredPanel.ts      ← open state + fixed-viewport coords for a dropdown that must escape a clipping toolbar. Listeners bind to the trigger's OWN document/window, so the panel also closes correctly inside a detached chart window
│   ├── ChartPanel.tsx           ← the MKT chart panel packaged for reuse: quote header · indicator bar (IndicatorPicker + VP/REG/EVT/P·E/FP) · `TimeframeRow` · ModularChart (+ F&G / P/E sub-panes, EventDetailPopover) · OHLC footer. Owns its queries; `paused` skips the history fetch and body (minimized window) while keeping the quote. market-view still renders its own inline copy of the whole panel — it is entangled with the symbol search and layout splitters — but both now share `TimeframeRow`
│   ├── DetachedChartWindow.tsx  ← chart in a REAL `window.open` window, portalled into the child document so it stays one React tree (same atoms, same React Query cache). Parent stylesheets are cloned into the child head. **Window name is unique per detach** — Chrome remembers a named popup's geometry (including maximized, which script cannot resize) and would pin the chart there forever. Saved bounds are re-applied at 0/60/300/800/1500ms because a freshly opened popup ignores `resizeTo` until it settles. Screen bounds sampled every 2s → `chartWindowNativeBoundsAtom`. Closing the native window closes the entry; closing the terminal tab closes the window
│   ├── ChartWindowLayer.tsx     ← renders every chart window — docked in-page, detached as real windows; docks everything on mount (a native window cannot be reopened without a user gesture); portalled to <body>, `fixed inset-0 pointer-events-none z-[60]`, mounted once in `layout/bloomberg-terminal.tsx` so windows survive view switches. Carries the CHARTS n/10 + CLOSE ALL manager strip (bottom-left, above the alert ticker)
│   ├── FloatingChartWindow.tsx  ← one draggable/resizable in-page chart popup: `<ChartPanel>` plus window controls (detach ⧉ / minimize / close) in the panel's header row, which doubles as the drag handle, and a resize grip. Per-window state = symbol + timePeriod + barInterval + geometry ONLY — indicators still come from the global spec atoms, so every chart (incl. the MKT panel) shares one indicator set. Minimized ⇒ history query disabled + chart unmounted; the quote stays so the collapsed bar keeps its price. **Clamping is display-only** — the stored x/y/w/h is the user's intent and is never rewritten to fit the viewport; an earlier version committed the clamped value on mount and on every browser resize, which permanently "reset" any window near an edge whenever the browser was resized or moved to another monitor. **Resize freeze**: ModularChart rebuilds its whole lightweight-charts instance whenever its measured height changes, so while `isResizing` the chart body is pinned at the height it had at gesture start and re-measures once, on release — without it a resize drag tore the chart down ~18 times
│   ├── useWindowDrag.ts         ← pointer-driven drag + resize. Listeners on `window` (not the element) so the gesture survives the cursor outrunning the box; geometry is local state during the gesture and committed via `onCommit` once on pointerup, so a drag is ONE localStorage write, not one per mousemove. `[data-no-drag]` on a title-bar child keeps it clickable. Re-clamps on mount + window resize
│   ├── window-geometry.ts       ← dependency-free rules behind the windows: `clampWindow` (title bar can never leave the viewport — body may hang off bottom/right), `cascadeOrigin` (+28px diagonal, wraps every 8, bounded by the ACTUAL window size not the default), `resolveOpenGeometry` (remembered layout → last-used size + cascade → defaults), `rememberLayout` (recency-ordered, capped at `MAX_REMEMBERED_LAYOUTS`), `hasGeometry`, `nextZ`, `canOpenWindow` (cap 10, but re-opening an existing symbol always allowed — it focuses instead of duplicating). Tested in `__tests__/window-geometry.test.ts`
│   ├── IndicatorPicker.tsx      ← technical indicator selector (number params + `type:"select"` dropdown params)
│   ├── FearGreedPane.tsx        ← recharts sub-pane (F&G 0–100 + zone bands)
│   ├── PEPane.tsx               ← recharts sub-pane: trailing P/E line + p10/p90 valuation bands + percentile label (consumes /api/stock/pe-history)
│   ├── useChartIndicators.ts    ← indicator/overlay state; exposes vpConfig, showPE via atoms, plus `selectedEvent`/`clearSelectedEvent` for the detail card. Regression arming wins the click when both could claim it
│   ├── indicators/volume-profile.ts ← session+composite VP (gap-based sessions, delta, naked POC, HVN/LVN, VRVP)
│   ├── indicators/rv-core.ts        ← realized-vol math shared by the 3 RV panes: `calcRealizedVol(bars, period, estimator, periodsPerYear)` (cc/parkinson/gk/rs/yz, returns ANNUALISED %), `inferPeriodsPerYear()` (median bar spacing → 252/52/12 or 252×bars-per-session), `rollingPercentRank()`. Tested in `__tests__/rv-core.test.ts`
│   ├── indicators/realized-vol.ts   ← RV pane: 3 windows at once (5/21/63 default, 0 hides a line), estimator select
│   ├── indicators/rv-rank.ts        ← RV percentile rank pane (RV window 21 vs 252-bar lookback), zone-coloured histogram + 50 midline
│   ├── indicators/rv-ratio.ts       ← RV(fast)/RV(slow) realized term structure pane, 1.0 reference line, expansion/compression thresholds
│   ├── useSdBands.ts               ← data side of the SD heatmap, shared by stock-view + market-view: useQuery on `/api/options/sd-bands` + **self-heal** — when `snapshotCount === 0` it POSTs `/api/options/iv-snapshot` once per symbol (ref-guarded, or a symbol with no options chain retries forever) and invalidates the query. Effects depend on the ACTIVE BOOLEAN, never on the indicator object: writing `preloadedData` replaces it, so depending on it makes the effect retrigger its own cause
│   ├── heatmap-overlay.ts           ← `createHeatmapOverlay(spec)`: HeatmapSpec → CanvasOverlay. 3-zone layout: LEFT GUTTER (`HeatmapRowLabel` = level + odds beside it, opaque, never scrolls, width measured from its own content) · PLOT (cells sized from the gap between COLUMNS not barSpacing, labelled with `cellLabels`) · RIGHT RAIL (fallback only — dropped when the cells can label themselves, since it would just repeat them). Type scales with row height (`fontFor`, 7–14px); text degrades before it can ever overlap. Text degrades by row height BEFORE it can collide (rail dropped <13px, only ±2σ/0 <18px, prob line <22px, title <26px) — a 5-row pane at the 44px default gives 9px rows, under the 9px type. Cells can carry per-row text (`HeatmapColumn.cellLabels` — the SD pane colours by mode value but LABELS with the price at that sigma), and `HeatmapSpec.rail` reserves a fixed right-edge strip (price + odds per row) that survives a 1-column series or a zoomed-out chart, where cells are too narrow for any text. Rows tile the pane by EVEN DIVISION (they are categories, not prices — a price scale would let a row drift off-pane); `rows[0]` = BOTTOM. Column pitch comes from `timeScale().options().barSpacing`, so columns line up with the candles even when the heatmap is sparser than the price series. Tested in `__tests__/heatmap-overlay.test.ts` (stub 2D context)
│   └── indicators/sd-heatmap.ts     ← IV SD Heatmap pane: 5 buckets (−2σ…+2σ) from `σ_mid=(IV_call+IV_put)/2` under BS lognormal. Data comes PRE-COMPUTED from `/api/options/{sym}/sd-bands` via `config.preloadedData` (fear-greed pattern) — compute() only maps payload dates onto bar times (one column per day) and picks the colour scale. Exports `occupancyColor` (freq ÷ its own reference, so tails read hotter than the centre for the same overshoot) + `cheapnessColor` (sign of `P_rv − P_iv`). Tested in `__tests__/sd-heatmap.test.ts`
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
│   ├── chart-windows.ts         ← floating chart windows: `chartWindowsAtom` (atomWithStorage `bloomberg_chart_windows`) + open/close/closeAll/focus/patch/toggleMinimized write atoms. **Layout memory**: `chartWindowLayoutsAtom` (symbol → last x/y/w/h, `bloomberg_chart_window_layouts`, LRU-capped at 40) + `chartWindowSizeAtom` (last shaped size) — `patchChartWindowAtom` writes them on every geometry commit, so a closed-and-reopened symbol lands where it was left and a brand-new symbol inherits the size. Detached windows: `chartWindowNativeBoundsAtom` (symbol → screen left/top/width/height, `bloomberg_chart_window_native`), `rememberNativeBoundsAtom` (write-if-changed, called on a 2s sampler), `dockAllChartWindowsAtom` (clears `detached` on load). Geometry rules re-exported from `chart/window-geometry`
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
| `atoms/chart-windows.ts` | `chartWindowsAtom`, `openChartWindowAtom`, `closeChartWindowAtom`, `closeAllChartWindowsAtom`, `focusChartWindowAtom`, `patchChartWindowAtom`, `toggleChartWindowMinimizedAtom`, `ChartWindowState`, `MAX_CHART_WINDOWS` (10) |
| `chart/window-geometry.ts` | `clampWindow`, `cascadeOrigin`, `resolveOpenGeometry`, `rememberLayout`, `hasGeometry`, `nextZ`, `canOpenWindow`, size constants |
| `chart/ChartWindowLayer.tsx` | `ChartWindowLayer` |
| `chart/FloatingChartWindow.tsx` | `FloatingChartWindow` |
| `chart/ChartPanel.tsx` | `ChartPanel`, `ChartPanelProps` |
| `chart/DetachedChartWindow.tsx` | `DetachedChartWindow` |
| `chart/TimeframeRow.tsx` | `TimeframeRow`, `IntervalPicker`, `TimeframeRowProps` |
| `chart/useAnchoredPanel.ts` | `useAnchoredPanel()` → `{ open, setOpen, toggle, pos, wrapRef, triggerRef }` |
| `chart/useChartTimeframe.ts` | `useChartTimeframe()`, plus pure `applyPeriod(p, interval, chartType)` / `applyInterval(iv, period)` for components that store the timeframe outside React state |
| `chart/useAutoExtendRange.ts` | `useAutoExtendRange({symbol, period, interval, barCount, isLoading, enabled})` → `{ effectivePeriod, onLogicalRange, atMaxHistory, extended, viewportKey }` — ซูมออกสุดข้อมูล → ไต่ period ladder โหลดประวัติเพิ่มเอง; plus `periodSpanDays`, `ladderSteps` |
| `chartkit/prefetch.ts` | `isApproachingEdge`, `planPrefetch` — warm history window ถัดไปล่วงหน้า (เทคนิค stream LOD); คู่กับ `usePrefetchStockHistory()` ใน `hooks/useStockData.ts` |
| `chartkit/` (lib ของเราเอง) | `buildLadder`, `nextWider`, `needsExtend`, `planExtend`, types `LogicalRange`/`TimeRange`/`ViewportSample`; `chartkit/adapters/lightweight-charts` → `watchLogicalRange`, `captureVisibleRange`, `applyVisibleRange`. **กฎ:** core บริสุทธิ์ (ห้าม import engine/React), engine อยู่ใน `adapters/` เท่านั้น — ดู `chartkit/README.md` |
| `chart/ModularChart.tsx` (perf contract) | props `indicators`/`overlays`/`eventMarkers` = **โครงสร้าง** (ต้อง memo ที่ call site); `data` ไม่ใช่ — บาร์ใหม่ถูก push เข้า series เดิมผ่าน refill path, rebuild เฉพาะเมื่อ refill ทำไม่ได้ |
| `chart/useWindowDrag.ts` | `useWindowDrag()` → `{ x, y, w, h, isGesturing, isResizing, beginDrag, beginResize }` |
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
| `portfolio/tabs/theses/types.ts` | `Thesis`, `ThesisStatus`, `ThesisEvent`, `ThesisLink`, `ThesisNote`, `NoteKind`, `NoteStatus`, `NoteImpact`, `STATUSES`, `STATUS_COLOR`, `CATEGORIES`, `HORIZONS`, `STRATEGIES`, `NOTE_KINDS`, `NOTE_STATUSES`, `NOTE_KIND_COLOR`, `NOTE_STATUS_COLOR`, `NOTE_IMPACT_COLOR` |
| `portfolio/tabs/theses/ThesisRail.tsx` | `ThesisRail` |
| `portfolio/tabs/theses/ThesisEditor.tsx` | `ThesisEditor`, `ThesisDraft`, `emptyDraft`, `draftFrom` |
| `portfolio/tabs/theses/ThesisNotes.tsx` | `ThesisNotes`, `NoteDraft`, `emptyNoteDraft` |
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
| `core/us-market-clock.tsx` | `UsMarketClock` — ET clock + session phase strip at the top of the TICK DATA board (presentation only) |
| `lib/us-market-session.ts` | `computeSession` `fmtClock` `fmtCountdown` + `NYSE_HOLIDAYS` `NYSE_HALF_DAYS` — pure session maths, no React. **US markets have no lunch break**; the model is pre/regular/after + 13:00 ET half-days. Tests: `npm run test:session` (21) |
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
