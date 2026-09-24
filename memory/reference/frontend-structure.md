# Frontend Structure Reference

**Last updated:** 2026-06-06

> **See also:** [data-shapes.md](data-shapes.md) — TypeScript interfaces + API response shapes | [api-endpoints.md](api-endpoints.md) — all backend endpoints | [architecture.md](architecture.md) — backend file structure | [gotchas.md](gotchas.md) — "Where is X?" lookup + anti-patterns

---

## Component Tree

```
components/bloomberg/
├── layout/
│   ├── bloomberg-terminal.tsx   ← root view router (9 views)
│   ├── terminal-header.tsx      ← top nav bar + view buttons (phone <768px: title + search only)
│   ├── mobile-nav.tsx           ← phone bottom view switcher (replaces header nav; ribbon + ticker hidden)
│   ├── terminal-layout.tsx      ← keyboard shortcut binding wrapper
│   └── terminal-filter-bar.tsx  ← watchlist filter
│
├── views/
│   ├── market-view.tsx          ← MKT: watchlist + chart + global indices + Regime panel
│   ├── iv-smile-panel.tsx       ← REGIME IV: selected chart symbol, optional Raw SVI, single/multiple monthly expiries, K vs IV%
│   ├── news-view.tsx            ← barrel → views/news/index.tsx (kept for the dynamic import path)
│   ├── news/                    ← NEWS view (2026-08-15 redesign)
│   │   ├── index.tsx            ← shell: WATCHLIST | NEWSFEED | SOCIAL tabs + shared Polymarket column
│   │   ├── watchlist-tab.tsx    ← sector rail + article stream + per-symbol HEADLINES/RATE STRESS/DCF/REGIME panels
│   │   │                          (group: SECTOR/TICKER/TIME · match: NAMED/ALL NEWS · sentiment · source toggles)
│   │   ├── newsfeed-tab.tsx     ← topic newswire (was the FEED tab)
│   │   ├── social-tab.tsx       ← X/YouTube/Reddit/RSS handles
│   │   ├── polymarket-column.tsx← {SYM} IMPLIED ladder + WATCHLIST MARKETS + MACRO SIGNALS + search
│   │   ├── prediction-ladder.tsx← implied distribution panel (CLOSE ABOVE CDF + TOUCH LADDER)
│   │   ├── useWatchlistNews.ts  ← useWatchlistSymbols() (pins atom → localStorage fallback) + React Query
│   │   ├── constants.ts / helpers.ts / types.ts
│   ├── market-movers-view.tsx   ← GMOV: global indices table + heatmap treemap
│   ├── clippings-view.tsx       ← CLIP: Obsidian reader + Ollama AI panel
│   ├── tail-risk-view.tsx       ← TAIL: 6 dimensions + macro context (EventStrip under HealthStrip, MacroPanel in left column, EVENT tag on VIX signals, event ReferenceLines on 90D chart)
│   ├── tail/macro-context.tsx   ← useMacroContext() + EventStrip + MacroPanel + KIND_COLOR (2026-09-17)
│   ├── tail/decomposition.tsx   ← RealRatesPanel + EnergySpreadsPanel (EVIDENCE section, 2026-09-24)
│   ├── tail/market-events.tsx   ← MarketEventsPanel — named events + evidence + earlier sessions (2026-09-24)
│   ├── tail/sector-rotation.tsx ← SectorRotationPanel + useSectorRotation() — diverging bars + tilt (2026-09-23)
│   ├── credit-view.tsx          ← CRDT: 4 tabs (overview/spreads/stress/consumer)
│   ├── stock-view.tsx           ← Equity analysis tabs incl. DCF/RATE STRESS/REGIME — no nav button, via search/heatmap
│   ├── stock/dcf/index.tsx      ← shared adaptive DCF lab: model/scenario controls + 5 quant sub-tabs
│   ├── stock/dcf/types.ts       ← DcfModel/DcfScenario and API response contracts
│   ├── pinned-assets.tsx        ← Pinned assets sidebar
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
│           │   ├── theses/graphs/     ← GRAPHS sub-tab: GraphsPanel — lists rendered analysis
│           │   │                        pages for the thesis, previews one in a sandboxed
│           │   │                        iframe (no allow-same-origin: the HTML is agent-written)
│           │   └── theses/zettel/     ← KB sub-tab: ZettelPanel (list+detail+create),
│           │                             ConflictPanel (two sides + RESOLVE),
│           │                             ZettelGraph (deterministic radial SVG)
│           ├── theses/                ← DB-backed thesis system (CRUD + notes + history)
│           │   ├── index.tsx          ← rail + detail + sub-tabs THESIS|NOTES|HISTORY|LINKED TRADES|AI
│           │   ├── ThesisRail.tsx     ← grouped category → sub-portfolio → symbol (+ open-note badge "3N")
│           │   ├── ThesisEditor.tsx   ← form + markdown editor/preview
│           │   ├── ThesisNotes.tsx    ← standing scenarios/risks/catalysts: kind filter, L×S score, watch date, resolve
│           │   ├── ThesisTimeline.tsx ← thesis_events feed + manual notes
│           │   ├── markdown.tsx       ← renderMarkdown
│           │   └── types.ts
│           └── ImportTab.tsx         ← Excel drag-drop + manual form. **ENTRY shows six fields only** (ACCOUNT · SYMBOL · DATE ENTRY · PRICE ENTRY · VOLUME · STRATEGY) plus the IS OPTION / REINVEST checkboxes; SECTOR · STOP LOSS · TARGET · ENTRY TRIGGER · VAT · SUB-PORT · NOTE sit behind the ADD FIELD row (`ui/useEntryExtras.tsx`). Grids size themselves from how many optional cells are on, so a hidden field leaves no gap. `autoFillSector()` reads `/api/stock/sector/{resolved}` and takes the first of `[set_sector, us_sector]` that the account's list offers; anything undecidable reveals the SECTOR picker instead of guessing
│               ui/useEntryExtras.tsx ← `useEntryExtras()` (state in `localStorage["bloomberg_entry_extra_fields"]`, `showExtra` reveals but never hides) + `<ExtraFieldToggles>`, the text-only `+ FIELD` / `− FIELD` row
│
├── chart/
│   ├── ModularChart.tsx         ← reusable chart container (candle + overlay/pane indicators + event rail). **Grid in the price pane only** — the library's chart-wide grid is `visible: false`; the price pane draws its own via `createPriceGridOverlay()` (`price-grid-overlay.ts`), an `OverlayPrimitive` at `zOrder: "bottom"`, always first in `allOverlays`. Indicator sub-panes have no grid because nothing draws one there. No `createSeriesMarkers` — events are drawn by the rail overlay. `onBarClick(time, ctx)` reports every marker within 2 bars of the click + viewport coords
│   ├── price-grid-overlay.ts   ← the chart grid as our own bottom layer in the price pane: horizontal lines on round prices (`niceStep()` / `priceLevels()`, ~10 rows), vertical lines on calendar boundaries in the data — `chooseBoundaries()` picks the finest of month/week/day/hour that fits the pane width (weeks are Monday-aligned), then thinned to ≥30px apart, so a 3M chart and a 5Y chart end up equally dense. Drawn as LaTeX/TikZ-style dot rules (round cap + zero-length dash, 4px pitch) so the grid reads as background against the indicator lines over it. Pure helpers tested in `__tests__/price-grid-overlay.test.ts`
│   ├── event-icons.ts          ← Path2D icon set for the rail (`cash` · `arrowUp` · `arrowDown` · `clock` · `split`) + `drawEventIcon()`. Lucide 24×24 grid so `EventDetailPopover` can render the matching `lucide-react` component and the canvas/DOM marks stay the same vocabulary
│   ├── event-rail-overlay.ts    ← CanvasOverlay drawing icon chips on a fixed 18px row at the bottom of the price pane — **no background band or divider** (removed 2026-08-31; each chip paints its own ~87% pane-colour backdrop so wicks pass behind it and the row is invisible where nothing sits on it): banknote = dividend, trending up/down = beat/miss, clock = no surprise reported, split, `···N` cluster (still text — a count is the one thing an icon cannot say). Dashed border = `upcoming`, queued right of the last bar. `clusterChips()` + `eventChipStyle()` are pure and tested
│   ├── EventDetailPopover.tsx   ← detail card for clicked events: EST vs ACTUAL EPS + BEAT/MISS, dividend amount + yield, split ratio, gap/close/D+1/D+5 reaction. An `upcoming` event shows EX-DATE/PAY DATE and "Scheduled — no price reaction yet" in place of the reaction block. Opens on a list when a cluster is clicked. Closes on Escape or an outside click
│   ├── event-reaction.ts        ← pure helpers: `earningsSession()` (BMO/AMC off `reportedAt`), `findEventBarIndex()` / `placeEvents()` (single placement rule shared by the rail and the card; future-dated events are kept with `future: true` + `daysAhead`, capped at `MAX_FUTURE_DAYS` 200), `daysPastLastBar()`, `computeEventReaction()`. Tested in `__tests__/event-reaction.test.ts`
│   ├── volume-event-overlay.ts  ← CanvasOverlay (`mode: "full"`, `zOrder: "top"`) drawing a 2-char chip per classified volume event (`CX AB VC BO ND DU`) **anchored to the bar**, above the high when the up side owned it and below the low when the down side did — the opposite choice from the corporate-event rail, because direction is half of what a volume event says, and it also keeps the two rows from stacking. One hue per TYPE, never per direction. Classifies inside `draw` (the only place the bar array exists) and caches on that array's identity, so it runs once per data change and not once per frame. Collisions are resolved strongest-|z|-first and the loser is DROPPED, not clustered — a `···N` would hide the one thing a chip exists to name, and the panel lists every event anyway. `resolveCollisions()` is pure and tested in `__tests__/volume-event-overlay.test.ts`
│   ├── VolumeEventPanel.tsx     ← the event list under the chart: DATE · EVENT (code + ▲/▼ + `×N` run length) · Z · RET · +1 · +5. The forward-return columns are the point rather than decoration — a label is only worth reading if its outcomes separate from the symbol's unconditional behaviour. Classifies the same bars the overlay does with the same defaults, so the two agree with nothing passed between them
│   ├── bollinger-fit.ts         ← pure 209-pair grid search (n=10..100 step 5, k=1..3.5 step .25); long/cash breakout %B > 1 enter / <= .5 exit at next open, net per-bar Sharpe, common warmup + train/holdout. WeakMap cache per immutable OHLCV array and cost.
│   ├── BollingerFitSummary.tsx  ← picker diagnostics: selected n/k, train/holdout Sharpe, net returns, trades, date ranges, assumptions and explicit unavailable/manual fallback.
│   ├── ChartTimeframeBar.tsx    ← period selector (1D/1W/1M/3M/YTD/1Y/5Y/MAX)
│   ├── TimeframeRow.tsx         ← THE timeframe control, shared by the MKT panel and every chart window: period buttons (invalid ones for the current interval greyed) + `IntervalPicker` — the TF dropdown, listing all nine intervals with a `→period` hint on the ones that would move the range. `trailing` slot carries the row's right-hand controls (chart type, POP, window buttons). Was defined inline in market-view; a popped-out chart had a nine-button row instead until it moved here
│   ├── useAnchoredPanel.ts      ← open state + fixed-viewport coords for a dropdown that must escape a clipping toolbar. Listeners bind to the trigger's OWN document/window, so the panel also closes correctly inside a detached chart window
│   ├── ChartPanel.tsx           ← the MKT chart panel packaged for reuse: quote header · indicator bar (IndicatorPicker + VP/VEVT/REG/P·E/FP — **no EVT button**: the event rail is always on for an equity candle chart, see `useChartIndicators`) · `TimeframeRow` · ModularChart (+ F&G / P/E sub-panes, EventDetailPopover) · OHLC footer. Owns its queries; `paused` skips the history fetch and body (minimized window) while keeping the quote. market-view still renders its own inline copy of the whole panel — it is entangled with the symbol search and layout splitters — but both now share `TimeframeRow`
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
│   ├── indicators/atr.ts            ← Wilder ATR / ATR% pane with native green/red per-bar line colors; prior ATR% SMA threshold + rising EMA trend filter; configurable settings and explicit gray warmup.
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
│   ├── boot-screen.tsx          ← dynamic() loading fallback + watchdog (auto-reload if terminal chunk stalls)
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
│   ├── useIvSmile.ts           ← on-demand single/multi-expiry chains + optional SVI fit, guarded identity and shared controls
│   ├── useStockData.ts
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
    ├── volume-stats.ts          ← `volumeZ()` (robust log-volume z-score: median/MAD of ln V) + `volumeRatio()` (baseline `median` | `mean`). Intraday bars are SLOTTED against the same point in prior sessions — by **bar index since the session's first bar** when >1 session is loaded (DST-proof; UTC time-of-day keying empties every slot for a lookback after each DST change), by UTC time-of-day on a single 24h session (crypto). Sessions split on a >4h gap, same constant as vwap.ts. `mode: "cum"` compares the session's volume SO FAR against the same point in prior sessions, which is what makes a live partial bar read honestly instead of "quiet". `MIN_SAMPLES` 8, `MIN_SIGMA` 1e-6 (a repeated-value history leaves σ at ~1e-16 — dividing by it turns one share into z=1e15). Mirrored server-side by `backend/alerts/operands._vol_z_series` for daily bars. Tests: `npm run test:session`
    ├── volume-events.ts         ← `classifyVolumeEvents(bars, cfg)` → `VolumeEvent[]`: volume as countable events rather than a series. Six types, one label per bar, priority `climax > vacuum > breakout > absorption > noDemand` (+ `dryUp`, run-based, emitted at the run's END and only when that bar is otherwise unlabelled). Every rule is a joint threshold on z (participation) × retSigma (result) × range/closePos (who won the bar). `dir` is **never a forecast** — which side owned the bar. `forwardReturnPct(bars, i, h)` is null past the data, deliberately (a 0 there biases every eye that reads the table). `EVENT_CODE` / `EVENT_NAME` / `EVENT_DOC` maps. Tests: `npm run test:session`
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
| `chart/bollinger-fit.ts` | `BOLLINGER_PERIOD_GRID`, `BOLLINGER_DEVIATION_GRID`, `BOLLINGER_FIT_MIN_BARS`, `BOLLINGER_FIT_PARAMS`, `calcBollingerStats`, `bollingerPercentB`, `evaluateBollingerBreakout`, `fitBollingerSharpe`, `resolveBollingerParameters`; types `BollingerStats`, `BollingerBacktest`, `BollingerFitCandidate`, `BollingerFitResult` |
| `chart/indicators/atr.ts` | `createATR`, `calcAtrRegime`, `resolveAtrConfig`, `validAtrInputs`, `ATR_REGIME_PARAMS`, `ATR_REGIME_COLORS`; types `AtrRegimeConfig`, `AtrRegimePoint`. Public chart/indicator barrels re-export all except picker-only `validAtrInputs`. |
| `chart/types.ts` (indicator points) | `SeriesDataPoint` accepts optional native line `color`; `WhitespaceDataPoint` supplies an explicit missing time; both are accepted by `IndicatorSeriesOutput.data`. |
| `chart/IndicatorPicker.tsx` (ATR settings) | `INDICATOR → ATR Accumulation → APPLY ATR`; gear reopens raw BARS/DAYS inputs; colored chip and applied diagnostics share the chart calculator. |
| `chart/BollingerFitSummary.tsx` | `BollingerFitSummary({data, costBps, colors})` |
| `chart/IndicatorPicker.tsx` (Bollinger settings) | `data` prop must be the same immutable bars passed to ModularChart. BB/%B default Manual; Parameters → Fit + Apply opts in. Gear reopens raw persisted inputs; chips show effective n/k and Fit / unavailable status. `useChartIndicators.instantiate` adds transient `config.inputParams` to preserve DAYS inputs after reopening. |

| `chart/DetachedChartWindow.tsx` | `DetachedChartWindow` |
| `chart/TimeframeRow.tsx` | `TimeframeRow`, `IntervalPicker`, `TimeframeRowProps` |
| `chart/useAnchoredPanel.ts` | `useAnchoredPanel()` → `{ open, setOpen, toggle, pos, wrapRef, triggerRef }` |
| `chart/useChartTimeframe.ts` | `useChartTimeframe()`, plus pure `applyPeriod(p, interval, chartType)` / `applyInterval(iv, period)` for components that store the timeframe outside React state |
| `chart/useAutoExtendRange.ts` | `useAutoExtendRange({symbol, period, interval, barCount, isLoading, enabled})` → `{ effectivePeriod, onLogicalRange, atMaxHistory, extended, viewportKey }` — ซูมออกสุดข้อมูล → ไต่ period ladder โหลดประวัติเพิ่มเอง; plus `periodSpanDays`, `ladderSteps` |
| `chartkit/prefetch.ts` | `isApproachingEdge`, `planPrefetch` — warm history window ถัดไปล่วงหน้า (เทคนิค stream LOD); คู่กับ `usePrefetchStockHistory()` ใน `hooks/useStockData.ts` |
| `chartkit/` (lib ของเราเอง) | `buildLadder`, `nextWider`, `needsExtend`, `planExtend`, types `LogicalRange`/`TimeRange`/`ViewportSample`; `chartkit/adapters/lightweight-charts` → `watchLogicalRange`, `captureVisibleRange`, `applyVisibleRange`. **กฎ:** core บริสุทธิ์ (ห้าม import engine/React), engine อยู่ใน `adapters/` เท่านั้น — ดู `chartkit/README.md` |
| `chart/ModularChart.tsx` (perf contract) | props `indicators`/`overlays`/`eventMarkers` = **โครงสร้าง** (ต้อง memo ที่ call site); `data` ไม่ใช่ — บาร์ใหม่ถูก push เข้า series เดิมผ่าน refill path, rebuild เฉพาะเมื่อ refill ทำไม่ได้. Optional `referencePriceLine` วาดเส้นประพร้อมป้ายราคาบน candle pane; quote update/remove ใช้ price-line API และ autoscale ใน series เดิม จึงไม่ reset viewport |
| `core/market-session.tsx` | `extendedHoursPriceLine(quote)` คืนราคาและสีสำหรับ `PRE`/`POST` ที่มีราคา valid เท่านั้น; MKT, stock-view และ `ChartPanel` (floating/detached) ส่งเข้า `ModularChart`. `PREPRE`/`POSTPOST`/`CLOSED` ไม่วาดเส้น; backend ล้างราคา extended-hours ที่ timestamp เก่า |
| `chart/useWindowDrag.ts` | `useWindowDrag()` → `{ x, y, w, h, isGesturing, isResizing, beginDrag, beginResize }` |
| `views/iv-smile-panel.tsx` | `IvSmilePanel`, `IvSmilePanelProps` — compact/expanded K vs IV%, Raw SVI/points/RMSE, multiple tenors; observed 25Δ skew/curvature below chart; optional stacked Call/Put OI with separate contracts axis and selected-expiry control |
| `hooks/useIvSmile.ts` | `useIvSmile(symbol, enabled)` — discovery + single/multiple expiry + optional fit queries; shared OI on/off and symbol-scoped expiry selection without new requests; guarded identity and refresh |
| `lib/iv-smile.ts` | `buildIvSmile`, `buildIvSmileOi`, `chooseSmileExpiry`, `expiryDays`, `smileTenorDate`, `selectSmileTenors`, `smileSamples`, `sviIvAtStrike`, `smilePlotRows`, `smileWingMetrics`, `SMILE_TENOR_MONTHS`; types `IvSmileOption`, `IvSmileChain`, `IvSmilePoint`, `IvSmileOiPoint`, `SmileSide`, `SmileFitMode`, `SviSample`, `RawSviParameters`, `RawSviFit`, `SviFitResponse`, `SmileTenor` |
| `hooks/useTerminalUI.ts` | `useTerminalUI()` → `{ currentView, handleKeyPress, ... }` |
| `layout/bloomberg-terminal.tsx` | `BloombergTerminal` (default) |
| `layout/terminal-header.tsx` | `TerminalHeader` |
| `layout/mobile-nav.tsx` | `MobileNav` |
| `portfolio/index.tsx` | `PortfolioView` (default) |
| `portfolio/types.ts` | `Trade`, `Account`, `CashEntry`, `CashAdjustment`, `Dividend`, `Summary`, `BacktestMetrics`, `ThesisData`, `OptionPosition` |
| `portfolio/helpers.ts` | `fmt`, `fmtK`, `fmtPct`, `pnlColor`, `wlColor`, `groupKey`, `FLAG`, `Colors` |
| `portfolio/constants.ts` | `ALL_COLS`, `DEFAULT_COLS`, `DENSE_COLS`, `TH_SECTORS` (34), `US_SECTORS` (11), `GROUP_COLORS`, `FINANSIA_SUBS`, `ALLOC_COLORS`, `SECTOR_COLORS`, `BLANK_CASH`, `BLANK_DIV`, `BLANK_FORM`, `STRATEGIES` |
| `portfolio/ui/AccBadge.tsx` | `AccBadge`, `WLBadge` |
| `portfolio/ui/SummaryBar.tsx` | `SummaryBar` |
| `views/tail-risk-view.tsx` | `TailRiskView`, `SectionRule` (2026-09-23 — TAIL แบ่ง 4 หัวข้อ: RISK DIMENSIONS · EVIDENCE · MACRO & ROTATION CONTEXT · METHOD; คอลัมน์ซ้าย 208px เหลือแค่ VIX TERM + VOL BOARD, การ์ดที่เหลือย้ายลงกริดเต็มความกว้าง) |
| `views/tail/decomposition.tsx` | `RealRatesPanel` (nominal = real + breakeven per tenor + split line), `EnergySpreadsPanel` (crude/products/cracks, ROLL + EST tags); types `Decomposition` `DecompRow` (2026-09-24) |
| `views/tail/market-events.tsx` | `MarketEventsPanel` (2026-09-24 compact: name · severity · `headline` · ≤4 number chips; click = summary/checked/definition/rule; props `staleHours`, `partial`), `SEVERITY_COLOR`; types `MarketEvent` `EventEvidence` `EventLogEntry` `RiskBasis` `EventSeverity` (2026-09-24 — top section of TAIL; ribbon imports `SEVERITY_COLOR` and prints the top 2 event names after the dimension chips) |
| `views/rotation-table.tsx` | `RotationTable` — MKT REGIME → ROT; TABLE/MAP toggle (`localStorage["bloomberg_rotation_view"]`), US|TH, tail 4/8/12W in MAP (2026-09-24) |
| `views/rotation-map.tsx` | `RotationMap` (SVG RRG: quadrants, faded weekly tails, hover focus, legend-by-quadrant click-to-hide), `RotationMapPanel`, `useRotationMap(market, tail, enabled)`, `RotationMapData`, `QUAD_COLOR` (2026-09-24) |
| `views/tail/sector-rotation.tsx` | `SectorRotationPanel` (TILT + 11 diverging bars + RRG tally + AUM record line), `useSectorRotation(window)` (2026-09-23) |
| `views/tail/macro-context.tsx` | `EventStrip`, `MacroPanel`, `MacroReadPanel` (2026-09-20 — 3 axes + CPI/core CPI/PCE/core PCE cross-check row), `useMacroContext`, `MacroContextData`, `MacroRead`, `MacroAxis`, `KIND_COLOR` |
| `portfolio/tabs/AnalyticsTab.tsx` | `AnalyticsTab` — NAV card has VALUE / INDEX modes (`localStorage["bloomberg_nav_chart_mode"]`): VALUE draws `NavValueChart` (4 labelled series: NAV area + HOLDINGS/CASH lines + dashed COST, legend chips double as show/hide so CASH can own the axis), INDEX draws `NavIndexChart` — the time-weighted curve vs the CAPM benchmark from `/api/v2/portfolio/nav-index`. Both internal to the file. CAPM card: β HEDGE / HEDGE notional / β REAL / vs IDX / α CAPM / t / R² / N; rf chip เปิดแผงตั้งค่า (override ต่อสกุลใน `localStorage["bloomberg_capm_rf"]`) |
| `portfolio/ui/AllocationBasisCard.tsx` | `AllocationBasisCard`, `AllocRow` — ALLOCATION (OPEN) cost-vs-market card (COST/VALUE/DRIFT modes + rebalance table) |
| `portfolio/ui/PortfolioRotationChart.tsx` | `PortfolioRotationChart`, `RotationGroup`, `RotationMode`, `PortfolioRotationResponse` — stacked weekly open-cost by theme/sector/account, COST/% modes, markers, legend click-to-hide; fixed `THEME_COLOR` per theme (2026-09-24) |
| `portfolio/ui/NavGrowthChart.tsx` | `NavGrowthChart`, `NavGrowthData`, `NavGrowthPoint` — signals-style TWR growth: Growth/Avg-month/Deposits/Withdrawals stats, growth line + least-squares trend, ▲ deposit ▼ withdrawal marks, year × month compounded table; default mode of ANALYTICS NAV card (`localStorage["bloomberg_nav_chart_mode_v2"]` GROWTH/VALUE/INDEX) (2026-09-25) |
- `views/portfolio/ui/PayoffChart.tsx` — payoff chart (2026-09-10): expiry line solid, T+0 dashed, shaded profit/loss regions, reference lines at spot and each breakeven, plus the headline stats. Exports `PayoffChart`, `PayoffResult`, `PayoffPoint`
- `views/portfolio/ui/usePayoff.ts` — `usePayoff(legs)` returns the expiry curve immediately from `localPayoff()` and swaps in the backend's answer (T+0 + POP) after a debounce. ⚠️ Depends on `JSON.stringify(legs)`, NOT the array: callers build it inline, so depending on the array re-ran the effect every render and aborted the request every time
- `views/portfolio/tabs/AuditTab.tsx` — PORT → TOOLS → AUDIT (2026-09-16): every change from `/audit-events`, filter by table + action, follows active account, click row for field-by-field BEFORE/AFTER, LOAD OLDER paging. Exports `AuditTab`
- `views/portfolio/modals/CashReconcileModal.tsx` — cash EDIT (2026-09-16): pick account, see DERIVED / ADJUST / CASH NOW, type broker balance → stores the difference; effective date + note; history with undo. Opened from SummaryBar CASH chip (always shown) and CASH tab EDIT. Invalidates `["portfolio","summary"]`. Exports `CashReconcileModal`
- `views/portfolio/modals/PayoffModal.tsx` — payoff for a saved lot, combined across every lot on the same underlying by default (a hedge read alone looks like a pure loss) with a `THIS LOT ONLY` toggle
- `views/portfolio/modals/OptionTradeEditModal.tsx` — correct a mis-entered option trade (2026-09-10): every field plus a required-by-convention `reason`, contract terms locked while the trade is matched, and the trade's audit log inline. Exports `OptionTradeEditModal`
- `views/portfolio/ui/OptionTradeLog.tsx` — OPTIONS tab · TRADES view (2026-09-10): every
  option execution with the 5 greeks + spot/IV captured at that trade. Migrated trades show
  `unknown` / `—` with a banner rather than being back-filled with today's values. Exports
  `OptionTradeLog`, `OptionTrade`
- `views/portfolio/ui/OptionAttributionCard.tsx` — ANALYTICS section `DERIVATIVES · PNL ATTRIBUTION` (2026-09-09): portfolio split across Δ/Γ/Θ/ν/residual, stacked bar per day, per-contract table with spot/IV endpoints and `explained_pct`. Exports `OptionAttributionCard`, `OptionAttribution`
| `portfolio/tabs/theses/index.tsx` | `ThesesTab` (props: `colors`, `accountId`, `initialSymbol`, `onConsumeInitialSymbol`) |
| `portfolio/tabs/theses/types.ts` | `Thesis`, `ThesisStatus`, `ThesisEvent`, `ThesisLink`, `ThesisNote`, `NoteKind`, `NoteStatus`, `NoteImpact`, `STATUSES`, `STATUS_COLOR`, `CATEGORIES`, `HORIZONS`, `STRATEGIES`, `NOTE_KINDS`, `NOTE_STATUSES`, `NOTE_KIND_COLOR`, `NOTE_STATUS_COLOR`, `NOTE_IMPACT_COLOR` |
| `portfolio/tabs/theses/ThesisRail.tsx` | `ThesisRail` |
| `portfolio/tabs/theses/ThesisEditor.tsx` | `ThesisEditor`, `ThesisDraft`, `emptyDraft`, `draftFrom` |
| `portfolio/tabs/theses/ThesisNotes.tsx` | `ThesisNotes`, `NoteDraft`, `emptyNoteDraft` |
| `portfolio/tabs/theses/ThesisTimeline.tsx` | `ThesisTimeline` |
| `portfolio/tabs/theses/graphs/GraphsPanel.tsx` | `GraphsPanel` (props: `thesisId`, `colors`, `onCountChange`), `AnalysisGraph` |
| `ui/series-board.tsx` | `SeriesBoard` (props: `group`, `colors`, `days`), `SeriesRow`, `SeriesBoardColors` — generic indicator board: sections, values, Δ%, sparkline, detail chart. Names no specific market |
| `views/news/data-tab.tsx` | `DataTab` — NEWS → DATA: group selector from `/api/v2/series/groups` + `SeriesBoard` |
| `portfolio/tabs/theses/ReadView.tsx` | `ReadView` (props: `thesis`, `notes`, `events`, `colors`) — READ mode: the whole thesis as one scrollable document (body + notes + zettel + analysis pages + history) with a scroll-spy contents rail |
| `portfolio/tabs/theses/markdown.tsx` | `renderMarkdown(text, colors, scale)`, `headingsOf`, `slugifyHeading`, `MdScale` (`"dense"` \| `"read"`) — tables, links, ordered/nested lists, blockquote, code fence, hr |
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
| `app/boot-watchdog.tsx` | `BootWatchdog` — inline `<script>` in the root layout; reloads once after 12s unless `window.__BT_MOUNTED__` is set (runs without the client bundle, which the React-side watchdog cannot) |
| `views/portfolio/queries.ts` | `portfolioQueries` (summary · accounts · openPositions · premarket · costOverrides · thesesSummary — React Query defs, `staleTime` mirrors each backend TTL) + `prewarmPortfolio(queryClient)` |
| `hooks/usePortfolioPrewarm.ts` | `usePortfolioPrewarm()` — 4s after terminal mount, on idle, fills the PORT caches so opening PORT paints from cache instead of a ~10s cold fetch chain |
| `core/boot-screen.tsx` | `BootScreen` — loading fallback for the `dynamic(ssr:false)` terminal import; reloads once after 12s if the chunk never arrives (`sessionStorage["bloomberg_boot_retry_at"]` guards the loop), RETRY button after that |
| `core/us-market-clock.tsx` | `UsMarketClock` — ET clock + session phase strip at the top of the TICK DATA board (presentation only) |
| `views/stock/market-state/index.tsx` | `MarketStateTab` (props `symbol` `colors`) — the REGIME panel, mounted by BOTH `news/watchlist-tab.tsx` (panel toggle beside RATE STRESS) and `stock-view.tsx` (REGIME tab), exactly like `RateStressTab`, so the two entry points cannot drift. Six sub-tabs in reading order: SUMMARY (A) · REGIME (B, price + regime shading) · EVOLUTION (C, scores + d/dt) · PROBABILITY (D, stacked posterior) · STRATEGY (E, decision layer + walk-forward button) · DIAGNOSTICS (feature redundancy + model card). **Interpretation tabs come before the decision tab on purpose** — a reader must be able to reject the recommendation without rejecting the description |
| `views/stock/dcf/index.tsx` | `DcfTab` (props `symbol` `colors`) — one shared component mounted in NEWS beside RATE STRESS and in stock-view. Sub-tabs: OVERVIEW · FORECAST · ASSUMPTIONS · SENSITIVITY · AUDIT; supports AUTO/manual model, Bear/Base/Bull, editable numeric assumptions and source lineage. |
| `views/stock/dcf/types.ts` | `DcfModel`, `DcfScenario`, `DcfForecastRow`, `DcfLineageRow`, `DcfResponse` |
| `views/stock/market-state/regime-runs.ts` | `toRuns()` + `Run` — collapses per-bar labels into contiguous runs for the chart's `<ReferenceArea>` bands (one rect per RUN, not per bar) and makes regime DURATION visible. Kept out of the `.tsx` because node's type stripping cannot load JSX. Tests: `npm run test:views` |
| `views/stock/market-state/SummarySubTab.tsx` | `SummarySubTab`, `fmtProb` (never prints 100% for a posterior — ">99%") |
| `views/stock/market-state/types.ts` | `MarketStateResponse` `ValidationResponse` `StateSlice` `ScoreBlock` `StrategyItem` `RedundancyReport` |
| `lib/volume-stats.ts` | `volumeZ()` `volumeRatio()` `median()` `mean()` `madSigma()` `stdev()` `isIntraday()` + `MIN_SAMPLES` `SESSION_GAP_SEC`; types `VolumeBar` `VolBaseline` (`"median"｜"mean"`) `VolMode` (`"bar"｜"cum"`) `VolStatsOpts` |
| `lib/volume-events.ts` | `classifyVolumeEvents()` `forwardReturnPct()` `EVENT_CODE` `EVENT_NAME` `EVENT_DOC`; types `EventBar` `VolumeEvent` `VolumeEventType` (`climax｜absorption｜vacuum｜breakout｜noDemand｜dryUp`) `VolumeEventConfig` |
| `chart/volume-event-overlay.ts` | `createVolumeEventOverlay()` `resolveCollisions()` `EVENT_COLOR`; type `PlacedChip` |
| `chart/VolumeEventPanel.tsx` | `VolumeEventPanel` (props `data` `colors` `height`) |
| `chart/indicators/rvol.ts` | `createRVOL` + `RVOL_SCALES` `RVOL_BASELINES` `RVOL_MODES` (select options re-exported through `indicators/index.ts` for the registry) |
| `lib/us-market-session.ts` | `computeSession` `fmtClock` `fmtCountdown` + `NYSE_HOLIDAYS` `NYSE_HALF_DAYS` — pure session maths, no React. **US markets have no lunch break**; the model is pre/regular/after + 13:00 ET half-days. Tests: `npm run test:session` (21) |
| `views/portfolio/weights.ts` | `navBreakdown` `weightPct` `fmtWeight`; types `NavInputs` `NavBreakdown` — pure % of NAV maths (NAV = equity MV + option MV + cash). Tests: `npm run test:views` |
| `views/portfolio/ui/usePortfolioNav.ts` | `usePortfolioNav(accountId, currency)` → `{ breakdown, pct }` (reads openPositions + summary query caches); `equityMarketValue(trade)` |
| `views/tail/macro-context.tsx` | `useMacroContext()` `EventStrip` `MacroPanel` `KIND_COLOR`; types `MacroEvent` `EventKind` `MacroContextData` |
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

The right-hand `tickdata` panel is a cross-asset board with seven sections. Each is
collapsible; collapse state persists in `localStorage["bloomberg_tickdata_sections"]`
(default collapsed: `ratesJP`, `fx`). Drag a section's grip onto another header or use
its up/down buttons to reorder whole sections. The order persists in
`localStorage["bloomberg_tickdata_order"]`, independently from collapse state.
Invalid/duplicate stored IDs are ignored and newly added sections append to the saved order.

Default order: **RATES · US → RATES · JP → AMERICAS → EMEA → ASIA PACIFIC → VOLATILITY → FX**.
The US market clock and column headings stay fixed above the reordered sections.

| Section | Source | Row component |
|---------|--------|---------------|
| RATES · US (11 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| RATES · JP (15 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| AMERICAS / EMEA / ASIA PACIFIC | `useMarketDataQuery` → `/api/market-data` | `TickRow` |
| VOLATILITY (VIX family) | `/api/volatility` | `TickRow` + subgroup headers |
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

## Bollinger Fit — 2026-09-13

- MKT, stock analysis and shared `ChartPanel` (floating/detached windows) all pass chart bars into the picker. Factories and diagnostics share one calculator; enabling BB and %B with equal costs fits identical parameters.
- `period` / `stdDev` remain manual fallbacks. Fit always searches **bars**, regardless of global DAYS/BARS input setting. Mode and cost persist in the existing `chart:indicator-specs` atom; the selected n/k and fitted returns never persist across symbols or datasets.
- Uses all loaded history, not only the visible viewport. Search recomputes when the dataset/cost changes; cash rate and risk-free rate are zero and Sharpe is **per bar**, without an annualization calendar assumption. The last candle is conservatively excluded. Minimum 201 input bars; first 100 are warmup; remaining closed bars split chronologically 70/30. At least 3 completed training trades and finite nonzero return SD qualify a candidate. Ties select smaller n, then k; negative best scores remain negative.
- Manual chart behavior is preserved when fitting is unavailable, with a visible `FIT N/A · MANUAL` chip and reason in settings. Historical fitted bands redraw using the winning parameters, so the display is not a walk-forward signal history.
- `alerts/quickAlerts.ts` omits fitted BB/%B from the active-chart suggestions because the daily alert backend cannot reproduce a chart-local fit. Fixed-parameter alert catalog/custom rules remain available. `quickAlerts.ts` and `customCondition.ts` exclude `fitCostBps` from signal params.


## ATR Accumulation Pane — 2026-09-13

- Optional registry entry `atr-regime` in Volatility. Stable pane ID preserves pane identity when settings change. Available through the shared picker/hook in MKT, stock analysis and chart windows; default indicator specs are unchanged.
- Defaults: Wilder ATR14, prior ATR% baseline50, limit1.0, trend EMA50, slope span5, display `percent`. `ATR% = 100 × ATR / close`. First TR uses high-low; later TR includes gaps from previous close. ATR and EMA use full-window SMA seeds.
- Green (`accumulate`) requires ATR% <= the **previous** lookback ATR% SMA × limit AND close > EMA AND EMA > its value slope-bars ago. Red (`avoid`) means the complete-data rule is false. Gray (`unknown`) covers incomplete history/invalid HLC and zero baseline. With default BARS settings the first possible classification is the 64th valid bar; ATR values exist earlier and draw gray.
- The thin gray threshold line uses ATR% units by default. In absolute display it is converted with current close (`thresholdPercent × close / 100`), so threshold crossings agree with the same normalized classification.
- Window lengths follow the shared BARS/DAYS setting; ratio and display do not scale. `config.inputParams` retains raw spec values for gear edits, while calculator config receives bar counts. Applying changes replaces the existing ATR pane.
- Calculator is O(N), cached by immutable OHLCV array/settings. It uses only current/past bars, so appending future bars preserves existing values. A forming candle can change until close; prepending older history can change recursive seeds. Invalid HLC resets ATR/EMA; explicit `{time}` whitespace retains missing timestamps, while a transparent outgoing segment before each gap prevents the native renderer from joining across it.
- Colors describe the user's configurable low-volatility/uptrend filter, not observed institutional accumulation. This entry has no backend alert outputs or alert labels; it must not be offered as a backend-evaluated operand.


## MKT REGIME IV Smile — 2026-09-13

- **25Δ metrics (2026-09-23):** Below the chart, one row per actual expiry displays observed skew `C25Δ − P25Δ` and curvature/butterfly `(C25Δ + P25Δ)/2 − ATM`, both in IV percentage points. Reuse the same strike range and quote-quality filtered observations regardless of side/FIT display choice; `OBS` marks the source even when Raw SVI is visible. Delta is Black-Scholes spot delta with zero carry (the chain has no reliable forward/dividend yield); interpolate IV between adjacent OTM strikes in delta space, never extrapolate. ATM is the call/put IV mean at spot when quoted, or the OTM put/call interpolation across spot. Missing wings, ATM, spot or positive time show `—`; no synthetic zero.

- **OI overlay (2026-09-13):** OI OFF/ON (defaultOFF), stacked Call cyan/Put amber contracts on right `oi` axis, every IV/SVI line on left `iv` axis. ComposedChart shares numeric K grid; custom centered3px compact/5px expanded rectangles keep OI visible despite dense SVI samples. Tooltip uses contracts for OI and% for IV. One labeled actual expiry is shown at a time, selected among active maturities in MULTI; removed expiry/new symbol safely falls back to first selected expiry. OI totals/P-C reflect selected K range and all contracts regardless of IV/quote filter; unknowns show PARTIAL/unavailable. No extra fetch or refit for OI toggles/expiry selection. Current reported OI only, no daily history. OI can draw when IV has too few points, with explicit insufficient-IV note. Shared compact/expanded hook state, no new persistence.

- `market-view.tsx` passes its main-chart `selectedSymbol` to `SectorRegimeHeatmap`. The lower-left REGIME adds **IV** alongside CORR/GEOM/ROT and also in its expanded modal. It follows main MKT chart selection (watchlist, symbol GO or tick row); floating-window focus does not replace the main chart symbol.
- `views/iv-smile-panel.tsx` keeps numeric `K (strike)` X, `IV (%)` Y and S reference. FIT defaults OFF (observed quotes); Raw SVI is optional. Single-expiry Call cyan/Put amber; multi-expiry color identifies maturity and Put is dashed. Call+Put, Call, Put or OTM selector (OTM uses put below S, call at/above S, never substitutes missing quotes from ITM side). POINTS toggles original observations over fitted lines; unavailable fits keep their observed dots visible. OFF joins actual observations, and missing quotes never become zeros.
- `hooks/useIvSmile.ts` uses existing `/api/options?symbol=&expiry=` only while IV is active. Discovery provides expirations; single default is nearest30 days preferring >=7 DTE. MULTI selects nearest actual expiries to calendar targets 1/3/5/7/9 months, clamps month-end, requires >=7 DTE and max45-day distance, deduplicates shared expiries, labels actual date/DTE with ≈. Month buttons select at least one. Queries reuse `options/chain/symbol/expiry` cache (5min); cancellation and symbol+expiry identity guards prevent stale plots. Per-expiry errors do not remove other available slices.
- Raw SVI fits request `/api/options/smile-fit` only when selected, S>0 and T>0; keys include symbol/expiry/chain dataUpdatedAt/range/quality/side/T. Fits use displayed observations only. `smilePlotRows` makes a shared numeric K grid for aligned tooltips, evaluates each fit only inside its observed strike span and preserves raw dots at exact quoted strikes. Show per-series RMSE (IV percentage points), sample counts via tooltip, and expandable `a,b,rho,m,sigma` or unavailable reason. Positive total variance alone does not guarantee an arbitrage-free surface; UI details say so. Use k=ln(K/S), ACT/365 date-only T because Yahoo does not supply a reliable forward. This is descriptive curve fitting, not a trading signal.
- Expiry/range/quality/fit/points/side/multi/month state is shared across compact and expanded views, without new localStorage keys. Symbol changes reset single expiry to the preferred maturity; other display preferences remain. Range defaults to K±25% (±50% and ALL K available). QUOTED requires positive bid and finite ask>=bid; ALL IV includes unquoted rows. IV<=0.0001/nonfinite stays missing. Chart requires >=3 distinct strikes; SVI requires >=8 per series and log-strike span>=0.05. 0DTE or missing S keeps observed quotes only.
- No options (HTTP404), loading, errors, unexpired-data absence and too few valid points have explicit UI states. Footer displays provider delay (metadata says ~15min) and fetched-at tooltip; this timestamp is not a quote/trade timestamp. Current chain only, no historical strike-level smile.
- CORR/GEOM queries and trend strip are disabled/hidden for IV and ROT. The matrix ResizeObserver reattaches when returning to a matrix view after its DOM was unmounted. Existing hydration-safe mode persistence also accepts `iv`.


## Watchlist shared data and rendering (2026-09-23)

| File | Exports / behavior |
|---|---|
| `lib/market-data-client.ts` | `MarketDataError`, `RequestQueue`, `SymbolBatcher`, `marketJson`, `marketRetry`, `marketRetryDelay`, `retryAfterSeconds`, `StockQuote`, `quoteBatcher`, `sparklineBatcher`, `quoteQueryOptions` |
| `lib/market-data-proxy.ts` | `marketDataProxy` — backend status/body/Retry-After, abort/deadline, no retry |
| `components/bloomberg/hooks/useMarketQueryResults.ts` | `useMarketQueryResults` — public TanStack QueriesObserver, 50ms React notification coalescing, one polling pass per resource, no overlapping passes, pause in hidden tab |
| `components/bloomberg/hooks/useWatchlistData.ts` | `useWatchlistQuotes`, `useWatchlistSparklines` — stable per-symbol query keys, retained cache, complete quote coverage, optional sparkline observers |
| `components/bloomberg/hooks/useStockData.ts` | `useStockQuote` shares quote key/transport with Watchlist; `useStockHistory(symbol, period, interval, enabled)` lets MKT load only the active chart mode |
| `components/bloomberg/hooks/useWatchlistSignals.ts` | per-symbol cache15min + batched network, no list truncation; existing `WatchlistSignal` shape unchanged |
| `components/bloomberg/hooks/useStockPredictions.ts` | all eligible symbols batched10, ready/no-market distinct from error |
| `components/bloomberg/views/pinned-assets.tsx` | full-list price/signal/PM data, sort before paging100 rows, overlapping groups share queries; cards request only displayed sparklines; coverage/errors shown; ADD saves before waiting for price |

The browser transport permits three batch requests concurrently. Quote jobs have priority, with an older non-quote job admitted after three quote jobs. Each reader owns its cancellation; cancelling one reader never aborts a surviving reader's shared request. Query retention30min survives panel remounts. Realtime quotes poll60s (off300s), technical scans900s and PM180s after a pass finishes. Metadata edits do not change quote keys. Data refresh remains full-list even though rendering is paged; groups are optional.
