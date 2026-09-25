/** Shapes of `/api/bonds/*` — see memory/reference/data-shapes.md (BOND). */

export interface BondKpi {
  id: string;
  label: string;
  fred_id: string | null;
  group: "treasury" | "credit" | "derived";
  unit?: string;
  value: number | null;
  asOf: string | null;
  chg1d_bp?: number | null;
  chg5d_bp?: number | null;
  chg20d_bp?: number | null;
  pctile_1y?: number | null;
}

/** One day; every key except `date` is a yield/spread in % or null. */
export type BondHistoryRow = { date: string } & Record<string, number | null | string>;

export interface BondOverview {
  ok: boolean;
  detail?: string;
  asOf: string | null;
  kpis: BondKpi[];
  history: BondHistoryRow[];
  errors: string[];
  source: string;
}

export interface Auction {
  auction_date: string;
  issue_date: string | null;
  type: string;
  term: string | null;
  reopening: boolean;
  offering_bn: number | null;
  accepted_bn: number | null;
  high_yield: number | null;
  bid_to_cover: number | null;
  dealer_pct: number | null;
  indirect_pct: number | null;
  upcoming: boolean;
}

export interface SlowPoint {
  date: string;
  value: number;
  chg_pct: number | null;
  yoy_pct: number | null;
}

export interface SlowSeries {
  id: string;
  fred_id: string;
  label: string;
  unit: string;
  freq: "q" | "m";
  points: SlowPoint[];
}

export interface BondSupply {
  ok: boolean;
  auctions: { upcoming: Auction[]; recent: Auction[] };
  weekly: { week: string; bills_bn: number; coupons_bn: number }[];
  slow: SlowSeries[];
  errors: string[];
  source: string;
}

export interface IssuanceDay {
  date: string;
  CORP: number;
  FIN: number;
  ABS: number;
  SOV: number;
  BANK: number;
  ex_bank: number;
}

export interface IssuanceWeek {
  week: string;
  CORP: number;
  FIN: number;
  ABS: number;
  days: number;
  UST10Y: number | null;
  IG_OAS: number | null;
}

export interface Deal {
  adsh: string;
  file_date: string;
  form: string;
  issuer: string;
  cik: string;
  sic: string;
  category: "CORP" | "FIN";
  /** prospectuses filed for this deal that day — one per tranche */
  filings: number;
  url: string | null;
}

export interface EventRow {
  series: "UST10Y" | "IG_OAS";
  h: number;
  event_mean_bp: number | null;
  other_mean_bp: number | null;
  diff_bp: number | null;
  t: number | null;
  n_event: number;
  n_other: number;
}

export interface EventStudy {
  ready: boolean;
  n_days: number;
  threshold?: number;
  n_event?: number;
  n_other?: number;
  rows?: EventRow[];
  weekly_corr?: Record<"UST10Y" | "IG_OAS", { r: number | null; n: number }>;
  note: string;
}

export interface BondIssuance {
  ok: boolean;
  daily: IssuanceDay[];
  weekly: IssuanceWeek[];
  recent: Deal[];
  event_study: EventStudy;
  backfill: {
    days_total: number;
    days_stored: number;
    pending: number;
    running: boolean;
    last_error: string | null;
  };
  method: { query: string; forms: string[]; unit: string; caveat: string; excluded: string };
  source: string;
}
