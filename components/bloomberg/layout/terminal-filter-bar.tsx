"use client";

/**
 * Terminal Status Bar — Minimal info strip below the command bar.
 * Shows: watchlist selector, %Chg mode badge, Esc hint.
 * Background: #000 (matches columns).
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAtom } from "jotai";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { showYTDAtom } from "../atoms";
import { activeWatchlistAtom } from "../atoms/terminal-ui";
import { bloombergColors } from "../lib/theme-config";

type TerminalFilterBarProps = {
  isDarkMode: boolean;
  watchlists: Array<{ name: string; indices: string[] }>;
  currentView: string;
};

const VIEW_LABELS: Record<string, string> = {
  market: "MARKET",
  news: "NEWS",
  movers: "MOVERS",
  volatility: "VOLATILITY",
  stock: "EQUITY",
  clippings: "CLIPPINGS",
  macro: "MACRO",
  credit: "CREDIT",
  portfolio: "PORTFOLIO",
  crypto: "CRYPTO",
  fx: "FX",
};

export function TerminalFilterBar({ isDarkMode, watchlists, currentView }: TerminalFilterBarProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [showYTD] = useAtom(showYTDAtom);
  const [activeWatchlist, setActiveWatchlist] = useAtom(activeWatchlistAtom);

  // Flash animation when mode toggles
  const [flash, setFlash] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(t);
  }, [showYTD]);

  const modeColor = showYTD ? colors.positive : colors.accent;
  const modeLabel = showYTD ? "YTD" : "DAILY";

  return (
    <div
      className="flex items-center gap-3 px-2 font-mono select-none"
      style={{
        backgroundColor: colors.background,
        borderBottom: `1px solid ${colors.border}`,
        height: 18,
        minHeight: 18,
      }}
    >
      {/* Current view breadcrumb */}
      <span
        className="text-[9px] font-bold tracking-widest"
        style={{ color: colors.accent }}
      >
        {VIEW_LABELS[currentView] ?? currentView.toUpperCase()}
      </span>

      <span className="text-[8px]" style={{ color: colors.border }}>│</span>

      {/* Watchlist selector */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-0.5 text-[9px] hover:opacity-70 outline-none"
          style={{ color: colors.textSecondary }}
        >
          <span>{activeWatchlist ?? "Standard"}</span>
          <ChevronDown className="h-2 w-2" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="font-mono text-xs">
          <DropdownMenuItem onClick={() => setActiveWatchlist(null)}>Standard</DropdownMenuItem>
          {watchlists.map((list) => (
            <DropdownMenuItem key={list.name} onClick={() => setActiveWatchlist(list.name)}>
              {list.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="text-[8px]" style={{ color: colors.border }}>│</span>

      {/* %Chg mode badge */}
      <span
        className="text-[8px] font-bold tracking-wider"
        style={{
          color: modeColor,
          opacity: flash ? 1 : 0.7,
          transition: "opacity 0.25s ease",
        }}
      >
        %{modeLabel}
      </span>
      <span className="text-[7px]" style={{ color: colors.textSecondary, opacity: 0.4 }}>
        Y
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Esc hint */}
      <span className="text-[8px]" style={{ color: colors.textSecondary, opacity: 0.4 }}>
        Esc:back
      </span>
    </div>
  );
}
