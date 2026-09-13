export type DcfModel =
  | "auto"
  | "fcff"
  | "growth"
  | "fcfe"
  | "excess_return"
  | "affo"
  | "normalized_cycle";

export type DcfScenario = "bear" | "base" | "bull";

export interface DcfForecastRow {
  year: number;
  stage: string;
  revenue?: number;
  growth?: number;
  ebit_margin?: number;
  nopat?: number;
  reinvestment?: number;
  roe?: number;
  book_equity?: number;
  earnings?: number;
  cash_flow: number;
  discount_rate: number;
  present_value: number;
}

export interface DcfLineageRow {
  key: string;
  value: number | null;
  source: string;
  tag?: string | null;
  period?: string | null;
  status: "STATEMENT" | "MARKET" | "DERIVED" | "MISSING" | string;
}

export interface DcfResponse {
  status: "ok" | "error";
  detail?: string;
  symbol: string;
  currency: string | null;
  as_of: string | null;
  scenario: DcfScenario;
  model: Exclude<DcfModel, "auto">;
  model_label: string;
  model_router: {
    model: Exclude<DcfModel, "auto">;
    label: string;
    reason: string;
    overrideable: boolean;
    alternatives: string[];
  };
  summary: {
    market_price: number | null;
    enterprise_value: number | null;
    equity_value: number | null;
    intrinsic_value_per_share: number | null;
    upside_downside: number | null;
    pv_explicit: number;
    pv_terminal: number;
    terminal_value_share: number | null;
  };
  bridge: {
    cash: number;
    debt: number;
    minority_interest: number;
    preferred_stock: number;
    shares: number;
  };
  assumptions: Record<string, number | boolean | null>;
  forecast: DcfForecastRow[];
  terminal: {
    cash_flow: number;
    undiscounted_value: number;
    method: string;
  };
  sensitivity: {
    discount_rate_key: "wacc" | "cost_of_equity";
    discount_rates: number[];
    terminal_growth_rates: number[];
    values_per_share: Array<Array<number | null>>;
  };
  data_quality: {
    completeness: number | null;
    warnings: string[];
    lineage: DcfLineageRow[];
  };
}
