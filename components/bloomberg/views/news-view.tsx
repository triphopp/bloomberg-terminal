"use client";

import { useAtom } from "jotai";
import { ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { stockSearchSymbolAtom } from "../atoms";
import { BloombergButton } from "../core/bloomberg-button";
import { useTabShortcuts } from "../hooks/useTabShortcuts";
import { bloombergColors } from "../lib/theme-config";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PolySignal {
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

interface PolySearchResult {
  slug: string;
  event_slug: string;
  question: string;
  probability: number | null;
  volume: number;
  end_date: string;
  image: string | null;
}

interface Article {
  title: string;
  url: string;
  source: string;
  published_at: string;
  topic: string;
}

type Platform = "twitter" | "youtube" | "reddit" | "rss";

interface SocialHandle {
  platform: Platform;
  handle: string;
}

interface SocialPost {
  platform: Platform;
  handle: string;
  display_name: string;
  title: string;
  url: string;
  published_at: string;
  thumbnail: string | null;
}

type ActiveTab = "feed" | "social";

const NEWS_TABS: { id: ActiveTab }[] = [{ id: "feed" }, { id: "social" }];

// ─── Constants ────────────────────────────────────────────────────────────────

const TOPICS_KEY = "bloomberg_news_topics";
const SOCIAL_KEY = "bloomberg_social_handles";

const PLATFORM_INFO: Record<Platform, { label: string; color: string; placeholder: string }> = {
  twitter: { label: "X", color: "#999999", placeholder: "@handle  or  handle" },
  youtube: { label: "YT", color: "#FF0000", placeholder: "UCxxxxx  or  @ChannelHandle" },
  reddit: { label: "REDDIT", color: "#FF4500", placeholder: "wallstreetbets  or  r/investing" },
  rss: { label: "RSS", color: "#F26522", placeholder: "https://example.com/feed.rss" },
};

const DEFAULT_TOPICS = ["market", "economy", "Fed"];

// Source badge colors (dark-mode safe)
const SOURCE_COLORS: Record<string, string> = {
  "Yahoo Finance": "#7B61FF",
  CNBC: "#D4142C",
  MarketWatch: "#0A6EBD",
  "Reuters Biz": "#FF8C00",
  Investopedia: "#0F8A65",
};
function sourceColor(name: string): string {
  return SOURCE_COLORS[name] ?? "#888";
}

const PLATFORMS: Platform[] = ["twitter", "youtube", "reddit", "rss"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return "";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─── Polymarket hook ──────────────────────────────────────────────────────────

function usePolymarketSignals() {
  const [signals, setSignals] = useState<PolySignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [asOf, setAsOf] = useState<string>("");

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/polymarket");
      if (!r.ok) return;
      const d = await r.json();
      setSignals(d.signals ?? []);
      setAsOf(d.as_of ?? "");
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { signals, loading, asOf, refresh: fetch_ };
}

// ─── Polymarket column ────────────────────────────────────────────────────────

type Colors = {
  accent: string;
  text: string;
  textSecondary: string;
  border: string;
  surface: string;
  background: string;
};

function polyUrl(slug: string, eventSlug: string): string {
  const s = eventSlug || slug;
  return `https://polymarket.com/event/${s}`;
}

function fmtVol(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtEndDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function ProbBar({ probability, colors }: { probability: number | null; colors: Colors }) {
  if (probability === null) return null;
  const pct = Math.round(probability * 100);
  const barClr = pct >= 60 ? "#4caf50" : pct <= 35 ? "#ef5350" : "#ffc107";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 rounded-sm" style={{ backgroundColor: "#1a1a1a" }}>
        <div
          className="h-full rounded-sm transition-all"
          style={{ width: `${Math.min(100, pct)}%`, backgroundColor: barClr }}
        />
      </div>
      <span
        className="text-[9px] font-bold font-mono w-8 text-right shrink-0"
        style={{ color: barClr }}
      >
        {pct}%
      </span>
      <span className="text-[8px] font-mono shrink-0" style={{ color: colors.textSecondary }}>
        YES
      </span>
    </div>
  );
}

function PolymarketColumn({ colors, isDark }: { colors: Colors; isDark: boolean }) {
  const { signals, loading, asOf, refresh } = usePolymarketSignals();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PolySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const asOfStr = asOf
    ? new Date(asOf).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "";
  const isSearching = query.trim().length >= 2;

  const runSearch = useCallback(async (q: string) => {
    setSearchLoading(true);
    try {
      const r = await fetch(`/api/polymarket?q=${encodeURIComponent(q)}`);
      if (!r.ok) return;
      const d = await r.json();
      setSearchResults(d.results ?? []);
    } catch {
      /* ignore */
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(query.trim()), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  return (
    <div
      className="w-64 shrink-0 flex flex-col border-l overflow-hidden"
      style={{ borderColor: colors.border, backgroundColor: isDark ? "#050505" : "#fafafa" }}
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-2 py-1 border-b"
        style={{ borderColor: colors.border, backgroundColor: colors.surface }}
      >
        <span
          className="text-[9px] font-bold font-mono tracking-widest"
          style={{ color: colors.accent }}
        >
          ⚡ POLYMARKET
        </span>
        <div className="flex items-center gap-2">
          {asOfStr && !isSearching && (
            <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
              {asOfStr}
            </span>
          )}
          {!isSearching && (
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="hover:opacity-70"
              title="Refresh"
            >
              <RefreshCw
                className={`h-2.5 w-2.5 ${loading ? "animate-spin" : ""}`}
                style={{ color: colors.accent }}
              />
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 py-1 border-b"
        style={{ borderColor: colors.border }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search markets..."
          className="flex-1 bg-transparent text-[9px] font-mono outline-none placeholder:opacity-30"
          style={{ color: colors.text }}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSearchResults([]);
            }}
            className="hover:opacity-70 shrink-0"
          >
            <X className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          </button>
        )}
        {searchLoading && (
          <RefreshCw
            className="h-2.5 w-2.5 animate-spin shrink-0"
            style={{ color: colors.accent }}
          />
        )}
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
      >
        {/* ── Search results ── */}
        {isSearching && (
          <>
            {!searchLoading && searchResults.length === 0 && (
              <div
                className="py-8 text-center text-[9px] font-mono"
                style={{ color: colors.textSecondary }}
              >
                no results
              </div>
            )}
            {searchResults.map((m) => (
              <a
                key={m.slug}
                href={polyUrl(m.slug, m.event_slug)}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-2 py-2 border-b hover:bg-[#111] transition-colors group"
                style={{ borderColor: colors.border }}
              >
                <p
                  className="text-[9px] font-mono leading-snug mb-1.5 group-hover:underline line-clamp-2"
                  style={{ color: colors.text }}
                >
                  {m.question}
                </p>
                <ProbBar probability={m.probability} colors={colors} />
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                    {fmtVol(m.volume)}
                    {m.end_date ? ` · ${fmtEndDate(m.end_date)}` : ""}
                  </span>
                  <ExternalLink
                    className="h-2 w-2 opacity-0 group-hover:opacity-40"
                    style={{ color: colors.textSecondary }}
                  />
                </div>
              </a>
            ))}
          </>
        )}

        {/* ── Signal cards ── */}
        {!isSearching && (
          <>
            {loading && signals.length === 0 && (
              <div
                className="flex items-center justify-center py-10 gap-2"
                style={{ color: colors.textSecondary }}
              >
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span className="text-[9px] font-mono">loading...</span>
              </div>
            )}
            {signals.map((sig) => {
              const dirIcon = sig.direction === "UP" ? "▲" : sig.direction === "DOWN" ? "▼" : "▬";
              const dirColor =
                sig.direction === "UP"
                  ? "#4caf50"
                  : sig.direction === "DOWN"
                    ? "#ef5350"
                    : "#616161";
              const statusColor =
                sig.status === "LIKELY"
                  ? "#4caf50"
                  : sig.status === "UNLIKELY"
                    ? "#ef5350"
                    : "#ffc107";
              const deltaStr =
                sig.delta_24h != null
                  ? `${sig.delta_24h > 0 ? "+" : ""}${(sig.delta_24h * 100).toFixed(1)}pp`
                  : null;
              return (
                <a
                  key={sig.signal_type}
                  href={polyUrl(sig.slug, sig.event_slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-2 py-2 border-b hover:bg-[#111] transition-colors group"
                  style={{ borderColor: colors.border }}
                >
                  {/* Row 1: label + vol */}
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className="text-[8px] font-bold font-mono px-1 py-0.5"
                      style={{
                        color: sig.color,
                        backgroundColor: `${sig.color}18`,
                        border: `1px solid ${sig.color}44`,
                      }}
                    >
                      {sig.label.toUpperCase()}
                    </span>
                    <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                      {fmtVol(sig.volume)}
                    </span>
                  </div>

                  {/* Question */}
                  <p
                    className="text-[9px] font-mono leading-snug mb-1.5 group-hover:underline line-clamp-2"
                    style={{ color: colors.text }}
                  >
                    {sig.question}
                  </p>

                  {/* Prob bar */}
                  <ProbBar probability={sig.probability} colors={colors} />

                  {/* Status row: status + direction + delta */}
                  <div className="flex items-center gap-2 mt-1 mb-0.5">
                    <span className="text-[8px] font-bold font-mono" style={{ color: statusColor }}>
                      {sig.status ?? "—"}
                    </span>
                    <span className="text-[8px] font-mono" style={{ color: dirColor }}>
                      {dirIcon} {deltaStr ?? "no hist"}
                    </span>
                    {sig.regime_flag === "HIGH_CONVICTION" && (
                      <span
                        className="text-[7px] font-mono px-1"
                        style={{ color: "#ff9800", border: "1px solid #ff980044" }}
                      >
                        CONV
                      </span>
                    )}
                    {sig.implied_odds != null && (
                      <span
                        className="text-[8px] font-mono ml-auto"
                        style={{ color: colors.textSecondary }}
                      >
                        {sig.implied_odds.toFixed(1)}x
                      </span>
                    )}
                  </div>

                  {/* End date + link */}
                  <div className="flex items-center gap-1">
                    {sig.end_date && (
                      <span
                        className="text-[8px] font-mono shrink-0"
                        style={{ color: colors.textSecondary }}
                      >
                        Ends {fmtEndDate(sig.end_date)}
                      </span>
                    )}
                    <ExternalLink
                      className="h-2 w-2 shrink-0 opacity-0 group-hover:opacity-40 ml-auto"
                      style={{ color: colors.textSecondary }}
                    />
                  </div>
                </a>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface NewsViewProps {
  isDarkMode: boolean;
  onBack: () => void;
}

export default function NewsView({ isDarkMode, onBack }: NewsViewProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const [stockSymbol] = useAtom(stockSearchSymbolAtom);

  // ── Tab ──────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>("feed");
  useTabShortcuts(NEWS_TABS, setActiveTab);

  // ── Feed state ───────────────────────────────────────────────────────────────
  const [topics, setTopics] = useState<string[]>(DEFAULT_TOPICS);
  const [newTopic, setNewTopic] = useState("");
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);

  // ── Social state ─────────────────────────────────────────────────────────────
  const [socialHandles, setSocialHandles] = useState<SocialHandle[]>([]);
  const [socialPosts, setSocialPosts] = useState<SocialPost[]>([]);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [newHandle, setNewHandle] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>("youtube");

  // ── Load persisted state ─────────────────────────────────────────────────────
  // Runs once on mount only — stockSymbol is read solely to seed topics the
  // FIRST time there's nothing saved. Depending on it would overwrite the
  // user's saved topic list every time they navigate to a different stock.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TOPICS_KEY);
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        if (parsed.length > 0) setTopics(parsed);
      } else if (stockSymbol) {
        // Pre-seed with current stock if no saved topics
        const initial = [...DEFAULT_TOPICS, stockSymbol];
        setTopics(initial);
        localStorage.setItem(TOPICS_KEY, JSON.stringify(initial));
      }
    } catch {
      /* ignore */
    }

    try {
      const saved = localStorage.getItem(SOCIAL_KEY);
      if (saved) {
        const parsed: { platform: string; handle: string }[] = JSON.parse(saved);
        const valid = parsed.filter((h) =>
          (PLATFORMS as string[]).includes(h.platform)
        ) as SocialHandle[];
        setSocialHandles(valid);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ── Fetch feed ───────────────────────────────────────────────────────────────
  const fetchFeed = useCallback(async (topicList: string[]) => {
    if (!topicList.length) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/news/feed?topics=${encodeURIComponent(topicList.join(","))}&limit=80`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setArticles(data.articles ?? []);
    } catch {
      setError("Failed to fetch news. Make sure the Python backend is running.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "feed" && topics.length > 0) fetchFeed(topics);
  }, [activeTab, topics, fetchFeed]);

  // ── Topic management ─────────────────────────────────────────────────────────
  const addTopic = () => {
    const t = newTopic.trim().toUpperCase();
    if (!t || topics.map((x) => x.toUpperCase()).includes(t)) {
      setNewTopic("");
      return;
    }
    const updated = [...topics, newTopic.trim()];
    setTopics(updated);
    localStorage.setItem(TOPICS_KEY, JSON.stringify(updated));
    setNewTopic("");
  };

  const removeTopic = (t: string) => {
    const updated = topics.filter((x) => x !== t);
    if (!updated.length) return; // keep at least one
    setTopics(updated);
    localStorage.setItem(TOPICS_KEY, JSON.stringify(updated));
  };

  // ── Client-side filter ───────────────────────────────────────────────────────
  const filtered = filterText
    ? articles.filter(
        (a) =>
          a.title.toLowerCase().includes(filterText.toLowerCase()) ||
          a.source.toLowerCase().includes(filterText.toLowerCase())
      )
    : articles;

  // ── Social feed handlers ─────────────────────────────────────────────────────
  const fetchSocialPosts = useCallback(async (handles: SocialHandle[]) => {
    if (!handles.length) return;
    setSocialLoading(true);
    setSocialError(null);
    try {
      // Build platform → handles[] map
      const map: Record<string, string[]> = {};
      for (const { platform, handle } of handles) {
        if (!map[platform]) map[platform] = [];
        map[platform].push(handle);
      }
      const res = await fetch(
        `/api/news/social?handles=${encodeURIComponent(JSON.stringify(map))}&limit=80`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSocialPosts(data.posts ?? []);
      if (data.errors?.length)
        setSocialError(`Some sources failed: ${data.errors.slice(0, 3).join(" · ")}`);
    } catch {
      setSocialError("Failed to connect to backend. Make sure the Python backend is running.");
    } finally {
      setSocialLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "social" && socialHandles.length > 0 && socialPosts.length === 0)
      fetchSocialPosts(socialHandles);
  }, [activeTab, socialHandles, socialPosts.length, fetchSocialPosts]);

  const normalizeHandle = (platform: Platform, raw: string): string => {
    const s = raw.trim().replace(/\/+$/, "");
    if (platform === "twitter") return s.replace(/^@/, "");
    if (platform === "reddit") return s.replace(/^\/?(r\/)?/, "");
    if (platform === "youtube" && s.includes("youtube.com/")) {
      const m = s.match(/\/(?:channel\/|@)([\w-]+)/);
      if (m) return s.includes("/channel/") ? m[1] : `@${m[1]}`;
    }
    return s;
  };

  const handleAddHandle = () => {
    const handle = normalizeHandle(selectedPlatform, newHandle);
    if (!handle) return;
    const already = socialHandles.some(
      (h) => h.platform === selectedPlatform && h.handle === handle
    );
    if (already) {
      setNewHandle("");
      return;
    }
    const updated = [...socialHandles, { platform: selectedPlatform, handle }];
    setSocialHandles(updated);
    localStorage.setItem(SOCIAL_KEY, JSON.stringify(updated));
    setNewHandle("");
    fetchSocialPosts(updated);
  };

  const handleRemoveHandle = (platform: Platform, handle: string) => {
    const updated = socialHandles.filter((h) => !(h.platform === platform && h.handle === handle));
    setSocialHandles(updated);
    localStorage.setItem(SOCIAL_KEY, JSON.stringify(updated));
    setSocialPosts((prev) => prev.filter((p) => !(p.platform === platform && p.handle === handle)));
  };

  // ── Shared styles ────────────────────────────────────────────────────────────
  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const tabStyle = (active: boolean) => ({
    borderBottom: active ? `2px solid ${colors.accent}` : "2px solid transparent",
    color: active ? colors.accent : colors.textSecondary,
  });

  // ── Render ───────────────────────────────────────────────────────────────────
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
        {/* Tabs */}
        <div className="flex items-end gap-0">
          {(["feed", "social"] as ActiveTab[]).map((tab, i) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className="flex items-center gap-1 px-3 py-1 text-xs font-mono font-bold tracking-widest uppercase transition-colors"
              style={tabStyle(activeTab === tab)}
              title={`Alt+${i + 1}`}
            >
              <span className="text-[8px] opacity-35 hidden sm:inline">⌥{i + 1}</span>
              {tab === "feed" ? "NEWSFEED" : "SOCIAL"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {activeTab === "feed" && (
            <>
              {/* Filter */}
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="filter headlines…"
                className="px-2 py-0.5 text-xs bg-transparent border outline-none font-mono w-36"
                style={{ borderColor: colors.border, color: colors.text }}
              />
              <BloombergButton color="default" onClick={() => fetchFeed(topics)} disabled={loading}>
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : "mr-1"}`} />
                {!loading && "REFRESH"}
              </BloombergButton>
            </>
          )}
        </div>
      </div>

      {/* ── Body: tab content + polymarket column ──────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── FEED TAB ────────────────────────────────────────────────────────── */}
        {activeTab === "feed" && (
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Topic chips bar */}
            <div
              className="shrink-0 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b"
              style={{ borderColor: colors.border }}
            >
              {topics.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold border"
                  style={{ borderColor: colors.accent, color: colors.accent }}
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTopic(t)}
                    className="hover:opacity-60"
                    aria-label={`Remove ${t}`}
                    disabled={topics.length === 1}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}

              {/* Add topic input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addTopic();
                }}
                className="flex items-center gap-1"
              >
                <input
                  ref={topicInputRef}
                  type="text"
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  placeholder="+ add topic"
                  className="px-2 py-0.5 text-xs bg-transparent border outline-none font-mono w-24"
                  style={{ borderColor: colors.border, color: colors.text }}
                />
                <button
                  type="submit"
                  className="p-0.5 hover:opacity-70"
                  style={{ color: colors.accent }}
                  disabled={!newTopic.trim()}
                  aria-label="Add topic"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </form>

              {/* Article count */}
              {articles.length > 0 && (
                <span className="ml-auto text-xs" style={{ color: colors.textSecondary }}>
                  {filterText ? `${filtered.length} / ` : ""}
                  {articles.length} articles
                </span>
              )}
            </div>

            {/* Article list */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
            >
              {error && (
                <div
                  className="m-2 p-2 text-xs border"
                  style={{ borderColor: colors.negative, color: colors.negative }}
                >
                  {error}
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw
                    className="h-4 w-4 animate-spin mr-2"
                    style={{ color: colors.accent }}
                  />
                  <span className="text-xs" style={{ color: colors.textSecondary }}>
                    Fetching news…
                  </span>
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-16 text-center text-xs" style={{ color: colors.textSecondary }}>
                  {articles.length === 0 ? "No articles loaded" : "No articles match filter"}
                </div>
              ) : (
                <div className="divide-y" style={{ borderColor: colors.border }}>
                  {filtered.map((article, i) => (
                    <a
                      key={article.url || `${article.title}-${i}`}
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2 px-3 py-1.5 hover:bg-[#111111] transition-colors group"
                    >
                      {/* Source badge */}
                      <span
                        className="shrink-0 mt-0.5 text-[10px] font-bold px-1 py-0.5 whitespace-nowrap"
                        style={{
                          backgroundColor: `${sourceColor(article.source)}22`,
                          color: sourceColor(article.source),
                          border: `1px solid ${sourceColor(article.source)}55`,
                        }}
                      >
                        {article.source.length > 10 ? article.source.slice(0, 10) : article.source}
                      </span>

                      {/* Time */}
                      <span
                        className="shrink-0 mt-0.5 text-[10px] w-8 text-right"
                        style={{ color: colors.textSecondary }}
                      >
                        {timeAgo(article.published_at)}
                      </span>

                      {/* Headline */}
                      <span
                        className="flex-1 text-[10px] leading-snug group-hover:underline"
                        style={{ color: colors.text }}
                      >
                        {article.title}
                      </span>

                      {/* Link icon */}
                      <ExternalLink
                        className="shrink-0 h-2.5 w-2.5 mt-0.5 opacity-0 group-hover:opacity-60"
                        style={{ color: colors.textSecondary }}
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SOCIAL TAB ──────────────────────────────────────────────────────── */}
        {activeTab === "social" && (
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Add handle bar */}
            <div
              className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b"
              style={{ borderColor: colors.border }}
            >
              {/* Platform selector */}
              <select
                value={selectedPlatform}
                onChange={(e) => setSelectedPlatform(e.target.value as Platform)}
                className="bg-transparent text-xs font-bold font-mono outline-none border px-1.5 py-0.5 cursor-pointer"
                style={{ borderColor: colors.border, color: PLATFORM_INFO[selectedPlatform].color }}
              >
                {PLATFORMS.map((p) => (
                  <option
                    key={p}
                    value={p}
                    style={{ color: PLATFORM_INFO[p].color, backgroundColor: colors.surface }}
                  >
                    {PLATFORM_INFO[p].label}
                  </option>
                ))}
              </select>

              {/* Handle input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAddHandle();
                }}
                className="flex-1 flex items-center gap-1"
              >
                <input
                  type="text"
                  value={newHandle}
                  onChange={(e) => setNewHandle(e.target.value)}
                  placeholder={PLATFORM_INFO[selectedPlatform].placeholder}
                  className="flex-1 bg-transparent text-xs outline-none font-mono placeholder:opacity-30 min-w-0"
                  style={{ color: colors.text }}
                />
                <button
                  type="submit"
                  className="shrink-0 p-0.5 hover:opacity-70"
                  style={{ color: colors.accent }}
                  disabled={!newHandle.trim()}
                  aria-label="Add"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </form>

              {/* Refresh */}
              {socialHandles.length > 0 && (
                <BloombergButton
                  color="default"
                  onClick={() => {
                    setSocialPosts([]);
                    fetchSocialPosts(socialHandles);
                  }}
                  disabled={socialLoading}
                >
                  <RefreshCw className={`h-3 w-3 ${socialLoading ? "animate-spin" : "mr-1"}`} />
                  {!socialLoading && "REFRESH"}
                </BloombergButton>
              )}
            </div>

            {/* Followed handles chips */}
            {socialHandles.length > 0 && (
              <div
                className="shrink-0 flex flex-wrap gap-1.5 px-2 py-1.5 border-b"
                style={{ borderColor: colors.border }}
              >
                {socialHandles.map(({ platform, handle }) => {
                  const info = PLATFORM_INFO[platform];
                  return (
                    <div
                      key={`${platform}:${handle}`}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold border font-mono"
                      style={{ borderColor: `${info.color}66`, color: info.color }}
                    >
                      <span className="opacity-70">{info.label}</span>
                      <span>{handle}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveHandle(platform, handle)}
                        className="hover:opacity-60 ml-0.5"
                        aria-label={`Remove ${handle}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Content area */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
            >
              {/* Error */}
              {socialError && (
                <div
                  className="m-2 p-2 text-xs border"
                  style={{
                    borderColor: colors.negative,
                    color: colors.negative,
                    backgroundColor: `${colors.negative}10`,
                  }}
                >
                  {socialError}
                </div>
              )}

              {/* Empty state */}
              {socialHandles.length === 0 && (
                <div className="py-16 text-center space-y-3">
                  <p className="text-[10px] font-bold" style={{ color: colors.textSecondary }}>
                    No sources added yet
                  </p>
                  <div
                    className="text-xs space-y-1 opacity-60"
                    style={{ color: colors.textSecondary }}
                  >
                    <p>YouTube: UCxxxxx or @ChannelHandle</p>
                    <p>Reddit: wallstreetbets or r/investing</p>
                    <p>Facebook: BeautyInvestor (via RSSHub)</p>
                    <p>X/Twitter: elonmusk (via Nitter)</p>
                    <p>RSS: https://example.com/feed.rss</p>
                  </div>
                </div>
              )}

              {/* Loading */}
              {socialLoading && (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw
                    className="h-4 w-4 animate-spin mr-2"
                    style={{ color: colors.accent }}
                  />
                  <span className="text-xs" style={{ color: colors.textSecondary }}>
                    Fetching social feed…
                  </span>
                </div>
              )}

              {/* Posts list */}
              {!socialLoading && socialPosts.length > 0 && (
                <div className="divide-y" style={{ borderColor: colors.border }}>
                  {socialPosts.map((post, i) => {
                    const info = PLATFORM_INFO[post.platform];
                    return (
                      <a
                        key={post.url || `${post.platform}-${post.handle}-${i}`}
                        href={post.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-2 px-3 py-1.5 hover:bg-[#111111] transition-colors group"
                      >
                        {/* Platform badge */}
                        <span
                          className="shrink-0 mt-0.5 text-[9px] font-bold px-1 py-0.5 whitespace-nowrap"
                          style={{
                            backgroundColor: `${info.color}22`,
                            color: info.color,
                            border: `1px solid ${info.color}55`,
                          }}
                        >
                          {info.label}
                        </span>

                        {/* Source name + time */}
                        <div
                          className="shrink-0 mt-0.5 text-[10px] text-right w-20 leading-tight"
                          style={{ color: colors.textSecondary }}
                        >
                          <div className="truncate">{post.display_name || post.handle}</div>
                          <div>{timeAgo(post.published_at)}</div>
                        </div>

                        {/* Title */}
                        <span
                          className="flex-1 text-[10px] leading-snug group-hover:underline"
                          style={{ color: colors.text }}
                        >
                          {post.title || "(no title)"}
                        </span>

                        <ExternalLink
                          className="shrink-0 h-2.5 w-2.5 mt-0.5 opacity-0 group-hover:opacity-60"
                          style={{ color: colors.textSecondary }}
                        />
                      </a>
                    );
                  })}
                </div>
              )}

              {/* No posts returned */}
              {!socialLoading &&
                !socialError &&
                socialHandles.length > 0 &&
                socialPosts.length === 0 && (
                  <div
                    className="py-10 text-center text-xs"
                    style={{ color: colors.textSecondary }}
                  >
                    No posts returned. Sources may be unavailable or handles are incorrect.
                  </div>
                )}
            </div>
          </div>
        )}

        {/* ── Polymarket column ───────────────────────────────────────────────── */}
        <PolymarketColumn colors={colors} isDark={isDarkMode} />
      </div>
      {/* end body row */}
    </div>
  );
}
