"use client";

import { Search, Settings } from "lucide-react";
import type React from "react";
import { bloombergColors } from "../lib/theme-config";
import { ProviderSwitch } from "./provider-switch";
import { SyncStatus } from "./sync-status";

export interface NavItem {
  id: string;
  label: string;
  shortcut: string;
  onClick: () => void;
}

type TerminalHeaderProps = {
  isDarkMode: boolean;
  currentView: string;
  navItems: NavItem[];
  onSearchClick: () => void;
  onHelpClick: () => void;
  showYTD: boolean;
  onYTDToggle: () => void;
  centerSlot?: React.ReactNode;
  onSettingsClick?: () => void;
  onBack?: () => void;
};

export function TerminalHeader({
  isDarkMode,
  currentView,
  navItems,
  onSearchClick,
  onHelpClick,
  showYTD,
  onYTDToggle,
  centerSlot,
  onSettingsClick,
  onBack,
}: TerminalHeaderProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const sep = `1px solid ${colors.border}33`;

  return (
    <div
      className="font-mono select-none flex items-stretch"
      style={{
        backgroundColor: colors.background,
        borderBottom: `1px solid ${colors.border}`,
        height: 22,
        minHeight: 22,
      }}
    >
      {/* LEFT — nav items, scrollable if viewport too narrow */}
      <div className="flex items-center overflow-x-auto shrink-0" style={{ maxWidth: "55%" }}>
        {navItems.map((item) => {
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              className="flex items-center gap-0 px-1.5 h-full whitespace-nowrap transition-colors"
              style={{
                backgroundColor: isActive ? colors.accent : "transparent",
                color: isActive ? "#000" : colors.textSecondary,
                fontWeight: isActive ? 700 : 400,
                fontSize: 10,
                borderRight: sep,
              }}
              title={`${item.label} (${item.shortcut})`}
            >
              <span
                className="font-bold mr-0.5"
                style={{ color: isActive ? "#000" : colors.accent, fontSize: 9 }}
              >
                {item.shortcut}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* CENTER — key indicators ticker (only when market data available) */}
      <div className="flex-1 min-w-0 overflow-hidden flex items-center" style={{ borderLeft: sep }}>
        {centerSlot}
      </div>

      {/* RIGHT — status controls, always visible */}
      <div className="flex items-center shrink-0">
        {/* Quote provider switch + health */}
        <ProviderSwitch isDarkMode={isDarkMode} />

        {/* Portfolio cloud-sync status (hidden when sync disabled) */}
        <SyncStatus isDarkMode={isDarkMode} />

        {/* %YTD / %DAILY toggle — collapsed to a status light like the
            provider/sync chips; hover to read the mode, click (or "Y") to
            flip it. */}
        <button
          type="button"
          onClick={onYTDToggle}
          className="flex items-center justify-center px-2 h-full transition-opacity hover:opacity-100"
          style={{ borderLeft: sep, opacity: 0.85 }}
          title={`Showing ${showYTD ? "%YTD" : "%Daily"} — click to switch (Y)`}
        >
          <span
            className="inline-block rounded-full"
            style={{ width: 6, height: 6, background: showYTD ? colors.positive : colors.accent }}
          />
        </button>

        {/* Esc:back — sub-views only, clickable when onBack provided */}
        {currentView !== "market" &&
          (onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="px-2 text-[8px] h-full flex items-center hover:opacity-80 transition-opacity"
              style={{ color: colors.textSecondary, opacity: 0.5, borderLeft: sep }}
              title="Back (Esc)"
            >
              ← ESC
            </button>
          ) : (
            <span
              className="px-2 text-[8px] h-full flex items-center"
              style={{ color: colors.textSecondary, opacity: 0.4, borderLeft: sep }}
            >
              Esc:back
            </span>
          ))}

        <button
          type="button"
          onClick={onHelpClick}
          className="flex items-center gap-0.5 px-1.5 h-full transition-colors hover:opacity-70"
          style={{ color: colors.textSecondary, fontSize: 9, borderLeft: sep }}
          title="Keyboard shortcuts (?)"
        >
          <span className="font-bold" style={{ color: colors.accent, fontSize: 8 }}>
            ?
          </span>
          <span>HELP</span>
        </button>

        {/* Search */}
        <button
          type="button"
          onClick={onSearchClick}
          className="flex items-center gap-1 px-2 h-full transition-colors hover:opacity-70"
          style={{
            color: colors.textSecondary,
            fontSize: 9,
            borderLeft: sep,
            backgroundColor: `${colors.accent}08`,
          }}
          title="Search (/ or Ctrl+K)"
        >
          <Search className="h-2.5 w-2.5" style={{ color: colors.accent }} />
          <span className="hidden sm:inline">Search</span>
          <kbd
            className="hidden sm:inline px-1 py-0 font-mono ml-0.5"
            style={{ background: `${colors.border}66`, color: colors.textSecondary, fontSize: 8 }}
          >
            /
          </kbd>
        </button>

        {/* Layout settings — market view only */}
        {onSettingsClick && currentView === "market" && (
          <button
            type="button"
            onClick={onSettingsClick}
            className="flex items-center gap-0.5 px-1.5 h-full transition-colors hover:opacity-70"
            style={{ color: colors.textSecondary, fontSize: 9, borderLeft: sep }}
            title="Layout settings"
          >
            <Settings className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}
