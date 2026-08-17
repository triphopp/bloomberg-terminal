// Shared types for the NEWS view (watchlist · newsfeed · social · polymarket).

import type { bloombergColors } from "../../lib/theme-config";

export type ThemeColors = typeof bloombergColors.dark;

// ── Watchlist news (/api/news/watchlist) ─────────────────────────────────────

export type Sentiment = "POS" | "NEG" | "NEU";
export type SourceKind = "wire" | "aggregator" | "analysis" | "filing" | "company";

export interface WatchlistArticle {
  title: string;
  url: string;
  source: string;
  source_kind: SourceKind;
  published_at: string;
  summary: string;
  /** Every watchlist ticker this headline mentions — first is the one that fetched it. */
  symbols: string[];
  primary_symbol: string;
  sector: string;
  company: string;
  sentiment: Sentiment;
  /** "direct" — headline names the ticker/company · "feed" — off that symbol's wire only. */
  relevance: "direct" | "feed";
}

export interface WatchlistSymbolMeta {
  symbol: string;
  company: string;
  sector: string;
  industry: string | null;
  country: string | null;
  article_count: number;
}

export interface WatchlistSectorMeta {
  sector: string;
  symbols: string[];
  article_count: number;
}

export interface WatchlistMarket {
  symbol: string;
  sector: string;
  question: string;
  slug: string;
  event_slug: string;
  probability: number | null;
  volume: number;
  end_date: string;
}

export interface WatchlistNewsResponse {
  as_of: string;
  sources_used: string[];
  symbols: WatchlistSymbolMeta[];
  sectors: WatchlistSectorMeta[];
  articles: WatchlistArticle[];
  markets: WatchlistMarket[];
  errors: string[];
  error?: string;
}

export interface NewsSource {
  id: string;
  label: string;
  kind: SourceKind;
}

// ── Polymarket ────────────────────────────────────────────────────────────────

export interface PolySignal {
  signal_type: string;
  label: string;
  color: string;
  question: string;
  probability: number;
  volume: number;
  liquidity: number;
  description: string;
  end_date: string;
  slug: string;
  event_slug: string;
  status: "LIKELY" | "UNCERTAIN" | "UNLIKELY";
  direction: "UP" | "DOWN" | "STABLE";
  implied_odds: number | null;
  regime_flag: "HIGH_CONVICTION" | "UNCERTAIN";
  delta_24h: number | null;
}

export interface PolySearchResult {
  slug: string;
  event_slug: string;
  question: string;
  probability: number | null;
  volume: number;
  end_date: string;
  image: string | null;
}

// ── Topic newsfeed + social (unchanged shapes) ───────────────────────────────

export interface Article {
  title: string;
  url: string;
  source: string;
  published_at: string;
  topic: string;
}

export type Platform = "twitter" | "youtube" | "reddit" | "rss";

export interface SocialHandle {
  platform: Platform;
  handle: string;
}

export interface SocialPost {
  platform: Platform;
  handle: string;
  display_name: string;
  title: string;
  url: string;
  published_at: string;
  thumbnail: string | null;
}

export type NewsTab = "watchlist" | "feed" | "social";
