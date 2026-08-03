// Define proper types for market data
export type MarketItem = {
  id: string;
  /** yfinance ticker for this row, e.g. "^GSPTSE" — absent on the static fallback dataset */
  symbol?: string;
  /** Exchange-local date the quote last traded, "YYYY-MM-DD" */
  quoteDate?: string | null;
  /** False when that date is not the exchange's today — change/pctChange are a past session's */
  isCurrentSession?: boolean | null;
  marketState?: string | null;
  num?: string;
  rmi?: string;
  value: number;
  change: number;
  pctChange: number;
  avat: number;
  time: string;
  ytd: number;
  ytdCur: number;
  size?: number;
  sparkline1?: number[];
  sparkline2?: number[];
  sparklineUpdated?: string;
  lastUpdated?: string;
  // Additional properties for filters
  historicalData10D?: number[];
  volatility?: number;
  isMover?: boolean;
};

export type MarketData = {
  americas: MarketItem[];
  emea: MarketItem[];
  asiaPacific: MarketItem[];
  lastUpdated?: string;
  lastSparklineUpdate?: string;
  isFromRedis?: boolean;
  dataSource?: string;
  [key: string]: MarketItem[] | string | boolean | undefined; // Type-safe index signature for dynamic access
};

export interface FilterState {
  showMovers: boolean;
  showVolatility: boolean;
  showRatios: boolean;
  showFutures: boolean;
  showAvat: boolean;
  show10D: boolean;
  showYTD: boolean;
  showCAD: boolean;
}
