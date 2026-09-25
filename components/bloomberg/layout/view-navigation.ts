import type { MouseEvent } from "react";

export type TerminalView = "market" | "news" | "heatmap" | "stock" | "portfolio" | "tail" | "bonds";

const views = new Set<TerminalView>([
  "market",
  "news",
  "heatmap",
  "stock",
  "portfolio",
  "tail",
  "bonds",
]);

export function viewFromSearch(search: string): TerminalView | null {
  const value = new URLSearchParams(search).get("view");
  return value && views.has(value as TerminalView) ? (value as TerminalView) : null;
}

export function viewHref(view: TerminalView): string {
  return `/?view=${view}`;
}

/** Preserve native modified clicks; use in-app state for an ordinary primary click. */
export function handleViewLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onClick: () => void
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  const next = new URL(href, window.location.href);
  if (next.href !== window.location.href) window.history.pushState(null, "", next.href);
  onClick();
}
