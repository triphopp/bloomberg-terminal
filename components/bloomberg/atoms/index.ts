import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { marketData as fallbackData } from "../lib/marketData";
import type { FilterState, MarketData } from "../types";

// ── Pin Asset Types ───────────────────────────────────────────────────────────
export interface PinGroup {
  id: string; // unique id
  name: string; // display name e.g. "Tech", "Macro"
  color: string; // hex color e.g. "#f59e0b"
}

export interface PinTag {
  id: string; // unique id
  name: string; // display name e.g. "High Conviction"
  color: string; // hex color e.g. "#94a3b8"
}

export interface PinnedAsset {
  id: string; // unique id
  symbol: string; // ticker e.g. "PLTR"
  groupId: string; // references PinGroup.id
  comment: string; // free-text note
  addedAt: string; // YYYY-MM-DD
  buyTarget?: number; // alert when price <= this
  sellTarget?: number; // alert when price >= this
  priority?: number; // 1–3 stars
  priceAtPin?: number; // price when first pinned
  tags?: string[]; // array of PinTag IDs
}

export const pinGroupsAtom = atom<PinGroup[]>([]);
export const pinnedAssetsAtom = atom<PinnedAsset[]>([]);
export const pinTagsAtom = atom<PinTag[]>([]);

// ── Portfolio Types ───────────────────────────────────────────────────────────
export interface Holding {
  id: string; // unique ID (timestamp-based)
  symbol: string; // "PLTR"
  shares: number; // 50
  avgCost: number; // 95.00 USD per share
  purchaseDate: string; // "2025-12-01" YYYY-MM-DD
  notes?: string;
}

// Global state to prevent multiple API calls across component instances
const GlobalState = {
  lastFetchTime: 0,
  updateTimer: null as NodeJS.Timeout | null,
  isUpdating: false,
  activeInstances: 0,
  minTimeBetweenUpdates: 60000, // 60 seconds minimum between updates
};

// UI state atoms
export const isDarkModeAtom = atom(false);
export const errorAtom = atom<string | null>(null);
export const isShortcutsHelpOpenAtom = atom(false);
export const isGlobalSearchOpenAtom = atom(false);
export const tickerEnabledAtom = atom(true); // Bloomberg crawl strip

// View state atoms
export const currentViewAtom = atom<
  | "market"
  | "news"
  | "movers"
  | "stock"
  | "clippings"
  | "macro"
  | "credit"
  | "portfolio"
  | "crypto"
  | "fx"
  | "tail"
>("market");

// Portfolio atoms
export const portfolioHoldingsAtom = atom<Holding[]>([]);
export const selectedHoldingSymbolAtom = atom<string>("");

// Pre-filled symbol when navigating from a market card to the equity view
export const stockSearchSymbolAtom = atom<string>("");

// Filter state atoms
export const showMoversAtom = atom(false);
export const showVolatilityAtom = atom(false);
export const showRatiosAtom = atom(false);
export const showFuturesAtom = atom(false);
export const showAvatAtom = atom(true);
export const show10DAtom = atom(false);
export const showYTDAtom = atom(true);
export const showCADAtom = atom(false);

// Composite filter state atom for convenience
export const filtersAtom = atom(
  (get) =>
    ({
      showMovers: get(showMoversAtom),
      showVolatility: get(showVolatilityAtom),
      showRatios: get(showRatiosAtom),
      showFutures: get(showFuturesAtom),
      showAvat: get(showAvatAtom),
      show10D: get(show10DAtom),
      showYTD: get(showYTDAtom),
      showCAD: get(showCADAtom),
    }) as FilterState
);

// Market data atoms
export const marketDataAtom = atom<MarketData>(fallbackData);
export const isLoadingAtom = atom(false);
export const lastUpdatedAtom = atom<Date | null>(null);
export const lastServerFetchAtom = atom<Date | null>(null);
export const dataSourceAtom = atom<string>("local");
export const isFromRedisAtom = atom(false);
// Live polling on by default (60s cadence, aligned with backend CACHE_TTL).
// Persisted so a user who turns it off stays off across reloads.
export const isRealTimeEnabledAtom = atomWithStorage<boolean>("market:realtime", true);
export const lastSparklineUpdateAtom = atom<Date | null>(null);
export const updatedCellsAtom = atom<Record<string, boolean>>({});
export const updatedSparklinesAtom = atom<Record<string, boolean>>({});

// Chart indicator persistence atoms — saved to localStorage.
//
// ⚠️ All of these pass `getOnInit: true`. jotai's atomWithStorage defaults to
// `false`, which means the atom's value on first render is the DEFAULT and the
// stored value only arrives on a later subscription tick — anything that reads
// the atom in a useState initializer (as useChartIndicators does) would capture
// the defaults and silently drop the user's saved setup on every mount.

/**
 * One active indicator = a registry entry id plus the params it was created with.
 * Storing params (not just the derived instance id like "rsi-30") is what lets a
 * custom period survive a reload — rebuilding from the id alone re-applies the
 * registry defaults.
 */
export interface IndicatorSpec {
  /** INDICATOR_REGISTRY entry id, e.g. "ema", "rsi", "volume" */
  id: string;
  params?: Record<string, number | boolean | string>;
}

export const DEFAULT_INDICATOR_SPECS: IndicatorSpec[] = [
  { id: "ema", params: { period: 20 } },
  { id: "ema", params: { period: 50 } },
  { id: "volume" },
];

export const chartIndicatorSpecsAtom = atomWithStorage<IndicatorSpec[]>(
  "chart:indicator-specs",
  DEFAULT_INDICATOR_SPECS,
  undefined,
  { getOnInit: true }
);
export const chartShowVolumeProfileAtom = atomWithStorage<boolean>(
  "chart:volume-profile",
  false,
  undefined,
  { getOnInit: true }
);
export const chartShowFootprintAtom = atomWithStorage<boolean>(
  "chart:footprint",
  false,
  undefined,
  {
    getOnInit: true,
  }
);
export const chartShowEventsAtom = atomWithStorage<boolean>("chart:show-events", true, undefined, {
  getOnInit: true,
});
export const chartShowPEAtom = atomWithStorage<boolean>("chart:show-pe", false, undefined, {
  getOnInit: true,
});

// Volume Profile display options (see chart/indicators/volume-profile.ts)
export interface VPConfig {
  deltaMode: boolean; // split each bucket into buy (up-bar) vs sell (down-bar) volume
  showNakedPoc: boolean; // extend prior-session POCs that price hasn't revisited
  showHvnLvn: boolean; // mark high/low volume nodes on the composite strip
}
export const chartVPConfigAtom = atomWithStorage<VPConfig>(
  "chart:vp-config",
  {
    deltaMode: false,
    showNakedPoc: true,
    showHvnLvn: false,
  },
  undefined,
  { getOnInit: true }
);

// Global chart type (shared across all chart views) — saved to localStorage
export const chartTypeAtom = atomWithStorage<"area" | "candle">("chart:type", "candle", undefined, {
  getOnInit: true,
});

// Focus signal for heatmap symbol search — increment to trigger focus
export const focusHeatmapSearchAtom = atom(0);

// Heatmap layout settings panel open/close
export const showHeatmapSettingsAtom = atom(false);

// Derived atoms
export const themeClassAtom = atom((get) => (get(isDarkModeAtom) ? "dark" : "light"));

// Global state atoms (for internal use)
export const globalStateAtom = atom(GlobalState);
