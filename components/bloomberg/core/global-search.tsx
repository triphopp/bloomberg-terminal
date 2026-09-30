"use client";

/**
 * GlobalSearch — command-palette + terminal command language overlay.
 *
 * Open:   press  /  or  Ctrl+K  anywhere (when not in an input).
 * Close:  press  Escape  or click the backdrop.
 *
 * Modes:
 *   Stock search  — default; type ticker/company name
 *   Command mode  — first word matches a registered command/function
 *                   e.g. "MKT", "ALERT OFF", "corr(AAPL, MSFT, 3m)"
 *
 * Per stock result:
 *   Enter / click  → open EQUITY view
 *   Ctrl+P / 📌    → quick-pin to selected group
 */

import { useQueryClient } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import { Check, Loader2, Pin, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  chartCompareSymbolsAtom,
  chartScalingUnitAtom,
  chartTypeAtom,
  currentViewAtom,
  heatmapMarketAtom,
  heatmapMetricAtom,
  isDarkModeAtom,
  isGlobalSearchOpenAtom,
  showYTDAtom,
  stockSearchSymbolAtom,
  tickerEnabledAtom,
} from "../atoms";
import { resolveSymbol } from "../lib/resolve-symbol";
import { recordSearchHit } from "../lib/search-stats";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors } from "../lib/theme-config";
import { PinGroupPicker } from "../pins/PinGroupPicker";
import { type PinTarget, usePinActions } from "../pins/usePinActions";
import {
  ALL_COMMANDS,
  type CommandResult,
  type ResultContent,
  type RowData,
  type Suggestion,
  type TerminalCtx,
  executeAst,
  getSuggestions,
  isCommandInput,
  parse,
  validate,
} from "../terminal";

// ── Search result type (from /api/stock?type=search) ─────────────────────────

interface SearchResult {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  typeDisp?: string;
  // Backend display normalisation: suffix hidden (BH.BK → BH) and ticker
  // prefix stripped from Thai names (BH_BUMRUNGRAD → BUMRUNGRAD)
  display_symbol?: string;
  display_name?: string;
}

// Session cache for symbol search — backspacing or retyping a query costs no
// request. Keyed like the backend (trimmed, lower-case); bounded LRU.
const SEARCH_CACHE_MAX = 200;
const SEARCH_CACHE_TTL = 10 * 60_000;
const searchCache = new Map<string, { at: number; results: SearchResult[] }>();

function searchKey(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

function cachedSearch(key: string): SearchResult[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key); // refresh LRU position
  searchCache.set(key, hit);
  return hit.results;
}

function storeSearch(key: string, results: SearchResult[]) {
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeColor(type?: string): string {
  switch ((type ?? "").toLowerCase()) {
    case "equity":
      return "#4ade80";
    case "etf":
      return "#60a5fa";
    case "index":
      return "#a78bfa";
    case "mutualfund":
      return "#fb923c";
    case "currency":
      return "#f59e0b";
    case "future":
      return "#f87171";
    default:
      return "#94a3b8";
  }
}

const GROUP_COLORS: Record<string, string> = {
  analysis: "#FF6600",
  nav: "#42a5f5",
  setting: "#a78bfa",
  info: "#4ade80",
  period: "#f59e0b",
  hint: "#666",
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Renders a result from analytics/command execution */
function ResultPanel({
  result,
  colors,
  onClose,
}: {
  result: CommandResult & { kind: "display" };
  colors: typeof bloombergColors.dark;
  onClose: () => void;
}) {
  const c = result.content;

  const cellColor = (hint: string, value: string, colors: typeof bloombergColors.dark): string => {
    if (hint === "accent") return colors.accent;
    if (hint === "pos") return "#22DD66";
    if (hint === "neg") return "#FF5555";
    if (value.startsWith("+")) return "#22DD66";
    if (value.startsWith("-")) return "#FF5555";
    return "#FFD700";
  };

  return (
    <div className="px-4 py-3 font-mono border-b" style={{ borderColor: colors.border }}>
      <div className="text-[9px] tracking-widest mb-2 uppercase" style={{ color: "#666" }}>
        {c.label}
      </div>

      {c.type === "scalar" && (
        <>
          <div className="text-2xl font-bold mb-1" style={{ color: "#FFD700" }}>
            {c.value}
          </div>
          {c.sub && (
            <div className="text-[10px]" style={{ color: "#555" }}>
              {c.sub}
            </div>
          )}
        </>
      )}

      {c.type === "table" && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {c.cols.map((col) => (
                  <th
                    key={col}
                    className="text-left py-0.5 px-2 font-bold"
                    style={{ color: "#555", borderBottom: `1px solid ${colors.border}` }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row: RowData, i: number) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static render-once command result
                <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {row.cells.map((cell: string, j: number) => (
                    <td
                      key={c.cols[j] ?? `col-${cell}`}
                      className="py-1 px-2 font-mono"
                      style={{ color: cellColor(row.colors[j] ?? "", cell, colors) }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {c.type === "info" && (
        <div className="space-y-0.5">
          {c.lines.map((line: string, i: number) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static render-once command result
            <div key={i} className="text-[10px]" style={{ color: colors.textSecondary }}>
              {line}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="mt-2 text-[9px] px-2 py-0.5 border font-bold hover:opacity-70"
        style={{ color: colors.textSecondary, borderColor: colors.border }}
        onClick={onClose}
      >
        NEW QUERY
      </button>
    </div>
  );
}

/** Single suggestion row (command / function) */
function SuggestionRow({
  suggestion,
  isActive,
  onSelect,
  colors,
}: {
  suggestion: Suggestion;
  isActive: boolean;
  onSelect: () => void;
  colors: typeof bloombergColors.dark;
}) {
  const gc = GROUP_COLORS[suggestion.group] ?? colors.accent;
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors"
      style={{
        background: isActive ? `${colors.accent}18` : "transparent",
        borderBottom: `1px solid ${colors.border}`,
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
    >
      <div
        className="w-1 h-5 shrink-0"
        style={{ background: isActive ? colors.accent : "transparent" }}
      />
      <span
        className="font-bold font-mono text-xs w-44 shrink-0 truncate"
        style={{ color: colors.accent }}
      >
        {suggestion.label}
      </span>
      <span className="flex-1 text-xs truncate" style={{ color: colors.textSecondary }}>
        {suggestion.desc}
      </span>
      <span
        className="text-xs px-1.5 py-0.5 font-bold shrink-0"
        style={{ background: `${gc}22`, color: gc, border: `1px solid ${gc}44` }}
      >
        {suggestion.group.toUpperCase()}
      </span>
    </div>
  );
}

/** Stock search result row */
function ResultRow({
  result,
  isActive,
  isPinned,
  onOpen,
  onPinClick,
  colors,
  rowRef,
}: {
  result: SearchResult;
  isActive: boolean;
  isPinned: boolean;
  onOpen: () => void;
  onPinClick: (e: React.MouseEvent) => void;
  colors: typeof bloombergColors.dark;
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  const tColor = typeColor(result.typeDisp);
  const name = displayName(result);
  const symbol = displaySymbol(result);
  return (
    <div
      ref={rowRef ?? null}
      className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
      style={{
        background: isActive ? `${colors.accent}18` : "transparent",
        borderBottom: `1px solid ${colors.border}`,
      }}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <div
        className="w-1 h-6 rounded-full shrink-0"
        style={{ background: isActive ? colors.accent : "transparent" }}
      />
      <span
        className="font-bold font-mono text-sm w-24 shrink-0"
        style={{ color: colors.accent }}
        title={result.symbol}
      >
        {symbol}
      </span>
      <span className="flex-1 text-sm truncate" style={{ color: colors.text }}>
        {name}
      </span>
      {result.typeDisp && (
        <span
          className="text-xs px-1.5 py-0.5 rounded font-bold shrink-0 hidden sm:block"
          style={{ background: `${tColor}22`, color: tColor, border: `1px solid ${tColor}44` }}
        >
          {result.typeDisp.toUpperCase()}
        </span>
      )}
      {result.exchDisp && (
        <span
          className="text-xs shrink-0 w-20 text-right hidden sm:block"
          style={{ color: colors.textSecondary }}
        >
          {result.exchDisp}
        </span>
      )}
      <button
        type="button"
        className="flex items-center gap-1 text-xs px-2 py-1 rounded shrink-0 font-bold transition-all hover:scale-105"
        style={{
          background: isPinned ? "#22c55e22" : `${colors.accent}22`,
          color: isPinned ? "#4ade80" : colors.accent,
          border: `1px solid ${isPinned ? "#22c55e44" : `${colors.accent}44`}`,
        }}
        onClick={onPinClick}
        title={isPinned ? "Pinned - click to move to another group" : "Pin this asset (P)"}
      >
        {isPinned ? (
          <>
            <Check className="h-3 w-3" />
            PINNED
          </>
        ) : (
          <>
            <Pin className="h-3 w-3" />
            PIN
          </>
        )}
      </button>
    </div>
  );
}

// ── Main GlobalSearch ─────────────────────────────────────────────────────────

export function GlobalSearch() {
  const [isOpen, setIsOpen] = useAtom(isGlobalSearchOpenAtom);
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const { groups, pins, groupOf, ensureLoaded, pin: pinTo } = usePinActions();
  const setCurrentView = useSetAtom(currentViewAtom);
  const setChartCompare = useSetAtom(chartCompareSymbolsAtom);
  const setChartScalingUnit = useSetAtom(chartScalingUnitAtom);
  const setChartType = useSetAtom(chartTypeAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const setHeatmapMarket = useSetAtom(heatmapMarketAtom);
  const setHeatmapMetric = useSetAtom(heatmapMetricAtom);
  const setTickerEnabled = useSetAtom(tickerEnabledAtom);
  const setShowYTD = useSetAtom(showYTDAtom);
  const setIsDarkMode = useSetAtom(isDarkModeAtom);
  const queryClient = useQueryClient();
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  // ── Stock search state ─────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pinFeedback, setPinFeedback] = useState<Record<string, string>>({});

  // ── Terminal command state ─────────────────────────────────────────────────
  const [execResult, setExecResult] = useState<CommandResult | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ── Command / function mode ────────────────────────────────────────────────
  const isCommandMode = isCommandInput(query) || /^[a-z]{2,8}_scaling$/i.test(query.trim());
  const suggestions = isCommandMode ? getSuggestions(query) : [];
  const upperQuery = query.trim().toUpperCase();

  // ── TerminalCtx (stable ref) ──────────────────────────────────────────────
  const ctx: TerminalCtx = {
    setView: (v) => {
      // biome-ignore lint/suspicious/noExplicitAny: terminal command strings map onto the view atom union
      setCurrentView(v as any);
    },
    setTickerEnabled: (b) => setTickerEnabled(b),
    setDarkMode: (b) => setIsDarkMode(b),
    setShowYTD: (b) => setShowYTD(b),
    setStockSymbol: (s) => {
      recordSearchHit(s);
      setStockSymbol(s);
    },
    setChartCompare: (symbols) => {
      setChartCompare(symbols);
      setChartType("candle");
    },
    setChartScalingUnit: (unit) => setChartScalingUnit(unit),
    openHeatmap: (market, metric) => {
      if (market) setHeatmapMarket(market);
      if (metric) setHeatmapMetric(metric);
      // biome-ignore lint/suspicious/noExplicitAny: "heatmap" is a valid view atom value
      setCurrentView("heatmap" as any);
    },
    invalidate: (ks) => {
      for (const k of ks) queryClient.invalidateQueries({ queryKey: [k] });
    },
    close: () => setIsOpen(false),
  };

  // ── Open: sync groups + reset ─────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset runs only on open toggle by design
  useEffect(() => {
    if (!isOpen) return;
    void ensureLoaded();
    setQuery("");
    setResults([]);
    setActiveIdx(0);
    setPickerFor(null);
    setExecResult(null);
    setExecLoading(false);
    abortRef.current?.abort();
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // cleanup abort on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  // ── Stock search — cheapest source first ───────────────────────────────────
  // synthetic (client) → session cache (no request) → backend (debounced,
  // superseded requests aborted so an old reply never overwrites a newer one)
  useEffect(() => {
    if (!query.trim() || isCommandMode) {
      setResults([]);
      setLoading(false);
      setSearchError(null);
      return;
    }
    const q = query.trim().toUpperCase();
    if (
      "FEAR-GREED".startsWith(q) ||
      "FEAR".startsWith(q) ||
      "GREED".startsWith(q) ||
      q === "FG" ||
      q === "F&G" ||
      q === "SENTIMENT"
    ) {
      setResults([
        {
          symbol: "FEAR-GREED",
          shortname: "Fear & Greed Index",
          longname:
            "CNN-style Fear & Greed composite (VIX, momentum, safe-haven, junk bonds, breadth)",
          typeDisp: "Index",
        },
      ]);
      setSearchError(null);
      setActiveIdx(0);
      setLoading(false);
      return;
    }

    const key = searchKey(query);
    const cached = cachedSearch(key);
    if (cached) {
      setResults(cached);
      setSearchError(null);
      setActiveIdx(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSearchError(null);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/stock?type=search&symbol=${encodeURIComponent(key)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (ctrl.signal.aborted) return;
        if (!res.ok || data?.error) {
          setSearchError(data?.error ?? `Backend error ${res.status}`);
          setResults([]);
          return;
        }
        const arr: SearchResult[] = (Array.isArray(data) ? data : (data.quotes ?? [])).slice(0, 10);
        // Empty may be an upstream outage (backend serves [] then) — don't pin it
        if (arr.length) storeSearch(key, arr);
        setResults(arr);
        setSearchError(null);
        setActiveIdx(0);
      } catch {
        if (ctrl.signal.aborted) return;
        setSearchError("Cannot reach backend — is the Python server running?");
        setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, isCommandMode]);

  // ── Clear result when query changes ───────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on query only
  useEffect(() => {
    if (execResult) setExecResult(null);
  }, [query]);

  // scroll active row into view
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const openEquity = useCallback(
    (sym: string) => {
      recordSearchHit(sym);
      setStockSymbol(sym);
      // biome-ignore lint/suspicious/noExplicitAny: "stock" is a valid view atom value
      setCurrentView("stock" as any);
      setIsOpen(false);
    },
    [setStockSymbol, setCurrentView, setIsOpen]
  );

  const runCommand = useCallback(
    async (completion?: string) => {
      const raw = completion ?? query;
      if (!raw.trim()) return;

      const scaling = /^([a-z]{2,8})_scaling$/i.exec(raw.trim());
      if (scaling) {
        const unit = scaling[1].toUpperCase();
        if (!/^[A-Z]{3}$/.test(unit)) {
          setExecResult({
            kind: "error",
            message: "Use a three-letter currency code, such as USD, BTC, EUR or THB.",
          });
          return;
        }
        setChartScalingUnit(unit);
        setChartCompare([]);
        setChartType("candle");
        setCurrentView("market");
        setIsOpen(false);
        return;
      }

      const parseResult = validate(parse(raw));
      if (!parseResult.ok) {
        setExecResult({ kind: "error", message: parseResult.error });
        return;
      }

      const ast = parseResult.ast;

      // Instant nav / action — no async needed; still wrap for uniformity
      if (ast.kind === "nav" || ast.kind === "set" || ast.kind === "lookup") {
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const result = await executeAst(ast, ctx, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (result.kind === "navigate" || result.kind === "action") {
          setIsOpen(false);
          return;
        }
        if (result.kind === "stay") return;
        setExecResult(result);
        return;
      }

      // Async function call
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setExecLoading(true);
      setExecResult(null);

      try {
        const result = await executeAst(ast, ctx, ctrl.signal);
        if (ctrl.signal.aborted) return;
        // A function can navigate too — heatmap(TH) opens a view, not a result card.
        if (result.kind === "navigate" || result.kind === "action") {
          setIsOpen(false);
          return;
        }
        setExecResult(result);
      } finally {
        if (!ctrl.signal.aborted) setExecLoading(false);
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: ctx is rebuilt every render by design
    [query, ctx, setIsOpen, setChartScalingUnit, setChartCompare, setChartType, setCurrentView]
  );

  const doPin = useCallback(
    async (sym: string, target?: PinTarget) => {
      setPickerFor(null);
      const result = await pinTo(sym, target);
      if (!result) return; // usePinActions rolled back and reported the error
      const verb = result.action === "moved" ? "Moved to" : "Pinned to";
      setPinFeedback((fb) => ({ ...fb, [sym]: `${verb} ${result.group.name}` }));
      setTimeout(
        () =>
          setPinFeedback((fb) => {
            const n = { ...fb };
            delete n[sym];
            return n;
          }),
        2500
      );
    },
    [pinTo]
  );

  const handlePinClick = useCallback(
    (e: React.MouseEvent, sym: string) => {
      e.stopPropagation();
      void ensureLoaded();
      setPickerFor((v) => (v === sym ? null : sym));
    },
    [ensureLoaded]
  );

  // ── Keyboard handler inside overlay ───────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setPickerFor(null);
        if (!pickerFor) setIsOpen(false);
        return;
      }

      // Tab — apply first suggestion
      if (e.key === "Tab" && isCommandMode && suggestions.length > 0) {
        e.preventDefault();
        setQuery(suggestions[0].completion);
        return;
      }

      // Command / function mode navigation
      if (isCommandMode && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const s = suggestions[activeIdx];
          if (s) {
            if (s.isFunc && !query.trim().endsWith(")")) {
              // If function not yet complete, apply completion (open paren)
              setQuery(s.completion);
            } else {
              runCommand(query);
            }
          }
          return;
        }
      }

      // Enter when query looks complete (has closing paren or is a nav/setting)
      if (e.key === "Enter" && isCommandMode && !suggestions.length) {
        e.preventDefault();
        runCommand(query);
        return;
      }

      // Enter when no suggestions matched but it's command-like
      if (e.key === "Enter" && isCommandMode) {
        e.preventDefault();
        runCommand(query);
        return;
      }

      // Enter before the result list arrives: resolve what was typed
      // (CPALL → CPALL.BK) instead of doing nothing
      if (!isCommandMode && !results.length && e.key === "Enter" && query.trim()) {
        e.preventDefault();
        void resolveSymbol(query).then(openEquity);
        return;
      }

      // Stock search navigation
      if (!isCommandMode && results.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIdx((i) => Math.min(i + 1, results.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIdx((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          openEquity(results[activeIdx].symbol);
        } else if ((e.key === "p" || e.key === "P") && e.ctrlKey) {
          e.preventDefault();
          const sym = results[activeIdx]?.symbol;
          if (!sym) return;
          // Quick pin into the first group; an already-pinned symbol opens the
          // picker instead so Ctrl+P can never silently move it.
          if (groupOf(sym) || !groups.length) setPickerFor(sym);
          else doPin(sym, { groupId: groups[0].id });
        }
      }
    },
    [
      results,
      activeIdx,
      pickerFor,
      isCommandMode,
      suggestions,
      query,
      runCommand,
      openEquity,
      doPin,
      groups,
      groupOf,
      setIsOpen,
    ]
  );

  if (!isOpen) return null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(2px)" }}
      role="presentation"
      onClick={() => setIsOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setIsOpen(false);
      }}
    >
      <div
        className="w-full max-w-2xl border overflow-hidden"
        style={{ background: colors.background, borderColor: colors.border }}
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* ── Input bar ── */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: colors.border }}
        >
          {loading || execLoading ? (
            <Loader2 className="h-5 w-5 shrink-0 animate-spin" style={{ color: colors.accent }} />
          ) : (
            <Search className="h-5 w-5 shrink-0" style={{ color: colors.accent }} />
          )}
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-sm font-mono"
            style={{ color: colors.text }}
            placeholder="Search stocks, ETFs…  or type  corr(AAPL, MSFT)  MKT  HELP"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPickerFor(null);
              setActiveIdx(0);
            }}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" onClick={() => setIsOpen(false)}>
            <X className="h-4 w-4 hover:opacity-70" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        {/* ── Results ── */}
        <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: "min(65vh, 480px)" }}>
          {/* ── Error from execution ── */}
          {execResult?.kind === "error" && (
            <div className="px-4 py-3 border-b font-mono" style={{ borderColor: colors.border }}>
              <div className="text-[9px] tracking-widest mb-1" style={{ color: "#f87171" }}>
                ERROR
              </div>
              <div className="text-sm" style={{ color: "#f87171" }}>
                {execResult.message}
              </div>
            </div>
          )}

          {/* ── Display result (scalar / table / info) ── */}
          {execResult?.kind === "display" && (
            <ResultPanel
              result={execResult as CommandResult & { kind: "display" }}
              colors={colors}
              onClose={() => {
                setExecResult(null);
                setQuery("");
                inputRef.current?.focus();
              }}
            />
          )}

          {/* ── Command / function suggestions ── */}
          {isCommandMode && !execResult && !execLoading && (
            <>
              {suggestions.length === 0 && query.trim() && (
                <div className="py-6 text-center text-xs" style={{ color: colors.textSecondary }}>
                  Unknown command — type <strong>HELP</strong> to list all
                </div>
              )}
              {suggestions.map((s, i) => (
                <SuggestionRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: label may repeat across groups
                  key={s.label + i}
                  suggestion={s}
                  isActive={i === activeIdx}
                  onSelect={() => {
                    if (s.isFunc && !query.trim().endsWith(")")) {
                      setQuery(s.completion);
                      inputRef.current?.focus();
                    } else {
                      runCommand(s.completion);
                    }
                  }}
                  colors={colors}
                />
              ))}
              {/* HELP: show all commands */}
              {upperQuery === "HELP" && (
                <div className="px-4 py-2 font-mono">
                  {["analysis", "nav", "setting", "info"].map((group) => {
                    const cmds = ALL_COMMANDS.filter((c) => c.group === group);
                    if (!cmds.length) return null;
                    const gc = GROUP_COLORS[group] ?? colors.accent;
                    return (
                      <div key={group} className="mb-3">
                        <div
                          className="text-[9px] font-bold tracking-widest mb-1 uppercase"
                          style={{ color: gc }}
                        >
                          {group}
                        </div>
                        {cmds.map((c) => (
                          <div key={c.name} className="flex gap-3 text-[10px] py-0.5">
                            <span
                              className="w-40 shrink-0 font-bold"
                              style={{ color: colors.accent }}
                            >
                              {c.name}
                              {c.args?.length
                                ? `(${c.args.map((a) => (a.optional ? `${a.name}?` : a.name)).join(", ")})`
                                : ""}
                            </span>
                            <span style={{ color: colors.textSecondary }}>{c.description}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ── Loading spinner for async function ── */}
          {execLoading && (
            <div className="py-8 flex items-center justify-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
              <span className="text-xs font-mono" style={{ color: colors.textSecondary }}>
                Computing…
              </span>
            </div>
          )}

          {/* ── Stock search mode ── */}
          {!isCommandMode && !execResult && (
            <>
              {!query.trim() && (
                <div className="py-10 text-center" style={{ color: colors.textSecondary }}>
                  <Search className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <div className="text-sm">Type a ticker or company name</div>
                  <div className="text-xs mt-2 opacity-60">
                    AAPL · TSLA · ^GSPC · ^SET.BK · GC=F
                  </div>
                </div>
              )}
              {query.trim() && !loading && searchError && (
                <div className="py-10 text-center px-6">
                  <div className="text-sm font-bold mb-1" style={{ color: "#f87171" }}>
                    Search failed
                  </div>
                  <div className="text-xs" style={{ color: colors.textSecondary }}>
                    {searchError}
                  </div>
                </div>
              )}
              {query.trim() && !loading && !searchError && results.length === 0 && (
                <div className="py-10 text-center text-sm" style={{ color: colors.textSecondary }}>
                  No results for &ldquo;{query}&rdquo;
                </div>
              )}
              {results.map((r, i) => (
                <div key={r.symbol} className="relative">
                  <ResultRow
                    result={r}
                    isActive={i === activeIdx}
                    isPinned={groupOf(r.symbol) !== undefined}
                    onOpen={() => openEquity(r.symbol)}
                    onPinClick={(e) => handlePinClick(e, r.symbol)}
                    colors={colors}
                    rowRef={(el) => {
                      rowRefs.current[i] = el;
                    }}
                  />
                  {pinFeedback[r.symbol] && (
                    <div
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded font-bold pointer-events-none"
                      style={{
                        // Opaque: it sits on top of the row's type/exchange columns.
                        background: colors.background,
                        color: "#4ade80",
                        border: "1px solid #22c55e66",
                      }}
                    >
                      ✓ {pinFeedback[r.symbol]}
                    </div>
                  )}
                  {pickerFor === r.symbol && (
                    <div className="absolute right-4 top-full" style={{ zIndex: 200 }}>
                      <PinGroupPicker
                        groups={groups}
                        currentGroupId={groupOf(r.symbol)}
                        onPick={(g) => doPin(r.symbol, { groupId: g.id })}
                        onCreate={(name) => doPin(r.symbol, { newGroup: { name } })}
                        onClose={() => setPickerFor(null)}
                        colors={colors}
                      />
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          className="flex items-center gap-4 px-4 py-2 border-t text-xs flex-wrap"
          style={{
            borderColor: colors.border,
            color: colors.textSecondary,
            background: colors.surface,
          }}
        >
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: colors.border }}
            >
              ↑↓
            </kbd>{" "}
            navigate
          </span>
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: colors.border }}
            >
              Tab
            </kbd>{" "}
            complete
          </span>
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: colors.border }}
            >
              ↵
            </kbd>{" "}
            execute / open
          </span>
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: colors.border }}
            >
              Ctrl+P
            </kbd>{" "}
            pin asset
          </span>
          <span>
            <kbd
              className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: colors.border }}
            >
              Esc
            </kbd>{" "}
            close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Pin className="h-3 w-3" style={{ color: colors.accent }} />
            {pins.length} pinned
          </span>
        </div>
      </div>
    </div>
  );
}
