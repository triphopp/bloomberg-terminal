"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// Same-origin Next proxy routes (app/api/**). Calling the Python backend
// directly from the browser hardcoded its port here and needed CORS for every
// page that used this hook; the proxy resolves the backend from PYTHON_API_URL
// on the server instead, so a port change is one env var.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompositeIndicator {
  value: number | null;
  score: number;
  weight: number;
}

export interface CrisisComposite {
  composite_score: number;
  traffic_light: "GREEN" | "YELLOW" | "RED";
  indicators: {
    cape: CompositeIndicator;
    vix: CompositeIndicator;
    hy_spread: CompositeIndicator;
    yield_10y2y: CompositeIndicator;
    ted_spread: CompositeIndicator;
  };
  as_of: string;
}

export interface StockQuality {
  symbol: string;
  accrual: {
    ratio: number | null;
    score: number;
    level: string;
  };
  beneish: {
    m_score: number | null;
    score: number;
    level: string;
    variables: Record<string, number | null>;
  };
  piotroski: {
    f_score: number;
    f_total: number;
    score: number;
    level: string;
    signals: Record<string, boolean | null>;
  };
  overall_quality_score: number;
  flag: "GREEN" | "YELLOW" | "ORANGE" | "RED";
  as_of: string;
}

export interface CircuitBreakerResult {
  symbol?: string;
  price?: number;
  prior_close?: number;
  pct_change?: number;
  tier?: number;
  halt_duration_min?: number | null;
  halt_label?: string;
  trigger_reason?: string;
  as_of: string;
}

export interface MarketHaltResult {
  index_value?: number;
  prior_close?: number;
  drop_pct?: number;
  level?: string;
  halt_duration_min?: number | null;
  halt_label?: string;
  trigger_reason?: string;
  level3_blocked?: boolean;
  as_of: string;
}

export interface MarginResult {
  cape: number | null;
  vix: number | null;
  base_margin_pct: number;
  required_margin_pct: number;
  multiplier: number;
  addon_pct: number;
  cape_regime: string;
  vix_regime: string;
  level: string;
  pct_above_base: number;
  rationale: string;
  as_of: string;
}

export interface ListingGateResult {
  company_id: string;
  company_name: string;
  decision: "APPROVE" | "CONDITIONAL" | "REJECT";
  score: number;
  score_breakdown: Record<string, number>;
  hard_filter_results: Record<string, boolean>;
  hard_filter_fails: string[];
  recommendations: string[];
  as_of: string;
}

export interface ListingGateInput {
  company_id: string;
  company_name: string;
  years_profitable: [boolean, boolean, boolean];
  operating_cashflow: [number, number, number];
  free_float_pct: number;
  market_cap_usd: number;
  independent_directors_ratio: number;
  has_audit_committee: boolean;
  has_internal_controls: boolean;
  auditor_registered: boolean;
  going_concern_count: number;
  related_party_revenue_pct: number;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useCrisisComposite() {
  return useQuery<CrisisComposite>({
    queryKey: ["crisis-composite"],
    queryFn: async () => {
      const res = await fetch("/api/crisis/composite");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}

export function useStockQuality(symbol: string | null) {
  return useQuery<StockQuality>({
    queryKey: ["stock-quality", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/stock/quality/${symbol}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!symbol,
    staleTime: 60 * 60 * 1000,
  });
}

export function useMarginRequirement() {
  return useQuery<MarginResult>({
    queryKey: ["circuit-margin"],
    queryFn: async () => {
      const res = await fetch("/api/circuit-breaker/margin");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useListingGateScreen() {
  const qc = useQueryClient();
  return useMutation<ListingGateResult, Error, ListingGateInput>({
    mutationFn: async (body) => {
      const res = await fetch("/api/listing-gate/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

export function useCircuitBreakerCheck() {
  return useMutation<
    CircuitBreakerResult,
    Error,
    { symbol: string; price: number; priorClose: number }
  >({
    mutationFn: async ({ symbol, price, priorClose }) => {
      const url = `/api/circuit-breaker/check?symbol=${encodeURIComponent(symbol)}&price=${price}&prior_close=${priorClose}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

export function useCircuitBreakerMarket() {
  return useMutation<
    MarketHaltResult,
    Error,
    { indexValue: number; priorClose: number; time?: string }
  >({
    mutationFn: async ({ indexValue, priorClose, time }) => {
      let url = `/api/circuit-breaker/market?index_value=${indexValue}&prior_close=${priorClose}`;
      if (time) url += `&time=${encodeURIComponent(time)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}
