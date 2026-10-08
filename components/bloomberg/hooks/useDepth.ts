"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DEPTH_CHOICES,
  type DepthBook,
  SPLIT,
  buildLadder,
  clampSplit,
  isDepthSymbol,
} from "../lib/depth-book";
import { type Trade, mergeTape, tapeTotals } from "../lib/trade-tape";
import { type VolumeProfile, addPull, emptyProfile, profileRows } from "../lib/volume-by-price";

export type DepthErrorCode =
  | "keys"
  | "token_missing"
  | "token_pending"
  | "subscription"
  | "unsupported"
  | "empty"
  | "rate_limit"
  | "upstream";

export class DepthError extends Error {
  code: DepthErrorCode;
  status: number;
  constructor(message: string, code: DepthErrorCode, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface WebullStatus {
  configured: boolean;
  host: string;
  environment: "production" | "test" | "custom";
  token: {
    status: string;
    expires_at: number | null;
    /** Seconds until the token's own expiry date (a token lasts 15 days). */
    expires_in_s: number | null;
    checked_at: number | null;
  } | null;
  /** When the market-data entitlement ends, as written in backend/.env — the API does not say. */
  subscription: { ends: string; days_left: number | null; error: string | null } | null;
}

/** A book the request can no longer refresh is said to be old after this long. */
const STALE_MS = 20_000;

async function read<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body as T;
  const detail = body?.detail;
  throw new DepthError(
    detail?.message ?? (typeof detail === "string" ? detail : body?.error) ?? `HTTP ${res.status}`,
    detail?.code ?? "upstream",
    res.status
  );
}

/**
 * How long to wait before asking again, by what the last answer was. While the
 * stream is pushing the book, the request is only a check that nothing has been
 * refused since (a subscription lapsed, the token died) — the stream carries
 * books and nothing else.
 */
function cadence(error: DepthError | null, live: boolean): number | false {
  if (!error) return live ? 20_000 : 2_000;
  if (error.code === "token_pending") return 5_000; // the owner is typing the SMS code
  if (error.code === "keys" || error.code === "token_missing" || error.code === "unsupported")
    return false; // nothing changes until someone acts
  return 20_000; // the backend holds a refusal that long anyway
}

const NO_TRADES: Trade[] = [];
const NO_PROFILE = emptyProfile();
const PULL = 1000; // the most prints Webull hands over in one call
const SEED = 100; // of those, what the tape starts with

/** Shared compact/expanded state; nothing is requested until the DEPTH tab is open. */
export function useDepth(symbol: string | null, enabled: boolean) {
  const [depth, setDepth] = useState<(typeof DEPTH_CHOICES)[number]>(10);
  const [overnight, setOvernight] = useState(false);
  // How the row under the book is shared between the tape and the volume by
  // price. Here, not in the panel: the compact panel and the expanded one are
  // two components and must show the same split.
  const [split, setSplitState] = useState<number>(() => {
    if (typeof window === "undefined") return SPLIT.initial;
    try {
      const stored = localStorage.getItem(SPLIT.key);
      if (stored != null) return clampSplit(Number(stored));
    } catch {
      /* ignore */
    }
    return SPLIT.initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT.key, String(split));
    } catch {
      /* ignore */
    }
  }, [split]);
  const setSplit = useCallback((value: number) => setSplitState(clampSplit(value)), []);
  const [live, setLive] = useState(false);
  // Why the stream is not delivering, when it said why (the 2 s request then
  // carries the panel — which works, and is exactly how a fault goes unseen).
  const [streamError, setStreamError] = useState<string | null>(null);
  // Volume by price since the panel was opened on this symbol.
  const [volume, setVolume] = useState<{ symbol: string | null; profile: VolumeProfile }>({
    symbol: null,
    profile: NO_PROFILE,
  });
  // Time and sales, kept per symbol: a tape of INTC must not carry over to MU.
  const [tape, setTape] = useState<{ symbol: string | null; rows: Trade[] }>({
    symbol: null,
    rows: [],
  });
  const qc = useQueryClient();
  const supported = isDepthSymbol(symbol);

  const status = useQuery<WebullStatus, DepthError>({
    queryKey: ["webull", "status"],
    queryFn: ({ signal }) => fetch("/api/webull/status", { signal }).then((r) => read(r)),
    enabled,
    staleTime: 30_000,
    // The countdown to the token's end, and a token Webull ended on its side.
    refetchInterval: 10 * 60_000,
  });

  const book = useQuery<DepthBook, DepthError>({
    queryKey: ["webull", "depth", symbol, depth, overnight],
    queryFn: ({ signal }) =>
      fetch(
        `/api/webull/depth?symbol=${encodeURIComponent(symbol ?? "")}&depth=${depth}&overnight=${overnight}`,
        { signal }
      ).then((r) => read<DepthBook>(r)),
    enabled: enabled && supported && status.data?.configured === true,
    refetchInterval: (q) => cadence(q.state.error, live),
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 1_000,
  });

  // The live book. Opened only once a request has answered with a book — that
  // call is where "no keys", "no token" and "not subscribed" are explained — and
  // closed with the panel, a refusal, or a hidden tab; the backend hangs up on
  // Webull 20 s after the last listener is gone.
  const streamOn = enabled && supported && !!book.data && !book.error;
  useEffect(() => {
    if (!streamOn || !symbol) return;
    const key = ["webull", "depth", symbol, depth, overnight];
    let source: EventSource | null = null;
    const print = (incoming: Trade[]) =>
      setTape((held) => {
        const rows = mergeTape(held.symbol === symbol ? held.rows : [], incoming);
        return held.symbol === symbol && rows === held.rows ? held : { symbol, rows };
      });
    const open = () => {
      if (source || document.visibilityState === "hidden") return;
      source = new EventSource(
        `/api/webull/depth/stream?symbol=${encodeURIComponent(symbol)}&depth=${depth}&overnight=${overnight}`
      );
      source.onmessage = (e) => {
        try {
          const next = JSON.parse(e.data) as DepthBook;
          if (next.symbol === symbol && (next.bids.length || next.asks.length))
            qc.setQueryData(key, next);
        } catch {
          /* a broken frame: the next one replaces it */
        }
      };
      source.addEventListener("trades", (e) => {
        try {
          print(JSON.parse((e as MessageEvent).data) as Trade[]);
        } catch {
          /* skipped: the next print is its own frame */
        }
      });
      source.addEventListener("state", (e) => {
        try {
          const state = JSON.parse((e as MessageEvent).data);
          setLive(state.live === true);
          setStreamError(state.error?.message ?? null);
          // The token ended while streaming: ask at once, so the panel shows
          // "request a new one" now and not at the next 20 s check.
          if (state.error?.code === "token_missing")
            qc.invalidateQueries({ queryKey: ["webull", "depth"] });
        } catch {
          setLive(false);
        }
      });
      source.onerror = () => setLive(false); // EventSource reconnects by itself
    };
    const close = () => {
      source?.close();
      source = null;
      setLive(false);
      setStreamError(null);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? close() : open());
    open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [streamOn, symbol, depth, overnight, qc]);

  // The last prints, pulled again every 15 s. Two uses:
  //  · volume by price is built from these pulls ONLY. The stream leaves out
  //    most small prints (measured 2026-10-08: 28% of the prints, 86% of the
  //    volume) and times some of them differently, so mixing the two feeds
  //    would count a print twice or not at all. 1000 prints is 35–50 s of a
  //    busy stock; a pull that does not reach the previous one is a gap, shown.
  //  · the tape starts from the newest of them, so it is not empty until
  //    somebody trades — and lives on them while the stream is down.
  const recent = useQuery<{ symbol: string; trades: Trade[] }, DepthError>({
    queryKey: ["webull", "ticks", symbol],
    queryFn: ({ signal }) =>
      fetch(`/api/webull/ticks?symbol=${encodeURIComponent(symbol ?? "")}&count=${PULL}`, {
        signal,
      }).then((r) => read(r)),
    enabled: streamOn,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 2_000,
  });
  useEffect(() => {
    const got = recent.data;
    if (!got || got.symbol !== symbol) return;
    setVolume((held) => {
      const before = held.symbol === symbol ? held.profile : NO_PROFILE;
      const profile = addPull(before, got.trades, got.trades.length >= PULL);
      return held.symbol === symbol && profile === before ? held : { symbol, profile };
    });
    setTape((held) => {
      const mine = held.symbol === symbol ? held.rows : [];
      // While the stream prints, it owns the tape: a pull would show again, a
      // few seconds late, the prints the two feeds time differently.
      if (live && mine.length) return held;
      const rows = mergeTape(mine, got.trades.slice(0, SEED));
      return held.symbol === symbol && rows === held.rows ? held : { symbol, rows };
    });
  }, [recent.data, symbol, live]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["webull", "status"] });
    qc.invalidateQueries({ queryKey: ["webull", "depth"] });
  };
  const requestToken = useMutation<unknown, DepthError>({
    mutationFn: () => fetch("/api/webull/token", { method: "POST" }).then((r) => read(r)),
    onSettled: refresh,
  });
  const checkToken = useMutation<unknown, DepthError>({
    mutationFn: () => fetch("/api/webull/token/check", { method: "POST" }).then((r) => read(r)),
    onSettled: refresh,
  });

  const data = book.data?.symbol === symbol ? book.data : undefined;
  const ladder = useMemo(() => (data ? buildLadder(data, depth) : null), [data, depth]);
  const trades = tape.symbol === symbol ? tape.rows : NO_TRADES;
  const totals = useMemo(() => tapeTotals(trades), [trades]);
  const profile = volume.symbol === symbol ? volume.profile : NO_PROFILE;
  const profileLevels = useMemo(() => profileRows(profile, 22), [profile]);

  return {
    symbol,
    supported,
    status: status.data,
    statusLoading: status.isLoading,
    book: data,
    ladder,
    loading: book.isLoading,
    /** The book on screen is being pushed by Webull, not polled. */
    live: live && streamOn,
    /** Time and sales, newest first — and what they add up to. */
    trades,
    totals,
    /** Volume by price since this symbol was opened, top price first. */
    profile,
    profileLevels,
    // A refusal replaces the ladder; a blip between two good polls does not —
    // but a book that has not been refreshed for a while is not shown as current.
    error:
      book.error &&
      (!data || book.error.code !== "upstream" || Date.now() - book.dataUpdatedAt > STALE_MS)
        ? book.error
        : null,
    /** Why the live stream is not delivering (the request is carrying the panel). */
    streamError: streamOn && !live ? streamError : null,
    /** Why the tape and the volume by price are not filling. */
    tapeError: streamOn ? (recent.error?.message ?? null) : null,
    /** The market-data entitlement's end, when it was written down. */
    feed: status.data?.subscription ?? null,
    /** Seconds until the access token ends; null when unknown. */
    tokenLeftS:
      status.data?.token?.status === "NORMAL" ? (status.data.token.expires_in_s ?? null) : null,
    depth,
    setDepth,
    /** The tape's share (0–1) of the row it splits with the volume by price. */
    split,
    setSplit,
    overnight,
    setOvernight,
    requestToken,
    checkToken,
  };
}
