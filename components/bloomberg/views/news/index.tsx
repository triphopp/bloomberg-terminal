"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { AskBar, AskColumn, useAskColumnShown } from "../../ask";
import { useTabShortcuts } from "../../hooks/useTabShortcuts";
import { bloombergColors } from "../../lib/theme-config";
import { NEWS_TAB_KEY } from "./constants";
import { DataTab } from "./data-tab";
import { NewsFeedTab } from "./newsfeed-tab";
import { PolymarketColumn } from "./polymarket-column";
import { SocialTab } from "./social-tab";
import type { NewsTab, WatchlistMarket } from "./types";
import { WatchlistNewsTab } from "./watchlist-tab";

// Memoised: their props (theme, callbacks, matched markets) change rarely, and
// NewsView re-renders for reasons that are none of their business.
const WatchlistTab = memo(WatchlistNewsTab);
const FeedTab = memo(NewsFeedTab);
const SocialFeedTab = memo(SocialTab);
const SeriesTab = memo(DataTab);
const MarketsColumn = memo(PolymarketColumn);

const TABS: { id: NewsTab; label: string }[] = [
  { id: "watchlist", label: "WATCHLIST" },
  { id: "feed", label: "NEWSFEED" },
  { id: "social", label: "SOCIAL" },
  { id: "data", label: "DATA" },
];

interface NewsViewProps {
  isDarkMode: boolean;
  onBack: () => void;
}

export default function NewsView({ isDarkMode }: NewsViewProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [activeTab, setActiveTab] = useState<NewsTab>(() => {
    if (typeof window === "undefined") return "watchlist";
    const saved = localStorage.getItem(NEWS_TAB_KEY) as NewsTab | null;
    return saved && TABS.some((t) => t.id === saved) ? saved : "watchlist";
  });
  useTabShortcuts(TABS, setActiveTab);

  useEffect(() => {
    localStorage.setItem(NEWS_TAB_KEY, activeTab);
  }, [activeTab]);

  // Prediction markets matched to the watchlist, lifted so the shared right-hand
  // Polymarket column can render them next to whichever tab is open.
  const [markets, setMarkets] = useState<WatchlistMarket[]>([]);
  const [focus, setFocus] = useState<string[] | null>(null);
  const [ladder, setLadder] = useState<{ symbol: string; company: string } | null>(null);

  const handleMarkets = useCallback(
    (m: WatchlistMarket[], f: string[] | null, l: { symbol: string; company: string } | null) => {
      setMarkets(m);
      setFocus(f);
      setLadder(l);
    },
    []
  );

  // ASK lives in components/bloomberg/ask; this view only gives it a column.
  const askShown = useAskColumnShown();

  const tabStyle = (active: boolean) => ({
    borderBottom: active ? `2px solid ${colors.accent}` : "2px solid transparent",
    color: active ? colors.accent : colors.textSecondary,
  });

  return (
    <div
      className="h-full flex flex-col font-mono overflow-hidden"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-2 px-2 py-1 border-b"
        style={{ backgroundColor: colors.surface, borderColor: colors.border }}
      >
        <div className="flex items-end gap-0">
          {TABS.map((tab, i) => (
            <button
              aria-pressed={activeTab === tab.id}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-1 px-3 py-1 text-xs font-mono font-bold tracking-widest uppercase transition-colors"
              style={tabStyle(activeTab === tab.id)}
              title={`Alt+${i + 1}`}
            >
              <span className="text-[8px] opacity-35 hidden sm:inline">⌥{i + 1}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[9px]" style={{ color: colors.textSecondary }}>
          {activeTab === "watchlist"
            ? "news sourced per watchlist symbol · grouped by sector"
            : activeTab === "feed"
              ? "topic newswire"
              : activeTab === "social"
                ? "followed social accounts"
                : "published series — recorded here one day at a time"}
        </span>
      </div>

      {/* ── Body: ask + tab content + shared polymarket column ────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* ASK: the question box sits above every tab until a conversation is open;
              then it lives at the foot of the answer column on the right. */}
          <AskBar />
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {activeTab === "watchlist" && (
              <WatchlistTab colors={colors} onMarketsChange={handleMarkets} />
            )}
            {activeTab === "feed" && <FeedTab colors={colors} />}
            {activeTab === "social" && <SocialFeedTab colors={colors} />}
            {activeTab === "data" && <SeriesTab colors={colors} />}
          </div>
        </div>

        <AskColumn />

        {/* The answer column takes this one's place while it is open. */}
        {activeTab !== "data" && !askShown && (
          <MarketsColumn
            colors={colors}
            isDark={isDarkMode}
            watchlistMarkets={markets}
            focusSymbols={activeTab === "watchlist" ? focus : null}
            ladderSymbol={activeTab === "watchlist" ? (ladder?.symbol ?? null) : null}
            ladderCompany={ladder?.company}
          />
        )}
      </div>
    </div>
  );
}
