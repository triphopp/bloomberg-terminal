import { atomWithStorage } from "jotai/utils";
import type { CashEntry, Dividend } from "./types";

// ── Column definitions ──────────────────────────────────────────────────────

export const ALL_COLS = [
  "SYMBOL",
  "SECTOR",
  "ENTRY",
  "CURRENT",
  "VOL",
  "COST",
  "DAY P&L",
  "UNREAL",
  "% RTN",
  "TARGET",
  "S/L",
  "DYN SL",
  "SL DIST%",
  "STRATEGY",
] as const;
export type ColName = (typeof ALL_COLS)[number];
export const DEFAULT_COLS: ColName[] = [
  "SYMBOL",
  "SECTOR",
  "ENTRY",
  "CURRENT",
  "VOL",
  "COST",
  "DAY P&L",
  "UNREAL",
  "% RTN",
];
export const DENSE_COLS: ColName[] = ["SYMBOL", "ENTRY", "CURRENT", "UNREAL", "% RTN"];

// ── Persisted column selection atom ─────────────────────────────────────────
export const portfolioColsAtom = atomWithStorage<ColName[]>(
  "bloomberg_portfolio_cols",
  DEFAULT_COLS
);

// ── Group colors (for OpenPositionsTab) ─────────────────────────────────────

export const GROUP_COLORS: Record<string, string> = {
  Finansia: "#3b82f6",
  Dime: "#a855f7",
  InnovestX: "#ef4444",
};

// Distinct accent per Finansia sub-port badge
export const SUBPORT_COLORS: Record<string, string> = {
  "0153717": "#3b82f6",
  "6065157": "#f59e0b",
  "6065151": "#22c55e",
};

// ── Sector lists ─────────────────────────────────────────────────────────────

export const TH_SECTORS = [
  // Agriculture & Food
  "AGRI",
  "FOOD",
  // Consumer Products
  "FASHION",
  "HOME",
  "PERSON",
  "MEDIA",
  "COMM",
  "HELTH",
  "TOURISM",
  // Financials
  "BANK",
  "FIN",
  "INSUR",
  // Industrials
  "AUTO",
  "ENERG",
  "PETRO",
  "MINE",
  "PACK",
  "PAPER",
  "STEEL",
  "HARDW",
  // Property & Construction
  "CONS",
  "CONMAT",
  "PFUND",
  "PROP",
  // Technology
  "ICT",
  "ETRON",
  // Transport & Services
  "TRANS",
  "PROF",
  // Instruments
  "ETF",
  "DW",
  "WARRANT",
  "BOND",
  // Other
  "CRYPTO",
  "Other",
];

export const US_SECTORS = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Information Technology",
  "Materials",
  "Real Estate",
  "Utilities",
  "ETF",
  "Fixed Income",
  "Crypto",
  "Other",
];

export const SECTORS_BY_ACCOUNT: Record<string, string[]> = {
  finansia: TH_SECTORS,
  dime: US_SECTORS,
  innovestx: ["CRYPTO", "ETF", "Other"],
};

export const SECTORS_BY_CURRENCY: Record<string, string[]> = {
  THB: TH_SECTORS,
  USD: US_SECTORS,
};

export const STRATEGIES = [
  "Breakout",
  "Trend Following",
  "Mean Reversion",
  "Swing",
  "Momentum",
  "Value",
  "Dividend",
  "Scalp",
  "Options Play",
  "Other",
];

// ── Blank form states ─────────────────────────────────────────────────────────

export const BLANK_CASH: Omit<CashEntry, "id"> = {
  account_id: "finansia",
  date: "",
  income: 0,
  investment: 0,
  exchange_rate: 1,
  note: "",
};

export const BLANK_DIV: Omit<Dividend, "id"> = {
  account_id: "finansia",
  asset: "",
  ex_date: "",
  pay_date: "",
  amount_per_unit: 0,
  total_received: 0,
  reinvested_amount: 0,
  reinvest_asset: "",
  reinvest_price: 0,
  reinvest_units: 0,
  currency: "THB",
};

export const BLANK_FORM = {
  account_id: "finansia",
  symbol: "",
  sector: "",
  date_entry: "",
  date_exit: "",
  price_entry: "",
  price_exit: "",
  price_stoploss: "",
  price_target: "",
  volume: "",
  pnl_amount: "",
  win_loss: "P",
  pnl_percent: "",
  strategy_name: "",
  entry_trigger: "",
  exit_trigger: "",
  note: "",
  is_option: false,
  option_type: "Call",
  option_direction: "Long",
  vat_amount: "",
};

// ── Sub-accounts ──────────────────────────────────────────────────────────────
// Sub-ports work for any account, not just Finansia. Persisted per account_id —
// "+ Add new sub-port" in the UI appends here, no code edit needed.

export const ACCOUNT_NAMES: Record<string, string> = {
  finansia: "Finansia",
  dime: "Dime",
  innovestx: "InnovestX",
};

const SUB_PORTS_DEFAULT: Record<string, string[]> = {
  finansia: ["Finansia (0153717)", "Finansia (6065157)", "Finansia (6065151)"],
};
export const subPortsAtom = atomWithStorage<Record<string, string[]>>(
  "bloomberg_sub_ports",
  SUB_PORTS_DEFAULT
);

// ── Chart colors ──────────────────────────────────────────────────────────────

export const ALLOC_COLORS = [
  "#ff9900",
  "#60a5fa",
  "#4ade80",
  "#f472b6",
  "#a78bfa",
  "#34d399",
  "#fb923c",
  "#818cf8",
];

export const SECTOR_COLORS: Record<string, string> = {
  BANK: "#3b82f6",
  FIN: "#3b82f6",
  ENERG: "#ef4444",
  PETRO: "#dc2626",
  ICT: "#ff9900",
  TECH: "#f97316",
  CRYPTO: "#a855f7",
  FOOD: "#22c55e",
  AGRO: "#16a34a",
  HELTH: "#06b6d4",
  PROP: "#f59e0b",
  CONS: "#ec4899",
  SERVICE: "#db2777",
  INDU: "#64748b",
  TRANS: "#475569",
  ETF: "#84cc16",
  GOLD: "#eab308",
  BOND: "#60a5fa",
  "Call Option": "#f97316",
  "Put Option": "#fb923c",
  Others: "#374151",
  Other: "#374151",
  "Finansia (0153717)": "#3b82f6",
  "Finansia (6065157)": "#f59e0b",
  "Finansia (6065151)": "#22c55e",
  Dime: "#a855f7",
  InnovestX: "#ef4444",
  finansia: "#3b82f6",
  dime: "#a855f7",
  innovestx: "#ef4444",
};
