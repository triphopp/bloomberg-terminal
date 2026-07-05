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
  type PinGroup,
  type PinnedAsset,
  currentViewAtom,
  isDarkModeAtom,
  isGlobalSearchOpenAtom,
  pinGroupsAtom,
  pinnedAssetsAtom,
  showYTDAtom,
  stockSearchSymbolAtom,
  tickerEnabledAtom,
} from "../atoms";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors } from "../lib/theme-config";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

export const DEFAULT_WATCHLIST_GROUP: PinGroup = {
  id: "watchlist",
  name: "Watchlist",
  color: "#f59e0b",
};
const LS_GROUPS = "bloomberg_pin_groups";
const LS_PINS = "bloomberg_pinned_assets";

function loadGroups(): PinGroup[] {
  try {
    const s = localStorage.getItem(LS_GROUPS);
    return s ? JSON.parse(s) : [DEFAULT_WATCHLIST_GROUP];
  } catch {
    return [DEFAULT_WATCHLIST_GROUP];
  }
}

function savePin(pin: PinnedAsset) {
  try {
    const existing: PinnedAsset[] = JSON.parse(localStorage.getItem(LS_PINS) ?? "[]");
    localStorage.setItem(LS_PINS, JSON.stringify([...existing, pin]));
  } catch {
    /* ignore */
  }
}

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

/** GroupPicker popover for pinning */
function GroupPicker({
  groups,
  onPick,
  onClose,
  colors,
}: {
  groups: PinGroup[];
  onPick: (g: PinGroup) => void;
  onClose: () => void;
  colors: typeof bloombergColors.dark;
}) {
  return (
    <div
      className="absolute right-0 top-full mt-1 z-[200] border min-w-[160px]"
      style={{ background: colors.surface, borderColor: colors.border }}
      role="presentation"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="px-3 py-1.5 text-xs font-bold border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        PIN TO GROUP
      </div>
      {groups.map((g) => (
        <button
          type="button"
          key={g.id}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:opacity-70"
          style={{ color: colors.text }}
          onClick={() => onPick(g)}
        >
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
          {g.name}
        </button>
      ))}
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs border-t"
        style={{ color: colors.textSecondary, borderColor: colors.border }}
        onClick={onClose}
      >
        Cancel
      </button>
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
        title={isPinned ? "Already pinned" : "Pin this asset (P)"}
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
  const [pins, setPins] = useAtom(pinnedAssetsAtom);
  const [groups, setGroups] = useAtom(pinGroupsAtom);
  const setCurrentView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
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
  const [pinnedNow, setPinnedNow] = useState<Set<string>>(new Set());
  const [pinFeedback, setPinFeedback] = useState<Record<string, string>>({});

  // ── Terminal command state ─────────────────────────────────────────────────
  const [execResult, setExecResult] = useState<CommandResult | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ── Command / function mode ────────────────────────────────────────────────
  const isCommandMode = isCommandInput(query);
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
    setStockSymbol: (s) => setStockSymbol(s),
    invalidate: (ks) => {
      for (const k of ks) queryClient.invalidateQueries({ queryKey: [k] });
    },
    close: () => setIsOpen(false),
  };

  // ── Open: sync groups + reset ─────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset runs only on open toggle by design
  useEffect(() => {
    if (!isOpen) return;
    setGroups(loadGroups());
    setQuery("");
    setResults([]);
    setActiveIdx(0);
    setPickerFor(null);
    setPinnedNow(new Set(pins.map((p) => p.symbol)));
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

  // ── Debounced stock search ─────────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim() || isCommandMode) {
      setResults([]);
      setLoading(false);
      setSearchError(null);
      return;
    }
    setLoading(true);
    setSearchError(null);
    const t = setTimeout(async () => {
      try {
        // ── Synthetic symbols (client-side, no backend needed) ────────────────
        const q = query.trim().toUpperCase();
        const syntheticResults: SearchResult[] = [];
        if (
          "FEAR-GREED".startsWith(q) ||
          "FEAR".startsWith(q) ||
          "GREED".startsWith(q) ||
          q === "FG" ||
          q === "F&G" ||
          q === "SENTIMENT"
        ) {
          syntheticResults.push({
            symbol: "FEAR-GREED",
            shortname: "Fear & Greed Index",
            longname:
              "CNN-style Fear & Greed composite (VIX, momentum, safe-haven, junk bonds, breadth)",
            typeDisp: "Index",
          });
        }
        if (syntheticResults.length > 0) {
          setResults(syntheticResults.slice(0, 10));
          setSearchError(null);
          setActiveIdx(0);
          setLoading(false);
          return;
        }

        // ── Backend stock search ───────────────────────────────────────────────
        const res = await fetch(`/api/stock?type=search&symbol=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (!res.ok || data?.error) {
          setSearchError(data?.error ?? `Backend error ${res.status}`);
          setResults([]);
          return;
        }
        const arr = Array.isArray(data) ? data : (data.quotes ?? []);
        setResults(arr.slice(0, 10));
        setSearchError(null);
        setActiveIdx(0);
      } catch {
        setSearchError("Cannot reach backend — is the Python server running?");
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
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
        setExecResult(result);
      } finally {
        if (!ctrl.signal.aborted) setExecLoading(false);
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: ctx is rebuilt every render by design
    [query, ctx, setIsOpen]
  );

  const doPin = useCallback(
    (sym: string, group: PinGroup) => {
      if (pins.some((p) => p.symbol === sym && p.groupId === group.id)) {
        setPinnedNow((s) => new Set([...s, sym]));
        return;
      }
      const newPin: PinnedAsset = {
        id: Date.now().toString(),
        symbol: sym,
        groupId: group.id,
        comment: "",
        addedAt: new Date().toISOString().split("T")[0],
      };
      setPins((ps) => [...ps, newPin]);
      savePin(newPin);
      setPinnedNow((s) => new Set([...s, sym]));
      setPinFeedback((fb) => ({ ...fb, [sym]: group.name }));
      setTimeout(
        () =>
          setPinFeedback((fb) => {
            const n = { ...fb };
            delete n[sym];
            return n;
          }),
        2500
      );
      setPickerFor(null);
      fetch("/api/pins/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newPin.id,
          symbol: newPin.symbol,
          group_id: newPin.groupId,
          comment: "",
          buy_target: null,
          sell_target: null,
          price_at_pin: null,
          priority: 1,
          added_at: newPin.addedAt,
          tags: [],
        }),
      }).catch((err) => console.error("[doPin global-search]", err));
    },
    [pins, setPins]
  );

  const handlePinClick = useCallback(
    (e: React.MouseEvent, sym: string) => {
      e.stopPropagation();
      const effectiveGroups = groups.length ? groups : [DEFAULT_WATCHLIST_GROUP];
      if (effectiveGroups.length === 1) {
        doPin(sym, effectiveGroups[0]);
      } else {
        setPickerFor((v) => (v === sym ? null : sym));
      }
    },
    [groups, doPin]
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
          const grps = groups.length ? groups : [DEFAULT_WATCHLIST_GROUP];
          if (sym) doPin(sym, grps[0]);
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
      setIsOpen,
    ]
  );

  if (!isOpen) return null;

  const effectiveGroups = groups.length ? groups : [DEFAULT_WATCHLIST_GROUP];

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
                    isPinned={pinnedNow.has(r.symbol)}
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
                        background: "#22c55e22",
                        color: "#4ade80",
                        border: "1px solid #22c55e44",
                      }}
                    >
                      ✓ Pinned to {pinFeedback[r.symbol]}
                    </div>
                  )}
                  {pickerFor === r.symbol && (
                    <div className="absolute right-4 top-full" style={{ zIndex: 200 }}>
                      <GroupPicker
                        groups={effectiveGroups}
                        onPick={(g) => doPin(r.symbol, g)}
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
