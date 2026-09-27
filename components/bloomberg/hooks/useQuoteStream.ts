"use client";

import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { isRealTimeEnabledAtom } from "../atoms";

export interface QuoteTick {
  price: number;
  change?: number | null;
  change_pct?: number | null;
  /** Exchange time of the trade, epoch ms (UTC). */
  ts?: number;
}

type Listener = { symbols: Set<string>; cb: (ticks: Record<string, QuoteTick>) => void };

/**
 * ONE EventSource for the whole page, shared by every `useQuoteStream`.
 *
 * A page can hold several consumers at once — PORT's table, the MKT chart, a
 * floating chart window, stock-view's four history queries — and a browser
 * allows six HTTP/1.1 connections per origin. One stream each would starve the
 * ordinary fetches of connections. So listeners register here, the stream is
 * opened for the union of their symbols, and each tick batch is split back out
 * to whoever asked for those symbols.
 *
 * Membership changes are coalesced (one reopen per 250ms) so a view mounting
 * ten consumers in one render reopens the stream once, not ten times.
 */
const listeners = new Set<Listener>();
let es: EventSource | null = null;
let openKey = "";
let reopenTimer: ReturnType<typeof setTimeout> | null = null;

function unionKey(): string {
  const all = new Set<string>();
  for (const l of listeners) for (const s of l.symbols) all.add(s);
  return [...all].sort().join(",");
}

function sync() {
  reopenTimer = null;
  const key = unionKey();
  if (key === openKey) return;
  es?.close();
  es = null;
  openKey = key;
  if (!key) return;
  es = new EventSource(`/api/stream/quotes?symbols=${encodeURIComponent(key)}`);
  es.onmessage = (e) => {
    let ticks: Record<string, QuoteTick>;
    try {
      ticks = JSON.parse(e.data) as Record<string, QuoteTick>;
    } catch {
      return; // malformed frame — the next one is a second away
    }
    for (const l of listeners) {
      let mine: Record<string, QuoteTick> | null = null;
      for (const s of l.symbols) {
        const t = ticks[s];
        if (!t) continue;
        mine ??= {};
        mine[s] = t;
      }
      if (mine) l.cb(mine);
    }
  };
}

function scheduleSync() {
  if (reopenTimer == null) reopenTimer = setTimeout(sync, 250);
}

/**
 * Live quotes pushed from the backend's Yahoo stream (`/api/stream/quotes`).
 * `onTicks` gets at most one batch a second, holding only its own symbols that
 * traded since the last batch.
 *
 * This is the push side of the seam `useLiveQuery` describes: callers write
 * ticks into their React Query cache, and the REST poll keeps running
 * underneath as the source of truth. Stream down = the poll is all there is;
 * nothing on screen depends on the stream being up.
 *
 * Runs only while real-time is ON (same switch as the polling cadence) and the
 * tab is visible. EventSource reconnects on its own after a drop.
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
    const listener: Listener = {
      symbols: new Set(key.split(",")),
      cb: (t) => handler.current(t),
    };
    listeners.add(listener);
    scheduleSync();
    return () => {
      listeners.delete(listener);
      scheduleSync();
    };
  }, [key, active, isRealTime, visible]);
}
