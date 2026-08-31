"use client";

import { useSetAtom } from "jotai";
import { AlertTriangle, ExternalLink, Filter, Layers, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { currentViewAtom, stockSearchSymbolAtom } from "../../atoms";
import { BloombergButton } from "../../core/bloomberg-button";
import { RateStressTab } from "../stock/rate-stress";
import {
  ALL_SOURCE_IDS,
  SENTIMENT_COLORS,
  SENTIMENT_GLYPH,
  SOURCE_LABELS,
  WL_LAYOUT_KEY,
  WL_SOURCES_KEY,
  sectorAbbr,
  sectorColor,
  sourceColor,
} from "./constants";
import { clockStr, timeAgo } from "./helpers";
import type {
  Sentiment,
  ThemeColors,
  WatchlistArticle,
  WatchlistMarket,
  WatchlistSymbolMeta,
} from "./types";
import { useWatchlistNews, useWatchlistSymbols } from "./useWatchlistNews";

type GroupMode = "sector" | "ticker" | "time";
type SentFilter = "ALL" | Sentiment;

type MatchMode = "direct" | "all";

interface LayoutPrefs {
  group: GroupMode;
  sentiment: SentFilter;
  perSymbol: number;
  match: MatchMode;
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  group: "sector",
  sentiment: "ALL",
  perSymbol: 6,
  match: "direct",
};

// ── Row ───────────────────────────────────────────────────────────────────────

function ArticleRow({
  article,
  colors,
  showSector,
  onSymbolClick,
}: {
  article: WatchlistArticle;
  colors: ThemeColors;
  showSector: boolean;
  onSymbolClick: (sym: string) => void;
}) {
  const clr = sectorColor(article.sector);
  const extra = article.symbols.slice(1);
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 hover:bg-[#111111] transition-colors group border-l-2"
      style={{ borderLeftColor: clr }}
    >
      {/* Which stock this headline is about — always explicit */}
      <button
        type="button"
        onClick={() => onSymbolClick(article.primary_symbol)}
        className="shrink-0 mt-0.5 text-[10px] font-bold px-1 py-0.5 whitespace-nowrap hover:opacity-80"
        style={{ color: clr, backgroundColor: `${clr}1a`, border: `1px solid ${clr}55` }}
        title={`${article.company} — ${article.sector}`}
      >
        {article.primary_symbol}
      </button>

      {article.relevance === "feed" && (
        <span
          className="shrink-0 mt-0.5 text-[8px] px-1 py-0.5"
          style={{ color: colors.textSecondary, border: `1px dashed ${colors.border}` }}
          title="From this symbol's wire but the headline doesn't name it"
        >
          WIRE
        </span>
      )}

      {extra.length > 0 && (
        <span
          className="shrink-0 mt-0.5 text-[9px] px-1 py-0.5 whitespace-nowrap"
          style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
          title={`Also mentions ${extra.join(", ")}`}
        >
          +{extra.join(" +")}
        </span>
      )}

      {showSector && (
        <span
          className="shrink-0 mt-0.5 text-[9px] font-bold w-9 text-center"
          style={{ color: clr, opacity: 0.85 }}
          title={article.sector}
        >
          {sectorAbbr(article.sector)}
        </span>
      )}

      <span
        className="shrink-0 mt-0.5 text-[10px] w-7 text-right"
        style={{ color: colors.textSecondary }}
      >
        {timeAgo(article.published_at)}
      </span>

      <span
        className="shrink-0 mt-0.5 text-[10px] w-3 text-center font-bold"
        style={{ color: SENTIMENT_COLORS[article.sentiment] }}
        title={`headline tone: ${article.sentiment}`}
      >
        {SENTIMENT_GLYPH[article.sentiment]}
      </span>

      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 text-[10px] leading-snug group-hover:underline min-w-0"
        style={{ color: colors.text }}
      >
        {article.title}
      </a>

      <span
        className="shrink-0 mt-0.5 text-[9px] px-1 py-0.5 whitespace-nowrap max-w-[110px] truncate"
        style={{
          backgroundColor: `${sourceColor(article.source)}22`,
          color: sourceColor(article.source),
          border: `1px solid ${sourceColor(article.source)}55`,
        }}
        title={`${article.source} · ${article.source_kind}`}
      >
        {article.source}
      </span>

      <ExternalLink
        className="shrink-0 h-2.5 w-2.5 mt-0.5 opacity-0 group-hover:opacity-60"
        style={{ color: colors.textSecondary }}
      />
    </div>
  );
}

// ── Group header ──────────────────────────────────────────────────────────────

function GroupHeader({
  label,
  sublabel,
  count,
  color,
  colors,
}: {
  label: string;
  sublabel?: string;
  count: number;
  color: string;
  colors: ThemeColors;
}) {
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1 border-b border-t"
      style={{ backgroundColor: colors.surface, borderColor: colors.border }}
    >
      <span className="h-2.5 w-1" style={{ backgroundColor: color }} />
      <span className="text-[10px] font-bold tracking-widest" style={{ color }}>
        {label}
      </span>
      {sublabel && (
        <span className="text-[9px] truncate" style={{ color: colors.textSecondary }}>
          {sublabel}
        </span>
      )}
      <span className="ml-auto text-[9px] font-mono" style={{ color: colors.textSecondary }}>
        {count}
      </span>
    </div>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

interface Props {
  colors: ThemeColors;
  /** The parent renders the Polymarket column; this tab feeds it the matched markets
   *  plus the single ticker (if any) the user drilled into, which gets the ladder. */
  onMarketsChange: (
    markets: WatchlistMarket[],
    focus: string[] | null,
    ladder: { symbol: string; company: string } | null
  ) => void;
}

export function WatchlistNewsTab({ colors, onMarketsChange }: Props) {
  const symbols = useWatchlistSymbols();
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const setCurrentView = useSetAtom(currentViewAtom);

  const [sources, setSources] = useState<string[]>(() => {
    if (typeof window === "undefined") return [...ALL_SOURCE_IDS];
    try {
      const raw = localStorage.getItem(WL_SOURCES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        const valid = parsed.filter((s) => (ALL_SOURCE_IDS as readonly string[]).includes(s));
        if (valid.length) return valid;
      }
    } catch {
      /* ignore */
    }
    return [...ALL_SOURCE_IDS];
  });

  const [layout, setLayout] = useState<LayoutPrefs>(() => {
    if (typeof window === "undefined") return DEFAULT_LAYOUT;
    try {
      const raw = localStorage.getItem(WL_LAYOUT_KEY);
      if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutPrefs>) };
    } catch {
      /* ignore */
    }
    return DEFAULT_LAYOUT;
  });

  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  // With one company in focus the panel can answer more than "what was written
  // about it". Rate stress rides alongside the headlines rather than replacing
  // them. The choice is stored against the company it was made for, so moving
  // the focus falls back to the headlines without an effect having to notice.
  const [panelChoice, setPanelChoice] = useState<{
    symbol: string | null;
    panel: "headlines" | "rate-stress";
  }>({ symbol: null, panel: "headlines" });
  const panel = panelChoice.symbol === selectedSymbol ? panelChoice.panel : "headlines";
  const setPanel = (next: "headlines" | "rate-stress") =>
    setPanelChoice({ symbol: selectedSymbol, panel: next });
  const [filterText, setFilterText] = useState("");
  const [showSourcePicker, setShowSourcePicker] = useState(false);

  useEffect(() => {
    localStorage.setItem(WL_SOURCES_KEY, JSON.stringify(sources));
  }, [sources]);
  useEffect(() => {
    localStorage.setItem(WL_LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  const { data, isFetching, error, refetch } = useWatchlistNews({
    symbols,
    sources,
    perSymbol: layout.perSymbol,
  });

  const articles = data?.articles ?? [];
  const sectors = data?.sectors ?? [];
  const symbolMeta: WatchlistSymbolMeta[] = data?.symbols ?? [];

  // Feed the Polymarket column
  useEffect(() => {
    const focus = selectedSymbol
      ? [selectedSymbol]
      : selectedSector
        ? (sectors.find((s) => s.sector === selectedSector)?.symbols ?? [])
        : null;
    const ladder = selectedSymbol
      ? {
          symbol: selectedSymbol,
          company: symbolMeta.find((m) => m.symbol === selectedSymbol)?.company ?? "",
        }
      : null;
    onMarketsChange(data?.markets ?? [], focus, ladder);
  }, [data?.markets, selectedSector, selectedSymbol, sectors, symbolMeta, onMarketsChange]);

  // ── Filtering ───────────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return articles.filter((a) => {
      if (selectedSector && a.sector !== selectedSector) return false;
      if (selectedSymbol && !a.symbols.includes(selectedSymbol)) return false;
      // `relevance` is absent on responses cached before the field existed —
      // treat unknown as direct rather than hiding the whole feed.
      if (layout.match === "direct" && a.relevance === "feed") return false;
      if (layout.sentiment !== "ALL" && a.sentiment !== layout.sentiment) return false;
      if (q) {
        return (
          a.title.toLowerCase().includes(q) ||
          a.source.toLowerCase().includes(q) ||
          a.company.toLowerCase().includes(q) ||
          a.symbols.some((s) => s.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [articles, filterText, selectedSector, selectedSymbol, layout.sentiment, layout.match]);

  // ── Grouping ────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    if (layout.group === "time") {
      return [{ key: "ALL", label: "LATEST", sublabel: "", color: colors.accent, items: visible }];
    }
    if (layout.group === "ticker") {
      const bySym = new Map<string, WatchlistArticle[]>();
      for (const a of visible) {
        const list = bySym.get(a.primary_symbol) ?? [];
        list.push(a);
        bySym.set(a.primary_symbol, list);
      }
      return [...bySym.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sym, items]) => ({
          key: sym,
          label: sym,
          sublabel: `${items[0]?.company ?? ""} · ${items[0]?.sector ?? ""}`,
          color: sectorColor(items[0]?.sector ?? ""),
          items,
        }));
    }
    const bySector = new Map<string, WatchlistArticle[]>();
    for (const a of visible) {
      const list = bySector.get(a.sector) ?? [];
      list.push(a);
      bySector.set(a.sector, list);
    }
    return [...bySector.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([sector, items]) => ({
        key: sector,
        label: sector.toUpperCase(),
        sublabel: [...new Set(items.map((i) => i.primary_symbol))].join(" "),
        color: sectorColor(sector),
        items,
      }));
  }, [visible, layout.group, colors.accent]);

  const openStock = (sym: string) => {
    setStockSymbol(sym);
    setCurrentView("stock");
  };

  const toggleSource = (id: string) => {
    setSources((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
      return next.length ? next : prev; // never leave zero sources
    });
  };

  // ── Empty watchlist ─────────────────────────────────────────────────────────
  if (symbols.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 min-w-0">
        <AlertTriangle className="h-5 w-5" style={{ color: colors.textSecondary }} />
        <p className="text-[11px] font-bold" style={{ color: colors.textSecondary }}>
          WATCHLIST IS EMPTY
        </p>
        <p className="text-[10px] opacity-60" style={{ color: colors.textSecondary }}>
          Pin symbols in MKT [1] — news here is driven by that list.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* ── Sector rail ─────────────────────────────────────────────────────── */}
      <div
        className="w-44 shrink-0 flex flex-col border-r overflow-hidden"
        style={{ borderColor: colors.border }}
      >
        <div
          className="shrink-0 flex items-center gap-1 px-2 py-1 border-b"
          style={{ borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <Layers className="h-2.5 w-2.5" style={{ color: colors.accent }} />
          <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
            SECTORS
          </span>
          <span className="ml-auto text-[9px] font-mono" style={{ color: colors.textSecondary }}>
            {symbols.length} sym
          </span>
        </div>

        <div
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
        >
          <button
            type="button"
            onClick={() => {
              setSelectedSector(null);
              setSelectedSymbol(null);
            }}
            className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-[#111]"
            style={{
              backgroundColor: !selectedSector && !selectedSymbol ? "#151515" : undefined,
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <span className="text-[10px] font-bold" style={{ color: colors.accent }}>
              ALL SECTORS
            </span>
            <span className="ml-auto text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              {articles.length}
            </span>
          </button>

          {sectors.map((s) => {
            const clr = sectorColor(s.sector);
            const active = selectedSector === s.sector;
            return (
              <div key={s.sector}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSector(active ? null : s.sector);
                    setSelectedSymbol(null);
                  }}
                  className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[#111]"
                  style={{
                    backgroundColor: active ? "#151515" : undefined,
                    borderBottom: `1px solid ${colors.border}`,
                  }}
                >
                  <span className="h-2.5 w-1 shrink-0" style={{ backgroundColor: clr }} />
                  <span
                    className="text-[10px] truncate"
                    style={{ color: active ? clr : colors.text }}
                    title={s.sector}
                  >
                    {s.sector}
                  </span>
                  <span
                    className="ml-auto text-[9px] font-mono shrink-0"
                    style={{ color: colors.textSecondary }}
                  >
                    {s.article_count}
                  </span>
                </button>

                {/* Symbols inside the selected sector */}
                {active && (
                  <div
                    className="flex flex-wrap gap-1 px-2 py-1.5"
                    style={{ borderBottom: `1px solid ${colors.border}`, background: "#0a0a0a" }}
                  >
                    {s.symbols.map((sym) => {
                      const meta = symbolMeta.find((m) => m.symbol === sym);
                      const on = selectedSymbol === sym;
                      return (
                        <button
                          key={sym}
                          type="button"
                          onClick={() => setSelectedSymbol(on ? null : sym)}
                          className="text-[9px] font-bold px-1 py-0.5 hover:opacity-80"
                          style={{
                            color: on ? "#000" : clr,
                            backgroundColor: on ? clr : `${clr}1a`,
                            border: `1px solid ${clr}55`,
                          }}
                          title={`${meta?.company ?? sym} · ${meta?.article_count ?? 0} articles`}
                        >
                          {sym}
                          <span className="opacity-60"> {meta?.article_count ?? 0}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Stream ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {/* Toolbar */}
        <div
          className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b flex-wrap"
          style={{ borderColor: colors.border }}
        >
          {/* Group mode */}
          <div className="flex items-center border" style={{ borderColor: colors.border }}>
            {(["sector", "ticker", "time"] as GroupMode[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setLayout((l) => ({ ...l, group: g }))}
                className="px-1.5 py-0.5 text-[9px] font-bold tracking-wider"
                style={{
                  backgroundColor: layout.group === g ? colors.accent : "transparent",
                  color: layout.group === g ? "#000" : colors.textSecondary,
                }}
              >
                {g.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Relevance */}
          <div className="flex items-center border" style={{ borderColor: colors.border }}>
            {(["direct", "all"] as MatchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setLayout((l) => ({ ...l, match: m }))}
                className="px-1.5 py-0.5 text-[9px] font-bold tracking-wider"
                style={{
                  backgroundColor: layout.match === m ? colors.accent : "transparent",
                  color: layout.match === m ? "#000" : colors.textSecondary,
                }}
                title={
                  m === "direct"
                    ? "Only headlines that name the ticker or company"
                    : "Include everything off each symbol's wire (sector / market colour)"
                }
              >
                {m === "direct" ? "NAMED" : "ALL NEWS"}
              </button>
            ))}
          </div>

          {/* Sentiment */}
          <div className="flex items-center border" style={{ borderColor: colors.border }}>
            {(["ALL", "POS", "NEG"] as SentFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setLayout((l) => ({ ...l, sentiment: s }))}
                className="px-1.5 py-0.5 text-[9px] font-bold"
                style={{
                  backgroundColor:
                    layout.sentiment === s
                      ? s === "ALL"
                        ? colors.accent
                        : SENTIMENT_COLORS[s as Sentiment]
                      : "transparent",
                  color: layout.sentiment === s ? "#000" : colors.textSecondary,
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Filter */}
          <div
            className="flex items-center gap-1 border px-1"
            style={{ borderColor: colors.border }}
          >
            <Filter className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="filter headlines…"
              className="bg-transparent text-[10px] outline-none w-32 placeholder:opacity-30"
              style={{ color: colors.text }}
            />
            {filterText && (
              <button type="button" onClick={() => setFilterText("")}>
                <X className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
              </button>
            )}
          </div>

          {/* Sources */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSourcePicker((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold border"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              <Settings2 className="h-2.5 w-2.5" />
              SOURCES {sources.length}/{ALL_SOURCE_IDS.length}
            </button>
            {showSourcePicker && (
              <div
                className="absolute z-30 mt-1 p-1.5 border flex flex-col gap-1"
                style={{ backgroundColor: colors.surface, borderColor: colors.border }}
              >
                {ALL_SOURCE_IDS.map((id) => {
                  const on = sources.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleSource(id)}
                      className="flex items-center gap-2 px-1 py-0.5 text-[9px] font-bold hover:opacity-80"
                      style={{ color: on ? colors.accent : colors.textSecondary }}
                    >
                      <span
                        className="h-2 w-2 border"
                        style={{
                          borderColor: on ? colors.accent : colors.border,
                          backgroundColor: on ? colors.accent : "transparent",
                        }}
                      />
                      {SOURCE_LABELS[id] ?? id.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Depth */}
          <div className="flex items-center gap-1">
            <span className="text-[9px]" style={{ color: colors.textSecondary }}>
              /SYM
            </span>
            <select
              value={layout.perSymbol}
              onChange={(e) => setLayout((l) => ({ ...l, perSymbol: Number(e.target.value) }))}
              className="bg-transparent text-[9px] font-bold border px-1 py-0.5 outline-none"
              style={{ borderColor: colors.border, color: colors.text }}
            >
              {[4, 6, 10, 15, 20].map((n) => (
                <option key={n} value={n} style={{ backgroundColor: colors.surface }}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              {visible.length}/{articles.length} · {data?.as_of ? clockStr(data.as_of) : "—"}
            </span>
            <BloombergButton color="default" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : "mr-1"}`} />
              {!isFetching && "REFRESH"}
            </BloombergButton>
          </div>
        </div>

        {/* Active filter breadcrumb */}
        {(selectedSector || selectedSymbol) && (
          <div
            className="shrink-0 flex items-center gap-2 px-2 py-1 border-b"
            style={{ borderColor: colors.border, backgroundColor: "#0a0a0a" }}
          >
            <span className="text-[9px]" style={{ color: colors.textSecondary }}>
              SHOWING
            </span>
            {selectedSector && (
              <span
                className="text-[9px] font-bold px-1"
                style={{
                  color: sectorColor(selectedSector),
                  border: `1px solid ${sectorColor(selectedSector)}55`,
                }}
              >
                {selectedSector}
              </span>
            )}
            {selectedSymbol && (
              <span className="text-[9px] font-bold px-1" style={{ color: colors.accent }}>
                {selectedSymbol}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectedSector(null);
                setSelectedSymbol(null);
              }}
              className="text-[9px] hover:opacity-70"
              style={{ color: colors.textSecondary }}
            >
              clear ✕
            </button>

            {selectedSymbol && (
              <div className="ml-auto flex items-center gap-0">
                {(
                  [
                    { id: "headlines", label: "HEADLINES" },
                    { id: "rate-stress", label: "RATE STRESS" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setPanel(t.id)}
                    className="px-2 py-0.5 text-[9px] font-bold tracking-widest"
                    style={{
                      borderBottom:
                        panel === t.id ? `2px solid ${colors.accent}` : "2px solid transparent",
                      color: panel === t.id ? colors.accent : colors.textSecondary,
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Rate stress for the single company in focus, same panel the equity
            view uses so the two never drift apart. */}
        {selectedSymbol && panel === "rate-stress" && (
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
          >
            <RateStressTab symbol={selectedSymbol} colors={colors} />
          </div>
        )}

        {/* Stream */}
        <div
          className="flex-1 overflow-y-auto"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "#333 #000",
            display: selectedSymbol && panel === "rate-stress" ? "none" : undefined,
          }}
        >
          {error && (
            <div
              className="m-2 p-2 text-xs border"
              style={{ borderColor: colors.negative, color: colors.negative }}
            >
              Failed to load watchlist news. Make sure the Python backend is running.
            </div>
          )}

          {data?.errors && data.errors.length > 0 && (
            <div
              className="m-2 p-1.5 text-[9px] border"
              style={{ borderColor: "#ffc10744", color: "#ffc107" }}
            >
              {data.errors.slice(0, 3).join(" · ")}
              {data.errors.length > 3 ? ` · +${data.errors.length - 3} more` : ""}
            </div>
          )}

          {isFetching && articles.length === 0 && (
            <div className="flex items-center justify-center py-16 gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
              <span className="text-xs" style={{ color: colors.textSecondary }}>
                Scanning {symbols.length} symbols × {sources.length} sources…
              </span>
            </div>
          )}

          {!isFetching && visible.length === 0 && (
            <div className="py-16 text-center text-xs" style={{ color: colors.textSecondary }}>
              {articles.length === 0 ? "No articles found" : "No articles match the filters"}
            </div>
          )}

          {groups.map((g) => (
            <div key={g.key}>
              {layout.group !== "time" && (
                <GroupHeader
                  label={g.label}
                  sublabel={g.sublabel}
                  count={g.items.length}
                  color={g.color}
                  colors={colors}
                />
              )}
              <div className="divide-y" style={{ borderColor: colors.border }}>
                {g.items.map((a, i) => (
                  <ArticleRow
                    key={a.url || `${a.title}-${i}`}
                    article={a}
                    colors={colors}
                    showSector={layout.group !== "sector"}
                    onSymbolClick={openStock}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
