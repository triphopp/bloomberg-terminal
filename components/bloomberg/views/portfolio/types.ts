// Pure types — no "use client" needed

export interface Account {
  id: string; name: string; broker: string;
  country: string; currency: string; account_type: string;
}

export interface Trade {
  id: string; account_id: string; symbol: string; sector: string;
  date_entry: string; date_exit?: string;
  price_entry: number; price_exit?: number;
  price_stoploss?: number; price_target?: number;
  volume: number; amount?: number; pnl_amount?: number;
  win_loss: "W" | "L" | "P"; pnl_percent?: number;
  currency: string; exchange_rate: number;
  strategy_name?: string; entry_trigger?: string; exit_trigger?: string;
  market_trend?: string; note?: string;
  current_price?: number; unrealized_pnl?: number; unrealized_pct?: number;
  unrealized_pnl_thb?: number; acc_currency?: string; acc_name?: string;
}

export interface CashEntry {
  id: string; account_id: string; date: string;
  income: number; investment: number; exchange_rate: number; note: string;
}

export interface Dividend {
  id: string; account_id: string; asset: string;
  ex_date: string; pay_date: string;
  amount_per_unit: number; total_received: number;
  reinvested_amount: number; reinvest_asset: string;
  reinvest_price: number; reinvest_units: number;
}

export interface AccountStat {
  account: Account; total_trades: number; open_count: number;
  wins: number; losses: number; win_rate: number;
  pnl_native: number; pnl_base: number;
  total_income: number; total_invested: number; total_dividends: number;
}

export interface Summary {
  accounts: AccountStat[]; total_pnl_base: number;
  global_win_rate: number; base_currency: string; thb_per_usd: number;
}

// Legacy — used by backtest / theses
export interface Transaction {
  id: string; symbol: string; type: "buy" | "sell";
  shares: number; price: number; date: string; commission: number; notes: string; created_at: string;
}

export interface ChartPoint {
  date: string; portfolio_value: number; portfolio_return: number;
  benchmark_return: number; total_invested: number;
}

export interface BacktestMetrics {
  total_return: number; benchmark_total_return: number; cagr: number;
  sharpe_ratio: number; max_drawdown: number; volatility: number;
  beta: number; alpha: number; n_days: number; benchmark: string;
  total_pnl?: number; total_pnl_pct?: number; profit_factor?: number;
  win_rate?: number; avg_win?: number; avg_loss?: number;
  total_trades?: number; total_invested?: number; base_currency?: string;
}

export interface KO { id: string; title: string; content: string; probability: string; monitor: string }

export interface ThesisData {
  symbol: string; file: string;
  meta: { title: string; status: string; confidence: string; last_updated: string; tags: string[] };
  sections: Record<string, string>; condition_killers: KO[]; raw_body: string;
}

// TradeEditModal internal state
export interface TradeEditState {
  symbol: string; sector: string; date_entry: string; price_entry: string;
  price_stoploss: string; price_target: string; volume: string;
  strategy_name: string; entry_trigger: string; market_trend: string; note: string;
  date_exit: string; price_exit: string; pnl_amount: string; win_loss: string;
  pnl_percent: string; exit_trigger: string;
}
