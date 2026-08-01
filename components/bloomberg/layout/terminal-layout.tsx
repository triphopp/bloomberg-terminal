"use client";

import { Button } from "@/components/ui/button";
import { useAtom } from "jotai";
import { type ReactNode, useEffect, useState } from "react";
import { errorAtom, isDarkModeAtom } from "../atoms";
import { GlobalSearch } from "../core/global-search";
import { KeyboardShortcuts } from "../core/keyboard-shortcuts";
import { ShortcutIndicator } from "../core/shortcut-indicator";
import { bloombergColors } from "../lib/theme-config";

type TerminalLayoutProps = {
  children: ReactNode;
  shortcuts: Array<{
    key: string;
    ctrlKey?: boolean;
    action: () => void;
    description: string;
  }>;
};

export function TerminalLayout({ children, shortcuts }: TerminalLayoutProps) {
  // Use Jotai atoms directly instead of props
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const [error, setError] = useAtom(errorAtom);

  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  // Dark mode is permanent (isDarkModeAtom defaults true, no toggle UI left
  // to flip it) — this just keeps the body class in sync for any CSS that
  // still keys off it.
  useEffect(() => {
    document.body.classList.toggle("dark", isDarkMode);
    document.body.classList.toggle("light", !isDarkMode);
  }, [isDarkMode]);

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col font-mono"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {children}

      {/* Global Search overlay — available from any view */}
      <GlobalSearch />

      {/* Keyboard shortcuts */}
      <KeyboardShortcuts shortcuts={shortcuts} isEnabled={true} />

      {/* Error Message */}
      {error && (
        <div className="p-2 bg-red-500 text-white text-xs fixed bottom-0 left-0 right-0 z-50">
          Error: {error}
          <Button
            variant="ghost"
            size="sm"
            className="ml-2 h-4 text-white hover:bg-red-600"
            onClick={() => setError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Shortcut indicator */}
      <ShortcutIndicator isDarkMode={isDarkMode} />
    </div>
  );
}
