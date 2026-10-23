"use client";

import { useQuery } from "@tanstack/react-query";

import type { ToneArticle } from "../views/news/tone-summary";

/** One row of MKT → STRUCTURE → CHECK (backend prebuy_check.py). */
export interface PrebuyCheckItem {
  id: string;
  group: "TIMING" | "EVENTS" | "BOOK" | "THESIS";
  state: "CONFLICT" | "OPEN" | "PASS" | "PENDING";
  title: string;
  detail: string;
  /** Where the fact lives: ROT · chart · CAL · RISK · THESES · TRACK. */
  view: string | null;
  thesis_id?: string;
  date?: string;
  group_id?: string;
}

export interface PrebuyEvent {
  id: string;
  date: string;
  days_until: number;
  category: "MACRO" | "COMPANY" | "THESIS" | "PORT";
  kind: string;
  title: string;
  impact: string | null;
  estimated?: boolean;
  done?: boolean;
  detail?: string;
  source?: string;
  symbol?: string | null;
}

export interface PrebuyCheck {
  symbol: string;
  as_of: string;
  applicable: boolean;
  reason?: string;
  name?: string | null;
  sector?: string | null;
  /** A · B · C, or null while a fact is still loading and nothing conflicts yet. */
  tier: "A" | "B" | "C" | null;
  counts?: { conflict: number; open: number; pass: number; pending: number };
  size_multiplier?: number | null;
  tier_size?: number | null;
  guard?: { light: string; size_multiplier: number; why: string[] } | null;
  checks: PrebuyCheckItem[];
  events: PrebuyEvent[];
  pending: string[];
  errors?: Record<string, string>;
  rules: Record<string, unknown>;
}

/** Indices, FX, crypto, futures: nothing to check — same rule as the backend. */
export function checkApplies(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  const s = symbol.toUpperCase();
  return !(s.startsWith("^") || s.includes("=") || s.endsWith("-USD"));
}

/** The CHECK for the chart symbol — shared by the STRUCTURE panel and the chart
 *  chip (one React Query key, one request). Polls every 4 s while a fact is
 *  still loading (earnings asked of Yahoo behind the request). */
export function usePrebuyCheck(symbol: string | null | undefined, enabled = true) {
  const sym = symbol?.toUpperCase() ?? "";
  return useQuery<PrebuyCheck>({
    queryKey: ["prebuy-check", sym],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/prebuy-check/${encodeURIComponent(sym)}`, { signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? `CHECK failed (${res.status})`);
      return body as PrebuyCheck;
    },
    enabled: enabled && !!sym,
    staleTime: 60_000,
    refetchInterval: (q) => ((q.state.data?.pending?.length ?? 0) > 0 ? 4_000 : false),
    retry: 1,
  });
}

/** The symbol's headlines for the tone block — the NEWS → WATCHLIST endpoint. */
export function useSymbolNews(symbol: string | null | undefined, enabled = true) {
  const sym = symbol?.toUpperCase() ?? "";
  return useQuery<{ articles: ToneArticle[]; pending: number }>({
    queryKey: ["prebuy-news", sym],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({
        symbols: sym,
        per_symbol: "20",
        polymarket: "0",
        wait: "6",
      });
      const res = await fetch(`/api/news/watchlist?${qs}`, { signal });
      if (!res.ok) throw new Error(`news ${res.status}`);
      const body = await res.json();
      return { articles: body.articles ?? [], pending: body.pending ?? 0 };
    },
    enabled: enabled && !!sym,
    staleTime: 5 * 60_000,
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 6_000 : false),
    retry: 1,
  });
}
