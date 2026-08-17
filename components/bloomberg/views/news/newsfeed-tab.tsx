"use client";

import { useAtomValue } from "jotai";
import { ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { stockSearchSymbolAtom } from "../../atoms";
import { BloombergButton } from "../../core/bloomberg-button";
import { DEFAULT_TOPICS, TOPICS_KEY, sourceColor } from "./constants";
import { timeAgo } from "./helpers";
import type { Article, ThemeColors } from "./types";

/** Topic-driven macro newswire — yfinance search + curated RSS (unchanged behaviour). */
export function NewsFeedTab({ colors }: { colors: ThemeColors }) {
  const stockSymbol = useAtomValue(stockSearchSymbolAtom);

  const [topics, setTopics] = useState<string[]>(DEFAULT_TOPICS);
  const [newTopic, setNewTopic] = useState("");
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);

  // Mount-only: stockSymbol seeds topics the FIRST time nothing is saved.
  // Depending on it would overwrite the saved list on every stock navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TOPICS_KEY);
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        if (parsed.length > 0) setTopics(parsed);
      } else if (stockSymbol) {
        const initial = [...DEFAULT_TOPICS, stockSymbol];
        setTopics(initial);
        localStorage.setItem(TOPICS_KEY, JSON.stringify(initial));
      }
    } catch {
      /* ignore */
    }
  }, []);

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
    if (topics.length > 0) fetchFeed(topics);
  }, [topics, fetchFeed]);

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

  const filtered = filterText
    ? articles.filter(
        (a) =>
          a.title.toLowerCase().includes(filterText.toLowerCase()) ||
          a.source.toLowerCase().includes(filterText.toLowerCase())
      )
    : articles;

  return (
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

        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="filter headlines…"
            className="px-2 py-0.5 text-xs bg-transparent border outline-none font-mono w-36"
            style={{ borderColor: colors.border, color: colors.text }}
          />
          {articles.length > 0 && (
            <span className="text-xs" style={{ color: colors.textSecondary }}>
              {filterText ? `${filtered.length} / ` : ""}
              {articles.length} articles
            </span>
          )}
          <BloombergButton color="default" onClick={() => fetchFeed(topics)} disabled={loading}>
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : "mr-1"}`} />
            {!loading && "REFRESH"}
          </BloombergButton>
        </div>
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
            <RefreshCw className="h-4 w-4 animate-spin mr-2" style={{ color: colors.accent }} />
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

                <span
                  className="shrink-0 mt-0.5 text-[10px] w-8 text-right"
                  style={{ color: colors.textSecondary }}
                >
                  {timeAgo(article.published_at)}
                </span>

                <span
                  className="flex-1 text-[10px] leading-snug group-hover:underline"
                  style={{ color: colors.text }}
                >
                  {article.title}
                </span>

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
  );
}
