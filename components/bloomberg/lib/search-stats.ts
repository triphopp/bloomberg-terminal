/**
 * Search-frequency tracking for the MKT left panel FREQ tab.
 *
 * Every symbol opened from a search box (global search, `<TICKER> <GO>`, the
 * MKT chart's SYMBOL box) posts one hit; the backend keeps a count per symbol
 * in SQLite (`search_hits`, routers/discover.py). Fire-and-forget: a failed
 * write must never slow down or break opening the symbol.
 */

/** Window event the FREQ list listens to, so it refreshes right after a hit. */
export const SEARCH_HIT_EVENT = "bloomberg:search-hit";

export function recordSearchHit(symbol: string): void {
  const sym = symbol.trim().toUpperCase();
  if (!sym || typeof window === "undefined") return;
  fetch("/api/search-stats/hit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: sym }),
    keepalive: true,
  })
    .then(() => window.dispatchEvent(new CustomEvent(SEARCH_HIT_EVENT, { detail: sym })))
    .catch(() => {
      /* counting is best-effort */
    });
}
