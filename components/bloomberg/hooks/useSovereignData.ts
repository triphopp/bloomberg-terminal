"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QUERY_RETRY_ONCE } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WbSeriesPoint = { value: number; year: string };

export type WbValue = { value: number; year: string; series?: WbSeriesPoint[] } | null;

export type CountryIndicators = Record<string, WbValue>;

export type ScoreDetail = Record<string, { delta: number; value: number }>;

export type CountryDetail = {
  code:         string;
  name:         string;
  indicators:   CountryIndicators;
  score_detail: ScoreDetail;
  risk_score:   number;
  risk_label:   "LOW" | "MEDIUM" | "HIGH";
};

export type CountrySummary = {
  code:        string;
  name:        string;
  risk_score:  number | null;
  risk_label:  string | null;
  has_data:    boolean;
  indicators:  CountryIndicators | null;
};

export type SovereignList = {
  countries: CountrySummary[];
  total:     number;
};

export type SovereignCompareEntry = {
  code:   string;
  name:   string;
  value:  number | null;
  year:   string;
  series: WbSeriesPoint[];
};

export type SovereignCompareResult = {
  indicator: string;
  label:     string;
  unit:      string;
  data:      SovereignCompareEntry[];
};

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchList(q: string): Promise<SovereignList> {
  const url = `/api/sovereign/list${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchDetail(code: string): Promise<CountryDetail> {
  const res = await fetch(`/api/sovereign/${code.toUpperCase()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCompare(indicator: string, codes: string): Promise<SovereignCompareResult> {
  const params = new URLSearchParams({ indicator, codes });
  const res = await fetch(`/api/sovereign/compare?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useSovereignList(q: string) {
  return useQuery<SovereignList>({
    queryKey: ["sovereign-list", q],
    queryFn:  () => fetchList(q),
    staleTime: 5 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useSovereignDetail(code: string | null) {
  return useQuery<CountryDetail>({
    queryKey: ["sovereign", code],
    queryFn:  () => fetchDetail(code!),
    enabled:  !!code,
    staleTime: 60 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useSovereignCompare(indicator: string, codes: string) {
  return useQuery<SovereignCompareResult>({
    queryKey: ["sovereign-compare", indicator, codes],
    queryFn:  () => fetchCompare(indicator, codes),
    staleTime: 60 * 60_000,
    retry: QUERY_RETRY_ONCE,
  });
}

export function useSovereignRefresh() {
  const qc = useQueryClient();
  return async () => {
    await fetch("/api/sovereign/cache", { method: "DELETE" }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["sovereign"] });
    qc.invalidateQueries({ queryKey: ["sovereign-list"] });
    qc.invalidateQueries({ queryKey: ["sovereign-compare"] });
  };
}
