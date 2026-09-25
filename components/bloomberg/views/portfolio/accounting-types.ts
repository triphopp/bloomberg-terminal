export interface AccountingFinding {
  code: string;
  severity: "error" | "warn" | "info";
  account_id: string | null;
  symbol: string | null;
  message: string;
  evidence: Record<string, unknown>;
}

export interface AccountingReport {
  as_of: string;
  source: "reconstructed";
  counts: Record<"error" | "warn" | "info", number>;
  checks: { code: string; status: string; evaluated: number; reason?: string }[];
  findings: AccountingFinding[];
  events: number;
  posted_events: number;
  read_switch_gates: {
    id: string;
    status: "blocked" | "pending" | "met";
    reason: string;
    missing_account_ids?: string[];
    reconstructed_events?: number;
    posted_events?: number;
  }[];
  ready_for_read_switch: boolean;
  read_switch_reason: string;
}

export interface StockCard {
  account_id: string;
  symbol: string;
  currency: string;
  method: "AVCO" | "FIFO";
  source: "reconstructed";
  cost_in: number;
  cost_out: number;
  remaining_cost: number;
  remaining_qty: number;
  realized: number;
  findings: { code: string; message: string; severity: string }[];
  rows: {
    event: {
      id: string;
      type: string;
      trade_date: string;
      qty: number;
      price: number;
      fee: number;
      vat: number;
      tax: number;
      confidence: string;
    };
    qty_in: number;
    qty_out: number;
    cost_in: number;
    cost_out: number;
    realized: number | null;
    bal_qty: number;
    bal_cost: number;
    avg: number | null;
    allocations: { buy_event_id: string; qty: number; cost: number }[];
  }[];
}

export type EvidenceStatus =
  | "MATCHED"
  | "CONSOLIDATED"
  | "NETTED"
  | "MISSING_IN_DB"
  | "NO_EVIDENCE"
  | "OUT_OF_COVERAGE";

export interface EvidenceRow {
  status: EvidenceStatus;
  account_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  fill_ids: string[];
  event_ids: string[];
  source_refs: string[];
  images: string[];
  us_date: string | null;
  local_time: string | null;
  fill_qty: number | null;
  fill_price: number | null;
  book_date: string | null;
  book_qty: number | null;
  book_price: number | null;
  broker_cash: number | null;
  book_cash: number | null;
  fee_gap: number | null;
  sold_qty?: number;
  missing_realized?: number;
}

export interface EvidenceSymbol {
  account_id: string;
  symbol: string;
  currency: string;
  coverage_from: string;
  coverage_to: string;
  fills: number;
  counts: Partial<Record<EvidenceStatus, number>>;
  broker_cash: number;
  book_cash: number;
  cash_gap: number;
  fee_gap: number;
  cash_gap_ex_fees: number;
  broker_net_qty: number;
  book_net_qty: number;
  qty_match: boolean;
  missing_realized: number;
  verified: boolean;
}

export interface EvidenceReport {
  as_of: string;
  source: string;
  display_timezone_assumed: string;
  fills: number;
  counts: Partial<Record<EvidenceStatus, number>>;
  totals: Record<
    string,
    { cash_gap: number; fee_gap: number; cash_gap_ex_fees: number; missing_realized: number }
  >;
  symbols: EvidenceSymbol[];
  rows: EvidenceRow[];
  note: string;
}
