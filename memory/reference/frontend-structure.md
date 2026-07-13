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
│   ├── news-view.tsx            ← NEWS: NEWSFEED tab | SOCIAL tab + Polymarket column right (256px fixed, always visible)
│   ├── market-movers-view.tsx   ← GMOV: global indices table + heatmap treemap
│   ├── clippings-view.tsx       ← CLIP: Obsidian reader + Ollama AI panel
│   ├── macro-view.tsx           ← MACRO shell (911 ln): dashboard/yield/indicators/fed inline + country/signals imported. (2026-06-10: split, dead MarketQualityTab cluster deleted)
│   ├── macro/shared.tsx         ← SectionHeader (shared across macro tabs)
│   ├── macro/country-tab.tsx    ← CountryMacroTab + World Bank charts + country constants (POPULAR_COUNTRIES, WB_CATEGORIES, fmtWbVal)
│   ├── credit-view.tsx          ← CRDT: 4 tabs (overview/spreads/stress/consumer)
│   ├── stock-view.tsx           ← Equity analysis (9 tabs) — no nav button, via search/heatmap
│   ├── crypto-view.tsx          ← CRYP: 20 coins + chart
│   ├── fx-view.tsx              ← FX: 20 pairs + chart
│   ├── pinned-assets.tsx        ← Pinned assets sidebar
│   ├── rotation-tab.tsx         ← COUNTRY EQUITY ROTATION tab (inside macro-view SIGNALS)
│   ├── sector-tab.tsx           ← SECTOR SELECTION tab (inside macro-view SIGNALS)
│   ├── options-tab.tsx          ← stock-view OPTIONS tab: chain, strategies (10 auto-scan), builder, greeks, vol surface
│   ├── strategy-builder.tsx    ← Strategy Builder: 19 templates, multi-expiry (Calendar/Diagonal), BS payoff, leg editor
│   ├── ui-primitives.tsx        ← shared UI primitives (created, not yet migrated to all views)
│   │
│   └── portfolio/               ← PORT: barrel re-export from portfolio-view.tsx
│       ├── index.tsx            ← PortfolioView shell: account tabs, summary bar, 4 top-level tabs (Alt+1-4) + context-sensitive sub-tab bar
│       ├── types.ts             ← all interfaces (Account, Trade, CashEntry, Dividend, etc.)
│       ├── helpers.ts           ← fmt, fmtK, fmtPct, pnlColor, wlColor, groupKey, FLAG
│       ├── constants.ts         ← ALL_COLS, DEFAULT_COLS, DENSE_COLS, TH_SECTORS (34), US_SECTORS (11),
│       │                           GROUP_COLORS, FINANSIA_SUBS, ALLOC_COLORS, SECTOR_COLORS
│       ├── ui/
│       │   ├── AccBadge.tsx     ← AccBadge, WLBadge
│       │   └── SummaryBar.tsx   ← total cost, unrealized P&L, day change
│       ├── modals/
│       │   ├── SellModal.tsx    ← sell / partial-sell modal
│       │   └── TradeEditModal.tsx ← trade edit modal (17 fields, bulk-patch-sector)
│       └── tabs/
│           ├── OpenPositionsTab.tsx  ← positions table: DENSE, COLS picker, SELL/EDIT, grouped lots
│           ├── OptionsTab.tsx        ← options positions + live Greeks (Black-Scholes + Gram-Charlier)
│           ├── TradeLogTab.tsx       ← trade history with filter + WLBadge
│           ├── CashTab.tsx           ← cash flow CRUD + dividends CRUD + Finansia subs
│           ├── AnalyticsTab.tsx      ← P&L chart, allocation pie, dividend bar (M/Q/Y)
│           ├── BacktestTab.tsx       ← backtest v2 (4 sub-tabs: equity/holdings/distribution/attribution)
│           ├── RiskTab.tsx           ← 2 sub-tabs: OVERVIEW (dense col layout: header/9-stat/VaR+chart+EWS) | OPTIONS risk
│           ├── ThesesTab.tsx         ← investment theses list + markdown render
│           └── ImportTab.tsx         ← Excel drag-drop + manual form (IS OPTION checkbox, VAT field)
│
├── chart/
│   ├── ModularChart.tsx         ← reusable chart container (candle + overlay/pane indicators + event markers w/ per-marker color)
│   ├── ChartTimeframeBar.tsx    ← period selector (1D/1W/1M/3M/YTD/1Y/5Y/MAX)
│   ├── IndicatorPicker.tsx      ← technical indicator selector
│   ├── FearGreedPane.tsx        ← recharts sub-pane (F&G 0–100 + zone bands)
│   ├── PEPane.tsx               ← recharts sub-pane: trailing P/E line + p10/p90 valuation bands + percentile label (consumes /api/stock/pe-history)
│   ├── useChartIndicators.ts    ← indicator/overlay state; exposes vpConfig, showPE via atoms
│   └── indicators/volume-profile.ts ← session+composite VP (gap-based sessions, delta, naked POC, HVN/LVN, VRVP)
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
| `portfolio/modals/SellModal.tsx` | `SellModal` |
| `portfolio/modals/TradeEditModal.tsx` | `TradeEditModal` |
| `portfolio/tabs/OpenPositionsTab.tsx` | `OpenPositionsTab` |
| `portfolio/tabs/RiskTab.tsx` | `RiskTab` |
| `views/market-view.tsx` | `MarketView` (default), `KeyIndicatorsBar` |
| `views/news-view.tsx` | `NewsView` (default), `PolymarketColumn`, `ProbBar` |
| `views/macro-view.tsx` | `MacroView` (default) |
| `views/rotation-tab.tsx` | `RotationTab` (default) |
| `views/sector-tab.tsx` | `SectorTab` (default) |
| `hooks/useSectorSelection.ts` | `useSectorSelection()` → `{ signal, isLoading, error }` |
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
| `C` | Crypto view |
| `E` | FX / Forex view |
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
