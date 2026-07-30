"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import {
  Activity,
  BarChart2,
  ChevronDown,
  ChevronUp,
  GripVertical,
  LineChart,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  BAR_INTERVALS,
  INTERVAL_LABEL,
  INTERVAL_VALID_RANGES,
  IndicatorPicker,
  ModularChart,
  PERIOD_LABEL,
  TIME_PERIODS,
  useChartIndicators,
  useChartTimeframe,
} from "../chart";
import type { BarInterval, IndicatorRegistryEntry, OhlcvBar, TimePeriod } from "../chart";
import { FearGreedPane } from "../chart/FearGreedPane";
import { PEPane } from "../chart/PEPane";
import { ExtendedHoursPrice, MarketSessionBadge } from "../core/market-session";
import { useMarketDataQuery } from "../hooks/useMarketDataQuery";
import { useStockHistory, useStockQuote, useStockSearch } from "../hooks/useStockData";
import { calcHurst } from "../lib/market-utils";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors } from "../lib/theme-config";
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
      <td className="px-1 py-0.5 text-right text-[10px]" style={{ color: pctColor }}>
        {isUp ? "+" : ""}
        {item.change.toFixed(2)}
      </td>
      <td className="px-1 py-0.5 text-right font-bold text-[10px]" style={{ color: pctColor }}>
        <span className="text-[8px]">{isUp ? "▲" : "▼"}</span> {fmtPct(item.pctChange)}
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

function RegionHeader({
  label,
  count,
  colors,
}: { label: string; count: number; colors: typeof bloombergColors.dark }) {
  return (
    <tr>
      <td
        colSpan={6}
        className="px-1 py-0.5 text-[9px] font-bold tracking-widest"
        style={{
          background: "#0a0a0a",
          color: colors.accent,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        {label}{" "}
        <span className="font-mono" style={{ color: colors.textSecondary }}>
          ({count})
        </span>
      </td>
    </tr>
  );
}

// ── Quote Summary Bar ─────────────────────────────────────────────────────────

function QuoteSummaryBar({
  quote,
  colors,
  hurst,
}: { quote: Record<string, unknown>; colors: typeof bloombergColors.dark; hurst?: number | null }) {
  const q = quote as Record<string, number | string | null | undefined>;
  const price = q.regularMarketPrice as number | undefined;
  const chg = q.regularMarketChange as number | undefined;
  const pct = q.regularMarketChangePercent as number | undefined;
  const isUp = (pct ?? 0) >= 0;
  const pctColor = isUp ? "#00FF00" : "#FF0000";
  const items: { label: string; value: string; color?: string }[] = [];
  if (price != null) items.push({ label: "LAST", value: `$${fmtPrice(price)}` });
  if (chg != null)
    items.push({
      label: "CHG",
      value: `${isUp ? "+" : ""}${(chg as number).toFixed(2)}`,
      color: pctColor,
    });
  if (pct != null) items.push({ label: "%CHG", value: fmtPct(pct as number), color: pctColor });
  if (q.regularMarketVolume != null)
    items.push({ label: "VOL", value: fmtCompact(q.regularMarketVolume as number) });
  if (q.marketCap != null) items.push({ label: "MCAP", value: fmtCompact(q.marketCap as number) });
  if (q.trailingPE != null)
    items.push({ label: "P/E", value: (q.trailingPE as number).toFixed(1) });
  if (q.beta != null) items.push({ label: "BETA", value: (q.beta as number).toFixed(2) });
  if (q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh != null)
    items.push({
      label: "52W",
      value: `${fmtPrice(q.fiftyTwoWeekLow as number)}-${fmtPrice(q.fiftyTwoWeekHigh as number)}`,
    });
  if (q.dividendYield != null && (q.dividendYield as number) > 0) {
    const yieldPct = (q.dividendYield as number) * 100;
    const eps = q.epsTrailingTwelveMonths as number | undefined;
    const divRate = (yieldPct / 100) * (price ?? 0);
    // Sanity check: hide if yield > 30% or payout ratio > 200% (bad/stale Yahoo data)
    const payoutOk = !eps || eps <= 0 || divRate / eps < 2.0;
    if (yieldPct < 30 && payoutOk)
      items.push({ label: "DIV", value: `${yieldPct.toFixed(2)}%`, color: "#4ade80" });
  }
  if (q.epsTrailingTwelveMonths != null)
    items.push({ label: "EPS", value: `$${(q.epsTrailingTwelveMonths as number).toFixed(2)}` });
  if (q.regularMarketOpen != null)
    items.push({ label: "OPEN", value: `$${fmtPrice(q.regularMarketOpen as number)}` });
  if (q.regularMarketPreviousClose != null)
    items.push({ label: "PREV", value: `$${fmtPrice(q.regularMarketPreviousClose as number)}` });
  if (hurst != null) {
    const hColor = hurst < 0.45 ? colors.positive : hurst > 0.55 ? colors.negative : colors.text;
    const hLabel = hurst < 0.45 ? "mean-reverting" : hurst > 0.55 ? "trending" : "random walk";
    items.push({ label: "HURST", value: `${hurst.toFixed(3)} (${hLabel})`, color: hColor });
  }

  return (
    <div
      className="flex flex-wrap gap-x-2 gap-y-0 px-1 py-0.5 text-[9px] font-mono"
      style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
    >
      {items.map((it) => (
        <span key={it.label}>
          <span style={{ color: colors.textSecondary }}>{it.label}:</span>
          <span className="font-bold ml-0.5" style={{ color: it.color ?? colors.text }}>
            {it.value}
          </span>
        </span>
      ))}
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

  const setCurrentView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
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
    },
    [indexToSymbol]
  );

  const handleSearchSubmit = useCallback(() => {
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    setSelectedSymbol(sym);
    setSelectedLabel(sym);
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
      }
    }
  }, [pins, marketData, selectedSymbol, indexToSymbol]);

  const allMarketItems = [
    ...(marketData?.americas ?? []),
    ...(marketData?.emea ?? []),
    ...(marketData?.asiaPacific ?? []),
  ];
  const upCount = allMarketItems.filter((m) => m.pctChange > 0).length;
  const downCount = allMarketItems.filter((m) => m.pctChange < 0).length;

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
            ({allMarketItems.length})
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
                <RegionHeader
                  label="AMERICAS"
                  count={marketData?.americas?.length ?? 0}
                  colors={colors}
                />
                {(marketData?.americas ?? []).map((item: MarketItem) => (
                  <TickRow
                    key={item.id}
                    item={item}
                    colors={colors}
                    isSelected={selectedLabel === item.id}
                    onClick={() => handleTickSelect(item)}
                  />
                ))}
                <RegionHeader label="EMEA" count={marketData?.emea?.length ?? 0} colors={colors} />
                {(marketData?.emea ?? []).map((item: MarketItem) => (
                  <TickRow
                    key={item.id}
                    item={item}
                    colors={colors}
                    isSelected={selectedLabel === item.id}
                    onClick={() => handleTickSelect(item)}
                  />
                ))}
                <RegionHeader
                  label="ASIA PACIFIC"
                  count={marketData?.asiaPacific?.length ?? 0}
                  colors={colors}
                />
                {(marketData?.asiaPacific ?? []).map((item: MarketItem) => (
                  <TickRow
                    key={item.id}
                    item={item}
                    colors={colors}
                    isSelected={selectedLabel === item.id}
                    onClick={() => handleTickSelect(item)}
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

      {/* Symbol header */}
      <div
        className="px-1 py-0.5 shrink-0 flex items-center gap-2"
        style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
      >
        {selectedSymbol ? (
          <>
            <span className="text-sm font-bold font-mono" style={{ color: colors.accent }}>
              {selectedLabel || selectedSymbol}
            </span>
            {quote && (
              <>
                <span className="text-sm font-bold font-mono" style={{ color: colors.text }}>
                  ${fmtPrice(quote.regularMarketPrice)}
                </span>
                <span
                  className="text-xs font-bold font-mono"
                  style={{
                    color: (quote.regularMarketChangePercent ?? 0) >= 0 ? "#00FF00" : "#FF0000",
                  }}
                >
                  {(quote.regularMarketChangePercent ?? 0) >= 0 ? "▲" : "▼"}
                  {fmtPct(quote.regularMarketChangePercent ?? 0)}
                </span>
                {quote.shortName && (
                  <span className="text-[9px] truncate" style={{ color: colors.textSecondary }}>
                    {quote.shortName}
                  </span>
                )}
                <MarketSessionBadge state={quote.marketState as string | undefined} />
              </>
            )}
            <button
              className="ml-auto text-[8px] px-1 py-0 border hover:opacity-70"
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

      {/* Quote details */}
      {quote && (
        <QuoteSummaryBar
          quote={quote}
          colors={colors}
          // calcHurst needs >=2 R/S bucket sizes (8/16/32/64) to regress on —
          // that requires >=65 bars, else it silently falls back to a flat 0.5
          hurst={chartData.length >= 65 ? hurst : null}
        />
      )}
      {quote && (
        <div
          className="px-2 py-0.5 shrink-0"
          style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
        >
          <ExtendedHoursPrice quote={quote} positiveColor="#00FF00" negativeColor="#FF0000" />
        </div>
      )}

      {/* Time period tabs + chart type + volume toggle */}
      <div
        className="flex items-center gap-0 px-1 py-0.5 shrink-0"
        style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
      >
        {TIME_PERIODS.map((p) => {
          const active = p === timePeriod;
          const validRanges =
            heatmapChartType === "candle"
              ? INTERVAL_VALID_RANGES[barInterval as BarInterval]
              : null;
          const disabled = validRanges ? !validRanges.includes(p as TimePeriod) : false;
          return (
            <button
              key={p}
              className="text-[9px] font-bold font-mono px-1.5 py-0.5"
              disabled={disabled}
              style={{
                background: active ? colors.accent : "transparent",
                color: disabled
                  ? `${colors.textSecondary}44`
                  : active
                    ? "#000"
                    : colors.textSecondary,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
              onClick={() => handleHeatmapPeriod(p as TimePeriod, heatmapChartType)}
            >
              {PERIOD_LABEL[p as TimePeriod]}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
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
        </div>
      </div>

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
          {heatmapOhlcv.some((d) => (d.volume ?? 0) > 0) && (
            <button
              className="text-[8px] px-1 py-0 font-bold border"
              style={{
                borderColor: heatmapShowVP ? colors.accent : colors.border,
                color: heatmapShowVP ? colors.accent : colors.textSecondary,
                background: heatmapShowVP ? `${colors.accent}15` : "transparent",
              }}
              onClick={toggleHeatmapVP}
            >
              VP
            </button>
          )}
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

      {/* Timeframe interval row (candle mode only) */}
      {heatmapChartType === "candle" && (
        <div
          className="flex items-center gap-1 px-1 py-0.5 shrink-0"
          style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
        >
          <span className="text-[9px] font-mono mr-1" style={{ color: colors.textSecondary }}>
            TF
          </span>
          {BAR_INTERVALS.map((iv) => {
            const active = barInterval === iv;
            return (
              <button
                key={iv}
                className="text-[9px] font-bold font-mono px-1.5 py-0.5 border transition-colors"
                style={{
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? `${colors.accent}22` : "transparent",
                  color: active ? colors.accent : colors.textSecondary,
                }}
                onClick={() => handleHeatmapInterval(iv as BarInterval)}
              >
                {INTERVAL_LABEL[iv as BarInterval]}
              </button>
            );
          })}
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
                O:<span style={{ color: colors.text }}>${fmtPrice(chartData[0]?.price)}</span>
              </span>
              <span>
                H:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(Math.max(...chartData.map((d: { price: number }) => d.price)))}
                </span>
              </span>
              <span>
                L:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(Math.min(...chartData.map((d: { price: number }) => d.price)))}
                </span>
              </span>
              <span>
                C:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(chartData[chartData.length - 1]?.price)}
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
                        return [`$${fmtPrice(v)}`, "Price"];
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
                O:<span style={{ color: colors.text }}>${fmtPrice(chartData[0]?.price)}</span>
              </span>
              <span>
                H:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(Math.max(...chartData.map((d: { price: number }) => d.price)))}
                </span>
              </span>
              <span>
                L:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(Math.min(...chartData.map((d: { price: number }) => d.price)))}
                </span>
              </span>
              <span>
                C:
                <span style={{ color: colors.text }}>
                  ${fmtPrice(chartData[chartData.length - 1]?.price)}
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
