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
  /** When the oldest pull in this answer was made — not when it was requested. */
  as_of: string;
  /** Source pulls still running when the answer was assembled; > 0 → ask again with settle=1. */
  pending?: number;
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

// ── Rotation news (GET /api/news/rotation) ───────────────────────────────────

export type Tone = "POS" | "NEG" | "NEU";

export interface RotationHeadline {
  title: string;
  url: string;
  source: string;
  published_at: string;
  tone: Tone;
}

export interface RotationNewsGroup {
  id: string;
  name: string;
  kind: string;
  quadrant: "Leading" | "Improving" | "Weakening" | "Lagging" | null;
  mom_dir: string | null;
  m1: number | null;
  m1_vs_bench: number | null;
  tone: { n: number; pos: number; neg: number; neu: number; net: number | null };
  /** Price quadrant vs headline tone; null when tone is flat or too thin. */
  read: "CONFIRMS" | "DIVERGES" | null;
  headlines: RotationHeadline[];
  loading: boolean;
  error: string | null;
}

export interface RotationNewsResponse {
  market: "US" | "TH";
  kind: string;
  kinds: string[];
  bench?: string;
  rotation_as_of?: string | null;
  as_of: string;
  groups: RotationNewsGroup[];
  pending: number;
  method: string;
  error?: string;
}

export interface RotationMember {
  symbol: string;
  name: string | null;
  /** % of the fund (US) or of the group's market cap (TH) — see `weight_basis`. */
  weight: number | null;
  m1: number | null;
  m1_vs_bench: number | null;
  /** The member's own quadrant vs the benchmark. */
  quadrant: RotationNewsGroup["quadrant"];
  tone: RotationNewsGroup["tone"];
  read: RotationNewsGroup["read"];
  headlines: RotationHeadline[];
}

export interface RotationMemberNewsResponse {
  market: "US" | "TH";
  group: {
    id: string;
    name: string;
    kind: string;
    quadrant: RotationNewsGroup["quadrant"];
    m1: number | null;
    m1_vs_bench: number | null;
  } | null;
  bench?: string;
  weight_basis?: string | null;
  members_total?: number;
  members: RotationMember[];
  rollup?: {
    weighted_net: number | null;
    weight_covered: number;
    weight_listed: number;
    pos: number;
    neg: number;
    n: number;
    breadth: { positive: number; negative: number; flat: number; no_news: number };
    read: RotationNewsGroup["read"];
  };
  as_of?: string;
  pending: number;
  method?: string;
  error?: string;
}

// ── Sector screen (GET /api/rotation/screen) ────────────────────────────────

export type ScreenFactor = "momentum" | "quality" | "value" | "low_vol";

export interface ScreenRow {
  symbol: string;
  name: string | null;
  weight: number | null;
  quadrant: RotationNewsGroup["quadrant"];
  /** Percentile inside the group, 0 = worst, 100 = best; null = not enough data. */
  factors: Record<ScreenFactor, number | null>;
  score: number | null;
  coverage: number;
  raw: Record<string, number | null>;
  beta_vix: number | null;
  beta_move: number | null;
  flags: string[];
}

export interface SectorScreenResponse {
  market: "US" | "TH";
  group: { id: string; name: string | null; quadrant?: RotationNewsGroup["quadrant"] } | null;
  as_of?: string | null;
  market_state?: {
    state: "normal" | "stress" | "greed";
    fear_greed: number | null;
    fear_greed_label?: string | null;
    vix: number | null;
    vix_pct_1y: number | null;
    move: number | null;
    move_pct_1y: number | null;
    weights: Record<ScreenFactor, number>;
    rule: string;
    rules_set: string;
  };
  rows: ScreenRow[];
  top3?: string[];
  members_total?: number;
  notes?: string[];
  method?: string;
  error?: string;
}

// ── Topic newsfeed + social (unchanged shapes) ───────────────────────────────

export interface Article {
  title: string;
  url: string;
  source: string;
  published_at: string;
  topic: string;
  /** Yahoo's related tickers; empty for RSS stories (and older cached answers). */
  tickers?: string[];
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

export type NewsTab = "watchlist" | "feed" | "social" | "data";
