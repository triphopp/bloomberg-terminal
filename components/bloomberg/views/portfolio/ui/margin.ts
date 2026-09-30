/**
 * MARGIN (IBKR Reg T) — shared types, colours and queries.
 * Backend: /api/v2/portfolio/margin/{status,overview,settings} (backend/routers/margin.py,
 * model in backend/margin.py). Used by MarginCard (PORT → RISK, PAPER → DASHBOARD),
 * the MGN column in POSITIONS and MarginRibbon in the status row.
 */

import { useQueries, useQuery } from "@tanstack/react-query";

export type MarginScope = "port" | "paper";
export type MarginLevel = "SAFE" | "WATCH" | "WARNING" | "DANGER" | "LIQUIDATION";

export const LEVEL_COLOR: Record<MarginLevel, string> = {
  SAFE: "#00C853",
  WATCH: "#FFD600",
  WARNING: "#FF9100",
  DANGER: "#FF4444",
  LIQUIDATION: "#E040FB",
};

export const LEVEL_TEXT: Record<MarginLevel, string> = {
  SAFE: "ปลอดภัย",
  WATCH: "เฝ้าดู — cushion เริ่มบาง",
  WARNING: "เตือน — ลดขนาดหรือเติมเงิน",
  DANGER: "อันตราย — ใกล้ถูกบังคับขาย",
  LIQUIDATION: "Excess Liquidity < 0 — IBKR บังคับขายได้ทันที (ไม่มี call ล่วงหน้า)",
};

export interface MarginSettings {
  scope: MarginScope;
  account_id: string;
  enabled: boolean;
  maint_long: number;
  maint_short: number;
  initial: number;
  overrides: Record<string, number>;
  thresholds: { WATCH: number; WARNING: number; DANGER: number };
}

export interface MarginLine {
  kind: "stock" | "option";
  key: string;
  symbol: string;
  ref: string | null;
  qty: number;
  price: number;
  mv: number;
  maint: number;
  initial: number;
  maint_rate: number | null;
  rate_source: string;
  covered?: number;
  spread?: number;
  naked?: number;
  level: MarginLevel;
  drop_to_call: number | null;
}

export interface MarginAsset {
  key: string;
  mv: number;
  maint: number;
  initial: number;
  symbols: string[];
  drop_to_call: number | null;
  rise_to_call: number | null;
  level: MarginLevel;
  mm_share: number;
}

export interface MarginStatusOn {
  enabled: true;
  scope: MarginScope;
  account_id: string;
  name: string;
  broker: string | null;
  currency: string;
  cash_is_estimate: boolean;
  cash_reconciled_at: string | null;
  missing: string[];
  nlv: number;
  elv: number;
  stock_mv: number;
  option_mv: number;
  cash: number;
  loan: number;
  maint_margin: number;
  initial_margin: number;
  excess_liquidity: number;
  available_funds: number;
  cushion: number | null;
  gross_leverage: number | null;
  level: MarginLevel;
  restricted: boolean;
  uses_margin: boolean;
  drop_to_call: number | null;
  rise_to_call: number | null;
  lines: MarginLine[];
  assets: MarginAsset[];
  settings: MarginSettings;
}

export interface MarginStatusOff {
  enabled: false;
  scope: MarginScope;
  account_id: string;
  name: string;
  settings: MarginSettings;
}

export type MarginStatus = MarginStatusOn | MarginStatusOff;

export interface MarginOverviewRow {
  scope: MarginScope;
  account_id: string;
  name: string | null;
  currency: string | null;
  level: MarginLevel | null;
  cushion: number | null;
  excess_liquidity: number | null;
  available_funds: number | null;
  nlv: number | null;
  maint_margin: number | null;
  loan: number | null;
  drop_to_call: number | null;
  rise_to_call: number | null;
  restricted: boolean | null;
  uses_margin: boolean | null;
  cash_is_estimate: boolean | null;
  error?: string;
}

export interface MarginOverview {
  accounts: MarginOverviewRow[];
  worst: MarginLevel | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Same cadence as TRADE GUARD: prices move it, the backend scan is 5 min. */
export function useMarginStatus(scope: MarginScope, accountId: string | null | undefined) {
  return useQuery<MarginStatus>({
    queryKey: ["margin", "status", scope, accountId],
    queryFn: () =>
      getJson(
        `/api/v2/portfolio/margin/status?scope=${scope}&account_id=${encodeURIComponent(accountId ?? "")}`
      ),
    enabled: !!accountId && accountId !== "all",
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });
}

export function useMarginOverview() {
  return useQuery<MarginOverview>({
    queryKey: ["margin", "overview"],
    queryFn: () => getJson("/api/v2/portfolio/margin/overview"),
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });
}

export async function saveMarginSettings(
  s: Omit<MarginSettings, "thresholds"> & {
    thresholds: Partial<MarginSettings["thresholds"]>;
  }
): Promise<MarginSettings> {
  const r = await fetch("/api/v2/portfolio/margin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
  return d as MarginSettings;
}

/** 0.3333 → "33.3%"; null → "—". */
export const pct1 = (v: number | null | undefined) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;

/**
 * `${account_id}|${UNDERLYING}` → that underlying's margin colour, for every
 * margin-enabled account in `scope`. Shares the status cache with MarginCard.
 */
export function useMarginAssetLevels(scope: MarginScope) {
  const overview = useMarginOverview();
  const ids = (overview.data?.accounts ?? [])
    .filter((a) => a.scope === scope)
    .map((a) => a.account_id);
  const statuses = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["margin", "status", scope, id],
      queryFn: () =>
        getJson<MarginStatus>(
          `/api/v2/portfolio/margin/status?scope=${scope}&account_id=${encodeURIComponent(id)}`
        ),
      staleTime: 60_000,
      refetchInterval: 2 * 60_000,
    })),
  });
  const map = new Map<string, { asset: MarginAsset; account: MarginStatusOn }>();
  for (const q of statuses) {
    const s = q.data;
    if (!s?.enabled) continue;
    for (const a of s.assets)
      map.set(`${s.account_id}|${a.key.toUpperCase()}`, { asset: a, account: s });
  }
  return { map, enabledIds: new Set(ids) };
}
