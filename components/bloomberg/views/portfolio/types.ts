// Pure types — no "use client" needed

export interface Account {
  id: string;
  name: string;
  broker: string;
  country: string;
  currency: string;
  account_type: string;
}

export interface Trade {
  id: string;
  account_id: string;
  symbol: string;
  sector: string;
  date_entry: string;
  date_exit?: string;
  price_entry: number;
  price_exit?: number;
  price_stoploss?: number;
  price_target?: number;
  volume: number;
  amount?: number;
  amount_base?: number;
  pnl_amount?: number;
  pnl_base?: number;
  win_loss: "W" | "L" | "P";
  pnl_percent?: number;
  currency: string;
  exchange_rate: number;
  exit_exchange_rate?: number;
  price_entry_base?: number;
  price_exit_base?: number;
  strategy_name?: string;
  entry_trigger?: string;
  exit_trigger?: string;
  market_trend?: string;
  note?: string;
  is_reinvest?: number;
  current_price?: number;
  unrealized_pnl?: number;
  unrealized_pct?: number;
  unrealized_pnl_thb?: number;
  unrealized_pnl_base?: number;
  cost_basis_base?: number;
  market_value_base?: number;
  acc_currency?: string;
  pos_currency?: string; // instrument's native ccy (per market), may differ from acc_currency
  acc_name?: string;
  prev_close?: number;
  day_pnl?: number;
  day_pnl_thb?: number;
  day_pnl_base?: number;
  day_pct?: number;
}

export interface CashEntry {
  id: string;
  account_id: string;
  date: string;
  income: number;
  investment: number;
  exchange_rate: number;
  note: string;
  entry_type?: string;
  linked_id?: string;
}

export interface Dividend {
  id: string;
  account_id: string;
  asset: string;
  ex_date: string;
  pay_date: string;
  amount_per_unit: number;
  amount_per_unit_base?: number;
  total_received: number;
  total_received_base?: number;
  reinvested_amount: number;
  reinvested_amount_base?: number;
  reinvest_asset: string;
  reinvest_price: number;
  reinvest_units: number;
  currency: string;
}

export interface AccountStat {
  account: Account;
  total_trades: number;
  open_count: number;
  wins: number;
  losses: number;
  win_rate: number;
  pnl_native: number;
  pnl_base: number;
  pnl_economic_native?: number;
  pnl_economic_base?: number;
  ytd_realized_native?: number;
  ytd_realized_base?: number;
  ytd_economic_realized_native?: number;
  ytd_economic_realized_base?: number;
  ytd_closed?: number;
  total_income: number;
  total_income_base?: number;
  total_invested: number;
  total_invested_base?: number;
  total_dividends: number;
  total_dividends_base?: number;
}

export interface Summary {
  accounts: AccountStat[];
  total_pnl_base: number;
  total_economic_pnl_base?: number;
  total_ytd_realized_base?: number;
  total_ytd_economic_realized_base?: number;
  ytd_year?: number;
  global_win_rate: number;
  base_currency: string;
  thb_per_usd: number;
}

// Legacy — used by backtest / theses
export interface Transaction {
  id: string;
  symbol: string;
  type: "buy" | "sell";
  shares: number;
  price: number;
  date: string;
  commission: number;
  notes: string;
  created_at: string;
}

export interface ChartPoint {
  date: string;
  portfolio_value: number;
  portfolio_return: number;
  benchmark_return: number;
  total_invested: number;
}

export interface BacktestMetrics {
  total_return: number;
  benchmark_total_return: number;
  cagr: number;
  sharpe_ratio: number;
  max_drawdown: number;
  volatility: number;
  beta: number;
  alpha: number;
  n_days: number;
  benchmark: string;
  total_pnl?: number;
  total_pnl_pct?: number;
  profit_factor?: number;
  win_rate?: number;
  avg_win?: number;
  avg_loss?: number;
  total_trades?: number;
  total_invested?: number;
  base_currency?: string;
}

export interface KO {
  id: string;
  title: string;
  content: string;
  probability: string;
  monitor: string;
}

export interface ThesisData {
  symbol: string;
  file: string;
  meta: { title: string; status: string; confidence: string; last_updated: string; tags: string[] };
  sections: Record<string, string>;
  condition_killers: KO[];
  raw_body: string;
}

// TradeEditModal internal state
export interface TradeEditState {
  symbol: string;
  sector: string;
  date_entry: string;
  price_entry: string;
  price_stoploss: string;
  price_target: string;
  volume: string;
  strategy_name: string;
  entry_trigger: string;
  market_trend: string;
  note: string;
  date_exit: string;
  price_exit: string;
  pnl_amount: string;
  win_loss: string;
  pnl_percent: string;
  exit_trigger: string;
}
