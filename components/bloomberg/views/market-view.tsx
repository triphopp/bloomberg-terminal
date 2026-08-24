"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Activity,
  BarChart2,
  Check,
  ChevronDown,
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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useSdBands } from "../chart/useSdBands";
import { ExtendedHoursPrice, MarketSessionBadge, staleMoveStyle } from "../core/market-session";
import { UsMarketClock } from "../core/us-market-clock";
import { type FxPair, useFxTicks } from "../hooks/useFxTicks";
import { useMarketDataQuery } from "../hooks/useMarketDataQuery";
import { type RateRowData, useRatesCurve } from "../hooks/useRatesCurve";
import { useStockHistory, useStockQuote, useStockSearch } from "../hooks/useStockData";
import { calcHurst } from "../lib/market-utils";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors, cn } from "../lib/theme-config";
import type { MarketItem } from "../types";
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
    return parsed;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

// ── TICK DATA sections ────────────────────────────────────────────────────────
// The board went from ~20 rows (indices only) to ~66 once the US/JP curves and
// FX moved in, so each section collapses independently.

const LS_TICK_SECTIONS = "bloomberg_tickdata_sections";

type TickSection =
  | "americas"
  | "emea"
  | "asiaPacific"
  | "ratesUS"
  | "ratesJP"
  | "volatility"
  | "fx";

const TICK_SECTIONS: TickSection[] = [
  "americas",
  "emea",
  "asiaPacific",
  "ratesUS",
  "ratesJP",
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

function TickRow({
  item,
  colors,
  isSelected,
  onClick,
}: {
  item: MarketItem;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onClick: () => void;
}) {
  const isUp = item.pctChange >= 0;
  const pctColor = isUp ? "#00FF00" : "#FF0000";
  // Dim + date a move that belongs to a session which has already ended, so a
  // closed market's last change cannot be misread as today's.
  const stale = staleMoveStyle(item);
  return (
    <tr
      className="cursor-pointer hover:bg-[#111] transition-colors"
      style={{
        background: isSelected ? "#0a1628" : undefined,
        borderBottom: "1px solid #1a1a1a",
        borderLeft: isSelected ? "2px solid #00FFFF" : "2px solid transparent",
      }}
      onClick={onClick}
    >
      <td className="px-1 py-0.5 text-left">
        <span
          className="font-bold text-[10px]"
          style={{ color: isSelected ? "#00FFFF" : colors.accent }}
        >
          {item.id}
        </span>
      </td>
      <td className="px-1 py-0.5 text-right font-bold text-[10px]" style={{ color: colors.text }}>
        {fmtPrice(item.value)}
      </td>
      <td
        className="px-1 py-0.5 text-right text-[10px]"
        style={{ color: pctColor, opacity: stale?.opacity }}
        title={stale?.title}
      >
        {isUp ? "+" : ""}
        {item.change.toFixed(2)}
      </td>
      <td
        className="px-1 py-0.5 text-right font-bold text-[10px]"
        style={{ color: pctColor }}
        title={stale?.title}
      >
        <span style={{ opacity: stale?.opacity }}>
          <span className="text-[8px]">{isUp ? "▲" : "▼"}</span> {fmtPct(item.pctChange)}
        </span>
        {stale?.tag && (
          <span className="text-[7px] ml-0.5 font-normal" style={{ color: colors.textSecondary }}>
            {stale.tag}
          </span>
        )}
      </td>
      <td className="px-1 py-0.5 text-right text-[9px]">
        {item.ytd !== 0 && (
          <span style={{ color: item.ytd >= 0 ? "#4ade80" : "#f87171" }}>{fmtPct(item.ytd)}</span>
        )}
      </td>
      <td className="px-0.5 py-0.5 w-[40px]">
        {item.sparkline1 && item.sparkline1.length > 2 && (
          <MiniSparkline data={item.sparkline1} color={pctColor} />
        )}
      </td>
    </tr>
  );
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const w = 36;
  const h = 12;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="block">
      <polyline fill="none" stroke={color} strokeWidth="1" points={points} />
    </svg>
  );
}

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
        colSpan={6}
        className="px-1 py-0 text-[8px] font-bold tracking-widest"
        style={{ background: "#080808", color: `${colors.textSecondary}cc` }}
      >
        <span className="pl-3">{label}</span>
      </td>
    </tr>
  );
}

function RegionHeader({
  label,
  count,
  colors,
  collapsed,
  onToggle,
  note,
}: {
  label: string;
  count: number;
  colors: typeof bloombergColors.dark;
  /** omit both to render a plain, non-interactive header */
  collapsed?: boolean;
  onToggle?: () => void;
  /** small right-aligned annotation, e.g. a stale-data warning */
  note?: string;
}) {
  const interactive = onToggle != null;
  return (
    <tr>
      <td
        colSpan={6}
        className={cn(
          "px-1 py-0.5 text-[9px] font-bold tracking-widest",
          interactive && "cursor-pointer hover:bg-[#141414]"
        )}
        style={{
          background: "#0a0a0a",
          color: colors.accent,
          borderBottom: `1px solid ${colors.border}`,
        }}
        onClick={onToggle}
      >
        <span className="inline-flex items-center gap-1 w-full">
          {interactive &&
            (collapsed ? (
              <ChevronRight className="h-2.5 w-2.5 shrink-0" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5 shrink-0" />
            ))}
          {label}{" "}
          <span className="font-mono" style={{ color: colors.textSecondary }}>
            ({count})
          </span>
          {note && (
            <span className="ml-auto font-mono text-[8px] normal-case" style={{ color: "#facc15" }}>
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
  if (error) {
    return (
      <tr>
        <td colSpan={6} className="px-2 py-1 text-[9px] font-mono" style={{ color: "#facc15" }}>
          {error}
        </td>
      </tr>
    );
  }
  if (loading) {
    return (
      <tr>
        <td
          colSpan={6}
          className="px-2 py-1 text-[9px] font-mono"
          style={{ color: colors.textSecondary }}
        >
          loading…
        </td>
      </tr>
    );
  }
  if (empty) {
    return (
      <tr>
        <td
          colSpan={6}
          className="px-2 py-1 text-[9px] font-mono"
          style={{ color: colors.textSecondary }}
        >
          no data
        </td>
      </tr>
    );
  }
  return null;
}

/** Yield row: value is a percentage and moves are basis points, not %chg.
 *  Colour follows MACRO's convention — yield up = red (bond price down). */
function RateRow({
  row,
  colors,
  isSelected,
  onClick,
}: {
  row: RateRowData;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onClick: () => void;
}) {
  const chg = row.changeBp;
  const chgColor =
    chg == null || chg === 0 ? colors.textSecondary : chg > 0 ? "#FF0000" : "#00FF00";
  const ytdColor = row.ytdBp >= 0 ? "#f87171" : "#4ade80";
  const chartable = row.chartSymbol != null;
  return (
    <tr
      className="cursor-pointer hover:bg-[#111] transition-colors"
      style={{
        background: isSelected ? "#0a1628" : undefined,
        borderBottom: "1px solid #1a1a1a",
        borderLeft: isSelected ? "2px solid #00FFFF" : "2px solid transparent",
      }}
      onClick={onClick}
      title={
        chartable
          ? `${row.id} — as of ${row.asOf}`
          : `${row.id} — as of ${row.asOf} · no intraday series for this tenor`
      }
    >
      <td className="px-1 py-0.5 text-left">
        <span
          className="font-bold text-[10px]"
          style={{
            color: isSelected ? "#00FFFF" : chartable ? colors.accent : colors.textSecondary,
          }}
        >
          {row.tenor}
        </span>
      </td>
      <td className="px-1 py-0.5 text-right font-bold text-[10px]" style={{ color: colors.text }}>
        {row.value.toFixed(3)}%
      </td>
      <td className="px-1 py-0.5 text-right text-[10px]" style={{ color: chgColor }}>
        {fmtBp(chg)}
      </td>
      {/* %CHG is meaningless on a yield (0.05% → 0.10% is not "+100%") */}
      <td className="px-1 py-0.5 text-right text-[9px]" style={{ color: colors.textSecondary }}>
        —
      </td>
      <td className="px-1 py-0.5 text-right text-[9px]">
        <span style={{ color: ytdColor }}>{fmtBp(row.ytdBp)}</span>
      </td>
      <td className="px-0.5 py-0.5 w-[40px]">
        {row.sparkline1?.length > 2 && <MiniSparkline data={row.sparkline1} color={chgColor} />}
      </td>
    </tr>
  );
}

/** FX row: rates need 5 decimals (3 for JPY crosses), not the 2 fmtPrice gives. */
function FxRow({
  pair,
  colors,
  isSelected,
  onClick,
}: {
  pair: FxPair;
  colors: typeof bloombergColors.dark;
  isSelected: boolean;
  onClick: () => void;
}) {
  const pct = pair.pctChange ?? 0;
  const isUp = pct >= 0;
  const pctColor = isUp ? "#00FF00" : "#FF0000";
  return (
    <tr
      className="cursor-pointer hover:bg-[#111] transition-colors"
      style={{
        background: isSelected ? "#0a1628" : undefined,
        borderBottom: "1px solid #1a1a1a",
        borderLeft: isSelected ? "2px solid #00FFFF" : "2px solid transparent",
      }}
      onClick={onClick}
    >
      <td className="px-1 py-0.5 text-left">
        <span
          className="font-bold text-[10px]"
          style={{ color: isSelected ? "#00FFFF" : colors.accent }}
        >
          {pair.id}
        </span>
      </td>
      <td className="px-1 py-0.5 text-right font-bold text-[10px]" style={{ color: colors.text }}>
        {fmtFxPrice(pair.id, pair.price)}
      </td>
      <td className="px-1 py-0.5 text-right text-[10px]" style={{ color: pctColor }}>
        {pair.change == null ? "—" : `${isUp ? "+" : ""}${fmtFxPrice(pair.id, pair.change)}`}
      </td>
      <td className="px-1 py-0.5 text-right font-bold text-[10px]" style={{ color: pctColor }}>
        <span className="text-[8px]">{isUp ? "▲" : "▼"}</span> {fmtPct(pct)}
      </td>
      {/* FX overview carries no YTD — left blank rather than faked */}
      <td className="px-1 py-0.5 text-right text-[9px]" />
      <td className="px-0.5 py-0.5 w-[40px]" />
    </tr>
  );
}

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

  // Which tick row is lit. Kept separate from selectedLabel — that captions
  // whatever the chart is drawing, and the two diverge for tenors with no
  // chartable series (clicking US 7Y must light the row without relabelling a
  // chart that is still showing something else).
  const [selectedTickId, setSelectedTickId] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<TickSection[]>(loadTickSections);
  useEffect(() => {
    try {
      localStorage.setItem(LS_TICK_SECTIONS, JSON.stringify(collapsedSections));
    } catch {
      /* ignore */
    }
  }, [collapsedSections]);
  const toggleSection = useCallback((id: TickSection) => {
    setCollapsedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
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
      const newLeft = Math.max(15, Math.min(60, newWidths[leftPanel] + deltaPct));
      const newRight = Math.max(15, Math.min(60, newWidths[rightPanel] - deltaPct));
      newWidths[leftPanel] = newLeft;
      newWidths[rightPanel] = newRight;
      const next = { ...prev, panelWidths: newWidths };
      saveLayout(next);
      return next;
    });
  }, []);

  // Selected symbol for chart
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
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
  const [watchlistHeight, setWatchlistHeight] = useState<number>(() => {
    try {
      return Number.parseInt(localStorage.getItem(LS_WATCHLIST_H) ?? "220", 10) || 220;
    } catch {
      return 220;
    }
  });

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
    regressionSel: mktRegressionSel,
    regressionArmed: mktRegressionArmed,
    regressionPending: mktRegressionPending,
    regressionOpts: mktRegressionOpts,
    toggleRegression: toggleMktRegression,
    setRegressionMode: setMktRegressionMode,
    handleChartClick: handleMktChartClick,
    toggleVolumeProfile: toggleHeatmapVP,
    showEvents: heatmapShowEvents,
    toggleEvents: toggleHeatmapEvents,
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
  const areaHistQuery = useStockHistory(selectedSymbol, timePeriod);
  const candleHistQuery = useStockHistory(selectedSymbol, timePeriod, barInterval);
  const historyQuery = heatmapChartType === "candle" ? candleHistQuery : areaHistQuery;

  const quote = quoteQuery.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawChartData = (historyQuery.data?.quotes ?? []).filter((q: any) => q.close != null);
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

  const handleSearchSubmit = useCallback(() => {
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    setSelectedSymbol(sym);
    setSelectedLabel(sym);
    setSelectedTickId(null);
    addToRecent(sym, sym);
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
  const renderCollapsedPanel = (panelId: PanelId) => (
    <div
      className="flex flex-col items-center h-full cursor-pointer hover:bg-[#111] transition-colors"
      style={{ background: "#0a0a0a", borderRight: `1px solid ${colors.border}` }}
      onClick={() => toggleCollapsed(panelId)}
    >
      <ChevronDown className="h-3 w-3 mt-1 mb-1 shrink-0" style={{ color: colors.textSecondary }} />
      <div className="flex-1 flex items-start justify-center pt-1">
        <span
          className="text-[9px] font-bold tracking-widest"
          style={{ color: colors.accent, writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {PANEL_LABELS[panelId]}
        </span>
      </div>
    </div>
  );

  const renderWatchlistPanel = (isCollapsed: boolean) => {
    if (isCollapsed) return renderCollapsedPanel("watchlist");
    return (
      <div className="flex flex-col overflow-hidden h-full">
        {/* ── Watchlist section ── */}
        <div className="shrink-0 flex flex-col" style={{ height: watchlistHeight, minHeight: 100 }}>
          <div
            className="flex items-center gap-1 px-1 py-0.5 shrink-0"
            style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
          >
            <Activity className="h-2.5 w-2.5" style={{ color: colors.accent }} />
            <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              WATCHLIST
            </span>
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              ({pins.length})
            </span>
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
            <PinnedAssets
              onSymbolClick={(sym) => {
                setSelectedSymbol(sym);
                setSelectedLabel(sym);
              }}
            />
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
          <SectorRegimeHeatmap colors={colors} isDark={isDark} />
        </div>
      </div>
    );
  };

  const renderTickDataPanel = (isCollapsed: boolean) => {
    if (isCollapsed) return renderCollapsedPanel("tickdata");
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
            <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#050505", position: "sticky", top: 0, zIndex: 1 }}>
                  <th
                    className="px-1 py-0.5 text-left text-[8px] font-bold tracking-wider"
                    style={{ color: colors.textSecondary }}
                  >
                    INDEX
                  </th>
                  <th
                    className="px-1 py-0.5 text-right text-[8px] font-bold tracking-wider"
                    style={{ color: colors.textSecondary }}
                  >
                    LAST
                  </th>
                  <th
                    className="px-1 py-0.5 text-right text-[8px] font-bold tracking-wider"
                    style={{ color: colors.textSecondary }}
                  >
                    CHG
                  </th>
                  <th
                    className="px-1 py-0.5 text-right text-[8px] font-bold tracking-wider"
                    style={{ color: colors.textSecondary }}
                  >
                    %CHG
                  </th>
                  <th
                    className="px-1 py-0.5 text-right text-[8px] font-bold tracking-wider"
                    style={{ color: colors.textSecondary }}
                  >
                    YTD
                  </th>
                  <th className="px-1 py-0.5 w-[40px]" />
                </tr>
              </thead>
              <tbody>
                {/* ── RATES · US — full UST curve, FRED daily ── */}
                <RegionHeader
                  label="RATES · US"
                  count={usRates.length}
                  colors={colors}
                  collapsed={collapsedSections.includes("ratesUS")}
                  onToggle={() => toggleSection("ratesUS")}
                  note={ratesData?.usError ? "FRED key missing" : undefined}
                />
                {!collapsedSections.includes("ratesUS") && (
                  <TickNotice
                    colors={colors}
                    loading={ratesLoading}
                    error={ratesData?.usError}
                    empty={usRates.length === 0}
                  />
                )}
                {!collapsedSections.includes("ratesUS") &&
                  usRates.map((row) => (
                    <RateRow
                      key={row.id}
                      row={row}
                      colors={colors}
                      isSelected={selectedTickId === row.id}
                      onClick={() => handleRateSelect(row)}
                    />
                  ))}

                {/* ── RATES · JP — full JGB curve, MOF daily ── */}
                <RegionHeader
                  label="RATES · JP"
                  count={jpRates.length}
                  colors={colors}
                  collapsed={collapsedSections.includes("ratesJP")}
                  onToggle={() => toggleSection("ratesJP")}
                  note={ratesData?.jpStale ? "MOF down — OECD monthly" : undefined}
                />
                {!collapsedSections.includes("ratesJP") && (
                  <TickNotice colors={colors} loading={ratesLoading} empty={jpRates.length === 0} />
                )}
                {!collapsedSections.includes("ratesJP") &&
                  jpRates.map((row) => (
                    <RateRow
                      key={row.id}
                      row={row}
                      colors={colors}
                      isSelected={selectedTickId === row.id}
                      onClick={() => handleRateSelect(row)}
                    />
                  ))}

                {(
                  [
                    ["americas", "AMERICAS", marketData?.americas],
                    ["emea", "EMEA", marketData?.emea],
                    ["asiaPacific", "ASIA PACIFIC", marketData?.asiaPacific],
                  ] as [TickSection, string, MarketItem[] | undefined][]
                ).map(([id, label, items]) => (
                  <Fragment key={id}>
                    <RegionHeader
                      label={label}
                      count={items?.length ?? 0}
                      colors={colors}
                      collapsed={collapsedSections.includes(id)}
                      onToggle={() => toggleSection(id)}
                    />
                    {!collapsedSections.includes(id) &&
                      (items ?? []).map((item: MarketItem) => (
                        <TickRow
                          key={item.id}
                          item={item}
                          colors={colors}
                          isSelected={selectedTickId === item.id}
                          onClick={() => handleTickSelect(item)}
                        />
                      ))}
                  </Fragment>
                ))}

                {/* ── VOLATILITY — the VIX family, grouped by what each one
                    is priced off. Sub-headers rather than one flat list: the
                    S&P term structure only means something read in order. ── */}
                <RegionHeader
                  label="VOLATILITY"
                  count={volItems.length}
                  colors={colors}
                  collapsed={collapsedSections.includes("volatility")}
                  onToggle={() => toggleSection("volatility")}
                  note={volData?.error ? "feed unavailable" : undefined}
                />
                {!collapsedSections.includes("volatility") && (
                  <TickNotice
                    colors={colors}
                    loading={volLoading}
                    error={volData?.error}
                    empty={volItems.length === 0}
                  />
                )}
                {!collapsedSections.includes("volatility") &&
                  volItems.map((item, idx) => (
                    <Fragment key={item.id}>
                      {item.group && item.group !== volItems[idx - 1]?.group && (
                        <SubGroupHeader label={item.group} colors={colors} />
                      )}
                      <TickRow
                        item={item}
                        colors={colors}
                        isSelected={selectedTickId === item.id}
                        onClick={() => handleTickSelect(item)}
                      />
                    </Fragment>
                  ))}

                {/* ── FX — moved here from the removed FX [E] view ── */}
                <RegionHeader
                  label="FX"
                  count={fxPairs.length}
                  colors={colors}
                  collapsed={collapsedSections.includes("fx")}
                  onToggle={() => toggleSection("fx")}
                />
                {!collapsedSections.includes("fx") &&
                  fxPairs.map((pair) => (
                    <FxRow
                      key={pair.symbol}
                      pair={pair}
                      colors={colors}
                      isSelected={selectedTickId === pair.id}
                      onClick={() => handleFxSelect(pair)}
                    />
                  ))}
              </tbody>
            </table>
          }
        </div>
      </div>
    );
  };

  const renderChartPanel = (_isCollapsed: boolean) => (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="relative shrink-0">
        <div
          className="flex items-center gap-1 px-1 py-0.5"
          style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
        >
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

      {/* Period + bar interval + chart type — one row that never wraps.
          Same control the popped-out chart windows use (chart/TimeframeRow). */}
      <TimeframeRow
        colors={colors}
        timePeriod={timePeriod as TimePeriod}
        barInterval={barInterval as BarInterval}
        chartType={heatmapChartType}
        onPeriodChange={(p) => handleHeatmapPeriod(p, heatmapChartType)}
        onIntervalChange={(iv) => handleHeatmapInterval(iv)}
        trailing={
          <>
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

      {/* Indicator picker bar (candle mode only) */}
      {heatmapChartType === "candle" && (
        <div
          className="flex items-center gap-1 px-1 py-0.5 shrink-0"
          style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
        >
          <IndicatorPicker
            colors={colors}
            activeIndicators={heatmapIndicators}
            onAdd={addHeatmapIndicator}
            onRemove={removeHeatmapIndicator}
            windowUnit={heatmapWindowUnit}
            onToggleWindowUnit={toggleHeatmapWindowUnit}
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
          <button
            className="text-[8px] px-1 py-0 font-bold border"
            title={
              mktRegressionSel
                ? "Clear regression channel"
                : mktRegressionArmed
                  ? "Click two bars on the chart to set the range (click again to cancel)"
                  : "Regression Channel: click two bars to fit a trend + channel"
            }
            style={{
              borderColor: mktRegressionArmed || mktRegressionSel ? "#ffc107" : colors.border,
              color: mktRegressionArmed || mktRegressionSel ? "#ffc107" : colors.textSecondary,
              background: mktRegressionArmed || mktRegressionSel ? "#ffc10715" : "transparent",
            }}
            onClick={toggleMktRegression}
          >
            {mktRegressionArmed ? (mktRegressionPending ? "REG 2/2" : "REG 1/2") : "REG"}
          </button>
          {mktRegressionSel && (
            <button
              className="text-[8px] px-1 py-0 font-bold border"
              title={
                mktRegressionOpts.mode === "stddev"
                  ? "Rails at \u00b1k\u03c3 of the residuals (symmetric). Click for quantile rails."
                  : "Rails fitted as conditional quantiles (asymmetric). Click for \u00b1k\u03c3 rails."
              }
              style={{ borderColor: "#ffc107", color: "#ffc107", background: "#ffc10708" }}
              onClick={() =>
                setMktRegressionMode(mktRegressionOpts.mode === "stddev" ? "quantile" : "stddev")
              }
            >
              {mktRegressionOpts.mode === "stddev"
                ? `${mktRegressionOpts.stdDevMult}\u03c3`
                : `q${mktRegressionOpts.tauPct}`}
            </button>
          )}
          {heatmapSupportsEvents && (
            <button
              className="text-[8px] px-1 py-0 font-bold border"
              style={{
                borderColor: heatmapShowEvents ? "#4fc3f7" : colors.border,
                color: heatmapShowEvents ? "#4fc3f7" : colors.textSecondary,
                background: heatmapShowEvents ? "#4fc3f715" : "transparent",
              }}
              onClick={toggleHeatmapEvents}
              title="Toggle Events (Dividends, Earnings, Splits)"
            >
              EVT
            </button>
          )}
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
      )}

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
                indicators={heatmapIndicators.filter((i) => i.id !== "fear-greed")}
                overlays={heatmapOverlays}
                eventMarkers={heatmapEventMarkers}
                onBarClick={handleMktChartClick}
                crosshairCursor={mktRegressionArmed}
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

      {/* 3-Column customizable layout */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden min-h-0">
        {layout.panelOrder.map((panelId, idx) => {
          const isCollapsed = layout.collapsedPanels.includes(panelId);
          const width = isCollapsed ? "36px" : `${layout.panelWidths[panelId]}%`;

          return (
            <div
              key={panelId}
              className="flex"
              style={{
                width,
                minWidth: isCollapsed ? 36 : panelId === "watchlist" ? 260 : undefined,
                flexShrink: isCollapsed ? 0 : 1,
                flexGrow: isCollapsed ? 0 : 1,
              }}
            >
              {/* Panel content */}
              <div className="flex-1 overflow-hidden">{panelRenderers[panelId](isCollapsed)}</div>
              {/* Resize divider (not after last panel) */}
              {idx < layout.panelOrder.length - 1 && !isCollapsed && (
                <ResizeDivider
                  onDrag={(delta) => handleResize(panelId, layout.panelOrder[idx + 1], delta)}
                  colors={colors}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
