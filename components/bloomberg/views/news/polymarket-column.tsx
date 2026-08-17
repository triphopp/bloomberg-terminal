"use client";

import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CompanyOutlookPanel } from "../../core/company-outlook-panel";
import { isUsListing } from "../../hooks/useCompanyOutlook";
import { sectorColor } from "./constants";
import { fmtEndDate, fmtVol, polyUrl } from "./helpers";
import { PredictionLadder } from "./prediction-ladder";
import type { PolySearchResult, PolySignal, ThemeColors, WatchlistMarket } from "./types";

// ── Signals hook ──────────────────────────────────────────────────────────────

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

// ── Probability bar ───────────────────────────────────────────────────────────

export function ProbBar({
  probability,
  colors,
}: {
  probability: number | null;
  colors: ThemeColors;
}) {
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

// ── Column ────────────────────────────────────────────────────────────────────

interface Props {
  colors: ThemeColors;
  isDark: boolean;
  /** Markets the backend matched to watchlist names — rendered above the macro signals. */
  watchlistMarkets?: WatchlistMarket[];
  /** Ticker filter applied by the WATCHLIST tab; null = show everything. */
  focusSymbols?: string[] | null;
  /** Single ticker the user drilled into — gets the full implied price ladder. */
  ladderSymbol?: string | null;
  ladderCompany?: string;
}

export function PolymarketColumn({
  colors,
  isDark,
  watchlistMarkets = [],
  focusSymbols,
  ladderSymbol,
  ladderCompany,
}: Props) {
  const { signals, loading, asOf, refresh } = usePolymarketSignals();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PolySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showMacro, setShowMacro] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const asOfStr = asOf
    ? new Date(asOf).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "";
  const isSearching = query.trim().length >= 2;

  const focused = focusSymbols?.length
    ? watchlistMarkets.filter((m) => focusSymbols.includes(m.symbol))
    : watchlistMarkets;

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

        {!isSearching && (
          <>
            {/* ── What management guided to, for the drilled-into ticker ── */}
            {ladderSymbol && isUsListing(ladderSymbol) && (
              <div className="border-b" style={{ borderColor: colors.border }}>
                <div
                  className="sticky top-0 z-10 px-2 py-1 border-b text-[8px] font-bold font-mono tracking-widest"
                  style={{
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    color: colors.accent,
                  }}
                >
                  {ladderSymbol} OUTLOOK · SEC
                </div>
                <CompanyOutlookPanel symbol={ladderSymbol} colors={colors} variant="compact" />
              </div>
            )}

            {/* ── Implied price ladder for the drilled-into ticker ── */}
            {ladderSymbol && (
              <PredictionLadder symbol={ladderSymbol} company={ladderCompany} colors={colors} />
            )}

            {/* ── Watchlist-matched markets ── */}
            {focused.length > 0 && (
              <>
                <div
                  className="sticky top-0 z-10 px-2 py-1 border-b text-[8px] font-bold font-mono tracking-widest"
                  style={{
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    color: colors.accent,
                  }}
                >
                  WATCHLIST MARKETS ({focused.length})
                </div>
                {focused.map((m) => {
                  const clr = sectorColor(m.sector);
                  return (
                    <a
                      key={`${m.symbol}-${m.slug}`}
                      href={polyUrl(m.slug, m.event_slug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block px-2 py-2 border-b hover:bg-[#111] transition-colors group"
                      style={{ borderColor: colors.border }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className="text-[8px] font-bold font-mono px-1 py-0.5"
                          style={{
                            color: clr,
                            backgroundColor: `${clr}18`,
                            border: `1px solid ${clr}44`,
                          }}
                        >
                          {m.symbol}
                        </span>
                        <span
                          className="text-[8px] font-mono"
                          style={{ color: colors.textSecondary }}
                        >
                          {fmtVol(m.volume)}
                        </span>
                      </div>
                      <p
                        className="text-[9px] font-mono leading-snug mb-1.5 group-hover:underline line-clamp-2"
                        style={{ color: colors.text }}
                      >
                        {m.question}
                      </p>
                      <ProbBar probability={m.probability} colors={colors} />
                      {m.end_date && (
                        <span
                          className="text-[8px] font-mono"
                          style={{ color: colors.textSecondary }}
                        >
                          Ends {fmtEndDate(m.end_date)}
                        </span>
                      )}
                    </a>
                  );
                })}
              </>
            )}

            {/* ── Macro signal cards ── */}
            <button
              type="button"
              onClick={() => setShowMacro((v) => !v)}
              className="sticky top-0 z-10 w-full text-left px-2 py-1 border-b text-[8px] font-bold font-mono tracking-widest hover:opacity-80"
              style={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                color: colors.accent,
              }}
            >
              {showMacro ? "▾" : "▸"} MACRO SIGNALS ({signals.length})
            </button>

            {showMacro && loading && signals.length === 0 && (
              <div
                className="flex items-center justify-center py-10 gap-2"
                style={{ color: colors.textSecondary }}
              >
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span className="text-[9px] font-mono">loading...</span>
              </div>
            )}

            {showMacro &&
              signals.map((sig) => {
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
                      <span
                        className="text-[8px] font-mono"
                        style={{ color: colors.textSecondary }}
                      >
                        {fmtVol(sig.volume)}
                      </span>
                    </div>

                    <p
                      className="text-[9px] font-mono leading-snug mb-1.5 group-hover:underline line-clamp-2"
                      style={{ color: colors.text }}
                    >
                      {sig.question}
                    </p>

                    <ProbBar probability={sig.probability} colors={colors} />

                    <div className="flex items-center gap-2 mt-1 mb-0.5">
                      <span
                        className="text-[8px] font-bold font-mono"
                        style={{ color: statusColor }}
                      >
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
