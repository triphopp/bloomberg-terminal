"use client";

import { useEffect } from "react";

/**
 * Alt+1..N switches tabs within the active view.
 * Skips when focus is inside an input/textarea/contenteditable.
 * AltGr safety: AltGr fires altKey=true AND ctrlKey=true — ctrlKey guard prevents false triggers.
 */
export function useTabShortcuts<T extends string>(
  tabs: { id: T }[],
  setActiveTab: (id: T) => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const n = parseInt(e.key, 10);
      if (isNaN(n) || n < 1 || n > tabs.length) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) return;
      e.preventDefault();
      setActiveTab(tabs[n - 1].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, setActiveTab]);
}
