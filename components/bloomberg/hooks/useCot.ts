"use client";

/**
 * CFTC Commitments of Traders — one hook for every view that shows positioning
 * (TAIL POSITIONING, BOND basis trade, MKT TICK DATA chips, stock-view COT tab,
 * PORT RISK). Data is weekly: positions as of TUESDAY, released FRIDAY 15:30 ET,
 * so every consumer must show `as_of` — a 3-day-old weekly number rendered like
 * a live quote is the misreading this data invites.
 *
 * Backend: `backend/routers/cot.py` (answers from SQLite; the CFTC pull runs on
 * a background thread). Shapes: memory/reference/data-shapes.md "COT Snapshot".
 */

import { useQuery } from "@tanstack/react-query";

export type CotGroup = "dealer" | "am" | "lev" | "other" | "nonrept" | "prod" | "swap" | "mm";

export interface CotGroupStats {
  long: number;
  short: number;
  net: number;
  net_oi: number; // % of open interest
  d_net: number | null;
  traders_long: number | null;
  traders_short: number | null;
  z: number | null; // of net/OI over the window
  pct: number | null; // 0–100, low = most net-short in the window
  n: number;
}

export interface CotContract {
  code: string;
  key: string;
  label: string;
  dataset: "TFF" | "DIS";
  class: "rates" | "equity" | "vol" | "fx" | "crypto" | "commod";
  focus: "lev" | "mm";
  yahoo: string;
  dv01: number | null;
  as_of: string;
  released: string;
  oi: number;
  d_oi: number | null;
  conc4_long: number | null;
  conc4_short: number | null;
  conc8_long: number | null;
  conc8_short: number | null;
  groups: Partial<Record<CotGroup, CotGroupStats>>;
}

export interface CotFlag {
  id: string;
  label: string;
  contract: string;
  contract_label: string;
  group: CotGroup;
  side: "long" | "short";
  z: number;
  pct: number;
  net_oi: number;
  as_of: string;
  released: string;
  why: string;
}

export interface CotStatus {
  running: boolean;
  last_error: string | null;
  cooldown: boolean;
  rows_last_run: number;
  expected_as_of: string;
  stored: number;
  contracts: number;
}

export interface CotSnapshot {
  window: number;
  as_of: string | null;
  released: string | null;
  contracts: CotContract[];
  flags: CotFlag[];
  status: CotStatus;
}

export interface CotHistoryRow {
  date: string;
  released: string;
  oi: number;
  conc4_long: number | null;
  conc4_short: number | null;
  conc8_long: number | null;
  conc8_short: number | null;
  groups: Partial<
    Record<
      CotGroup,
      {
        long: number;
        short: number;
        net: number;
        spread: number | null;
        traders_long: number | null;
        traders_short: number | null;
      }
    >
  >;
}

export interface CotHistory {
  code: string;
  key: string;
  label: string;
  dataset: "TFF" | "DIS";
  focus: "lev" | "mm";
  rows: CotHistoryRow[];
}

export const COT_GROUP_LABEL: Record<CotGroup, string> = {
  dealer: "DEALER",
  am: "ASSET MGR",
  lev: "LEV FUNDS",
  other: "OTHER",
  nonrept: "NON-REPT",
  prod: "PRODUCER",
  swap: "SWAP",
  mm: "MANAGED $",
};

export const COT_Z_EXTREME = 2;
export const COT_PCT_LOW = 5;
export const COT_PCT_HIGH = 95;

/** "short" = crowded net short, "long" = crowded net long, null = not extreme. */
export function cotExtreme(g: CotGroupStats | undefined | null): "long" | "short" | null {
  if (!g || g.z == null || g.pct == null) return null;
  if (g.z <= -COT_Z_EXTREME || g.pct <= COT_PCT_LOW) return "short";
  if (g.z >= COT_Z_EXTREME || g.pct >= COT_PCT_HIGH) return "long";
  return null;
}

/** Yahoo symbol → COT contract key, for rows that are not the futures ticker itself. */
export const COT_KEY_BY_SYMBOL: Record<string, string> = {
  "ES=F": "ES",
  "^GSPC": "ES",
  SPY: "ES",
  "NQ=F": "NQ",
  "^NDX": "NQ",
  QQQ: "NQ",
  "RTY=F": "RTY",
  "^RUT": "RTY",
  IWM: "RTY",
  "^VIX": "VIX",
  "VX=F": "VIX",
  "JPY=X": "JPY",
  "6J=F": "JPY",
  "USDJPY=X": "JPY",
  "EURUSD=X": "EUR",
  "6E=F": "EUR",
  "BTC-USD": "BTC",
  "BTC=F": "BTC",
  "CL=F": "WTI",
  USO: "WTI",
  "GC=F": "GOLD",
  GLD: "GOLD",
  "HG=F": "COPPER",
  "ZT=F": "UST2Y",
  "^IRX": "SOFR3M",
  "SR3=F": "SOFR3M",
  "ZF=F": "UST5Y",
  "^FVX": "UST5Y",
  "ZN=F": "UST10Y",
  "^TNX": "UST10Y",
  "TN=F": "UXY",
  "ZB=F": "USB",
  "^TYX": "USB",
  "UB=F": "ULTRA",
  TLT: "USB",
  IEF: "UST10Y",
  SHY: "UST2Y",
};

export function cotKeyFor(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  return COT_KEY_BY_SYMBOL[symbol.toUpperCase()] ?? COT_KEY_BY_SYMBOL[symbol] ?? null;
}

export function useCotSnapshot(enabled = true, window = 156) {
  return useQuery<CotSnapshot>({
    queryKey: ["cot-snapshot", window],
    queryFn: () => fetch(`/api/cot/snapshot?window=${window}`).then((r) => r.json()),
    enabled,
    staleTime: 30 * 60_000,
    // First open on a machine starts the backfill; poll quickly until it lands.
    refetchInterval: (q) => (q.state.data?.status?.running ? 10_000 : 60 * 60_000),
  });
}

export function useCotHistory(key: string | null, weeks = 156) {
  return useQuery<CotHistory>({
    queryKey: ["cot-history", key, weeks],
    queryFn: () =>
      fetch(`/api/cot/history?code=${encodeURIComponent(key ?? "")}&weeks=${weeks}`).then((r) =>
        r.json()
      ),
    enabled: !!key,
    staleTime: 30 * 60_000,
  });
}

export const fmtContracts = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const s =
    a >= 1e6
      ? `${(a / 1e6).toFixed(2)}M`
      : a >= 1e3
        ? `${(a / 1e3).toFixed(0)}k`
        : `${Math.round(a)}`;
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${s}`;
};
