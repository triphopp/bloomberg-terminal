import { useCallback, useRef } from "react";

// Keep in sync with dynamic() imports in bloomberg-terminal.tsx
// Each import() triggers a chunk download; fire-and-forget, errors are silent
const prefetchLoaders: Record<string, () => void> = {
  news:      () => { import("../views/news-view"); },
  movers:    () => { import("../views/market-movers-view"); },
  stock:     () => { import("../views/stock-view"); },
  clippings: () => { import("../views/clippings-view"); },
  macro:     () => { import("../views/macro-view"); },
  credit:    () => { import("../views/credit-view"); },
  portfolio: () => { import("../views/portfolio-view"); },
  crypto:    () => { import("../views/crypto-view"); },
  fx:        () => { import("../views/fx-view"); },
};

export function useViewPrefetch() {
  const prefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const prefetch = useCallback((viewId: string) => {
    const loader = prefetchLoaders[viewId];
    if (!loader) return;
    try { loader(); } catch { /* chunk load failure → normal navigation fallback handles it */ }
  }, []);

  // Prefetch after a short hover — avoids triggering on rapid mouse movement
  const prefetchOnHover = useCallback((viewId: string) => {
    const existing = prefetchTimers.current.get(viewId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => prefetch(viewId), 200);
    prefetchTimers.current.set(viewId, timer);
  }, [prefetch]);

  const cancelHoverPrefetch = useCallback((viewId: string) => {
    const existing = prefetchTimers.current.get(viewId);
    if (existing) {
      clearTimeout(existing);
      prefetchTimers.current.delete(viewId);
    }
  }, []);

  // Prefetch tier-1 views (most-used) when idle
  const prefetchTier1 = useCallback(() => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => {
        prefetch("stock");
      });
    }
  }, [prefetch]);

  return { prefetch, prefetchOnHover, cancelHoverPrefetch, prefetchTier1 };
}
