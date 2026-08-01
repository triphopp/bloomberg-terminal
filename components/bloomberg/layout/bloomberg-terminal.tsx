"use client";

import { useAtom } from "jotai";
import dynamic from "next/dynamic";
import { Suspense, memo, useCallback, useEffect } from "react";
import {
  chartTypeAtom,
  focusHeatmapSearchAtom,
  isGlobalSearchOpenAtom,
  showHeatmapSettingsAtom,
  showYTDAtom,
  stockSearchSymbolAtom,
} from "../atoms";
import {
  addWatchlistAtom,
  closeConfirmModalAtom,
  confirmAndCloseModalAtom,
  confirmModalPropsAtom,
  isConfirmModalOpenAtom,
  isWatchlistOpenAtom,
  openConfirmModalAtom,
} from "../atoms/terminal-ui";
import { resetFiltersAtom } from "../atoms/terminal-ui";
import { ConfirmationModal } from "../core/confirmation-modal";
import { ShortcutsHelp } from "../core/keyboard-shortcuts";
import { ViewSkeleton } from "../core/view-skeleton";
import { Watchlist } from "../core/watchlist";
import { useTerminalUI, useViewPrefetch } from "../hooks";
import { useMarketDataQuery } from "../hooks";
import { AlertTicker } from "../layout/alert-ticker";
import { TailRiskRibbon } from "../layout/tail-risk-ribbon";
import { TerminalHeader } from "../layout/terminal-header";
import type { NavItem } from "../layout/terminal-header";
import { TerminalLayout } from "../layout/terminal-layout";
import { bloombergColors } from "../lib/theme-config";
import type { MarketItem } from "../types";

// ── Eager: default landing view ────────────────────────────────────
import { KeyIndicatorsBar, MarketView } from "../views/market-view";

// ── Lazy: loaded only when user navigates to that view ─────────────
const MarketMoversView = dynamic(() => import("../views/market-movers-view"), {
  loading: () => <ViewSkeleton />,
});
const MacroView = dynamic(() => import("../views/macro-view").then((m) => m.MacroView), {
  loading: () => <ViewSkeleton />,
});
const CreditView = dynamic(() => import("../views/credit-view").then((m) => m.CreditView), {
  loading: () => <ViewSkeleton />,
});
const NewsView = dynamic(() => import("../views/news-view"), { loading: () => <ViewSkeleton /> });
const ClippingsView = dynamic(() => import("../views/clippings-view"), {
  loading: () => <ViewSkeleton />,
});
const StockView = dynamic(() => import("../views/stock-view"), { loading: () => <ViewSkeleton /> });
const PortfolioView = dynamic(
  () => import("../views/portfolio-view").then((m) => m.PortfolioView),
  { loading: () => <ViewSkeleton /> }
);
const CryptoView = dynamic(() => import("../views/crypto-view").then((m) => m.CryptoView), {
  loading: () => <ViewSkeleton />,
});
const FxView = dynamic(() => import("../views/fx-view").then((m) => m.FxView), {
  loading: () => <ViewSkeleton />,
});
const TailRiskView = dynamic(() => import("../views/tail-risk-view").then((m) => m.TailRiskView), {
  loading: () => <ViewSkeleton />,
});

const MemoMarketMovers = memo(MarketMoversView);
const MemoMacro = memo(MacroView);
const MemoCredit = memo(CreditView);
const MemoNews = memo(NewsView);
const MemoClippings = memo(ClippingsView);
const MemoStock = memo(StockView);
const MemoPortfolio = memo(PortfolioView);
const MemoCrypto = memo(CryptoView);
const MemoFx = memo(FxView);
const MemoTailRisk = memo(TailRiskView);

function BloombergTerminal() {
  const {
    isDarkMode,
    currentView,
    setCurrentView,
    isShortcutsHelpOpen,
    setIsShortcutsHelpOpen,
    handleMarketView,
    handleNewsView,
    handleMoversView,
    handleStockView,
    handleClippingsView,
    handleMacroView,
    handleCreditView,
    handlePortfolioView,
    handleCryptoView,
    handleFxView,
    handleTailView,
    handleHelpClick,
  } = useTerminalUI();

  const { prefetchTier1 } = useViewPrefetch();

  // Prefetch tier-1 view chunks when idle after mount
  useEffect(() => {
    prefetchTier1();
  }, [prefetchTier1]);

  // Jotai atoms
  const [isConfirmModalOpen] = useAtom(isConfirmModalOpenAtom);
  const [confirmModalProps] = useAtom(confirmModalPropsAtom);
  const [isWatchlistOpen, setIsWatchlistOpen] = useAtom(isWatchlistOpenAtom);
  const [, resetFilters] = useAtom(resetFiltersAtom);
  const [, openConfirmModal] = useAtom(openConfirmModalAtom);
  const [, closeConfirmModal] = useAtom(closeConfirmModalAtom);
  const [, confirmAndCloseModal] = useAtom(confirmAndCloseModalAtom);
  const [, addWatchlist] = useAtom(addWatchlistAtom);
  const [, setIsGlobalSearchOpen] = useAtom(isGlobalSearchOpenAtom);
  const [showYTD, setShowYTD] = useAtom(showYTDAtom);
  const [, setGlobalChartType] = useAtom(chartTypeAtom);
  const [, signalHeatmapSearch] = useAtom(focusHeatmapSearchAtom);
  const [, setShowHeatmapSettings] = useAtom(showHeatmapSettingsAtom);

  // Market data
  const { marketData: data, refreshData, isLoading } = useMarketDataQuery();
  const [stockSymbol] = useAtom(stockSearchSymbolAtom);

  // Watchlist indices
  const allMarketIndices = useCallback(() => {
    const indices: string[] = [];
    if (data?.americas) for (const item of data.americas) indices.push(item.id);
    if (data?.emea) for (const item of data.emea) indices.push(item.id);
    if (data?.asiaPacific) for (const item of data.asiaPacific) indices.push(item.id);
    return indices;
  }, [data]);

  // ── Esc handler: back to parent view (NOT cancl confirm) ──────────────────
  const handleEscape = useCallback(() => {
    // If we're in a sub-view, go back to market (home)
    if (currentView !== "market") {
      setCurrentView("market");
    }
    // If already on market view, Esc does nothing (no annoying confirm dialog)
  }, [currentView, setCurrentView]);

  // ── Navigation items with shortcut keys ──────────────────────────────────
  const navItems: NavItem[] = [
    { id: "market", label: "MKT", shortcut: "1", onClick: handleMarketView },
    { id: "news", label: "NEWS", shortcut: "2", onClick: handleNewsView },
    { id: "movers", label: "GMOV", shortcut: "3", onClick: handleMoversView },
    { id: "clippings", label: "CLIP", shortcut: "4", onClick: handleClippingsView },
    { id: "macro", label: "MACRO", shortcut: "5", onClick: handleMacroView },
    { id: "credit", label: "CRDT", shortcut: "6", onClick: handleCreditView },
    { id: "portfolio", label: "PORT", shortcut: "P", onClick: handlePortfolioView },
    { id: "crypto", label: "CRYP", shortcut: "C", onClick: handleCryptoView },
    { id: "fx", label: "FX", shortcut: "E", onClick: handleFxView },
    { id: "tail", label: "TAIL", shortcut: "T", onClick: handleTailView },
  ];

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  const shortcuts = [
    // Search
    { key: "/", action: () => setIsGlobalSearchOpen(true), description: "Open global search" },
    {
      key: "k",
      ctrlKey: true,
      action: () => setIsGlobalSearchOpen(true),
      description: "Open global search",
    },
    // Esc → back to market (not confirm)
    { key: "Escape", action: handleEscape, description: "Back / close overlay" },
    // Refresh
    { key: "r", ctrlKey: true, action: refreshData, description: "Refresh data" },
    // YTD toggle
    {
      key: "y",
      action: () => {
        if (currentView !== "portfolio") setShowYTD((v) => !v);
      },
      description:
        currentView === "portfolio" ? "Toggle THB ↔ USD (PORT only)" : "Toggle %Chg YTD / Daily",
    },
    // View shortcuts (number keys)
    { key: "1", action: handleMarketView, description: "Market overview" },
    { key: "2", action: handleNewsView, description: "News" },
    { key: "3", action: handleMoversView, description: "Market movers" },
    { key: "4", action: handleClippingsView, description: "Clippings" },
    { key: "5", action: handleMacroView, description: "Macro" },
    { key: "6", action: handleCreditView, description: "Credit" },
    { key: "p", action: handlePortfolioView, description: "Portfolio" },
    {
      key: "i",
      action: () => {
        handleMarketView();
        signalHeatmapSearch((n) => n + 1);
      },
      description: "Focus symbol search (MKT)",
    },
    { key: "c", action: handleCryptoView, description: "Crypto" },
    { key: "e", action: handleFxView, description: "FX / Forex" },
    { key: "t", action: handleTailView, description: "Tail Risk Monitor" },
    // Help
    { key: "?", shiftKey: true, action: handleHelpClick, description: "Show keyboard shortcuts" },
    // Toggle chart type
    {
      key: "T",
      ctrlKey: true,
      shiftKey: true,
      action: () => setGlobalChartType((t) => (t === "candle" ? "area" : "candle")),
      description: "Toggle Area / Candle chart",
    },
    // New watchlist
    {
      key: "n",
      ctrlKey: true,
      action: () => setIsWatchlistOpen(true),
      description: "Create new watchlist",
    },
    // Tab switching within view
    // Display-only in the help panel — actual per-view tab shortcuts (1–9) are
    // bound inside each view, not here, so this entry has no action to run.
    { key: "1–9", altKey: true, action: () => {}, description: "Switch to tab N in current view" },
  ];

  const headerColors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const VIEW_SUBTITLES: Record<string, string> = {
    news: "NEWS & SOCIAL",
    movers: "GLOBAL MARKET MOVERS",
    clippings: "CLIPPINGS · OLLAMA AI",
    macro: "MACRO ECONOMICS",
    credit: "CREDIT RISK & STRESS",
    portfolio: "PORTFOLIO",
    crypto: "CRYPTO",
    fx: "FX / FOREX",
    stock: "STOCK ANALYSIS",
    tail: "TAIL RISK MONITOR",
  };

  // ── Shared header (filter bar + key indicators merged in) ─────────────────
  const headerBlock = (
    <div className="shrink-0">
      <TerminalHeader
        isDarkMode={isDarkMode}
        currentView={currentView}
        navItems={navItems}
        onSearchClick={() => setIsGlobalSearchOpen(true)}
        onHelpClick={handleHelpClick}
        showYTD={showYTD}
        onYTDToggle={() => setShowYTD((v) => !v)}
        centerSlot={
          currentView === "market" && data ? (
            <KeyIndicatorsBar data={data} colors={headerColors} />
          ) : VIEW_SUBTITLES[currentView] ? (
            <span
              className="text-[9px] font-mono px-2 tracking-widest"
              style={{ color: headerColors.textSecondary, opacity: 0.55 }}
            >
              {VIEW_SUBTITLES[currentView]}
            </span>
          ) : undefined
        }
        onSettingsClick={() => setShowHeatmapSettings((v) => !v)}
        onBack={currentView !== "market" ? handleEscape : undefined}
      />
    </div>
  );

  // ── Shared modals ──────────────────────────────────────────────────────────
  const modals = (
    <>
      <ConfirmationModal
        isOpen={isConfirmModalOpen}
        onClose={closeConfirmModal}
        onConfirm={confirmAndCloseModal}
        title={confirmModalProps.title}
        message={confirmModalProps.message}
        isDarkMode={isDarkMode}
      />
      <Watchlist
        isOpen={isWatchlistOpen}
        onClose={() => setIsWatchlistOpen(false)}
        isDarkMode={isDarkMode}
        marketIndices={allMarketIndices()}
        onSave={(wl: { name: string; indices: string[] }) => addWatchlist(wl)}
      />
      <ShortcutsHelp
        shortcuts={shortcuts}
        isOpen={isShortcutsHelpOpen}
        onClose={() => setIsShortcutsHelpOpen(false)}
        isDarkMode={isDarkMode}
      />
    </>
  );

  // Back handler for sub-views — same as Esc
  const handleBack = () => setCurrentView("market");

  // ── View rendering ─────────────────────────────────────────────────────────

  const renderView = () => {
    switch (currentView) {
      case "news":
        return <MemoNews isDarkMode={isDarkMode} onBack={handleBack} />;
      case "movers":
        return (
          <MemoMarketMovers
            isDarkMode={isDarkMode}
            onBack={handleBack}
            marketData={data}
            onRefresh={refreshData}
            isLoading={isLoading}
          />
        );
      case "stock":
        return <MemoStock onBack={handleBack} defaultSymbol={stockSymbol || undefined} />;
      case "clippings":
        return <MemoClippings onBack={handleBack} />;
      case "macro":
        return <MemoMacro onBack={handleBack} />;
      case "credit":
        return <MemoCredit onBack={handleBack} />;
      case "portfolio":
        return <MemoPortfolio />;
      case "crypto":
        return <MemoCrypto onBack={handleBack} />;
      case "fx":
        return <MemoFx onBack={handleBack} />;
      case "tail":
        return <MemoTailRisk onBack={handleBack} />;
      default:
        return <MarketView isDarkMode={isDarkMode} />;
    }
  };

  return (
    <TerminalLayout shortcuts={shortcuts}>
      {headerBlock}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<ViewSkeleton />}>{renderView()}</Suspense>
      </div>
      <TailRiskRibbon />
      <AlertTicker />
      {modals}
    </TerminalLayout>
  );
}

export default memo(BloombergTerminal);
