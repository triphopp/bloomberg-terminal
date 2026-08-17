import type { Platform, Sentiment, SourceKind } from "./types";

// ── localStorage keys ─────────────────────────────────────────────────────────

export const TOPICS_KEY = "bloomberg_news_topics";
export const SOCIAL_KEY = "bloomberg_social_handles";
export const WL_SOURCES_KEY = "bloomberg_news_wl_sources";
export const WL_LAYOUT_KEY = "bloomberg_news_wl_layout";
export const NEWS_TAB_KEY = "bloomberg_news_tab";

export const DEFAULT_TOPICS = ["market", "economy", "Fed"];

// ── Sector palette ────────────────────────────────────────────────────────────
// GICS sectors + the pseudo-sectors the backend assigns to crypto / FX / indices.

export const SECTOR_COLORS: Record<string, string> = {
  "Information Technology": "#38bdf8",
  Technology: "#38bdf8",
  "Communication Services": "#a855f7",
  "Consumer Discretionary": "#f97316",
  "Consumer Cyclical": "#f97316",
  "Consumer Staples": "#84cc16",
  "Consumer Defensive": "#84cc16",
  Financials: "#22c55e",
  "Financial Services": "#22c55e",
  Healthcare: "#ec4899",
  "Health Care": "#ec4899",
  Industrials: "#eab308",
  Energy: "#ef4444",
  Materials: "#14b8a6",
  "Basic Materials": "#14b8a6",
  Utilities: "#60a5fa",
  "Real Estate": "#c084fc",
  "Crypto / FX": "#f59e0b",
  Index: "#94a3b8",
  Unclassified: "#6b7280",
};

export function sectorColor(sector: string): string {
  return SECTOR_COLORS[sector] ?? "#8b8b8b";
}

/** 3-letter sector abbreviation for the compact tags on each headline. */
export const SECTOR_ABBR: Record<string, string> = {
  "Information Technology": "TEC",
  Technology: "TEC",
  "Communication Services": "COM",
  "Consumer Discretionary": "CDI",
  "Consumer Cyclical": "CDI",
  "Consumer Staples": "CST",
  "Consumer Defensive": "CST",
  Financials: "FIN",
  "Financial Services": "FIN",
  Healthcare: "HLT",
  "Health Care": "HLT",
  Industrials: "IND",
  Energy: "ENR",
  Materials: "MAT",
  "Basic Materials": "MAT",
  Utilities: "UTL",
  "Real Estate": "RE",
  "Crypto / FX": "CFX",
  Index: "IDX",
  Unclassified: "N/A",
};

export function sectorAbbr(sector: string): string {
  return SECTOR_ABBR[sector] ?? sector.slice(0, 3).toUpperCase();
}

// ── Source styling ────────────────────────────────────────────────────────────

export const SOURCE_KIND_COLORS: Record<SourceKind, string> = {
  wire: "#7B61FF",
  aggregator: "#0A6EBD",
  analysis: "#0F8A65",
  filing: "#D4142C",
  company: "#FF8C00",
};

export const SOURCE_COLORS: Record<string, string> = {
  "Yahoo Finance": "#7B61FF",
  CNBC: "#D4142C",
  MarketWatch: "#0A6EBD",
  "Reuters Biz": "#FF8C00",
  Investopedia: "#0F8A65",
  "Google News": "#4285F4",
  "Bing News": "#008373",
  "Seeking Alpha": "#F5A623",
  Nasdaq: "#0092CF",
  "SEC EDGAR": "#D4142C",
};

export function sourceColor(name: string): string {
  return SOURCE_COLORS[name] ?? "#888";
}

/** Every source id the backend exposes — the default is "all on". */
export const ALL_SOURCE_IDS = [
  "yahoo",
  "yfinance",
  "google",
  "bing",
  "seekingalpha",
  "nasdaq",
  "sec",
] as const;

export const SOURCE_LABELS: Record<string, string> = {
  yahoo: "YAHOO",
  yfinance: "YF",
  google: "GOOGLE",
  bing: "BING",
  seekingalpha: "SA",
  nasdaq: "NASDAQ",
  sec: "SEC",
};

// ── Sentiment ─────────────────────────────────────────────────────────────────

export const SENTIMENT_COLORS: Record<Sentiment, string> = {
  POS: "#22c55e",
  NEG: "#ef4444",
  NEU: "#6b7280",
};

export const SENTIMENT_GLYPH: Record<Sentiment, string> = {
  POS: "▲",
  NEG: "▼",
  NEU: "·",
};

// ── Social platforms ──────────────────────────────────────────────────────────

export const PLATFORMS: Platform[] = ["twitter", "youtube", "reddit", "rss"];

export const PLATFORM_INFO: Record<
  Platform,
  { label: string; color: string; placeholder: string }
> = {
  twitter: { label: "X", color: "#999999", placeholder: "@handle  or  handle" },
  youtube: { label: "YT", color: "#FF0000", placeholder: "UCxxxxx  or  @ChannelHandle" },
  reddit: { label: "REDDIT", color: "#FF4500", placeholder: "wallstreetbets  or  r/investing" },
  rss: { label: "RSS", color: "#F26522", placeholder: "https://example.com/feed.rss" },
};
