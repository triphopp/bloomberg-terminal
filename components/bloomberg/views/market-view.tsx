"use client";

import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Activity,
  BarChart2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  LineChart,
  Loader2,
  PictureInPicture2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
} from "lucide-react";
import {
  type DragEvent,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  chartTypeAtom,
  currentViewAtom,
  focusHeatmapSearchAtom,
  isDarkModeAtom,
  pinGroupsAtom,
  pinnedAssetsAtom,
  showHeatmapSettingsAtom,
  stockSearchSymbolAtom,
} from "../atoms";
import { MAX_CHART_WINDOWS, chartWindowsAtom, openChartWindowAtom } from "../atoms/chart-windows";
import {
  BAR_INTERVALS,
  EventDetailPopover,
  INTERVAL_DEFAULT_RANGE,
  INTERVAL_LABEL,
  INTERVAL_VALID_RANGES,
  IndicatorPicker,
  IntervalPicker,
  ModularChart,
  PERIOD_LABEL,
  TIME_PERIODS,
  TimeframeRow,
  useAnchoredPanel,
  useChartIndicators,
  useChartTimeframe,
} from "../chart";
import type { BarInterval, IndicatorRegistryEntry, OhlcvBar, TimePeriod } from "../chart";
import { FearGreedPane } from "../chart/FearGreedPane";
import { PEPane } from "../chart/PEPane";
import { RegressionControls } from "../chart/RegressionControls";
import { VolumeEventPanel } from "../chart/VolumeEventPanel";
import { useAutoExtendRange } from "../chart/useAutoExtendRange";
import { useSdBands } from "../chart/useSdBands";
import { COT_KEY_BY_RATE_ID, CotChip } from "../core/cot-chip";
import {
  ExtendedHoursPrice,
  MarketSessionBadge,
  extendedHoursPriceLine,
  staleMoveStyle,
} from "../core/market-session";
import { UsMarketClock } from "../core/us-market-clock";
import { type CotFlag, cotKeyFor, useCotSnapshot } from "../hooks/useCot";
import { type FxPair, useFxTicks } from "../hooks/useFxTicks";
import { useMarketDataQuery } from "../hooks/useMarketDataQuery";
import { type RateRowData, useRatesCurve } from "../hooks/useRatesCurve";
import {
  usePrefetchStockHistory,
  useStockHistory,
  useStockQuote,
  useStockSearch,
} from "../hooks/useStockData";
import { calcHurst } from "../lib/market-utils";
import { recordSearchHit } from "../lib/search-stats";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors } from "../lib/theme-config";
import type { MarketItem } from "../types";
import { FrequentSearchList, MostActiveList } from "./discover-lists";
import { PinnedAssets } from "./pinned-assets";
import { SectorRegimeHeatmap } from "./sector-regime-heatmap";

type MarketViewProps = { isDarkMode: boolean };

// ── Layout Settings ───────────────────────────────────────────────────────────

const LS_LAYOUT_KEY = "bloomberg_heatmap_layout";
const LS_WATCHLIST_H = "bloomberg_watchlist_height";

type PanelId = "watchlist" | "chart" | "tickdata";

interface LayoutSettings {
  panelOrder: PanelId[];
  panelWidths: Record<PanelId, number>; // percentage widths (must sum to 100)
  collapsedPanels: PanelId[];
}

const DEFAULT_LAYOUT: LayoutSettings = {
  panelOrder: ["watchlist", "chart", "tickdata"],
  panelWidths: { watchlist: 30, chart: 40, tickdata: 30 },
  collapsedPanels: [],
};

function loadLayout(): LayoutSettings {
  try {
    const s = localStorage.getItem(LS_LAYOUT_KEY);
    if (!s) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(s);
    if (!parsed.panelOrder || !parsed.panelWidths) return DEFAULT_LAYOUT;
    // Enforce minimum widths so no panel can become invisible
    const widths = parsed.panelWidths as Record<PanelId, number>;
    const ids: PanelId[] = ["watchlist", "chart", "tickdata"];
    for (const id of ids) {
      if (typeof widths[id] !== "number" || widths[id] < 15) return DEFAULT_LAYOUT;
    }
    // A collapsed panel is now zero-width with no rail of its own, and the only
    // way back is the chip in the chart's header. A stored layout that folded
    // the chart would therefore hide its own restore control, so drop it.
    return {
      ...parsed,
      collapsedPanels: (parsed.collapsedPanels ?? []).filter((id: PanelId) => id !== "chart"),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

// ── TICK DATA sections ────────────────────────────────────────────────────────
// The board went from ~20 rows (indices only) to ~66 once the US/JP curves and
// FX moved in, so each section collapses independently.

const LS_TICK_SECTIONS = "bloomberg_tickdata_sections";
const LS_TICK_ORDER = "bloomberg_tickdata_order";

type TickSection =
  | "americas"
  | "emea"
  | "asiaPacific"
  | "ratesUS"
  | "ratesJP"
  | "volatility"
  | "fx";

const TICK_SECTIONS: TickSection[] = [
  "ratesUS",
  "ratesJP",
  "americas",
  "emea",
  "asiaPacific",
  "volatility",
  "fx",
];

/** JP curve and FX start collapsed — 35 extra rows on first open is a wall. */
const DEFAULT_COLLAPSED_SECTIONS: TickSection[] = ["ratesJP", "fx"];

function loadTickSections(): TickSection[] {
  if (typeof window === "undefined") return DEFAULT_COLLAPSED_SECTIONS;
  try {
    const s = localStorage.getItem(LS_TICK_SECTIONS);
    if (!s) return DEFAULT_COLLAPSED_SECTIONS;
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return DEFAULT_COLLAPSED_SECTIONS;
    return parsed.filter((x): x is TickSection => TICK_SECTIONS.includes(x));
  } catch {
    return DEFAULT_COLLAPSED_SECTIONS;
  }
}

/** Keep valid saved positions, then append newly introduced sections. */
function normalizeTickOrder(value: unknown): TickSection[] {
  if (!Array.isArray(value)) return [...TICK_SECTIONS];
  const order: TickSection[] = [];
  for (const id of value) {
    if (TICK_SECTIONS.includes(id) && !order.includes(id)) order.push(id);
  }
  return [...order, ...TICK_SECTIONS.filter((id) => !order.includes(id))];
}

function loadTickOrder(): TickSection[] {
  if (typeof window === "undefined") return [...TICK_SECTIONS];
  try {
    const stored = localStorage.getItem(LS_TICK_ORDER);
    return stored ? normalizeTickOrder(JSON.parse(stored)) : [...TICK_SECTIONS];
  } catch {
    return [...TICK_SECTIONS];
  }
}

function moveTickOrder(order: TickSection[], from: number, to: number): TickSection[] {
  if (from < 0 || to < 0 || to >= order.length || from === to) return order;
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function saveLayout(layout: LayoutSettings) {
  try {
    localStorage.setItem(LS_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(n: number) {
  if (n >= 10000)
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtDateLabel(dateStr: string, period: string) {
  const d = new Date(dateStr);
  if (period === "1d" || period === "5d") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (period === "1m" || period === "3m") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** JPY crosses quote to 3 decimals (157.243); everything else to 5 (1.09241). */
function fmtFxPrice(id: string, n: number | null | undefined): string {
  if (n == null) return "—";
  const d = id.toUpperCase().includes("JPY") ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** The 4 UST tenors that have a yfinance series — see `_UST_CHART` in rates.py. */
const RATE_CHART_SYMBOLS = new Set(["^IRX", "^FVX", "^TNX", "^TYX"]);

/** Chart-panel quote formatting. Rates and FX now reach this panel from the
 *  TICK DATA board, and neither is denominated in dollars: a 10Y yield is
 *  `4.745%`, EUR/USD is `1.15274`, and only equities/indices get a "$". */
function fmtQuote(symbol: string, n: number | null | undefined): string {
  if (n == null) return "—";
  if (RATE_CHART_SYMBOLS.has(symbol)) return `${n.toFixed(3)}%`;
  if (symbol.toUpperCase().endsWith("=X")) return fmtFxPrice(symbol, n);
  return `$${fmtPrice(n)}`;
}

function fmtBp(bp: number | null | undefined): string {
  if (bp == null) return "—";
  return `${bp >= 0 ? "+" : ""}${bp.toFixed(1)}bp`;
}

function fmtVolShort(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

const LS_MOBILE_PANEL_KEY = "bloomberg_mkt_mobile_tab";

/** Feeds that share the MKT left panel's top slot (see views/discover-lists.tsx). */
type LeftFeed = "watch" | "freq" | "active";
const LS_LEFT_FEED = "bloomberg_mkt_left_feed";
const LEFT_FEEDS: { key: LeftFeed; label: string; desc: string }[] = [
  { key: "watch", label: "WATCH", desc: "Your pinned watchlist" },
  { key: "freq", label: "FREQ", desc: "Top 30 symbols you open most from a search box" },
  { key: "active", label: "ACTIVE", desc: "Top 30 most-traded US stocks by share volume today" },
];

const PANEL_LABELS: Record<PanelId, string> = {
  watchlist: "WATCHLIST",
  chart: "CHART",
  tickdata: "TICK DATA",
};

// ── MACD Calculation ─────────────────────────────────────────────────────────

function calcEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  if (prices.length === 0) return ema;
  const k = 2 / (period + 1);
  ema[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

type MACDPoint = {
  label: string;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
};

function calcMACD(
  data: { price: number; label: string }[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MACDPoint[] {
  const prices = data.map((d) => d.price);
  if (prices.length < slowPeriod + signalPeriod) {
    return data.map((d) => ({ label: d.label, macd: null, signal: null, histogram: null }));
  }

  const emaFast = calcEMA(prices, fastPeriod);
  const emaSlow = calcEMA(prices, slowPeriod);

  // MACD line = EMA12 - EMA26
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);

  // Signal line = EMA9 of MACD line (only valid after slowPeriod points)
  const validMacd = macdLine.slice(slowPeriod - 1);
  const signalLine = calcEMA(validMacd, signalPeriod);

  return data.map((d, i) => {
    const macdIdx = i - (slowPeriod - 1);
    if (macdIdx < 0) return { label: d.label, macd: null, signal: null, histogram: null };

    const m = validMacd[macdIdx];
    const signalIdx = macdIdx;
    const s = signalIdx < signalLine.length ? signalLine[signalIdx] : null;
    const h = s != null ? m - s : null;

    return { label: d.label, macd: m, signal: s, histogram: h };
  });
}

/**
 * One VOLATILITY row — a MarketItem plus the sub-group it belongs to.
 *
 * The group is what turns nineteen vol indices into something scannable: the
 * S&P term structure read in order is itself the signal, and OVX sitting next
 * to VIX would say nothing.
 */
interface VolatilityItem extends MarketItem {
  group?: string;
}

// ── Tick Data Row ─────────────────────────────────────────────────────────────
//
// The board is read squeezed to its minimum width, so it carries four columns
// only — NAME · LAST · CHG · YTD — at 9px with no vertical padding. The
// sparkline and absolute-change columns were dropped: at that width they
// pushed YTD off the edge, and YTD answers "what is happening" better than a
// 36px squiggle. CHG is %chg for indices/FX/vol and bp for yields.
//
// Rows are memoised and receive a stable `onSelect`, so a keystroke elsewhere
// in MKT re-renders the section headers, not ~70 rows.

const TICK_COLS = 4;
const UP = "#00FF00";
const DOWN = "#FF0000";
const CELL = "pl-1 pr-0.5 py-0 text-right whitespace-nowrap tabular-nums";

function fmtYtd(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function rowStyle(isSelected: boolean) {
  return {
    background: isSelected ? "#0a1628" : undefined,
    borderBottom: "1px solid #111",
    boxShadow: isSelected ? "inset 2px 0 #00FFFF" : undefined,
  };
}

function NameCell({
  label,
  color,
  isSelected,
  cot,
}: {
  label: string;
  color: string;
  isSelected: boolean;
  /** CFTC crowding flags for this row's contract — renders a small ▼p/▲p mark */
  cot?: CotFlag[];
}) {
  return (
    <td
      className="px-1 py-0 text-left font-bold truncate max-w-0 w-full"
      style={{ color: isSelected ? "#00FFFF" : color }}
      title={label}
    >
      {cot?.length ? (
        <span className="flex items-center min-w-0">
          <span className="truncate">{label}</span>
          <CotChip flags={cot} />
        </span>
      ) : (
        label
      )}
    </td>
  );
}

const TickRow = memo(function TickRow({
  item,
  colors,
  isSelected,
  onSelect,
  cot,
}: {
  item: MarketItem;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onSelect: (item: MarketItem) => void;
  cot?: CotFlag[];
}) {
  const pctColor = item.pctChange >= 0 ? UP : DOWN;
  // Dim a move that belongs to a session which has already ended, so a closed
  // market's last change cannot be misread as today's. The day tag ("Thu")
  // lives in the tooltip only — inline it widened CHG by ~15px on every row.
  const stale = staleMoveStyle(item);
  return (
    <tr
      className="cursor-pointer hover:bg-[#111]"
      style={rowStyle(isSelected)}
      onClick={() => onSelect(item)}
    >
      <NameCell label={item.id} color={colors.accent} isSelected={isSelected} cot={cot} />
      <td className={CELL} style={{ color: colors.text }}>
        {fmtPrice(item.value)}
      </td>
      <td className={CELL} style={{ color: pctColor }} title={stale?.title}>
        <span style={{ opacity: stale?.opacity }}>{fmtPct(item.pctChange)}</span>
      </td>
      <td className={CELL} style={{ color: item.ytd >= 0 ? "#4ade80" : "#f87171" }}>
        {item.ytd !== 0 ? fmtYtd(item.ytd) : ""}
      </td>
    </tr>
  );
});

/**
 * A quieter header for a run of rows inside a section.
 *
 * Deliberately not a RegionHeader: those are accent-coloured and collapsible,
 * and a second one nested inside a section reads as a section of its own.
 */
function SubGroupHeader({
  label,
  colors,
}: {
  label: string;
  colors: typeof bloombergColors.dark;
}) {
  return (
    <tr>
      <td
        colSpan={TICK_COLS}
        className="px-1 py-0 text-[7px] font-bold tracking-widest leading-[11px]"
        style={{ background: "#080808", color: `${colors.textSecondary}cc` }}
      >
        <span className="pl-2">{label}</span>
      </td>
    </tr>
  );
}

function RegionHeader({
  id,
  label,
  count,
  colors,
  collapsed,
  onToggle,
  note,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  id: TickSection;
  label: string;
  count: number;
  colors: typeof bloombergColors.dark;
  collapsed: boolean;
  onToggle: (id: TickSection) => void;
  /** small right-aligned annotation, e.g. a stale-data warning */
  note?: string;
  isDropTarget: boolean;
  onDragStart: (id: TickSection, event: DragEvent<HTMLTableRowElement>) => void;
  onDragOver: (id: TickSection, event: DragEvent<HTMLTableRowElement>) => void;
  onDrop: (id: TickSection, event: DragEvent<HTMLTableRowElement>) => void;
  onDragEnd: () => void;
}) {
  // The whole header row is the drag handle — a separate grip and ↑/↓ buttons
  // cost ~50px of a row that is read at minimum width.
  return (
    <tr
      draggable
      title={`${label} — click to fold, drag to reorder`}
      onDragStart={(event) => onDragStart(id, event)}
      onDragOver={(event) => onDragOver(id, event)}
      onDrop={(event) => onDrop(id, event)}
      onDragEnd={onDragEnd}
    >
      <td
        colSpan={TICK_COLS}
        className="px-1 py-0 text-[8px] font-bold tracking-widest cursor-pointer hover:bg-[#141414] leading-[14px]"
        style={{
          background: "#0a0a0a",
          color: colors.accent,
          borderBottom: `1px solid ${colors.border}`,
          boxShadow: isDropTarget ? `inset 0 2px ${colors.accent}` : undefined,
        }}
        onClick={() => onToggle(id)}
      >
        <span className="flex items-center gap-0.5 w-full min-w-0">
          {collapsed ? (
            <ChevronRight className="h-2.5 w-2.5 shrink-0" />
          ) : (
            <ChevronDown className="h-2.5 w-2.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
          <span className="font-mono shrink-0" style={{ color: colors.textSecondary }}>
            {count}
          </span>
          {note && (
            <span
              className="ml-auto font-mono text-[7px] normal-case truncate"
              style={{ color: "#facc15" }}
            >
              {note}
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}

/** Single-row placeholder inside the tick table (loading / error / empty). */
function TickNotice({
  colors,
  loading,
  error,
  empty,
}: {
  colors: typeof bloombergColors.dark;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
}) {
  const text = error ?? (loading ? "loading…" : empty ? "no data" : null);
  if (!text) return null;
  return (
    <tr>
      <td
        colSpan={TICK_COLS}
        className="px-1 py-0 text-[8px] font-mono"
        style={{ color: error ? "#facc15" : colors.textSecondary }}
      >
        {text}
      </td>
    </tr>
  );
}

/** Yield row: value is a percentage and moves are basis points, not %chg.
 *  Colour follows MACRO's convention — yield up = red (bond price down). */
const RateRow = memo(function RateRow({
  row,
  colors,
  isSelected,
  onSelect,
  cot,
}: {
  row: RateRowData;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onSelect: (row: RateRowData) => void;
  cot?: CotFlag[];
}) {
  const chg = row.changeBp;
  const chgColor = chg == null || chg === 0 ? colors.textSecondary : chg > 0 ? DOWN : UP;
  const chartable = row.chartSymbol != null;
  return (
    <tr
      className="cursor-pointer hover:bg-[#111]"
      style={rowStyle(isSelected)}
      onClick={() => onSelect(row)}
      title={
        chartable
          ? `${row.id} — as of ${row.asOf}`
          : `${row.id} — as of ${row.asOf} · no intraday series for this tenor`
      }
    >
      <NameCell
        label={row.tenor}
        color={chartable ? colors.accent : colors.textSecondary}
        isSelected={isSelected}
        cot={cot}
      />
      <td className={CELL} style={{ color: colors.text }}>
        {row.value.toFixed(3)}
      </td>
      <td className={CELL} style={{ color: chgColor }}>
        {fmtBp(chg)}
      </td>
      <td className={CELL} style={{ color: row.ytdBp >= 0 ? "#f87171" : "#4ade80" }}>
        {`${row.ytdBp >= 0 ? "+" : ""}${row.ytdBp.toFixed(0)}bp`}
      </td>
    </tr>
  );
});

/** FX row: rates need 5 decimals (3 for JPY crosses), not the 2 fmtPrice gives. */
const FxRow = memo(function FxRow({
  pair,
  colors,
  isSelected,
  onSelect,
  cot,
}: {
  pair: FxPair;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onSelect: (pair: FxPair) => void;
  cot?: CotFlag[];
}) {
  const pct = pair.pctChange ?? 0;
  return (
    <tr
      className="cursor-pointer hover:bg-[#111]"
      style={rowStyle(isSelected)}
      onClick={() => onSelect(pair)}
    >
      <NameCell label={pair.id} color={colors.accent} isSelected={isSelected} cot={cot} />
      <td className={CELL} style={{ color: colors.text }}>
        {fmtFxPrice(pair.id, pair.price)}
      </td>
      <td className={CELL} style={{ color: pct >= 0 ? UP : DOWN }}>
        {fmtPct(pct)}
      </td>
      {/* FX overview carries no YTD — left blank rather than faked */}
      <td className={CELL} />
    </tr>
  );
});

// ── Quote fields ──────────────────────────────────────────────────────────────

interface QuoteField {
  label: string;
  value: string;
  color?: string;
}

/**
 * Split the quote into the handful of numbers that move during the session and
 * the reference data that is fixed for the day.
 *
 * They used to share one wrapping bar, which meant a dozen static fundamentals
 * pushed the chart down by a row or two to show numbers nobody re-reads tick to
 * tick. Only the live ones earn permanent space; the rest go behind a popover.
 */
function splitQuoteFields(
  quote: Record<string, unknown>,
  colors: typeof bloombergColors.dark,
  hurst?: number | null
): { live: QuoteField[]; stat: QuoteField[] } {
  const q = quote as Record<string, number | string | null | undefined>;
  const price = q.regularMarketPrice as number | undefined;
  const chg = q.regularMarketChange as number | undefined;
  const pct = q.regularMarketChangePercent as number | undefined;
  const isUp = (pct ?? 0) >= 0;
  const pctColor = isUp ? "#00FF00" : "#FF0000";

  // Outside regular hours CHG/VOL describe the *previous* session, while the
  // number actually ticking is the pre/after-hours delta shown by
  // ExtendedHoursPrice. Demote them so the header shows what is live now.
  const state = q.marketState as string | undefined;
  const extendedHours =
    state === "PRE" || state === "PREPRE" || state === "POST" || state === "POSTPOST";

  // LAST and %CHG live in the symbol header, so they are deliberately absent here.
  const live: QuoteField[] = [];
  const stat: QuoteField[] = [];
  const session = extendedHours ? stat : live;
  if (chg != null)
    session.push({
      label: "CHG",
      value: `${isUp ? "+" : ""}${(chg as number).toFixed(2)}`,
      color: pctColor,
    });
  if (q.regularMarketVolume != null)
    session.push({ label: "VOL", value: fmtCompact(q.regularMarketVolume as number) });

  if (q.regularMarketOpen != null)
    stat.push({ label: "OPEN", value: `$${fmtPrice(q.regularMarketOpen as number)}` });
  if (q.regularMarketPreviousClose != null)
    stat.push({ label: "PREV", value: `$${fmtPrice(q.regularMarketPreviousClose as number)}` });
  if (q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh != null)
    stat.push({
      label: "52W",
      value: `${fmtPrice(q.fiftyTwoWeekLow as number)}-${fmtPrice(q.fiftyTwoWeekHigh as number)}`,
    });
  if (q.marketCap != null) stat.push({ label: "MCAP", value: fmtCompact(q.marketCap as number) });
  if (q.trailingPE != null) stat.push({ label: "P/E", value: (q.trailingPE as number).toFixed(1) });
  // Forward P/E sits next to trailing so the two are read together — a forward
  // well below trailing is the market pricing in earnings growth, and vice versa.
  if (q.forwardPE != null)
    stat.push({ label: "FWD P/E", value: (q.forwardPE as number).toFixed(1) });
  if (q.beta != null) stat.push({ label: "BETA", value: (q.beta as number).toFixed(2) });
  if (q.epsTrailingTwelveMonths != null)
    stat.push({ label: "EPS", value: `$${(q.epsTrailingTwelveMonths as number).toFixed(2)}` });
  if (q.dividendYield != null && (q.dividendYield as number) > 0) {
    const yieldPct = (q.dividendYield as number) * 100;
    const eps = q.epsTrailingTwelveMonths as number | undefined;
    const divRate = (yieldPct / 100) * (price ?? 0);
    // Sanity check: hide if yield > 30% or payout ratio > 200% (bad/stale Yahoo data)
    const payoutOk = !eps || eps <= 0 || divRate / eps < 2.0;
    if (yieldPct < 30 && payoutOk)
      stat.push({ label: "DIV", value: `${yieldPct.toFixed(2)}%`, color: "#4ade80" });
  }
  if (hurst != null) {
    const hColor = hurst < 0.45 ? colors.positive : hurst > 0.55 ? colors.negative : colors.text;
    const hLabel = hurst < 0.45 ? "mean-reverting" : hurst > 0.55 ? "trending" : "random walk";
    stat.push({ label: "HURST", value: `${hurst.toFixed(3)} (${hLabel})`, color: hColor });
  }

  return { live, stat };
}

function FieldChip({ field, colors }: { field: QuoteField; colors: typeof bloombergColors.dark }) {
  return (
    <span className="whitespace-nowrap shrink-0">
      <span style={{ color: colors.textSecondary }}>{field.label}:</span>
      <span className="font-bold ml-0.5" style={{ color: field.color ?? colors.text }}>
        {field.value}
      </span>
    </span>
  );
}

/** Static fundamentals, revealed on demand so they cost no vertical space. */
function QuoteStatsPopover({
  fields,
  colors,
}: { fields: QuoteField[]; colors: typeof bloombergColors.dark }) {
  const { open, toggle, pos, wrapRef, triggerRef } = useAnchoredPanel();

  if (fields.length === 0) return null;

  return (
    <div className="shrink-0" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="flex items-center gap-0.5 px-1 text-[9px] font-mono border hover:opacity-70"
        style={{
          borderColor: open ? colors.accent : colors.border,
          color: open ? colors.accent : colors.textSecondary,
          background: open ? `${colors.accent}15` : "transparent",
        }}
        onClick={toggle}
        title="Fundamentals & reference data"
      >
        DETAILS
        <ChevronDown className="h-2.5 w-2.5" />
      </button>
      {open && pos && (
        <div
          className="fixed z-50 border px-2 py-1.5 grid gap-x-4 gap-y-0.5 text-[9px] font-mono"
          style={{
            left: pos.left,
            top: pos.top,
            background: colors.surface,
            borderColor: colors.border,
            gridTemplateColumns: "repeat(2, max-content)",
          }}
        >
          {fields.map((f) => (
            <FieldChip key={f.label} field={f} colors={colors} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Key Indicators Bar ────────────────────────────────────────────────────────

export function KeyIndicatorsBar({
  data,
  colors,
}: {
  data: { americas: MarketItem[]; emea: MarketItem[]; asiaPacific: MarketItem[] };
  colors: typeof bloombergColors.dark;
}) {
  const allItems = [...data.americas, ...data.emea, ...data.asiaPacific];
  const indicators = [
    { label: "VIX", id: "VIX" },
    { label: "DXY", id: "DOLLAR" },
    { label: "US10Y", id: "US 10Y" },
    { label: "GOLD", id: "GOLD" },
    { label: "WTI", id: "WTI" },
    { label: "BTC", id: "BITCOIN" },
  ];
  return (
    <div className="flex items-center gap-2 px-2 text-[9px] font-mono overflow-x-hidden w-full">
      {indicators.map(({ label, id }) => {
        const item = allItems.find((m) => m.id.toUpperCase().includes(id));
        if (!item) return null;
        const isUp = item.pctChange >= 0;
        return (
          <span key={id} className="whitespace-nowrap">
            <span style={{ color: colors.textSecondary }}>{label}</span>
            <span className="ml-0.5 font-bold" style={{ color: colors.text }}>
              {fmtPrice(item.value)}
            </span>
            <span className="ml-0.5" style={{ color: isUp ? colors.positive : colors.negative }}>
              {fmtPct(item.pctChange)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ── Resize Divider ────────────────────────────────────────────────────────────

function ResizeDivider({
  onDrag,
  colors,
}: {
  onDrag: (deltaX: number) => void;
  colors: typeof bloombergColors.dark;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        onDrag(delta);
      };
      const handleMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onDrag]
  );

  return (
    <div
      className="w-[5px] shrink-0 cursor-col-resize flex items-center justify-center group/divider hover:bg-[#222] transition-colors"
      style={{ background: colors.border }}
      onMouseDown={handleMouseDown}
    >
      <div className="w-[1px] h-8 bg-[#555] group-hover/divider:bg-[#ff9900] transition-colors" />
    </div>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────

function SettingsPanel({
  layout,
  onReorder,
  onReset,
  onClose,
  colors,
}: {
  layout: LayoutSettings;
  onReorder: (order: PanelId[]) => void;
  onReset: () => void;
  onClose: () => void;
  colors: typeof bloombergColors.dark;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const movePanel = (from: number, to: number) => {
    const newOrder = [...layout.panelOrder];
    const [item] = newOrder.splice(from, 1);
    newOrder.splice(to, 0, item);
    onReorder(newOrder);
  };

  return (
    <div
      className="fixed z-50 w-52 border shadow-lg p-2 text-xs space-y-2"
      style={{ background: colors.surface, borderColor: colors.border, top: "90px", right: "16px" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
          LAYOUT SETTINGS
        </span>
        <button onClick={onClose}>
          <span className="text-[10px]" style={{ color: colors.textSecondary }}>
            x
          </span>
        </button>
      </div>

      <div className="text-[8px] font-bold tracking-wider" style={{ color: colors.textSecondary }}>
        PANEL ORDER (drag to reorder)
      </div>
      <div className="space-y-1">
        {layout.panelOrder.map((pid, idx) => (
          <div
            key={pid}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null && dragIdx !== idx) movePanel(dragIdx, idx);
              setDragIdx(null);
            }}
            className="flex items-center gap-1.5 px-1.5 py-1 border cursor-grab active:cursor-grabbing"
            style={{
              borderColor: dragIdx === idx ? colors.accent : colors.border,
              background: dragIdx === idx ? `${colors.accent}15` : colors.background,
            }}
          >
            <GripVertical className="h-3 w-3 shrink-0" style={{ color: colors.textSecondary }} />
            <span className="text-[10px] font-bold font-mono" style={{ color: colors.text }}>
              {idx + 1}. {PANEL_LABELS[pid]}
            </span>
          </div>
        ))}
      </div>

      <div className="text-[8px] mt-1" style={{ color: colors.textSecondary }}>
        Drag dividers between panels to resize. Changes auto-save.
      </div>

      <div className="flex gap-1 pt-1 border-t" style={{ borderColor: colors.border }}>
        <button
          className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 font-bold hover:opacity-80"
          style={{ background: "#ef444422", color: "#f87171", border: "1px solid #ef444444" }}
          onClick={onReset}
        >
          <RotateCcw className="h-2.5 w-2.5" />
          RESET
        </button>
        <button
          className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 font-bold hover:opacity-80 ml-auto"
          style={{ background: "#22c55e22", color: "#4ade80", border: "1px solid #22c55e44" }}
          onClick={onClose}
        >
          <Save className="h-2.5 w-2.5" />
          DONE
        </button>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MarketView({ isDarkMode: _ }: MarketViewProps) {
  const [isDark] = useAtom(isDarkModeAtom);
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;

  const { marketData, refreshData, isLoading: marketLoading } = useMarketDataQuery();

  // TICK DATA cross-asset sections — indices come from useMarketDataQuery above,
  // rates and FX from their own endpoints (merged client-side so /api/market-data
  // keeps the shape GMOV / ticker / heatmap also depend on).
  const { data: ratesData, isLoading: ratesLoading } = useRatesCurve();
  const { data: fxData } = useFxTicks();
  // VIX-family "fear" gauges. Own endpoint rather than a region inside
  // /api/market-data: they are not a region, and that payload's shape is
  // consumed by GMOV, the ticker strip and the heatmap.
  const { data: volData, isLoading: volLoading } = useQuery<{
    items?: VolatilityItem[];
    error?: string;
  }>({
    queryKey: ["volatility"],
    queryFn: () => fetch("/api/volatility").then((r) => r.json()),
    staleTime: 55_000,
    refetchInterval: 60_000,
  });
  const volItems = volData?.items ?? [];
  const usRates = ratesData?.us ?? [];
  const jpRates = ratesData?.jp ?? [];
  const fxPairs = fxData?.pairs ?? [];

  // CFTC crowding flags (weekly). Only flagged contracts get a mark on their row.
  const { data: cotData } = useCotSnapshot();
  const cotFlags = useMemo(() => {
    const m = new Map<string, CotFlag[]>();
    for (const f of cotData?.flags ?? []) m.set(f.contract, [...(m.get(f.contract) ?? []), f]);
    return m;
  }, [cotData]);
  const cotForSymbol = (symbol: string | null | undefined) => {
    const k = cotKeyFor(symbol);
    return k ? cotFlags.get(k) : undefined;
  };

  // Which tick row is lit. Kept separate from selectedLabel — that captions
  // whatever the chart is drawing, and the two diverge for tenors with no
  // chartable series (clicking US 7Y must light the row without relabelling a
  // chart that is still showing something else).
  const [selectedTickId, setSelectedTickId] = useState<string | null>(null);
  // Same post-mount restore as `layout` below: which sections are collapsed
  // changes the markup, so it can only diverge from the server's HTML after
  // hydration, never during it.
  const [collapsedSections, setCollapsedSections] = useState<TickSection[]>(
    DEFAULT_COLLAPSED_SECTIONS
  );
  const [tickOrder, setTickOrder] = useState<TickSection[]>(TICK_SECTIONS);
  const [sectionsRestored, setSectionsRestored] = useState(false);
  useEffect(() => {
    setCollapsedSections(loadTickSections());
    setTickOrder(loadTickOrder());
    setSectionsRestored(true);
  }, []);
  useEffect(() => {
    if (!sectionsRestored) return;
    try {
      localStorage.setItem(LS_TICK_SECTIONS, JSON.stringify(collapsedSections));
    } catch {
      /* ignore */
    }
  }, [sectionsRestored, collapsedSections]);
  useEffect(() => {
    if (!sectionsRestored) return;
    try {
      localStorage.setItem(LS_TICK_ORDER, JSON.stringify(tickOrder));
    } catch {
      /* ignore */
    }
  }, [sectionsRestored, tickOrder]);
  const toggleSection = useCallback((id: TickSection) => {
    setCollapsedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }, []);
  const draggedTickSection = useRef<TickSection | null>(null);
  const [tickDropTarget, setTickDropTarget] = useState<TickSection | null>(null);
  const handleTickDragStart = useCallback(
    (id: TickSection, event: DragEvent<HTMLTableRowElement>) => {
      draggedTickSection.current = id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    []
  );
  const handleTickDragOver = useCallback(
    (id: TickSection, event: DragEvent<HTMLTableRowElement>) => {
      if (!draggedTickSection.current || draggedTickSection.current === id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setTickDropTarget(id);
    },
    []
  );
  const handleTickDrop = useCallback((id: TickSection, event: DragEvent<HTMLTableRowElement>) => {
    event.preventDefault();
    const source = draggedTickSection.current;
    if (source && source !== id) {
      setTickOrder((previous) =>
        moveTickOrder(previous, previous.indexOf(source), previous.indexOf(id))
      );
    }
    draggedTickSection.current = null;
    setTickDropTarget(null);
  }, []);
  const handleTickDragEnd = useCallback(() => {
    draggedTickSection.current = null;
    setTickDropTarget(null);
  }, []);

  // Layout settings
  const [layout, setLayout] = useState<LayoutSettings>(DEFAULT_LAYOUT);
  const [showSettings, setShowSettings] = useAtom(showHeatmapSettingsAtom);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load layout from localStorage
  useEffect(() => {
    setLayout(loadLayout());
  }, []);

  const updateLayout = useCallback((updates: Partial<LayoutSettings>) => {
    setLayout((prev) => {
      const next = { ...prev, ...updates };
      saveLayout(next);
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((panelId: PanelId) => {
    setLayout((prev) => {
      const collapsed = prev.collapsedPanels.includes(panelId)
        ? prev.collapsedPanels.filter((p) => p !== panelId)
        : [...prev.collapsedPanels, panelId];
      const next = { ...prev, collapsedPanels: collapsed };
      saveLayout(next);
      return next;
    });
  }, []);

  // Resize handler
  const handleResize = useCallback((leftPanel: PanelId, rightPanel: PanelId, deltaX: number) => {
    if (!containerRef.current) return;
    const containerW = containerRef.current.offsetWidth;
    const deltaPct = (deltaX / containerW) * 100;

    setLayout((prev) => {
      const newWidths = { ...prev.panelWidths };
      newWidths[leftPanel] = Math.max(15, Math.min(60, newWidths[leftPanel] + deltaPct));
      newWidths[rightPanel] = Math.max(15, Math.min(60, newWidths[rightPanel] - deltaPct));
      const next = { ...prev, panelWidths: newWidths };
      saveLayout(next);
      return next;
    });
  }, []);

  /**
   * The panel that absorbs leftover width — everything else keeps the size the
   * user set. The chart, whenever it is open: extra room shows more bars, while
   * a wider watchlist or tick board just pads columns. Falls back to the last
   * open panel so the row never leaves a gap.
   */
  // Folded panels, split by the side of the chart they will come back on.
  const [collapsedLeft, collapsedRight] = useMemo(() => {
    const chartIdx = layout.panelOrder.indexOf("chart");
    const folded = (id: PanelId) => layout.collapsedPanels.includes(id);
    return [
      layout.panelOrder.filter((id, i) => i < chartIdx && folded(id)),
      layout.panelOrder.filter((id, i) => i > chartIdx && folded(id)),
    ];
  }, [layout.panelOrder, layout.collapsedPanels]);

  const fillerPanel = useMemo(() => {
    const open = layout.panelOrder.filter((id) => !layout.collapsedPanels.includes(id));
    if (open.includes("chart")) return "chart";
    return open[open.length - 1];
  }, [layout.panelOrder, layout.collapsedPanels]);

  // Selected symbol for chart
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  // ── Phone layout: one panel at a time ──
  const isMobile = useIsMobile();
  const [mobilePanel, setMobilePanel] = useState<PanelId>(() => {
    if (typeof window === "undefined") return "chart";
    try {
      const s = localStorage.getItem(LS_MOBILE_PANEL_KEY);
      if (s === "watchlist" || s === "chart" || s === "tickdata") return s;
    } catch {
      /* ignore */
    }
    return "chart";
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_MOBILE_PANEL_KEY, mobilePanel);
    } catch {
      /* ignore */
    }
  }, [mobilePanel]);
  // Picking a symbol on the watchlist/tick board is a request to see it, and on
  // a phone the chart is behind another tab — follow the pick. The view fills
  // in a default symbol after load (null → DOW JONES); that is not a pick and
  // must not steal the stored tab, so only a change between two symbols counts.
  const prevSymbolRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSymbolRef.current;
    prevSymbolRef.current = selectedSymbol;
    if (isMobile && prev && selectedSymbol && prev !== selectedSymbol) setMobilePanel("chart");
  }, [selectedSymbol, isMobile]);
  const [selectedLabel, setSelectedLabel] = useState("");
  const {
    timePeriod,
    barInterval,
    isIntraday: heatmapIsIntraday,
    handlePeriodChange: handleHeatmapPeriod,
    handleIntervalChange: handleHeatmapInterval,
  } = useChartTimeframe({ defaultPeriod: "3m", defaultInterval: "1d" });
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownIdx, setDropdownIdx] = useState(-1);
  const [showVolume, setShowVolume] = useState(true);
  const [showMACD, setShowMACD] = useState(false);
  const [heatmapChartType, setHeatmapChartType] = useAtom(chartTypeAtom);
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusSignal] = useAtom(focusHeatmapSearchAtom);

  // Recent searches — stored in localStorage
  const LS_RECENT = "bloomberg_chart_recent";
  const [recentSymbols, setRecentSymbols] = useState<{ symbol: string; name: string }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_RECENT) ?? "[]");
    } catch {
      return [];
    }
  });
  const addToRecent = useCallback((symbol: string, name: string) => {
    setRecentSymbols((prev) => {
      const next = [{ symbol, name }, ...prev.filter((r) => r.symbol !== symbol)].slice(0, 8);
      try {
        localStorage.setItem(LS_RECENT, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // Vertical resize for watchlist panel
  const watchlistContentRef = useRef<HTMLDivElement>(null);
  // Default 220px so regime heatmap below has visible space from the start
  const [watchlistHeight, setWatchlistHeight] = useState<number>(220);

  // Adopt the stored height only after mount. Reading it in the initializer
  // put a different height in the first client render than the server had
  // emitted, and React discards the whole tree on that mismatch.
  useEffect(() => {
    try {
      const stored = Number.parseInt(localStorage.getItem(LS_WATCHLIST_H) ?? "", 10);
      if (Number.isFinite(stored) && stored >= 100) setWatchlistHeight(stored);
    } catch {
      /* private mode — keep the default */
    }
  }, []);

  const handleWatchlistResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = watchlistContentRef.current?.getBoundingClientRect().height ?? 220;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(100, startH + (ev.clientY - startY));
      setWatchlistHeight(h);
      try {
        localStorage.setItem(LS_WATCHLIST_H, String(h));
      } catch {}
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    if (focusSignal === 0) return;
    setTimeout(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    }, 50);
  }, [focusSignal]);

  // ── Modular chart indicator system ──
  const {
    indicators: heatmapIndicators,
    overlays: heatmapOverlays,
    eventMarkers: heatmapEventMarkers,
    showVolumeProfile: heatmapShowVP,
    addIndicator: addHeatmapIndicator,
    removeIndicator: removeHeatmapIndicator,
    windowUnit: heatmapWindowUnit,
    toggleWindowUnit: toggleHeatmapWindowUnit,
    regressionChannels: mktRegressionChannels,
    activeRegressionId: mktActiveRegressionId,
    regressionArmed: mktRegressionArmed,
    regressionPending: mktRegressionPending,
    regressionOpts: mktRegressionOpts,
    toggleRegression: toggleMktRegression,
    removeRegression: removeMktRegression,
    selectRegression: selectMktRegression,
    setRegressionMode: setMktRegressionMode,
    handleChartClick: handleMktChartClick,
    toggleVolumeProfile: toggleHeatmapVP,
    showVolumeEvents: heatmapShowVolumeEvents,
    toggleVolumeEvents: toggleHeatmapVolumeEvents,
    supportsEvents: heatmapSupportsEvents,
    selectedEvent: mktSelectedEvent,
    clearSelectedEvent: clearMktSelectedEvent,
    showPE: heatmapShowPE,
    togglePE: toggleHeatmapPE,
    peData: heatmapPeData,
    peLoading: heatmapPeLoading,
    showFootprint,
    toggleFootprint,
    isCryptoSymbol,
    footprintLoading,
    updateIndicatorConfig: updateHeatmapIndicatorConfig,
  } = useChartIndicators({ symbol: selectedSymbol, barInterval, chartType: heatmapChartType });

  // ── Fear & Greed data injection for market-view chart ────────────────────────
  const fearGreedActiveInMkt = heatmapIndicators.some((i) => i.id === "fear-greed");
  const fearGreedMktQuery = useQuery<{ history: Array<{ time: string; value: number }> }>({
    queryKey: [
      "fear-greed-history",
      barInterval.startsWith("1") && barInterval.length === 2 ? "3m" : "1y",
    ],
    queryFn: () => fetch("/api/fear-greed/history?period=1y").then((r) => r.json()),
    enabled: fearGreedActiveInMkt,
    staleTime: 60 * 60 * 1000,
  });
  useEffect(() => {
    if (fearGreedActiveInMkt && fearGreedMktQuery.data?.history) {
      updateHeatmapIndicatorConfig("fear-greed", { preloadedData: fearGreedMktQuery.data.history });
    }
  }, [fearGreedActiveInMkt, fearGreedMktQuery.data, updateHeatmapIndicatorConfig]);

  // ── IV SD Heatmap ──────────────────────────────────────────────────────────
  // Same hook the stock-view chart uses — fetch, self-heal on an unrecorded
  // symbol, and inject the payload into the indicator's config.
  useSdBands({
    indicators: heatmapIndicators,
    symbol: selectedSymbol,
    period: "1y",
    updateIndicatorConfig: updateHeatmapIndicatorConfig,
  });

  const setCurrentView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const openChartWindow = useSetAtom(openChartWindowAtom);
  const chartWindows = useAtomValue(chartWindowsAtom);
  const [pins] = useAtom(pinnedAssetsAtom);

  useEffect(() => {
    setDropdownIdx(-1);
    if (searchInput.length >= 1) {
      const t = setTimeout(() => setSearchQuery(searchInput), 300);
      return () => clearTimeout(t);
    }
    setSearchQuery("");
  }, [searchInput]);

  const searchResult = useStockSearch(searchQuery);

  const quoteQuery = useStockQuote(selectedSymbol);
  // Zoom out past the oldest bar and the chart loads more history by itself:
  // the candle query follows `effectivePeriod`, which climbs the period ladder
  // while `timePeriod` stays whatever the user pressed. Area mode is a plain
  // line chart with no logical-range events, so it keeps the picked window.
  const [chartDataState, setChartDataState] = useState({ barCount: 0, isLoading: false });
  const prefetchHistory = usePrefetchStockHistory();
  const {
    effectivePeriod,
    onLogicalRange: onChartLogicalRange,
    viewportKey: chartViewportKey,
    extended: chartExtended,
  } = useAutoExtendRange({
    symbol: selectedSymbol,
    period: timePeriod,
    interval: barInterval,
    barCount: chartDataState.barCount,
    isLoading: chartDataState.isLoading,
    enabled: heatmapChartType === "candle",
    onPrefetch: (p) => prefetchHistory(selectedSymbol, p, barInterval),
  });

  const areaHistQuery = useStockHistory(
    selectedSymbol,
    timePeriod,
    "",
    heatmapChartType !== "candle"
  );
  const candleHistQuery = useStockHistory(
    selectedSymbol,
    effectivePeriod,
    barInterval,
    heatmapChartType === "candle"
  );
  const historyQuery = heatmapChartType === "candle" ? candleHistQuery : areaHistQuery;

  const quote = quoteQuery.data;
  // Opening an event card re-renders MKT. Keep the filtered bars stable until
  // the query actually changes: a fresh array here cascades into new OHLCV and
  // makes ModularChart refill every series/overlay on each card click.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawChartData = useMemo(
    () => (historyQuery.data?.quotes ?? []).filter((q: any) => q.close != null),
    [historyQuery.data?.quotes]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData = useMemo(
    () =>
      rawChartData.map((q: any) => ({
        date: q.date,
        price: q.close,
        volume: q.volume ?? 0,
        label: fmtDateLabel(q.date, timePeriod),
      })),
    [rawChartData, timePeriod]
  );

  const chartTrend =
    chartData.length >= 2 ? chartData[chartData.length - 1].price >= chartData[0].price : true;
  const chartColor = chartTrend ? colors.positive : colors.negative;

  const hurst = useMemo(
    () => calcHurst(chartData.map((d: { price: number }) => d.price)),
    [chartData]
  );

  const quoteFields = useMemo(
    () =>
      quote
        ? // calcHurst needs >=2 R/S bucket sizes (8/16/32/64) to regress on —
          // that requires >=65 bars, else it silently falls back to a flat 0.5
          splitQuoteFields(quote, colors, chartData.length >= 65 ? hurst : null)
        : { live: [], stat: [] },
    [quote, colors, chartData.length, hurst]
  );

  // Volume stats
  const maxVolume = useMemo(
    () => Math.max(...chartData.map((d: { volume: number }) => d.volume), 1),
    [chartData]
  );
  const avgVolume = useMemo(() => {
    const vols = chartData.map((d: { volume: number }) => d.volume).filter((v: number) => v > 0);
    return vols.length > 0 ? vols.reduce((a: number, b: number) => a + b, 0) / vols.length : 0;
  }, [chartData]);

  // MACD data
  const macdData = useMemo(() => calcMACD(chartData), [chartData]);

  // OHLCV data for candlestick mode
  const heatmapOhlcv: OhlcvBar[] = useMemo(() => {
    if (!rawChartData.length) return [];
    const isIntraday =
      heatmapChartType === "candle"
        ? heatmapIsIntraday
        : timePeriod === "1d" || timePeriod === "5d";
    return (
      rawChartData
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((q: any) => q.open != null && q.high != null && q.low != null)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((q: any) => ({
          time: isIntraday
            ? Math.floor(new Date(q.date as string).getTime() / 1000)
            : (q.date as string).slice(0, 10),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume ?? undefined,
        }))
        .sort((a: OhlcvBar, b: OhlcvBar) =>
          typeof a.time === "number"
            ? (a.time as number) - (b.time as number)
            : (a.time as string).localeCompare(b.time as string)
        )
        .filter(
          (bar: OhlcvBar, i: number, arr: OhlcvBar[]) => i === 0 || bar.time !== arr[i - 1].time
        )
    );
  }, [rawChartData, timePeriod, heatmapChartType, barInterval]);

  /**
   * Indicators minus Fear & Greed (it has its own pane below the chart).
   *
   * Memoised because `ModularChart` treats this array's identity as structure:
   * a fresh `.filter()` result every render made it tear the chart down and
   * rebuild it on every single state change in this view — a keystroke in the
   * symbol box was enough.
   */
  const chartIndicators = useMemo(
    () => heatmapIndicators.filter((i) => i.id !== "fear-greed"),
    [heatmapIndicators]
  );

  // Fed back to the auto-extend hook, which runs before the query it drives and
  // so cannot read the result directly.
  useEffect(() => {
    setChartDataState((prev) =>
      prev.barCount === heatmapOhlcv.length && prev.isLoading === candleHistQuery.isFetching
        ? prev
        : { barCount: heatmapOhlcv.length, isLoading: candleHistQuery.isFetching }
    );
  }, [heatmapOhlcv.length, candleHistQuery.isFetching]);

  // Fallback only — the API now returns each row's real ticker as `item.symbol`
  // (see routers/market.py fetch_one). This map exists purely for the static
  // dataset (lib/marketData.ts, shown before the first API response lands) and
  // for any stale cached MarketItem from before that field existed. It MUST
  // mirror the `id` labels in lib/marketData.ts / the `indices` symbol_lists
  // rows exactly, or a click on that row silently resolves to the label text
  // itself — an invalid ticker with no data. (That mismatch is what made
  // several rows in TICK DATA look "broken": labels here had drifted from the
  // DB's actual labels after a rename.)
  const indexToSymbol = useCallback((id: string): string => {
    const map: Record<string, string> = {
      "DOW JONES": "^DJI",
      "S&P 500": "^GSPC",
      NASDAQ: "^IXIC",
      "S&P/TSX Comp": "^GSPTSE",
      "S&P/BMV IPC": "^MXX",
      IBOVESPA: "^BVSP",
      "Euro Stoxx 50": "^STOXX50E",
      "FTSE 100": "^FTSE",
      "CAC 40": "^FCHI",
      DAX: "^GDAXI",
      "IBEX 35": "^IBEX",
      "FTSE MIB": "FTSEMIB.MI",
      "OMX STKH30": "^OMX",
      "SWISS MKT": "^SSMI",
      NIKKEI: "^N225",
      "HANG SENG": "^HSI",
      "CSI 300": "000300.SS",
      "S&P/ASX 200": "^AXJO",
      "SET Index": "^SET.BK",
      KOSPI: "^KS11",
    };
    return map[id] ?? id;
  }, []);

  const handleTickSelect = useCallback(
    (item: MarketItem) => {
      setSelectedSymbol(item.symbol ?? indexToSymbol(item.id));
      setSelectedLabel(item.id);
      setSelectedTickId(item.id);
    },
    [indexToSymbol]
  );

  const handleRateSelect = useCallback((row: RateRowData) => {
    // Only 4 UST tenors have a yfinance series (^IRX/^FVX/^TNX/^TYX). For the
    // rest, highlight the row but leave BOTH the chart and its label alone —
    // relabelling the header to "US 7Y" while it still draws the previously
    // selected symbol would caption someone else's prices as a 7Y yield.
    setSelectedTickId(row.id);
    if (row.chartSymbol) {
      setSelectedSymbol(row.chartSymbol);
      setSelectedLabel(row.id);
    }
  }, []);

  const handleFxSelect = useCallback((pair: FxPair) => {
    setSelectedSymbol(pair.symbol); // e.g. "EURUSD=X"
    setSelectedLabel(pair.id);
    setSelectedTickId(pair.id);
  }, []);

  // Which feed fills the left panel's top slot. Restored after mount — the
  // server renders the default, so reading storage in the initializer would
  // be a hydration mismatch.
  const [leftFeed, setLeftFeed] = useState<LeftFeed>("watch");
  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_LEFT_FEED);
      if (LEFT_FEEDS.some((f) => f.key === v)) setLeftFeed(v as LeftFeed);
    } catch {
      /* private mode */
    }
  }, []);
  const selectLeftFeed = useCallback((f: LeftFeed) => {
    setLeftFeed(f);
    try {
      localStorage.setItem(LS_LEFT_FEED, f);
    } catch {
      /* ignore */
    }
  }, []);

  // Stable identity: PinnedAssets is memoised, and an inline arrow here made
  // it re-render (~30ms) on every MKT state change — a keystroke in SYMBOL.
  const handleWatchlistPick = useCallback((sym: string) => {
    setSelectedSymbol(sym);
    setSelectedLabel(sym);
  }, []);

  const handleSearchSubmit = useCallback(() => {
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    setSelectedSymbol(sym);
    setSelectedLabel(sym);
    setSelectedTickId(null);
    addToRecent(sym, sym);
    recordSearchHit(sym);
    setSearchInput("");
    setShowDropdown(false);
    setDropdownIdx(-1);
    searchRef.current?.blur();
  }, [searchInput, addToRecent]);

  const handleSelectSuggestion = useCallback(
    (symbol: string, name?: string) => {
      setSelectedSymbol(symbol);
      // Display normalisation is centralised in lib/symbol-display —
      // the real provider symbol stays in selectedSymbol for data fetches
      const dispSym = displaySymbol({ symbol });
      const dispName = name ? displayName({ symbol, shortname: name }) : "";
      setSelectedLabel(dispName ? `${dispSym} – ${dispName}` : dispSym);
      setSelectedTickId(null);
      addToRecent(symbol, dispName || dispSym);
      recordSearchHit(symbol);
      setSearchInput("");
      setSearchQuery("");
      setShowDropdown(false);
      setDropdownIdx(-1);
      searchRef.current?.blur();
    },
    [addToRecent]
  );

  const handleGoToEquity = useCallback(() => {
    if (selectedSymbol) {
      setStockSymbol(selectedSymbol);
      setCurrentView("stock");
    }
  }, [selectedSymbol, setStockSymbol, setCurrentView]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "f" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const tag = (ev.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        handleGoToEquity();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGoToEquity]);

  useEffect(() => {
    if (!selectedSymbol) {
      if (pins.length > 0) {
        setSelectedSymbol(pins[0].symbol);
        setSelectedLabel(pins[0].symbol);
      } else if (marketData?.americas?.length > 0) {
        const first = marketData.americas[0];
        setSelectedSymbol(first.symbol ?? indexToSymbol(first.id));
        setSelectedLabel(first.id);
        setSelectedTickId(first.id); // light the default row in the board too
      }
    }
  }, [pins, marketData, selectedSymbol, indexToSymbol]);

  const allMarketItems = [
    ...(marketData?.americas ?? []),
    ...(marketData?.emea ?? []),
    ...(marketData?.asiaPacific ?? []),
  ];
  // Indices + FX only. Rate rows are deliberately excluded: "yield up" means the
  // bond market fell, so counting them alongside "index up" would make the ▲/▼
  // tally mix two opposite meanings. Volatility rows are out for the same
  // reason — a green VIX is a bad day, not a good one.
  const upCount =
    allMarketItems.filter((m) => m.pctChange > 0).length +
    fxPairs.filter((p) => (p.pctChange ?? 0) > 0).length;
  const downCount =
    allMarketItems.filter((m) => m.pctChange < 0).length +
    fxPairs.filter((p) => (p.pctChange ?? 0) < 0).length;
  const tickRowCount =
    allMarketItems.length + usRates.length + jpRates.length + volItems.length + fxPairs.length;

  // ── Panel Renderers ─────────────────────────────────────────────────────────

  // Collapsed sidebar for any panel — vertical label + expand button
  /**
   * Collapsing used to leave a 36px rail carrying the panel name sideways. Two
   * folded panels cost 72px of chart for two words — the panel was closed
   * precisely because the chart wanted the room, and handing most of it back
   * but not all of it is the worst of both. A folded panel is now zero-width
   * and renders nothing at all; the way back is a chip in the chart's own
   * header row, which costs no width because that row already exists.
   */
  const renderWatchlistPanel = (isCollapsed: boolean) => {
    if (isCollapsed) return null;
    return (
      <div className="flex flex-col overflow-hidden h-full">
        {/* ── Watchlist section ── */}
        <div
          className="shrink-0 flex flex-col" // Phone: the drag handle is mouse-only and the stored pixel height was
          // sized for a desktop column, which left ~4 rows above the regime map.
          style={{ height: isMobile ? "60%" : watchlistHeight, minHeight: 100 }}
        >
          <div
            className="flex items-center gap-1 px-1 py-0.5 shrink-0"
            style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
          >
            <Activity className="h-2.5 w-2.5 shrink-0" style={{ color: colors.accent }} />
            {/* Same switcher shape as REGIME's CORR/GEOM/…/IV — one slot, three feeds. */}
            <div className="flex overflow-hidden border" style={{ borderColor: colors.border }}>
              {LEFT_FEEDS.map(({ key, label, desc }) => (
                <button
                  type="button"
                  key={key}
                  title={desc}
                  className="text-[8px] font-bold tracking-wider px-1.5 py-0 leading-4"
                  style={{
                    background: leftFeed === key ? `${colors.accent}20` : "transparent",
                    color: leftFeed === key ? colors.accent : colors.textSecondary,
                  }}
                  onClick={() => selectLeftFeed(key)}
                >
                  {label}
                  {key === "watch" && (
                    <span className="font-mono font-normal ml-0.5">{pins.length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                className="text-[8px] px-1 hover:opacity-70"
                style={{ color: colors.textSecondary }}
                title="Reset height"
                onClick={() => {
                  setWatchlistHeight(220);
                  try {
                    localStorage.setItem(LS_WATCHLIST_H, "220");
                  } catch {}
                }}
              >
                ↕
              </button>
              <button className="p-0.5" onClick={() => toggleCollapsed("watchlist")}>
                <ChevronUp className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
              </button>
            </div>
          </div>
          <div
            ref={watchlistContentRef}
            className="flex-1 overflow-y-auto overflow-x-hidden"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
          >
            {/* WATCHLIST stays mounted while hidden: remounting re-runs its DB
                bootstrap and drops any open add/edit form. */}
            <div style={{ display: leftFeed === "watch" ? undefined : "none" }}>
              <PinnedAssets onSymbolClick={handleWatchlistPick} />
            </div>
            {leftFeed === "freq" && (
              <FrequentSearchList colors={colors} onSymbolClick={handleWatchlistPick} />
            )}
            {leftFeed === "active" && (
              <MostActiveList colors={colors} onSymbolClick={handleWatchlistPick} />
            )}
          </div>
        </div>

        {/* Drag handle — splits watchlist / regime */}
        <div
          className="shrink-0 cursor-row-resize flex items-center justify-center hover:opacity-80 transition-opacity"
          style={{
            height: 8,
            background: "#111",
            borderTop: `1px solid ${colors.border}`,
            borderBottom: `1px solid ${colors.border}`,
          }}
          onMouseDown={handleWatchlistResizeStart}
          title="Drag to resize watchlist / regime"
        >
          <div className="w-10 h-px" style={{ background: colors.textSecondary, opacity: 0.4 }} />
        </div>

        {/* ── Regime Heatmap section — fills remaining space ── */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <SectorRegimeHeatmap colors={colors} isDark={isDark} symbol={selectedSymbol} />
        </div>
      </div>
    );
  };

  const renderTickDataPanel = (isCollapsed: boolean) => {
    if (isCollapsed) return null;
    return (
      <div className="flex flex-col overflow-hidden h-full">
        <div
          className="flex items-center gap-1 px-1 py-0.5 shrink-0"
          style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
        >
          <BarChart2 className="h-2.5 w-2.5" style={{ color: colors.accent }} />
          <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
            TICK DATA
          </span>
          <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
            ({tickRowCount})
          </span>
          <span className="text-[8px] ml-1">
            <span style={{ color: "#00FF00" }}>▲{upCount}</span>
            <span className="mx-0.5" style={{ color: colors.textSecondary }}>
              /
            </span>
            <span style={{ color: "#FF0000" }}>▼{downCount}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              title="Refresh"
              className="p-0.5 hover:opacity-70"
              onClick={refreshData}
              disabled={marketLoading}
            >
              {marketLoading ? (
                <Loader2
                  className="h-2.5 w-2.5 animate-spin"
                  style={{ color: colors.textSecondary }}
                />
              ) : (
                <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
              )}
            </button>
            <button className="p-0.5" onClick={() => toggleCollapsed("tickdata")}>
              <ChevronUp className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
            </button>
          </div>
        </div>
        <UsMarketClock colors={colors} />
        <div className="flex-1 overflow-y-auto overflow-x-hidden" style={SCROLLBAR_THIN_LIGHTER}>
          {
            <table
              className="w-full text-[9px] leading-[13px] font-mono"
              style={{ borderCollapse: "collapse" }}
            >
              <thead>
                <tr
                  className="text-[7px] font-bold tracking-wider leading-[12px]"
                  style={{
                    background: "#050505",
                    color: colors.textSecondary,
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                  }}
                >
                  <th className="px-1 py-0 text-left">NAME</th>
                  <th className="px-1 py-0 text-right">LAST</th>
                  <th className="px-1 py-0 text-right" title="%chg · bp for yields">
                    CHG
                  </th>
                  <th className="px-1 py-0 text-right">YTD</th>
                </tr>
              </thead>
              <tbody>
                {tickOrder.map((id) => {
                  const collapsed = collapsedSections.includes(id);
                  const header = (label: string, count: number, note?: string) => (
                    <RegionHeader
                      id={id}
                      label={label}
                      count={count}
                      colors={colors}
                      collapsed={collapsed}
                      onToggle={toggleSection}
                      note={note}
                      isDropTarget={tickDropTarget === id}
                      onDragStart={handleTickDragStart}
                      onDragOver={handleTickDragOver}
                      onDrop={handleTickDrop}
                      onDragEnd={handleTickDragEnd}
                    />
                  );

                  if (id === "ratesUS")
                    return (
                      <Fragment key={id}>
                        {header(
                          "RATES · US",
                          usRates.length,
                          ratesData?.usError ? "FRED key missing" : undefined
                        )}
                        {!collapsed && (
                          <TickNotice
                            colors={colors}
                            loading={ratesLoading}
                            error={ratesData?.usError}
                            empty={usRates.length === 0}
                          />
                        )}
                        {!collapsed &&
                          usRates.map((row) => (
                            <RateRow
                              key={row.id}
                              row={row}
                              cot={
                                COT_KEY_BY_RATE_ID[row.id]
                                  ? cotFlags.get(COT_KEY_BY_RATE_ID[row.id])
                                  : undefined
                              }
                              colors={colors}
                              isSelected={selectedTickId === row.id}
                              onSelect={handleRateSelect}
                            />
                          ))}
                      </Fragment>
                    );

                  if (id === "ratesJP")
                    return (
                      <Fragment key={id}>
                        {header(
                          "RATES · JP",
                          jpRates.length,
                          ratesData?.jpStale ? "MOF down — OECD monthly" : undefined
                        )}
                        {!collapsed && (
                          <TickNotice
                            colors={colors}
                            loading={ratesLoading}
                            empty={jpRates.length === 0}
                          />
                        )}
                        {!collapsed &&
                          jpRates.map((row) => (
                            <RateRow
                              key={row.id}
                              row={row}
                              colors={colors}
                              isSelected={selectedTickId === row.id}
                              onSelect={handleRateSelect}
                            />
                          ))}
                      </Fragment>
                    );

                  if (id === "americas" || id === "emea" || id === "asiaPacific") {
                    const label = {
                      americas: "AMERICAS",
                      emea: "EMEA",
                      asiaPacific: "ASIA PACIFIC",
                    }[id];
                    const items = marketData?.[id] ?? [];
                    return (
                      <Fragment key={id}>
                        {header(label, items.length)}
                        {!collapsed &&
                          items.map((item: MarketItem) => (
                            <TickRow
                              key={item.id}
                              item={item}
                              cot={cotForSymbol(item.symbol)}
                              colors={colors}
                              isSelected={selectedTickId === item.id}
                              onSelect={handleTickSelect}
                            />
                          ))}
                      </Fragment>
                    );
                  }

                  if (id === "volatility")
                    return (
                      <Fragment key={id}>
                        {header(
                          "VOLATILITY",
                          volItems.length,
                          volData?.error ? "feed unavailable" : undefined
                        )}
                        {!collapsed && (
                          <TickNotice
                            colors={colors}
                            loading={volLoading}
                            error={volData?.error}
                            empty={volItems.length === 0}
                          />
                        )}
                        {!collapsed &&
                          volItems.map((item, itemIndex) => (
                            <Fragment key={item.id}>
                              {item.group && item.group !== volItems[itemIndex - 1]?.group && (
                                <SubGroupHeader label={item.group} colors={colors} />
                              )}
                              <TickRow
                                item={item}
                                cot={cotForSymbol(item.symbol)}
                                colors={colors}
                                isSelected={selectedTickId === item.id}
                                onSelect={handleTickSelect}
                              />
                            </Fragment>
                          ))}
                      </Fragment>
                    );

                  return (
                    <Fragment key={id}>
                      {header("FX", fxPairs.length)}
                      {!collapsed &&
                        fxPairs.map((pair) => (
                          <FxRow
                            key={pair.symbol}
                            cot={cotForSymbol(pair.symbol)}
                            pair={pair}
                            colors={colors}
                            isSelected={selectedTickId === pair.id}
                            onSelect={handleFxSelect}
                          />
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          }
        </div>
      </div>
    );
  };

  /**
   * A folded panel reappears from the side it lives on, so its chip sits on
   * that side of the chart's header and points that way. `panelOrder` is
   * user-reorderable, so the side is read from the order rather than assumed.
   */
  const renderRestoreChip = (panelId: PanelId, side: "left" | "right") => (
    <button
      key={panelId}
      type="button"
      className="shrink-0 flex items-center gap-0.5 px-1 py-0.5 text-[8px] font-bold tracking-widest border hover:opacity-70"
      style={{ background: "#000", color: colors.accent, borderColor: colors.border }}
      title={`Show ${PANEL_LABELS[panelId]}`}
      onClick={() => toggleCollapsed(panelId)}
    >
      {side === "left" && <ChevronLeft className="h-2.5 w-2.5" />}
      {PANEL_LABELS[panelId]}
      {side === "right" && <ChevronRight className="h-2.5 w-2.5" />}
    </button>
  );

  const renderChartPanel = (_isCollapsed: boolean) => (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="relative shrink-0">
        <div
          className="flex items-center gap-1 px-1 py-0.5"
          style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
        >
          {collapsedLeft.map((id) => renderRestoreChip(id, "left"))}
          <Search className="h-2.5 w-2.5" style={{ color: colors.accent }} />
          <input
            ref={searchRef}
            className="text-[10px] font-mono font-bold px-1 py-0.5 border outline-none flex-1 uppercase"
            style={{
              background: "#000",
              color: colors.accent,
              borderColor: showDropdown ? colors.accent : colors.border,
            }}
            placeholder="SYMBOL <GO>"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value.toUpperCase());
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() =>
              setTimeout(() => {
                setShowDropdown(false);
                setDropdownIdx(-1);
              }, 150)
            }
            onKeyDown={(e) => {
              const apiItems: any[] = (searchResult.data as any[]) ?? [];
              const items =
                searchInput.length > 0
                  ? apiItems
                  : recentSymbols.map((r) => ({ symbol: r.symbol, shortname: r.name }));
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setDropdownIdx((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setDropdownIdx((i) => Math.max(i - 1, -1));
              } else if (e.key === "Enter") {
                if (dropdownIdx >= 0 && items[dropdownIdx]) {
                  const it = items[dropdownIdx];
                  handleSelectSuggestion(it.symbol, it.shortname);
                } else {
                  handleSearchSubmit();
                }
              } else if (e.key === "Escape") {
                setShowDropdown(false);
                setDropdownIdx(-1);
              }
            }}
          />
          <button
            className="text-[9px] px-1.5 py-0.5 font-bold"
            style={{ background: colors.accent, color: "#000" }}
            onClick={handleSearchSubmit}
          >
            GO
          </button>
          {collapsedRight.map((id) => renderRestoreChip(id, "right"))}
        </div>

        {/* Dropdown */}
        {showDropdown &&
          (() => {
            const apiItems: any[] = (searchResult.data as any[]) ?? [];
            const isTyping = searchInput.length > 0;
            const showRecent = !isTyping && recentSymbols.length > 0;
            const showResults = isTyping && apiItems.length > 0;
            const showLoading = isTyping && searchResult.isLoading;
            const showEmpty =
              isTyping &&
              !searchResult.isLoading &&
              apiItems.length === 0 &&
              searchQuery.length > 0;
            if (!showRecent && !showResults && !showLoading && !showEmpty) return null;
            return (
              <div
                className="absolute top-full left-0 right-0 z-50 border border-t-0 shadow-xl"
                style={{ backgroundColor: "#050505", borderColor: `${colors.accent}66` }}
              >
                {/* Recent searches */}
                {showRecent && (
                  <>
                    <div
                      className="flex items-center justify-between px-2 py-0.5"
                      style={{ borderBottom: `1px solid ${colors.border}`, background: "#0a0a0a" }}
                    >
                      <span
                        className="text-[8px] font-bold tracking-widest"
                        style={{ color: colors.textSecondary }}
                      >
                        RECENT
                      </span>
                      <button
                        className="text-[8px] hover:opacity-70"
                        style={{ color: colors.textSecondary }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setRecentSymbols([]);
                          try {
                            localStorage.removeItem(LS_RECENT);
                          } catch {}
                        }}
                      >
                        CLR
                      </button>
                    </div>
                    {recentSymbols.map((r, idx) => (
                      <button
                        key={r.symbol}
                        type="button"
                        className="w-full text-left px-2 py-1 text-[10px] flex items-center gap-2 border-b"
                        style={{
                          borderColor: colors.border,
                          color: colors.text,
                          background: dropdownIdx === idx ? "#0a1628" : "transparent",
                        }}
                        onMouseEnter={() => setDropdownIdx(idx)}
                        onMouseDown={() => handleSelectSuggestion(r.symbol, r.name)}
                      >
                        <span
                          className="font-bold font-mono w-16 shrink-0"
                          style={{ color: colors.accent }}
                          title={r.symbol}
                        >
                          {displaySymbol({ symbol: r.symbol })}
                        </span>
                        <span
                          className="truncate flex-1 text-[9px]"
                          style={{ color: colors.textSecondary }}
                        >
                          {r.name !== r.symbol ? r.name : ""}
                        </span>
                        <span
                          className="text-[8px] ml-auto"
                          style={{ color: `${colors.textSecondary}66` }}
                        >
                          ↩
                        </span>
                      </button>
                    ))}
                  </>
                )}

                {/* Loading */}
                {showLoading && (
                  <div
                    className="px-2 py-2 flex items-center gap-1.5 text-[10px]"
                    style={{ color: colors.textSecondary }}
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    SEARCHING...
                  </div>
                )}

                {/* No results */}
                {showEmpty && (
                  <div className="px-2 py-2 text-[10px]" style={{ color: colors.textSecondary }}>
                    NO RESULTS FOR "{searchQuery}"
                  </div>
                )}

                {/* API results */}
                {showResults && (
                  <>
                    <div
                      className="px-2 py-0.5"
                      style={{ borderBottom: `1px solid ${colors.border}`, background: "#0a0a0a" }}
                    >
                      <span
                        className="text-[8px] font-bold tracking-widest"
                        style={{ color: colors.textSecondary }}
                      >
                        RESULTS ({apiItems.length})
                      </span>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {apiItems.map((item: any, idx: number) => (
                        <button
                          key={item.symbol}
                          type="button"
                          className="w-full text-left px-2 py-1 text-[10px] flex items-center gap-2 border-b"
                          style={{
                            borderColor: colors.border,
                            color: colors.text,
                            background: dropdownIdx === idx ? "#0a1628" : "transparent",
                          }}
                          onMouseEnter={() => setDropdownIdx(idx)}
                          onMouseDown={() => handleSelectSuggestion(item.symbol, displayName(item))}
                        >
                          <span
                            className="font-bold font-mono w-16 shrink-0"
                            style={{ color: colors.accent }}
                            title={item.symbol}
                          >
                            {displaySymbol(item)}
                          </span>
                          <span className="truncate flex-1">{displayName(item)}</span>
                          <span
                            className="ml-auto shrink-0 text-[9px]"
                            style={{ color: colors.textSecondary }}
                          >
                            {item.exchDisp}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
      </div>

      {/* Symbol header — price, the live quote fields, and everything else behind
          DETAILS. This absorbed what used to be two more full-width rows (the
          quote summary bar and the extended-hours strip). Height is fixed at one
          line: every child is nowrap/shrink-0 except the company name, which
          takes the slack and truncates, so the row can never wrap or scroll. */}
      <div
        className="px-1 py-0.5 shrink-0 flex flex-nowrap items-center gap-2 overflow-hidden"
        style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
      >
        {selectedSymbol ? (
          <>
            <span
              className="text-sm font-bold font-mono whitespace-nowrap shrink-0"
              style={{ color: colors.accent }}
            >
              {selectedLabel || selectedSymbol}
            </span>
            {quote && (
              <>
                <span
                  className="text-sm font-bold font-mono whitespace-nowrap shrink-0"
                  style={{ color: colors.text }}
                >
                  {fmtQuote(selectedSymbol, quote.regularMarketPrice)}
                </span>
                <span
                  className="text-xs font-bold font-mono whitespace-nowrap shrink-0"
                  style={{
                    color: (quote.regularMarketChangePercent ?? 0) >= 0 ? "#00FF00" : "#FF0000",
                  }}
                >
                  {(quote.regularMarketChangePercent ?? 0) >= 0 ? "▲" : "▼"}
                  {fmtPct(quote.regularMarketChangePercent ?? 0)}
                </span>
                {/* The live quote fields (CHG, VOL) — the only ones that move
                    intraday, so the only ones worth permanent space. Clips
                    rather than pushing the row wider. */}
                <span className="flex items-center gap-2 text-[9px] font-mono min-w-0 overflow-hidden">
                  {quoteFields.live.map((f) => (
                    <FieldChip key={f.label} field={f} colors={colors} />
                  ))}
                </span>
                <QuoteStatsPopover fields={quoteFields.stat} colors={colors} />
                <MarketSessionBadge state={quote.marketState as string | undefined} compact />
                {/* Pre/after-hours price folded into the header instead of its own
                    full-width row below — it's only relevant outside regular hours,
                    so a dedicated row sat empty (or absent, shifting layout) most
                    of the trading day. */}
                <ExtendedHoursPrice
                  quote={quote}
                  positiveColor="#00FF00"
                  negativeColor="#FF0000"
                  hideLabel
                />
                {/* Gives up width first (flexShrink far above the default 1) and
                    truncates — the one field cheap enough to lose characters.
                    Everything left of it keeps its digits intact. */}
                {quote.shortName && (
                  <span
                    className="text-[9px] truncate flex-1 min-w-0"
                    style={{ color: colors.textSecondary, flexShrink: 100 }}
                  >
                    {quote.shortName}
                  </span>
                )}
              </>
            )}
            <button
              className="ml-auto shrink-0 text-[8px] px-1 py-0 border hover:opacity-70"
              style={{ borderColor: "#00FFFF44", color: "#00FFFF" }}
              onClick={handleGoToEquity}
            >
              FULL EQTY →
            </button>
          </>
        ) : (
          <span className="text-[10px]" style={{ color: colors.textSecondary }}>
            Select an index or search a symbol
          </span>
        )}
      </div>

      {/* Chart controls share one row when the panel is wide. In a narrow panel,
          indicators move beneath the timeframe so each control stays reachable. */}
      <TimeframeRow
        colors={colors}
        timePeriod={timePeriod as TimePeriod}
        barInterval={barInterval as BarInterval}
        chartType={heatmapChartType}
        onPeriodChange={(p) => handleHeatmapPeriod(p, heatmapChartType)}
        onIntervalChange={(iv) => handleHeatmapInterval(iv)}
        middle={
          heatmapChartType === "candle" ? (
            <div className="flex items-center gap-1 min-w-0 flex-1 whitespace-nowrap">
              <IndicatorPicker
                data={heatmapOhlcv}
                colors={colors}
                activeIndicators={heatmapIndicators}
                onAdd={addHeatmapIndicator}
                onRemove={removeHeatmapIndicator}
                windowUnit={heatmapWindowUnit}
                onToggleWindowUnit={toggleHeatmapWindowUnit}
                compact
              />
              {(() => {
                // Volume Profile needs traded volume, and several things reachable
                // from this view report none: calculated indices (^VIX, ^OVX — a
                // formula over option prices, nothing actually trades), yields
                // (^TNX) and FX (=X). Cash indices like ^GSPC/^DJI DO carry volume
                // (Yahoo sums the constituents), so this can't key off "is an index".
                // Show the button greyed out with a reason rather than unmounting
                // it, which reads as "the indicator vanished".
                const hasVolume = heatmapOhlcv.some((d) => (d.volume ?? 0) > 0);
                return (
                  <button
                    className="text-[8px] px-1 py-0 font-bold border"
                    style={{
                      borderColor: heatmapShowVP && hasVolume ? colors.accent : colors.border,
                      color: !hasVolume
                        ? colors.border
                        : heatmapShowVP
                          ? colors.accent
                          : colors.textSecondary,
                      background: heatmapShowVP && hasVolume ? `${colors.accent}15` : "transparent",
                      cursor: hasVolume ? "pointer" : "not-allowed",
                    }}
                    disabled={!hasVolume}
                    title={
                      hasVolume
                        ? "Volume Profile"
                        : "Volume Profile — this symbol reports no volume (calculated indices like VIX, plus yields and FX, quote a level with nothing trading behind it)"
                    }
                    onClick={toggleHeatmapVP}
                  >
                    VP
                  </button>
                );
              })()}
              {(() => {
                const hasVolume = heatmapOhlcv.some((d) => (d.volume ?? 0) > 0);
                return (
                  <button
                    className="text-[8px] px-1 py-0 font-bold border"
                    style={{
                      borderColor: heatmapShowVolumeEvents && hasVolume ? "#26a69a" : colors.border,
                      color: !hasVolume
                        ? colors.border
                        : heatmapShowVolumeEvents
                          ? "#26a69a"
                          : colors.textSecondary,
                      background:
                        heatmapShowVolumeEvents && hasVolume ? "#26a69a15" : "transparent",
                      cursor: hasVolume ? "pointer" : "not-allowed",
                    }}
                    disabled={!hasVolume}
                    title={
                      hasVolume
                        ? "Volume Events — classify each bar's participation against its result (climax / absorption / vacuum / breakout / no-demand / dry-up) as chips on the bars plus a list below"
                        : "Volume Events — this symbol reports no volume, so there is nothing to classify"
                    }
                    onClick={toggleHeatmapVolumeEvents}
                  >
                    VEVT
                  </button>
                );
              })()}
              <RegressionControls
                channels={mktRegressionChannels}
                activeId={mktActiveRegressionId}
                armed={mktRegressionArmed}
                pending={mktRegressionPending}
                options={mktRegressionOpts}
                onToggle={toggleMktRegression}
                onSelect={selectMktRegression}
                onRemove={removeMktRegression}
                onModeChange={setMktRegressionMode}
                border={colors.border}
                muted={colors.textSecondary}
              />
              {heatmapSupportsEvents && (
                <button
                  className="text-[8px] px-1 py-0 font-bold border"
                  style={{
                    borderColor: heatmapShowPE ? "#ba68c8" : colors.border,
                    color: heatmapShowPE ? "#ba68c8" : colors.textSecondary,
                    background: heatmapShowPE ? "#ba68c815" : "transparent",
                  }}
                  onClick={toggleHeatmapPE}
                  title="Toggle Trailing P/E history pane"
                >
                  P/E{heatmapShowPE && heatmapPeLoading ? "…" : ""}
                </button>
              )}
              {isCryptoSymbol && (
                <button
                  className="text-[8px] px-1 py-0 font-bold border"
                  style={{
                    borderColor: showFootprint ? "#ff9800" : colors.border,
                    color: showFootprint ? "#ff9800" : colors.textSecondary,
                    background: showFootprint ? "#ff980015" : "transparent",
                  }}
                  onClick={toggleFootprint}
                >
                  FP{footprintLoading ? "…" : ""}
                </button>
              )}
            </div>
          ) : null
        }
        trailing={
          <>
            {/* The period buttons keep showing what the user picked; this says
              how far the chart has actually loaded after zooming out past it. */}
            {chartExtended && (
              <span
                className="px-1 py-0 text-[8px] font-mono border"
                title={`Zoomed out past ${timePeriod.toUpperCase()} — history auto-extended to ${effectivePeriod.toUpperCase()}`}
                style={{ borderColor: colors.border, color: colors.textSecondary }}
              >
                {effectivePeriod.toUpperCase()}·AUTO
              </span>
            )}
            {/* Pop the current symbol into a free-floating window — the panel
              chart stays put, so this is "add a chart", not "move the chart". */}
            <button
              type="button"
              disabled={
                !selectedSymbol ||
                (chartWindows.length >= MAX_CHART_WINDOWS &&
                  !chartWindows.some((w) => w.symbol === selectedSymbol))
              }
              title={
                chartWindows.length >= MAX_CHART_WINDOWS
                  ? `Chart window limit reached (${MAX_CHART_WINDOWS})`
                  : "Pop out into a floating chart window"
              }
              className="flex items-center gap-0.5 px-1 py-0 text-[8px] font-mono border disabled:opacity-40"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
              onClick={() =>
                selectedSymbol &&
                openChartWindow({
                  symbol: selectedSymbol,
                  label: selectedLabel,
                  timePeriod,
                  barInterval,
                })
              }
            >
              <PictureInPicture2 className="h-2 w-2" /> POP
            </button>
            {/* Chart type toggle */}
            <div className="flex border overflow-hidden" style={{ borderColor: colors.border }}>
              <button
                className="flex items-center gap-0.5 px-1 py-0 text-[8px] font-mono transition-colors"
                style={{
                  backgroundColor: heatmapChartType === "area" ? colors.accent : "transparent",
                  color: heatmapChartType === "area" ? "#000" : colors.textSecondary,
                }}
                onClick={() => setHeatmapChartType("area")}
              >
                <LineChart className="h-2 w-2" /> AREA
              </button>
              <button
                className="flex items-center gap-0.5 px-1 py-0 text-[8px] font-mono transition-colors border-l"
                style={{
                  borderColor: colors.border,
                  backgroundColor: heatmapChartType === "candle" ? colors.accent : "transparent",
                  color: heatmapChartType === "candle" ? "#000" : colors.textSecondary,
                }}
                onClick={() => setHeatmapChartType("candle")}
              >
                <BarChart2 className="h-2 w-2" /> CANDLE
              </button>
            </div>
            {heatmapChartType === "area" && (
              <button
                className="text-[8px] px-1 py-0 font-bold"
                style={{
                  color: showVolume ? "#00FFFF" : colors.textSecondary,
                  background: showVolume ? "#00FFFF15" : "transparent",
                }}
                onClick={() => setShowVolume((v) => !v)}
              >
                VOL
              </button>
            )}
            {heatmapChartType === "area" && (
              <button
                className="text-[8px] px-1 py-0 font-bold"
                style={{
                  color: showMACD ? "#ff9800" : colors.textSecondary,
                  background: showMACD ? "#ff980015" : "transparent",
                }}
                onClick={() => setShowMACD((v) => !v)}
              >
                MACD
              </button>
            )}
            {quoteQuery.isLoading && (
              <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.accent }} />
            )}
          </>
        }
      />

      {/* Chart area */}
      <div
        className="flex-1 min-h-0 overflow-hidden px-0.5 py-0.5"
        style={{ background: "#050505" }}
      >
        {!selectedSymbol ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <BarChart2
                className="h-8 w-8 mx-auto mb-2 opacity-10"
                style={{ color: colors.textSecondary }}
              />
              <div className="text-[10px]" style={{ color: colors.textSecondary }}>
                Click a market index or search a symbol
              </div>
            </div>
          </div>
        ) : historyQuery.isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-[10px]" style={{ color: colors.textSecondary }}>
              No data for this period
            </span>
          </div>
        ) : heatmapChartType === "candle" ? (
          /* ── Candlestick (Modular Chart) ── */
          <div className="h-full flex flex-col">
            <div className="flex-1 min-h-0">
              <ModularChart
                data={heatmapOhlcv}
                isDark={isDark}
                colors={colors}
                height={240}
                indicators={chartIndicators}
                overlays={heatmapOverlays}
                eventMarkers={heatmapEventMarkers}
                referencePriceLine={extendedHoursPriceLine(quote)}
                onBarClick={handleMktChartClick}
                crosshairCursor={mktRegressionArmed}
                onLogicalRange={onChartLogicalRange}
                viewportKey={chartViewportKey}
              />
              {mktSelectedEvent && (
                <EventDetailPopover
                  markers={mktSelectedEvent.markers}
                  anchor={mktSelectedEvent.anchor}
                  data={heatmapOhlcv}
                  colors={colors}
                  symbol={selectedSymbol}
                  onClose={clearMktSelectedEvent}
                />
              )}
            </div>
            {fearGreedActiveInMkt && fearGreedMktQuery.data?.history && (
              <div className="shrink-0">
                <FearGreedPane data={fearGreedMktQuery.data.history} colors={colors} height={100} />
              </div>
            )}
            {heatmapShowPE && heatmapPeData?.history && heatmapPeData.history.length > 0 && (
              <div className="shrink-0">
                <PEPane
                  data={heatmapPeData.history}
                  stats={heatmapPeData.stats}
                  colors={colors}
                  height={100}
                />
              </div>
            )}
            {heatmapShowVolumeEvents && heatmapOhlcv.length > 0 && (
              <div className="shrink-0">
                <VolumeEventPanel data={heatmapOhlcv} colors={colors} />
              </div>
            )}
            {/* Chart footer stats */}
            <div
              className="shrink-0 flex justify-between text-[9px] font-mono px-1 py-0.5"
              style={{ borderTop: "1px solid #1a1a1a", color: colors.textSecondary }}
            >
              <span>
                O:
                <span style={{ color: colors.text }}>
                  {fmtQuote(selectedSymbol, chartData[0]?.price)}
                </span>
              </span>
              <span>
                H:
                <span style={{ color: colors.text }}>
                  {fmtQuote(
                    selectedSymbol,
                    Math.max(...chartData.map((d: { price: number }) => d.price))
                  )}
                </span>
              </span>
              <span>
                L:
                <span style={{ color: colors.text }}>
                  {fmtQuote(
                    selectedSymbol,
                    Math.min(...chartData.map((d: { price: number }) => d.price))
                  )}
                </span>
              </span>
              <span>
                C:
                <span style={{ color: colors.text }}>
                  {fmtQuote(selectedSymbol, chartData[chartData.length - 1]?.price)}
                </span>
              </span>
              <span style={{ color: chartColor }}>
                {chartTrend ? "▲" : "▼"}
                {Math.abs(
                  ((chartData[chartData.length - 1].price - chartData[0].price) /
                    chartData[0].price) *
                    100
                ).toFixed(2)}
                %
              </span>
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {/* Charts wrapper */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Price + Volume chart */}
              <div style={{ flex: showMACD ? "7" : "1", minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="heatmapPriceGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 8, fill: colors.textSecondary }}
                      tickLine={false}
                      axisLine={{ stroke: "#1a1a1a" }}
                      interval="preserveStartEnd"
                      minTickGap={40}
                      hide={showMACD}
                    />
                    {/* Price axis (left) */}
                    <YAxis
                      yAxisId="price"
                      tick={{ fontSize: 8, fill: colors.textSecondary }}
                      tickLine={false}
                      axisLine={{ stroke: "#1a1a1a" }}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) =>
                        v >= 10000
                          ? `${(v / 1000).toFixed(0)}k`
                          : v >= 1000
                            ? `${(v / 1000).toFixed(1)}k`
                            : v.toFixed(v < 10 ? 2 : 0)
                      }
                      width={45}
                    />
                    {/* Volume axis (right, hidden ticks) */}
                    {showVolume && (
                      <YAxis
                        yAxisId="volume"
                        orientation="right"
                        tick={false}
                        axisLine={false}
                        tickLine={false}
                        domain={[0, maxVolume * 4]}
                        width={0}
                      />
                    )}
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#111",
                        borderColor: colors.border,
                        color: colors.text,
                        fontSize: 10,
                        fontFamily: "monospace",
                        borderRadius: 0,
                        padding: "4px 6px",
                      }}
                      formatter={(v: number, name: string) => {
                        if (name === "volume") return [fmtVolShort(v), "Vol"];
                        return [fmtQuote(selectedSymbol, v), "Price"];
                      }}
                      labelStyle={{ color: colors.textSecondary }}
                    />
                    {/* Volume bars (behind price) */}
                    {showVolume && (
                      <Bar
                        yAxisId="volume"
                        dataKey="volume"
                        isAnimationActive={false}
                        barSize={chartData.length > 200 ? 1 : chartData.length > 100 ? 2 : 3}
                      >
                        {chartData.map((entry: { volume: number }, idx: number) => (
                          <Cell
                            key={idx}
                            fill={
                              entry.volume > avgVolume * 1.5
                                ? "#ff990044"
                                : entry.volume > avgVolume
                                  ? "#4ade8033"
                                  : "#33333344"
                            }
                          />
                        ))}
                      </Bar>
                    )}
                    {/* Price area */}
                    <Area
                      yAxisId="price"
                      type="monotone"
                      dataKey="price"
                      stroke={chartColor}
                      strokeWidth={1.5}
                      fill="url(#heatmapPriceGrad)"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* ── MACD Sub-chart ─────────────────────────────────────── */}
              {showMACD && (
                <div style={{ flex: "3", minHeight: 0, borderTop: "1px solid #1a1a1a" }}>
                  {/* MACD label */}
                  <div
                    className="flex items-center gap-2 px-1"
                    style={{ height: 14, background: "#050505" }}
                  >
                    <span className="text-[8px] font-bold font-mono" style={{ color: "#ff9800" }}>
                      MACD
                    </span>
                    <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
                      12,26,9
                    </span>
                    {macdData.length > 0 && macdData[macdData.length - 1].macd != null && (
                      <>
                        <span className="text-[7px] font-mono" style={{ color: "#42a5f5" }}>
                          MACD:{macdData[macdData.length - 1].macd?.toFixed(2)}
                        </span>
                        <span className="text-[7px] font-mono" style={{ color: "#ff9800" }}>
                          SIG:{macdData[macdData.length - 1].signal?.toFixed(2) ?? "—"}
                        </span>
                        <span
                          className="text-[7px] font-mono"
                          style={{
                            color:
                              (macdData[macdData.length - 1].histogram ?? 0) >= 0
                                ? "#4caf50"
                                : "#ef5350",
                          }}
                        >
                          HIST:{macdData[macdData.length - 1].histogram?.toFixed(2) ?? "—"}
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ height: "calc(100% - 14px)" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={macdData}
                        margin={{ top: 2, right: 5, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 8, fill: colors.textSecondary }}
                          tickLine={false}
                          axisLine={{ stroke: "#1a1a1a" }}
                          interval="preserveStartEnd"
                          minTickGap={40}
                        />
                        <YAxis
                          tick={{ fontSize: 7, fill: colors.textSecondary }}
                          tickLine={false}
                          axisLine={{ stroke: "#1a1a1a" }}
                          domain={["auto", "auto"]}
                          tickFormatter={(v: number) => v.toFixed(1)}
                          width={45}
                        />
                        <ReferenceLine y={0} stroke="#333" strokeWidth={1} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#111",
                            borderColor: colors.border,
                            color: colors.text,
                            fontSize: 10,
                            fontFamily: "monospace",
                            borderRadius: 0,
                            padding: "4px 6px",
                          }}
                          formatter={(v: unknown, name: string) => {
                            if (v == null || typeof v !== "number") return ["—", name];
                            const labels: Record<string, string> = {
                              macd: "MACD",
                              signal: "Signal",
                              histogram: "Hist",
                            };
                            return [v.toFixed(3), labels[name] ?? name];
                          }}
                          labelStyle={{ color: colors.textSecondary }}
                        />
                        {/* Histogram bars */}
                        <Bar
                          dataKey="histogram"
                          isAnimationActive={false}
                          barSize={chartData.length > 200 ? 1 : chartData.length > 100 ? 2 : 3}
                        >
                          {macdData.map((entry, idx) => (
                            <Cell
                              key={idx}
                              fill={
                                (entry.histogram ?? 0) >= 0
                                  ? idx > 0 &&
                                    (entry.histogram ?? 0) >= (macdData[idx - 1].histogram ?? 0)
                                    ? "#4caf50"
                                    : "#4caf5080"
                                  : idx > 0 &&
                                      (entry.histogram ?? 0) <= (macdData[idx - 1].histogram ?? 0)
                                    ? "#ef5350"
                                    : "#ef535080"
                              }
                            />
                          ))}
                        </Bar>
                        {/* MACD line */}
                        <Line
                          type="monotone"
                          dataKey="macd"
                          stroke="#42a5f5"
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls={false}
                        />
                        {/* Signal line */}
                        <Line
                          type="monotone"
                          dataKey="signal"
                          stroke="#ff9800"
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
            {/* end charts wrapper */}

            {/* Chart footer stats */}
            <div
              className="shrink-0 flex justify-between text-[9px] font-mono px-1 py-0.5"
              style={{ borderTop: "1px solid #1a1a1a", color: colors.textSecondary }}
            >
              <span>
                O:
                <span style={{ color: colors.text }}>
                  {fmtQuote(selectedSymbol, chartData[0]?.price)}
                </span>
              </span>
              <span>
                H:
                <span style={{ color: colors.text }}>
                  {fmtQuote(
                    selectedSymbol,
                    Math.max(...chartData.map((d: { price: number }) => d.price))
                  )}
                </span>
              </span>
              <span>
                L:
                <span style={{ color: colors.text }}>
                  {fmtQuote(
                    selectedSymbol,
                    Math.min(...chartData.map((d: { price: number }) => d.price))
                  )}
                </span>
              </span>
              <span>
                C:
                <span style={{ color: colors.text }}>
                  {fmtQuote(selectedSymbol, chartData[chartData.length - 1]?.price)}
                </span>
              </span>
              {showVolume && avgVolume > 0 && (
                <span>
                  AvgVol:<span style={{ color: colors.text }}>{fmtVolShort(avgVolume)}</span>
                </span>
              )}
              <span style={{ color: chartColor }}>
                {chartTrend ? "▲" : "▼"}
                {Math.abs(
                  ((chartData[chartData.length - 1].price - chartData[0].price) /
                    chartData[0].price) *
                    100
                ).toFixed(2)}
                %
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const panelRenderers: Record<PanelId, (collapsed: boolean) => React.ReactNode> = {
    watchlist: renderWatchlistPanel,
    chart: renderChartPanel,
    tickdata: renderTickDataPanel,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="h-full flex flex-col overflow-hidden relative"
      style={{ backgroundColor: "#000", color: colors.text }}
    >
      {showSettings && (
        <SettingsPanel
          layout={layout}
          onReorder={(order) => updateLayout({ panelOrder: order })}
          onReset={() => {
            localStorage.removeItem(LS_LAYOUT_KEY);
            setLayout(DEFAULT_LAYOUT);
            saveLayout(DEFAULT_LAYOUT);
          }}
          onClose={() => setShowSettings(false)}
          colors={colors}
        />
      )}

      {isMobile ? (
        // Phone: the three columns can't share 375px (the chart got squeezed
        // to nothing), so show one at a time. Desktop panel order, widths and
        // folds are left untouched — they belong to the desktop layout.
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div
            className="shrink-0 flex items-stretch"
            style={{ borderBottom: `1px solid ${colors.border}` }}
            role="tablist"
          >
            {(["watchlist", "chart", "tickdata"] as const).map((pid) => (
              <button
                key={pid}
                type="button"
                role="tab"
                aria-selected={mobilePanel === pid}
                onClick={() => setMobilePanel(pid)}
                className="flex-1 h-9 text-[11px] font-mono tracking-widest"
                style={{
                  color: mobilePanel === pid ? colors.accent : colors.textSecondary,
                  fontWeight: mobilePanel === pid ? 700 : 400,
                }}
              >
                {PANEL_LABELS[pid]}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">{panelRenderers[mobilePanel](false)}</div>
        </div>
      ) : (
        /* 3-Column customizable layout.

          The side panels hold their configured width; the chart absorbs
          whatever folding a panel frees. Before, every open panel had
          `flexGrow: 1`, so collapsing TICK DATA handed the watchlist half the
          freed space — it jumped from its 30% to ~45% and the divider could not
          pull it back, since its stored width was already at the 15% floor
          while the bonus stayed. A watchlist is a list: it needs the width the
          user gave it and no more. The chart is what benefits from the room. */
        <div ref={containerRef} className="flex-1 flex overflow-hidden min-h-0">
          {layout.panelOrder.map((panelId, idx) => {
            const isCollapsed = layout.collapsedPanels.includes(panelId);
            // Nothing is rendered for a folded panel — not a narrow one, none.
            if (isCollapsed) return null;
            // The next panel that is actually rendered — a folded one is not in
            // the row at all, so a divider must reach past it to the next open
            // panel or it would resize something invisible.
            const nextPanel = layout.panelOrder
              .slice(idx + 1)
              .find((id) => !layout.collapsedPanels.includes(id));
            const isFiller = panelId === fillerPanel;
            const showDivider = nextPanel != null;

            return (
              <div
                key={panelId}
                className="flex"
                style={
                  isFiller
                    ? // Explicit `minWidth: 0` rather than `auto`: a flex item
                      // never shrinks below its min-content width by default,
                      // and the chart's tables are wide enough to claim space
                      // back off the panel widths.
                      { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }
                    : {
                        flex: `0 0 ${layout.panelWidths[panelId]}%`,
                        minWidth: panelId === "watchlist" ? 260 : 0,
                      }
                }
              >
                {/* Panel content */}
                <div className="flex-1 overflow-hidden">{panelRenderers[panelId](isCollapsed)}</div>
                {showDivider && (
                  <ResizeDivider
                    onDrag={(delta) => handleResize(panelId, nextPanel, delta)}
                    colors={colors}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
