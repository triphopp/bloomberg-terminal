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
