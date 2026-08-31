import type { bloombergColors } from "../../../lib/theme-config";

export type Colors = typeof bloombergColors.dark;

export interface Sourced {
  value: number | null;
  tag?: string;
  end?: string;
  filed?: string;
}

export interface Exposure {
  symbol: string;
  cik: string | null;
  debt: {
    total: number | null;
    current: number | null;
    long_term: number | null;
    capital_leases: number | null;
    cash: number | null;
    net_debt: number | null;
    source: string;
  };
  income: {
    interest_expense: number | null;
    ebit: number | null;
    icr: number | null;
    tax_rate: number | null;
    source: string;
  };
  ladder: Record<string, Sourced | null>;
  ladder_total: number | null;
  /** Share of total debt the filed maturity buckets account for — data quality,
   *  not the interest-coverage ratio that also appears on this screen. */
  ladder_completeness: number | null;
  ladder_as_of: string | null;
  ladder_stale: boolean;
  ladder_usable: boolean;
  wall_12m: number | null;
  wall_3y: number | null;
  cost: {
    r_eff: number | null;
    market_refi_rate: number | null;
    refi_gap: number | null;
    refi_gap_bp: number | null;
    wall_12m_repricing_cost: number | null;
  };
  floating_share: { value: number | null; source: string; note: string };
  confidence: {
    level: "high" | "medium" | "low";
    bounded_assessment_available: boolean;
    refi_term_available: boolean;
    missing: string[];
    always_missing: string[];
  };
}

export interface ScenarioMeta {
  id: string;
  label: string;
  /** Column group: a single meeting, a full cycle, a shape change, or a replay. */
  band: "meeting" | "cycle" | "shape" | "history";
  driver: string | null;
  headline_bp: number;
  hypothetical: boolean;
  price_channel_extrapolable: boolean;
  beyond_historical_record: boolean;
}

export interface PriceImpact {
  exact: number | null;
  linear: number | null;
  convexity: number | null;
  status?: string;
  note?: string;
}

export interface EmpiricalImpact {
  status: string;
  value: number | null;
  ci95?: [number, number];
  t?: number | null;
  r2_rate_only?: number | null;
  note?: string;
  limit_bp?: number;
}

export interface ScenarioRow {
  scenario: ScenarioMeta;
  delta_interest: {
    lo: number;
    hi: number;
    lo_breakdown: Record<string, number>;
    hi_breakdown: Record<string, number>;
    note: string;
  };
  vs_ebit: { lo: number | null; hi: number | null };
  after_tax: { lo: number; hi: number };
  icr: {
    base: number | null;
    lo: number | null;
    hi: number | null;
    covenant_level: number;
    already_below_covenant: boolean;
  };
  price: { model: PriceImpact; empirical: EmpiricalImpact };
}

export interface ValuationProfile {
  market_cap: number | null;
  risk_free: number | null;
  beta: number | null;
  k_e: number | null;
  shareholder_yield: {
    total: number | null;
    dividend: number | null;
    buyback: number | null;
    source?: string;
  };
  spread: number | null;
  g_implied: number | null;
  duration: number | null;
  theta: number | null;
  theta_source: string;
  method: string;
  /** Whether this name's measured beta could supply theta, and why not if it could not. */
  theta_fit?: {
    theta: number | null;
    status: "ok" | "unavailable" | "mechanism_conflict";
    rejected_theta?: number;
    note?: string;
  };
}

export interface RateBeta {
  status: string;
  n?: number;
  market_beta?: number;
  kappa_10y_pct_per_100bp?: number;
  kappa_10y_se?: number;
  kappa_10y_t?: number | null;
  kappa_10y_ci95?: [number, number];
  r2_full?: number | null;
  r2_rate_only?: number | null;
  significant?: boolean;
  window?: string;
  caveat?: string;
}

export interface BreakingPoint {
  status: string;
  bp: number | null;
  target_icr?: number;
  worst_case?: boolean;
  note?: string;
}

export interface StressResponse {
  symbol: string;
  sector: string | null;
  exposure: Exposure;
  valuation: ValuationProfile;
  rate_beta: RateBeta;
  scenarios: ScenarioRow[];
  breaking_point: { covenant_2x: BreakingPoint; breach_1x: BreakingPoint };
  channel_gap: {
    worst_after_tax_interest_over_mcap: number | null;
    price_impact_100bp: number | null;
  };
  /** FastAPI error body, present when the symbol is not a US listing. */
  detail?: string;
  /** Proxy error body, present when the backend never answered. */
  error?: string;
}

// ── Formatters ───────────────────────────────────────────────────────────────

export const fmtB = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${(v / 1e9).toFixed(dp)}B`;

export const fmtM = (v: number | null | undefined, dp = 0) =>
  v == null ? "—" : `${(v / 1e6).toFixed(dp)}M`;

export const fmtPct = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(dp)}%`;

export const fmtSignedPct = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;

export const fmtBp = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}bp`;

export const fmtX = (v: number | null | undefined, dp = 2) =>
  v == null ? "—" : `${v.toFixed(dp)}x`;
