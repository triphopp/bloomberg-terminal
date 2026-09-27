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

// ── /api/bonds/decomposition — 10Y = expected real + breakeven + term premium ──

export type DecompPiece = "REAL" | "BE" | "TP";

export interface DecompAttribution {
  days: number;
  since?: string;
  dNominal_bp?: number | null;
  dReal_bp?: number | null;
  dBE_bp?: number | null;
  /** % of the market-lens move from TIPS real; null when real and BE offset */
  realShare?: number | null;
  dExpected_bp?: number | null;
  dTP_bp?: number | null;
  modelSince?: string;
  dExpReal_bp?: number | null;
  dModel_bp?: number | null;
  driver?: DecompPiece | null;
}

export interface DecompWire {
  id: "TP_HIGH" | "BE_RANGE" | "NOM_ALARM";
  label: string;
  piece: DecompPiece | "ALL";
  value: number | null;
  level: number | null;
  levelNote: string;
  warn?: number | null;
  status: "OK" | "WATCH" | "BREACH" | "NA";
  gap_bp: number | null;
  tpRoom_bp?: number | null;
}

export interface DecompLongRun {
  years: number;
  since: string;
  avg: number;
  min: number;
  minDate: string;
  max: number;
  maxDate: string;
  pctile: number;
}

export interface DecompContext {
  y20: DecompLongRun | null;
  y10: DecompLongRun | null;
  ago5: { date: string; value: number } | null;
  ago10: { date: string; value: number } | null;
  ago20: { date: string; value: number } | null;
}

export interface DecompHistoryRow {
  date: string;
  nominal: number | null;
  real: number | null;
  expReal: number | null;
  breakeven: number | null;
  termPremium: number | null;
  expected: number | null;
}

export interface BondDecomposition {
  ok: boolean;
  detail?: string;
  model: "ACM" | "KW";
  modelNote: string;
  snapshot: {
    market?: {
      asOf: string;
      nominal: number;
      real: number;
      breakeven: number;
      residual_bp: number;
    };
    model?: {
      asOf: string;
      fitted: number;
      expected: number;
      termPremium: number;
      residual_bp: number;
    };
    pieces?: {
      asOf: string;
      expReal: number;
      breakeven: number;
      termPremium: number;
      total: number;
      share: { expReal: number | null; breakeven: number | null; termPremium: number | null };
    };
    doubleCount?: { stacked: number; nominal: number; overshoot_bp: number };
  };
  attribution: DecompAttribution[];
  driver: {
    window: number;
    key: DecompPiece | null;
    label: string;
    case: string;
    read: string;
    severity: 0 | 1 | 2 | 3;
  };
  tripwires: { wires: DecompWire[]; flip: boolean; flipNote: string | null };
  context: Record<"nominal" | "real" | "breakeven" | "termPremium", DecompContext>;
  history: DecompHistoryRow[];
  errors: string[];
  source: string;
}
