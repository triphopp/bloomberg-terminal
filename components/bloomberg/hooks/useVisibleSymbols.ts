"use client";

import { type RefObject, useEffect, useMemo, useState } from "react";

/** Rows this many places before/after the visible ones count as visible: data is in before they scroll in. */
const BUFFER_ROWS = 12;
/** Scrolling settles before the set is published — a stream resubscribe per pixel is waste. */
const SETTLE_MS = 250;

const ROW = "[data-wl-sym]";

/**
 * Symbols of the rows (`[data-wl-sym]` under `rootRef`) that are on screen,
 * plus BUFFER_ROWS neighbours either side in DOM order, as a sorted list.
 *
 * WATCHLIST keeps every row in the DOM — ASK reads the screen's text, Ctrl+F
 * and group drag-and-drop need the rows — so this does not skip rendering; it
 * tells the data layer which rows deserve live ticks, a 60 s poll and a
 * Polymarket search. Folded groups and a hidden view have no visible rows.
 *
 * Rows are found by a MutationObserver, not by a dependency list: React
 * remounts rows whenever the table's shape changes (groups arriving, a view
 * switch), and an observer left on a detached row reports it off screen.
 * The observer's root is the viewport — it already clips by every scrolling
 * ancestor; a scroll container picked at mount went stale once MKT's layout
 * settled and the set read 0 with 8 rows in view (2026-10-21). `null` until
 * the first measurement: callers treat that as "all visible", so the first
 * paint never waits on it.
 */
export function useVisibleSymbols(
  rootRef: RefObject<HTMLElement | null>,
  enabled = true
): string[] | null {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || typeof IntersectionObserver === "undefined") return;
    const inView = new Map<Element, boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const publish = () => {
      timer = undefined;
      const rows = [...root.querySelectorAll<HTMLElement>(ROW)]; // DOM order
      const syms = new Set<string>();
      rows.forEach((row, i) => {
        if (!inView.get(row)) return;
        const end = Math.min(rows.length - 1, i + BUFFER_ROWS);
        for (let j = Math.max(0, i - BUFFER_ROWS); j <= end; j++) {
          const sym = rows[j].dataset.wlSym;
          if (sym) syms.add(sym);
        }
      });
      const next = [...syms].sort().join(",");
      setKey((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(publish, SETTLE_MS);
    };

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) inView.set(e.target, e.isIntersecting);
      schedule();
    });
    const rescan = () => {
      const rows = new Set(root.querySelectorAll(ROW));
      for (const row of [...inView.keys()]) {
        if (!rows.has(row)) {
          io.unobserve(row);
          inView.delete(row);
        }
      }
      for (const row of rows) {
        if (!inView.has(row)) {
          inView.set(row, false);
          io.observe(row); // its first callback reports where it is
        }
      }
      schedule();
    };

    let rescanTimer: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      if (!rescanTimer)
        rescanTimer = setTimeout(() => {
          rescanTimer = undefined;
          rescan();
        }, 50);
    });
    // childList only: a price tick rewrites text (characterData), not rows.
    mo.observe(root, { childList: true, subtree: true });
    rescan();
    return () => {
      mo.disconnect();
      io.disconnect();
      if (timer) clearTimeout(timer);
      if (rescanTimer) clearTimeout(rescanTimer);
    };
  }, [rootRef, enabled]);

  return useMemo(() => (key === null ? null : key ? key.split(",") : []), [key]);
}
