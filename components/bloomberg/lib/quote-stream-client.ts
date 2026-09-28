/**
 * Quote-stream transport: ONE EventSource per page, symbol set changed by diff.
 *
 * A page holds several consumers at once — PORT's table, the MKT chart, a
 * floating chart window, stock-view's history queries — and a browser allows
 * six HTTP/1.1 connections per origin, so listeners register here and the
 * stream carries the union of their symbols; each tick batch is split back out
 * to whoever asked.
 *
 * The stream is a backend session (`sessionId`, one per page load). When the
 * union changes, `POST /api/stream/interest` sends the new set and the backend
 * subscribes/releases only the difference — the pipe stays open, symbols held
 * before keep ticking, new ones get the hub's last tick at once
 * (backend/stream_sessions.py). The stream is reopened only when there is
 * none, it closed, or the backend no longer knows the session (404: expired
 * while the tab was away, backend restarted). A reconnect within the backend's
 * grace period resumes the session as it was — `event: ready` says `resumed`,
 * and then the union is resent. Membership changes are coalesced.
 *
 * Also keeps what `useStreamPollInterval` needs: backend coverage
 * (`event: coverage`) and when each symbol last ticked.
 *
 * Pure: EventSource, fetch and the clock are injected (tests drive fakes);
 * `hooks/useQuoteStream.ts` holds the page's single instance.
 */

import { type Cadence, type StreamCoverage, streamCadence } from "./stream-cadence.ts";

export interface QuoteTick {
  price: number;
  change?: number | null;
  change_pct?: number | null;
  /** Exchange time of the trade, epoch ms (UTC). */
  ts?: number;
}

type TickHandler = (ticks: Record<string, QuoteTick>) => void;

/** The part of EventSource this client uses. */
export interface EventSourceLike {
  readonly readyState: number;
  close(): void;
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
}

export interface QuoteStreamDeps {
  EventSource: new (url: string) => EventSourceLike;
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => Promise<{ status: number }>;
  sessionId: string;
  now?: () => number;
  /** Coalescing window for membership changes. */
  debounceMs?: number;
  /** Retry after a failed (non-404) interest POST. */
  retryMs?: number;
  /** Re-check tick freshness this often while a stream is open. */
  freshnessMs?: number;
}

const OPEN = 1;
const CLOSED = 2;

export function createQuoteStreamClient(deps: QuoteStreamDeps) {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? 250;
  const retryMs = deps.retryMs ?? 3_000;
  const freshnessMs = deps.freshnessMs ?? 15_000;

  const listeners = new Set<{ symbols: Set<string>; cb: TickHandler }>();
  let es: EventSourceLike | null = null;
  /** Union the backend session is known to hold (by URL or confirmed interest). */
  let openKey = "";
  /** Backend attached the session (`event: ready`) — interest may be sent. */
  let ready = false;
  let interestInFlight = false;
  /** A (re)attach arrived while a POST was out: resend once it settles. */
  let forceAfterFlight = false;
  /** Bumped on every open/close: a POST that outlives its stream is ignored. */
  let streamGen = 0;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let freshnessTimer: ReturnType<typeof setInterval> | null = null;

  const lastTickAt = new Map<string, number>();
  let coverage: StreamCoverage | null = null;
  const storeSubs = new Set<() => void>();
  // Snapshot clock: advances only on emit, so a cadence read is stable between
  // store changes (useSyncExternalStore requirement).
  let clock = now();

  function emit() {
    clock = now();
    for (const f of storeSubs) f();
  }

  function setCoverage(next: StreamCoverage | null) {
    coverage = next;
    emit();
  }

  function unionKey(): string {
    const all = new Set<string>();
    for (const l of listeners) for (const s of l.symbols) all.add(s);
    return [...all].sort().join(",");
  }

  function closeStream() {
    streamGen++;
    es?.close();
    es = null;
    ready = false;
    openKey = "";
    setCoverage(null);
    if (freshnessTimer != null) {
      clearInterval(freshnessTimer);
      freshnessTimer = null;
    }
  }

  function openStream(key: string) {
    closeStream();
    openKey = key;
    const stream = new deps.EventSource(
      `/api/stream/quotes?session=${encodeURIComponent(deps.sessionId)}&symbols=${encodeURIComponent(key)}`
    );
    es = stream;
    freshnessTimer = setInterval(emit, freshnessMs);
    let firstAttach = true;
    stream.addEventListener("ready", (e) => {
      if (es !== stream) return;
      ready = true;
      let resumed = true; // unreadable: resend, it is one small POST
      try {
        resumed = (JSON.parse(e.data) as { resumed?: boolean }).resumed === true;
      } catch {
        /* keep true */
      }
      // Only a brand-new session built from this very URL already holds the
      // union; a resumed one kept whatever it held before.
      const skip = firstAttach && !resumed && unionKey() === key;
      firstAttach = false;
      if (!skip) void sendInterest(true);
    });
    stream.addEventListener("coverage", (e) => {
      if (es !== stream) return;
      try {
        const d = JSON.parse(e.data) as { connected?: boolean; denied?: string[] };
        setCoverage({ connected: d.connected === true, denied: new Set(d.denied ?? []) });
      } catch {
        /* malformed — keep the previous verdict */
      }
    });
    // Dropped: REST is all there is until the reconnect sends ready/coverage again.
    stream.addEventListener("error", () => {
      if (es !== stream) return;
      ready = false;
      setCoverage(null);
    });
    stream.addEventListener("message", (e) => {
      if (es !== stream) return;
      let ticks: Record<string, QuoteTick>;
      try {
        ticks = JSON.parse(e.data) as Record<string, QuoteTick>;
      } catch {
        return; // malformed frame — the next one is a second away
      }
      const t = now();
      for (const s of Object.keys(ticks)) lastTickAt.set(s, t);
      emit();
      for (const l of listeners) {
        let mine: Record<string, QuoteTick> | null = null;
        for (const s of l.symbols) {
          const tick = ticks[s];
          if (!tick) continue;
          mine ??= {};
          mine[s] = tick;
        }
        if (mine) l.cb(mine);
      }
    });
  }

  /** Tell the session its symbol set. One POST in flight; a change that lands
   * meanwhile is sent right after. */
  async function sendInterest(force = false): Promise<void> {
    if (interestInFlight) {
      forceAfterFlight ||= force;
      return;
    }
    if (!es || !ready) return;
    const key = unionKey();
    if (!key || (!force && key === openKey)) return;
    interestInFlight = true;
    const gen = streamGen;
    let status = 0;
    try {
      const r = await deps.fetch("/api/stream/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: deps.sessionId, symbols: key.split(",") }),
      });
      status = r.status;
    } catch {
      status = 0;
    } finally {
      interestInFlight = false;
    }
    if (gen !== streamGen) {
      // The stream was replaced meanwhile: this answer is about the old one. A
      // `ready` from the new one deferred during the POST is honoured now.
      if (forceAfterFlight) {
        forceAfterFlight = false;
        void sendInterest(true);
      }
      return;
    }
    if (status >= 200 && status < 300) {
      openKey = key;
    } else if (status === 404) {
      // Backend forgot the session (expired, restarted) — start it again.
      forceAfterFlight = false;
      const k = unionKey();
      if (k) openStream(k);
      else closeStream();
      return;
    } else if (retryTimer == null) {
      // Backend hiccup: a dropped stream resends on `ready`; this covers a
      // stream that stayed up while one POST failed.
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleSync();
      }, retryMs);
    }
    if (forceAfterFlight) {
      forceAfterFlight = false;
      void sendInterest(true);
    } else if (unionKey() !== openKey) scheduleSync();
  }

  function sync() {
    syncTimer = null;
    const key = unionKey();
    if (!key) {
      closeStream(); // the backend keeps the session for its grace period
      return;
    }
    if (!es || es.readyState === CLOSED) {
      openStream(key);
      return;
    }
    // Not attached yet (connecting / reconnecting): `ready` sends the union.
    if (key !== openKey && ready) void sendInterest();
  }

  function scheduleSync() {
    if (syncTimer == null) syncTimer = setTimeout(sync, debounceMs);
  }

  return {
    /** Watch `symbols`; returns the unsubscribe. */
    listen(symbols: Iterable<string>, cb: TickHandler): () => void {
      const l = { symbols: new Set(symbols), cb };
      listeners.add(l);
      scheduleSync();
      return () => {
        listeners.delete(l);
        scheduleSync();
      };
    },
    /** Subscribe to coverage / tick-freshness changes. */
    subscribe(cb: () => void): () => void {
      storeSubs.add(cb);
      return () => {
        storeSubs.delete(cb);
      };
    },
    /** Cadence for a canonical symbol key (`symbolKey`), as of the last change. */
    cadence(key: string): Cadence {
      return streamCadence(key, coverage, es?.readyState === OPEN, lastTickAt, clock);
    },
    /** Close the stream and stop every timer (tests, hot reload). */
    dispose(): void {
      listeners.clear();
      for (const t of [syncTimer, retryTimer]) if (t != null) clearTimeout(t);
      syncTimer = null;
      retryTimer = null;
      closeStream();
    },
    /** Test/inspection view of the transport state. */
    state() {
      return { openKey, ready, open: es != null, union: unionKey() };
    },
  };
}

export type QuoteStreamClient = ReturnType<typeof createQuoteStreamClient>;
