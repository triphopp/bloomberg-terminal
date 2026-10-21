"use client";

import {
  QueriesObserver,
  type QueryObserverOptions,
  type QueryObserverResult,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

/** Keep per-symbol cache/observers, but commit a large batch to React once per 50ms.
 * Otherwise thousands of fetch-status notifications can block typing/scrolling.
 * Pass memoized options. Unsubscription keeps TanStack's shared cancellation rules.
 */
export function useMarketQueryResults<T>(
  options: QueryObserverOptions<T>[],
  pollMs: number | false = false
) {
  const client = useQueryClient();
  const observer = useMemo(() => new QueriesObserver(client, options), [client, options]);
  const [snapshot, setSnapshot] = useState(() => ({
    observer,
    results: observer.getCurrentResult(),
  }));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      timer = undefined;
      setSnapshot({ observer, results: observer.getCurrentResult() });
    };
    const unsubscribe = observer.subscribe(() => {
      if (!timer) timer = setTimeout(publish, 50);
    });
    setSnapshot({ observer, results: observer.getCurrentResult() });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [observer]);
  usePrefetchLoop(options, pollMs);

  // Never pair a previous symbol set's results with the new symbol keys.
  return (
    snapshot.observer === observer ? snapshot.results : observer.getCurrentResult()
  ) as QueryObserverResult<T>[];
}

/**
 * One poll pass over `options` every `pollMs` (prefetch joins work in flight
 * and skips fresh data). Separate from the observers so one list can be
 * watched while its parts poll at different rates. Pass memoized options.
 */
export function usePrefetchLoop<T>(options: QueryObserverOptions<T>[], pollMs: number | false) {
  const client = useQueryClient();
  useEffect(() => {
    if (!pollMs || options.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      // fetchQuery joins existing work and skips fresh data (including chart updates).
      // Await the whole pass before scheduling another: no staggered per-row timers.
      if (document.visibilityState !== "hidden") {
        await Promise.all(
          options.filter((o) => o.enabled !== false).map((o) => client.prefetchQuery(o))
        );
      }
      if (!stopped) timer = setTimeout(refresh, pollMs);
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, options, pollMs]);
}
