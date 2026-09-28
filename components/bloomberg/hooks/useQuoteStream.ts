"use client";

import { useAtom } from "jotai";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isRealTimeEnabledAtom } from "../atoms";
import {
  type QuoteStreamClient,
  type QuoteTick,
  createQuoteStreamClient,
} from "../lib/quote-stream-client";
import { pollInterval, symbolKey } from "../lib/stream-cadence";

export type { QuoteTick };

/** The page's one stream client (lib/quote-stream-client.ts), made on first use. */
let client: QuoteStreamClient | null = null;

function getClient(): QuoteStreamClient {
  client ??= createQuoteStreamClient({
    EventSource: EventSource,
    fetch: (url, init) => fetch(url, init),
    sessionId:
      globalThis.crypto?.randomUUID?.() ??
      `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
  });
  return client;
}

const noopUnsubscribe = () => {};

/**
 * Live quotes pushed from the backend's Yahoo stream (`/api/stream/quotes`).
 * `onTicks` gets at most one batch a second, holding only its own symbols that
 * traded since the last batch — plus, when a symbol is first added, the hub's
 * last tick for it.
 *
 * This is the push side of the seam `useLiveQuery` describes: callers write
 * ticks into their React Query cache, and the REST poll keeps running
 * underneath as the source of truth. Stream down = the poll is all there is;
 * nothing on screen depends on the stream being up.
 *
 * All consumers share one EventSource per page; changing the set sends a diff
 * instead of reopening (lib/quote-stream-client.ts). Runs only while real-time
 * is ON (same switch as the polling cadence) and the tab is visible.
 *
 * @param symbols Yahoo symbols (AAPL, PTT.BK, BTC-USD). Order does not matter.
 */
export function useQuoteStream(
  symbols: readonly string[],
  onTicks: (ticks: Record<string, QuoteTick>) => void,
  active = true
) {
  const [isRealTime] = useAtom(isRealTimeEnabledAtom);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const handler = useRef(onTicks);
  useEffect(() => {
    handler.current = onTicks;
  }, [onTicks]);

  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Stable key: a new array with the same symbols must not re-register.
  const key = [...new Set(symbols.filter(Boolean))].sort().join(",");

  useEffect(() => {
    if (!active || !isRealTime || !visible || !key || typeof EventSource === "undefined") return;
    return getClient().listen(key.split(","), (t) => handler.current(t));
  }, [key, active, isRealTime, visible]);
}

function subscribeStore(cb: () => void) {
  return typeof EventSource === "undefined" ? noopUnsubscribe : getClient().subscribe(cb);
}

/**
 * REST poll interval that backs off while the stream is doing the work.
 *
 * `openSymbols` are the ones whose market is trading, per the caller's own
 * REST data (`openSymbolsOf` in lib/stream-cadence.ts); `null` = no data yet
 * (not loaded, error, empty payload) → `base`, since unknown is not closed.
 * None open → `QUIET_BACKOFF_MS` (bounded, so an opening market is noticed
 * within 2 min). All of them holding a slot on a connected stream and ticked
 * within `STREAM_TICK_FRESH_MS` → `STREAM_BACKOFF_MS`. Otherwise `base`: a
 * symbol that is open but silent (Yahoo does not stream it, or it lost its
 * slot) keeps the whole query at its old cadence, so nothing on screen gets
 * staler than before. The slower poll still lands as truth for the fields
 * ticks do not carry (volume, YTD, session flags).
 */
export function useStreamPollInterval(
  openSymbols: readonly string[] | null,
  base: number | false
): number | false {
  const key = openSymbols ? symbolKey(openSymbols) : null;
  const cadence = useSyncExternalStore(
    subscribeStore,
    () => (key === null || typeof EventSource === "undefined" ? null : getClient().cadence(key)),
    () => null
  );
  return pollInterval(base, cadence);
}
