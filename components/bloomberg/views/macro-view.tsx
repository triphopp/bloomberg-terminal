"use client";

import { useAtom } from "jotai";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Calendar,
  ChevronDown,
  Database,
  Globe,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isDarkModeAtom } from "../atoms";
import { useGlobalYields, useGlobalYieldsRefresh } from "../hooks/useGlobalYields";
import type { GlobalYieldRow } from "../hooks/useGlobalYields";
import { useMacroData, useMacroRefresh } from "../hooks/useMacroData";
import type { MacroData, MacroIndicator, MacroSeries } from "../hooks/useMacroData";
import {
  useSovereignCompare,
  useSovereignDetail,
  useSovereignRefresh,
} from "../hooks/useSovereignData";
import type {
  CountryDetail,
  SovereignCompareResult,
  WbSeriesPoint,
  WbValue,
} from "../hooks/useSovereignData";
import { useTabShortcuts } from "../hooks/useTabShortcuts";
import { bloombergColors } from "../lib/theme-config";
import { CountryMacroTab } from "./macro/country-tab";
import { SectionHeader } from "./macro/shared";
import { SignalsTab } from "./signals-tab";

// ── Types ────────────────────────────────────────────────────────────────────

type MacroTab = "dashboard" | "yield" | "indicators" | "fed" | "country" | "compare" | "signals";
type IndicatorKey =
  | "cpi"
  | "gdp"
  | "unemployment"
  | "nfp"
  | "fed_rate"
  | "retail_sales"
  | "consumer_sentiment";

// ── US Indicator config (FRED-based) ─────────────────────────────────────────

const IND_CFG: Record<
  IndicatorKey,
  {
    label: string;
    unit: string;
    hawkishIfRising: boolean;
    canBeNegative: boolean;
    target?: number;
    description: string;
  }
> = {
  cpi: {
    label: "CPI INFLATION",
    unit: "% YoY",
    hawkishIfRising: true,
    canBeNegative: true,
    target: 2.0,
    description: "Consumer Price Index YoY — key Fed inflation gauge",
  },
  gdp: {
    label: "REAL GDP",
    unit: "% YoY",
    hawkishIfRising: true,
    canBeNegative: true,
    description: "Real GDP year-over-year growth rate",
  },
  unemployment: {
    label: "UNEMPLOYMENT",
    unit: "%",
    hawkishIfRising: false,
    canBeNegative: false,
    target: 4.0,
    description: "US unemployment rate — below 4% = tight labor market",
  },
  nfp: {
    label: "NON-FARM PAYROLL",
    unit: "K",
    hawkishIfRising: true,
    canBeNegative: true,
    description: "Monthly net new jobs added",
  },
  fed_rate: {
    label: "FED FUNDS RATE",
    unit: "%",
    hawkishIfRising: true,
    canBeNegative: false,
    description: "Effective Federal Funds Rate",
  },
  retail_sales: {
    label: "RETAIL SALES",
    unit: "% MoM",
    hawkishIfRising: true,
    canBeNegative: true,
    description: "Advance retail & food services sales MoM",
  },
  consumer_sentiment: {
    label: "CONSUMER SENTIMENT",
    unit: "",
    hawkishIfRising: true,
    canBeNegative: false,
    description: "U. of Michigan Consumer Sentiment Index",
  },
};

const IND_ORDER: IndicatorKey[] = [
  "cpi",
  "gdp",
  "unemployment",
  "nfp",
  "fed_rate",
  "retail_sales",
  "consumer_sentiment",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function implication(
  key: IndicatorKey,
  value: number,
  prev: number
): "hawkish" | "dovish" | "neutral" {
  const diff = value - prev;
  if (Math.abs(diff) < 0.05) return "neutral";
  const rising = diff > 0;
  return rising === IND_CFG[key].hawkishIfRising ? "hawkish" : "dovish";
}

function fmtVal(key: IndicatorKey, v: number | null | undefined): string {
  if (v == null) return "—";
  if (key === "nfp") return `${v > 0 ? "+" : ""}${v.toFixed(0)}K`;
  if (key === "consumer_sentiment") return v.toFixed(1);
  return v.toFixed(2);
}

function fmtDate(d: string): string {
  if (!d) return "";
  const [y, m] = d.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[(Number.parseInt(m) - 1) % 12]} ${y}`;
}

function assessRegime(ind: MacroData["indicators"]) {
  const cpi = ind.cpi?.value;
  const gdp = ind.gdp?.value;
  const unem = ind.unemployment?.value;
  const rate = ind.fed_rate?.value;

  return {
    growth: gdp == null ? "—" : gdp >= 2 ? "EXPANDING" : gdp >= 0 ? "SLOWING" : "CONTRACTING",
    inflation:
      cpi == null ? "—" : cpi > 3.0 ? "ELEVATED" : cpi > 2.0 ? "ABOVE TARGET" : "AT/BELOW TARGET",
    labor: unem == null ? "—" : unem < 4.0 ? "TIGHT" : unem < 5.5 ? "BALANCED" : "SLACK",
    policy:
      rate == null ? "—" : rate > 4.0 ? "RESTRICTIVE" : rate > 2.5 ? "NEUTRAL" : "ACCOMMODATIVE",
    gColor: (g: string) => (g === "EXPANDING" ? "green" : g === "CONTRACTING" ? "red" : "yellow"),
    iColor: (i: string) => (i === "ELEVATED" || i === "ABOVE TARGET" ? "red" : "green"),
    lColor: (l: string) => (l === "TIGHT" ? "orange" : l === "SLACK" ? "green" : "yellow"),
    pColor: (p: string) =>
      p === "RESTRICTIVE" ? "red" : p === "ACCOMMODATIVE" ? "green" : "yellow",
  };
}

// ── Shared sub-components ────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  accent,
  text,
  border,
  shortcutN,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: string;
  text: string;
  border: string;
  shortcutN?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 px-3 py-1 text-xs font-mono font-bold border tracking-wider transition-colors"
      style={{
        borderColor: active ? accent : border,
        backgroundColor: active ? accent : "transparent",
        color: active ? "#000" : text,
      }}
      title={shortcutN ? `Alt+${shortcutN}` : undefined}
    >
      {shortcutN != null && (
        <span
          className="text-[8px] opacity-40 hidden sm:inline"
          style={{ color: active ? "#000" : accent }}
        >
          ⌥{shortcutN}
        </span>
      )}
      {label}
    </button>
  );
}

// ── Regime banner ────────────────────────────────────────────────────────────

function RegimeBanner({
  data,
  colors,
  isDark,
}: { data: MacroData; colors: typeof bloombergColors.dark; isDark: boolean }) {
  const r = assessRegime(data.indicators);
  const items = [
    { label: "GROWTH", value: r.growth, color: r.gColor(r.growth) },
    { label: "INFLATION", value: r.inflation, color: r.iColor(r.inflation) },
    { label: "LABOR", value: r.labor, color: r.lColor(r.labor) },
    { label: "POLICY", value: r.policy, color: r.pColor(r.policy) },
  ];
  const colorMap: Record<string, string> = {
    green: isDark ? "#1a4d1a" : "#d4edda",
    red: isDark ? "#4d1a1a" : "#f8d7da",
    orange: isDark ? "#4d3300" : "#fff3cd",
    yellow: isDark ? "#3d3d00" : "#ffeaa0",
  };
  const textMap: Record<string, string> = {
    green: "#4caf50",
    red: "#ef5350",
    orange: "#ff9800",
    yellow: "#ffc107",
  };

  return (
    <div className="flex gap-2 flex-wrap mb-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-center gap-2 px-3 py-1.5 border text-xs font-mono"
          style={{
            backgroundColor: colorMap[item.color] ?? colorMap.yellow,
            borderColor: textMap[item.color] ?? "#888",
          }}
        >
          <span style={{ color: colors.textSecondary }}>{item.label}</span>
          <span className="font-bold" style={{ color: textMap[item.color] }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Indicator card ───────────────────────────────────────────────────────────

function IndicatorCard({
  id,
  ind,
  colors,
  isDark,
  onClick,
  selected,
}: {
  id: IndicatorKey;
  ind: MacroIndicator;
  colors: typeof bloombergColors.dark;
  isDark: boolean;
  onClick: () => void;
  selected: boolean;
}) {
  const cfg = IND_CFG[id];
  if (!ind) {
    return (
      <div
        className="border p-3 flex flex-col gap-1 opacity-40"
        style={{ borderColor: colors.border, backgroundColor: colors.surface }}
      >
        <div
          className="text-[9px] tracking-widest font-bold"
          style={{ color: colors.textSecondary }}
        >
          {cfg.label}
        </div>
        <div className="text-lg font-mono font-bold" style={{ color: colors.text }}>
          —
        </div>
      </div>
    );
  }

  const impl = implication(id, ind.value, ind.prev);
  const delta = ind.value - ind.prev;
  const implClr =
    impl === "hawkish" ? "#ef5350" : impl === "dovish" ? "#4caf50" : colors.textSecondary;
  const implBg =
    impl === "hawkish"
      ? isDark
        ? "#2a0a0a"
        : "#fdf0f0"
      : impl === "dovish"
        ? isDark
          ? "#0a2a0a"
          : "#f0fdf0"
        : "transparent";

  return (
    <button
      type="button"
      onClick={onClick}
      className="border p-3 flex flex-col gap-1 text-left transition-all hover:opacity-85 active:opacity-70"
      style={{
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? (isDark ? "#1a1a0a" : "#fffff0") : colors.surface,
      }}
    >
      <div className="text-[9px] tracking-widest font-bold" style={{ color: colors.textSecondary }}>
        {cfg.label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-mono font-bold" style={{ color: colors.text }}>
          {fmtVal(id, ind.value)}
        </span>
        <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
          {cfg.unit}
        </span>
      </div>
      <div
        className="flex items-center gap-1 text-[10px] font-mono"
        style={{ color: colors.textSecondary }}
      >
        {delta > 0.005 ? (
          <ArrowUp className="h-2.5 w-2.5" style={{ color: "#f87171" }} />
        ) : delta < -0.005 ? (
          <ArrowDown className="h-2.5 w-2.5" style={{ color: "#4ade80" }} />
        ) : (
          <ArrowRight className="h-2.5 w-2.5" />
        )}
        <span>prev: {fmtVal(id, ind.prev)}</span>
        <span className="ml-auto">{fmtDate(ind.date)}</span>
      </div>
      {cfg.target != null && (
        <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
          target: {cfg.target}
          {cfg.unit.includes("%") ? "%" : ""}
        </div>
      )}
      <div
        className="mt-1 px-1.5 py-0.5 text-[8px] font-bold tracking-widest font-mono self-start border"
        style={{ backgroundColor: implBg, borderColor: implClr, color: implClr }}
      >
        {impl.toUpperCase()}
      </div>
    </button>
  );
}

// ── Mini sparkline ───────────────────────────────────────────────────────────

function MiniSparkline({
  series,
  color,
  height = 40,
}: { series: MacroSeries; color: string; height?: number }) {
  if (!series || series.length < 2) return null;
  const data = [...series].reverse().slice(-12);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sg-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#sg-${color.replace("#", "")})`}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── DASHBOARD tab ────────────────────────────────────────────────────────────

function DashboardTab({
  data,
  colors,
  isDark,
  onSelectIndicator,
}: {
  data: MacroData;
  colors: typeof bloombergColors.dark;
  isDark: boolean;
  onSelectIndicator: (k: IndicatorKey) => void;
}) {
  return (
    <div>
      <RegimeBanner data={data} colors={colors} isDark={isDark} />

      <div
        className="flex items-center gap-2 p-2 mb-4 border text-[10px] font-mono self-start w-fit"
        style={{
          borderColor: colors.border,
          backgroundColor: colors.surface,
          color: colors.textSecondary,
        }}
      >
        <Database className="h-3 w-3 shrink-0" style={{ color: colors.accent }} />
        <span>
          Data: <span style={{ color: colors.accent }}>FRED</span> (Federal Reserve Economic Data) —
          no API key required
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {IND_ORDER.map((key) => (
          <IndicatorCard
            key={key}
            id={key}
            ind={data.indicators[key]}
            colors={colors}
            isDark={isDark}
            onClick={() => onSelectIndicator(key)}
            selected={false}
          />
        ))}

        {/* Yield curve summary card */}
        <div
          className="border p-3 flex flex-col gap-1"
          style={{ borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <div
            className="text-[9px] tracking-widest font-bold"
            style={{ color: colors.textSecondary }}
          >
            YIELD CURVE
          </div>
          <div className="flex items-baseline gap-1">
            <span
              className="text-xl font-mono font-bold"
              style={{ color: data.yield_curve.is_inverted ? "#ef5350" : "#4caf50" }}
            >
              {data.yield_curve.is_inverted ? "INVERTED" : "NORMAL"}
            </span>
          </div>
          <div
            className="text-[10px] font-mono space-y-0.5"
            style={{ color: colors.textSecondary }}
          >
            {data.yield_curve["10y"] != null && (
              <div>
                10Y:{" "}
                <span style={{ color: colors.text }}>{data.yield_curve["10y"].toFixed(2)}%</span>
              </div>
            )}
            {data.yield_curve.spread_10y_2y != null && (
              <div>
                10Y-2Y:{" "}
                <span style={{ color: data.yield_curve.spread_10y_2y < 0 ? "#ef5350" : "#4caf50" }}>
                  {data.yield_curve.spread_10y_2y > 0 ? "+" : ""}
                  {data.yield_curve.spread_10y_2y.toFixed(2)}%
                </span>
              </div>
            )}
          </div>
          <div
            className="mt-1 px-1.5 py-0.5 text-[8px] font-bold tracking-widest font-mono self-start border"
            style={{
              borderColor: data.yield_curve.is_inverted ? "#ef5350" : "#4caf50",
              color: data.yield_curve.is_inverted ? "#ef5350" : "#4caf50",
              backgroundColor: data.yield_curve.is_inverted
                ? isDark
                  ? "#2a0a0a"
                  : "#fdf0f0"
                : isDark
                  ? "#0a2a0a"
                  : "#f0fdf0",
            }}
          >
            {data.yield_curve.is_inverted ? "RECESSION SIGNAL" : "HEALTHY"}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── YIELD CURVE tab ──────────────────────────────────────────────────────────

function YieldCurveTab({
  data,
  colors,
  isDark,
  isActive,
}: { data: MacroData; colors: typeof bloombergColors.dark; isDark: boolean; isActive: boolean }) {
  const yc = data.yield_curve;
  const maturities = [
    { key: "3m" as const, label: "3M", years: 0.25 },
    { key: "2y" as const, label: "2Y", years: 2 },
    { key: "5y" as const, label: "5Y", years: 5 },
    { key: "10y" as const, label: "10Y", years: 10 },
    { key: "30y" as const, label: "30Y", years: 30 },
  ];

  const base3m = yc["3m"] ?? 0;
  const curveData = maturities
    .map((m) => ({
      maturity: m.label,
      yield: yc[m.key] ?? null,
      inverted: (yc[m.key] ?? 999) < base3m,
    }))
    .filter((d) => d.yield !== null);

  const gridColor = isDark ? "#2a2a2a" : "#e5e5e5";
  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11,
    fontFamily: "monospace",
  };

  return (
    <div className="space-y-6">
      {/* Inversion status bar */}
      <div
        className="flex items-center gap-4 p-3 border font-mono"
        style={{
          borderColor: yc.is_inverted ? "#ef5350" : "#4caf50",
          backgroundColor: yc.is_inverted
            ? isDark
              ? "#1a0505"
              : "#fff5f5"
            : isDark
              ? "#051a05"
              : "#f5fff5",
        }}
      >
        {yc.is_inverted ? (
          <TrendingDown className="h-4 w-4 shrink-0" style={{ color: "#f87171" }} />
        ) : (
          <TrendingUp className="h-4 w-4 shrink-0" style={{ color: "#4ade80" }} />
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <span style={{ color: yc.is_inverted ? "#ef5350" : "#4caf50" }} className="font-bold">
            {yc.is_inverted ? "YIELD CURVE INVERTED" : "YIELD CURVE NORMAL"}
          </span>
          {yc.spread_10y_2y != null && (
            <span style={{ color: colors.textSecondary }}>
              10Y-2Y:{" "}
              <span
                className="font-bold"
                style={{ color: yc.spread_10y_2y < 0 ? "#ef5350" : "#4caf50" }}
              >
                {yc.spread_10y_2y > 0 ? "+" : ""}
                {yc.spread_10y_2y.toFixed(3)}%
              </span>
            </span>
          )}
          {yc.spread_10y_3m != null && (
            <span style={{ color: colors.textSecondary }}>
              10Y-3M:{" "}
              <span
                className="font-bold"
                style={{ color: yc.spread_10y_3m < 0 ? "#ef5350" : "#4caf50" }}
              >
                {yc.spread_10y_3m > 0 ? "+" : ""}
                {yc.spread_10y_3m.toFixed(3)}%
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Yield curve bar chart */}
      <div>
        <SectionHeader
          title="CURRENT YIELD CURVE"
          sub="US Treasury constant maturities"
          colors={colors}
        />
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={curveData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={gridColor} />
            <XAxis
              dataKey="maturity"
              tick={{ fontSize: 11, fontFamily: "monospace", fill: colors.textSecondary }}
            />
            <YAxis
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 10, fontFamily: "monospace", fill: colors.textSecondary }}
              domain={[0, "auto"]}
            />
            <Tooltip
              formatter={(v: number) => [`${v.toFixed(3)}%`, "Yield"]}
              contentStyle={tooltipStyle}
              labelStyle={{ color: colors.text }}
            />
            {yc["3m"] && (
              <ReferenceLine
                y={yc["3m"]}
                stroke="#888"
                strokeDasharray="4 2"
                label={{ value: "3M", fontSize: 9, fill: "#888" }}
              />
            )}
            <Bar dataKey="yield" radius={[2, 2, 0, 0]}>
              {curveData.map((entry) => (
                <Cell key={entry.maturity} fill={entry.inverted ? "#ef5350" : colors.accent} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Current yield table */}
      <div>
        <SectionHeader title="TREASURY YIELDS" sub="real-time" colors={colors} />
        <div className="grid grid-cols-5 gap-1">
          {maturities.map((m) => {
            const v = yc[m.key];
            return (
              <div
                key={m.key}
                className="border p-2 text-center font-mono"
                style={{ borderColor: colors.border, backgroundColor: colors.surface }}
              >
                <div className="text-[9px]" style={{ color: colors.textSecondary }}>
                  {m.label}
                </div>
                <div
                  className="text-sm font-bold"
                  style={{ color: v != null ? colors.text : colors.textSecondary }}
                >
                  {v != null ? `${v.toFixed(2)}%` : "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Global Government Bond Yields ── */}
      <GlobalYieldsSection colors={colors} isDark={isDark} isActive={isActive} />
    </div>
  );
}

// ── Global Government Bond Yields ────────────────────────────────────────────

const COMPARE_CODES = ["US", "JP", "CN", "DE", "GB"];
const COMPARE_COLORS: Record<string, string> = {
  US: "#ff9900",
  JP: "#4fc3f7",
  CN: "#ef5350",
  DE: "#81c784",
  GB: "#ce93d8",
};

function GlobalYieldsSection({
  colors,
  isDark,
  isActive,
}: { colors: typeof bloombergColors.dark; isDark: boolean; isActive: boolean }) {
  const { data, isLoading, error } = useGlobalYields(isActive);
  const refresh = useGlobalYieldsRefresh();
  const [selectedCodes, setSelectedCodes] = useState<string[]>(["US", "JP", "CN"]);
  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 10,
    fontFamily: "monospace",
  };

  const toggleCode = (code: string) => {
    setSelectedCodes((prev) =>
      prev.includes(code)
        ? prev.length > 1
          ? prev.filter((c) => c !== code)
          : prev
        : [...prev, code]
    );
  };

  // Build comparison line chart data (daily series, selected countries)
  const seriesData = data?.series ?? {};
  const allDates = [
    ...new Set(selectedCodes.flatMap((c) => (seriesData[c] ?? []).map((p) => p.date))),
  ].sort();

  const chartData = allDates.map((date) => {
    const point: Record<string, string | number | null> = { date: date.slice(5) }; // MM-DD
    for (const code of selectedCodes) {
      const found = (seriesData[code] ?? []).find((p) => p.date === date);
      point[code] = found ? found.value : null;
    }
    return point;
  });

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <SectionHeader
          title="GLOBAL GOV'T BOND YIELDS"
          sub="10Y · via FRED/OECD · 4h cache"
          colors={colors}
        />
        <button
          type="button"
          onClick={refresh}
          className="text-[8px] px-1.5 py-0.5 border font-mono font-bold hover:opacity-80"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          <RefreshCw className="h-2 w-2 inline mr-0.5" />
          REFRESH
        </button>
      </div>

      {/* Loading / error states */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs" style={{ color: colors.textSecondary }}>
          <RefreshCw className="h-3 w-3 animate-spin" />
          Fetching global yields from FRED…
        </div>
      )}
      {error && (
        <div className="text-xs p-2 border" style={{ borderColor: "#ef5350", color: "#ef5350" }}>
          Failed to load global yields. Make sure the Python backend is running.
        </div>
      )}

      {data && (
        <>
          {/* Country table */}
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {["COUNTRY", "10Y", "2Y", "30Y", "10Y-2Y SPD", "1D CHG"].map((h) => (
                    <th
                      key={h}
                      className={`px-2 py-1 text-[8px] font-bold tracking-wider ${h === "COUNTRY" ? "text-left" : "text-right"}`}
                      style={{ color: colors.textSecondary }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.table as GlobalYieldRow[]).map((row, i) => {
                  const chg = row.chg_1d;
                  const chgColor =
                    chg == null
                      ? colors.textSecondary
                      : chg > 0
                        ? "#ef5350"
                        : chg < 0
                          ? "#4caf50"
                          : colors.text;
                  const spread = row.spread_10y_2y;
                  return (
                    <tr
                      key={row.code}
                      style={{
                        borderBottom: `1px solid ${colors.border}`,
                        backgroundColor:
                          i % 2 === 0 ? "transparent" : isDark ? "#0a0a0a" : "#fafafa",
                      }}
                    >
                      <td className="px-2 py-1.5">
                        <span className="font-bold" style={{ color: colors.accent }}>
                          {row.code}
                        </span>
                        <span className="ml-1.5 text-[9px]" style={{ color: colors.textSecondary }}>
                          {row.name}
                        </span>
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-bold"
                        style={{ color: colors.text }}
                      >
                        {row["10y"].toFixed(3)}%
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>
                        {row["2y"] != null ? `${row["2y"].toFixed(3)}%` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>
                        {row["30y"] != null ? `${row["30y"].toFixed(3)}%` : "—"}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-bold"
                        style={{
                          color:
                            spread == null
                              ? colors.textSecondary
                              : spread < 0
                                ? "#ef5350"
                                : "#4caf50",
                        }}
                      >
                        {spread != null ? `${spread > 0 ? "+" : ""}${spread.toFixed(3)}%` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold" style={{ color: chgColor }}>
                        {chg != null ? `${chg > 0 ? "+" : ""}${chg.toFixed(3)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Comparison chart */}
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span
                className="text-[9px] font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                COMPARE 10Y:
              </span>
              {COMPARE_CODES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleCode(code)}
                  className="text-[9px] px-1.5 py-0.5 border font-mono font-bold transition-colors"
                  style={{
                    borderColor: selectedCodes.includes(code)
                      ? COMPARE_COLORS[code]
                      : colors.border,
                    color: selectedCodes.includes(code)
                      ? COMPARE_COLORS[code]
                      : colors.textSecondary,
                    backgroundColor: selectedCodes.includes(code)
                      ? `${COMPARE_COLORS[code]}18`
                      : "transparent",
                  }}
                >
                  {code}
                </button>
              ))}
            </div>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#2a2a2a" : "#e5e5e5"} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9, fill: colors.textSecondary }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={30}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: colors.textSecondary }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    domain={["auto", "auto"]}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name]}
                    labelStyle={{ color: colors.text }}
                  />
                  {selectedCodes.map((code) => (
                    <Area
                      key={code}
                      type="monotone"
                      dataKey={code}
                      stroke={COMPARE_COLORS[code] ?? colors.accent}
                      strokeWidth={1.5}
                      fill="none"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div
                className="flex items-center justify-center h-16 text-[10px] font-mono"
                style={{ color: colors.textSecondary, border: `1px dashed ${colors.border}` }}
              >
                No series data for selected countries — select US, JP, DE or GB
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── INDICATORS tab ───────────────────────────────────────────────────────────

function IndicatorsTab({
  data,
  colors,
  isDark,
}: { data: MacroData; colors: typeof bloombergColors.dark; isDark: boolean }) {
  const [selected, setSelected] = useState<IndicatorKey>("cpi");
  const ind = data.indicators[selected];
  const cfg = IND_CFG[selected];
  const gridColor = isDark ? "#2a2a2a" : "#e5e5e5";
  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11,
    fontFamily: "monospace",
  };

  const chartData = ind
    ? [...ind.series].reverse().map((s) => ({
        date: s.date.slice(0, 7),
        value: s.value,
      }))
    : [];

  const impl = ind ? implication(selected, ind.value, ind.prev) : "neutral";
  const barColor = (v: number, prev: number) => {
    const better = IND_CFG[selected].hawkishIfRising ? v >= prev : v <= prev;
    return better ? "#4caf50" : "#ef5350";
  };

  return (
    <div className="flex gap-4">
      {/* Left: selector list */}
      <div className="w-44 shrink-0 space-y-1">
        {IND_ORDER.map((key) => {
          const i = data.indicators[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(key)}
              className="w-full text-left px-2 py-2 border text-[10px] font-mono transition-colors"
              style={{
                borderColor: selected === key ? colors.accent : colors.border,
                backgroundColor:
                  selected === key ? (isDark ? "#1a1a0a" : "#fffff0") : colors.surface,
                color: colors.text,
              }}
            >
              <div
                className="font-bold tracking-wide text-[9px]"
                style={{ color: selected === key ? colors.accent : colors.textSecondary }}
              >
                {IND_CFG[key].label}
              </div>
              {i && (
                <div className="mt-0.5">
                  {fmtVal(key, i.value)}{" "}
                  <span style={{ color: colors.textSecondary }}>{IND_CFG[key].unit}</span>
                </div>
              )}
              {i && (
                <MiniSparkline
                  series={i.series}
                  color={implication(key, i.value, i.prev) === "dovish" ? "#4caf50" : "#ef5350"}
                  height={28}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Right: detail chart */}
      <div className="flex-1 min-w-0">
        {ind ? (
          <>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
                  {cfg.label}
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: colors.textSecondary }}>
                  {cfg.description}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold font-mono" style={{ color: colors.text }}>
                  {fmtVal(selected, ind.value)}
                  <span className="text-sm ml-1" style={{ color: colors.textSecondary }}>
                    {cfg.unit}
                  </span>
                </div>
                <div
                  className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 border font-mono"
                  style={{
                    borderColor: impl === "hawkish" ? "#ef5350" : "#4caf50",
                    color: impl === "hawkish" ? "#ef5350" : "#4caf50",
                  }}
                >
                  {impl.toUpperCase()}
                </div>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke={gridColor} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
                  angle={-45}
                  textAnchor="end"
                  interval={2}
                />
                <YAxis
                  tickFormatter={(v: number) => `${v}${cfg.unit.includes("%") ? "%" : ""}`}
                  tick={{ fontSize: 10, fontFamily: "monospace", fill: colors.textSecondary }}
                  domain={cfg.canBeNegative ? ["auto", "auto"] : [0, "auto"]}
                />
                <Tooltip
                  formatter={(v: number) => [`${v.toFixed(2)}${cfg.unit}`, cfg.label]}
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: colors.text }}
                />
                {cfg.target != null && (
                  <ReferenceLine
                    y={cfg.target}
                    stroke={colors.accent}
                    strokeDasharray="4 2"
                    label={{
                      value: `Target ${cfg.target}%`,
                      position: "insideTopRight",
                      fontSize: 9,
                      fill: colors.accent,
                    }}
                  />
                )}
                <Bar dataKey="value" radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, i) => {
                    const prev = i > 0 ? chartData[i - 1].value : entry.value;
                    return <Cell key={entry.date} fill={barColor(entry.value, prev)} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        ) : (
          <div
            className="flex items-center justify-center h-48"
            style={{ color: colors.textSecondary }}
          >
            <span className="text-sm font-mono">No data available from FRED</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── FED WATCH tab ────────────────────────────────────────────────────────────

function FedWatchTab({
  data,
  colors,
  isDark,
}: { data: MacroData; colors: typeof bloombergColors.dark; isDark: boolean }) {
  const fed = data.fed;
  const gridColor = isDark ? "#2a2a2a" : "#e5e5e5";
  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11,
    fontFamily: "monospace",
  };
  const rateSeries = [...(fed.series || [])].reverse().slice(-36);
  const stanceColor =
    fed.stance === "HIKING" ? "#ef5350" : fed.stance === "CUTTING" ? "#4caf50" : colors.accent;
  const stanceLabel =
    fed.stance === "HIKING"
      ? "RATE HIKING CYCLE"
      : fed.stance === "CUTTING"
        ? "RATE CUTTING CYCLE"
        : "ON HOLD";
  const restrictiveThreshold = 3.5;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div
          className="border p-3 font-mono"
          style={{ borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <div className="text-[9px] tracking-widest" style={{ color: colors.textSecondary }}>
            CURRENT RATE
          </div>
          <div className="text-2xl font-bold mt-1" style={{ color: colors.text }}>
            {fed.current_rate != null ? `${fed.current_rate.toFixed(2)}%` : "—"}
          </div>
          <div className="text-[9px] mt-0.5" style={{ color: colors.textSecondary }}>
            Effective Fed Funds Rate
          </div>
        </div>

        <div
          className="border p-3 font-mono"
          style={{ borderColor: stanceColor, backgroundColor: isDark ? "#0a0a0a" : "#fff" }}
        >
          <div className="text-[9px] tracking-widest" style={{ color: colors.textSecondary }}>
            FED STANCE
          </div>
          <div className="text-lg font-bold mt-1" style={{ color: stanceColor }}>
            {stanceLabel}
          </div>
        </div>

        <div
          className="border p-3 font-mono"
          style={{ borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <div className="text-[9px] tracking-widest" style={{ color: colors.textSecondary }}>
            POLICY STANCE
          </div>
          <div
            className="text-lg font-bold mt-1"
            style={{
              color: (fed.current_rate ?? 0) > restrictiveThreshold ? "#ef5350" : "#4caf50",
            }}
          >
            {(fed.current_rate ?? 0) > 4.0
              ? "RESTRICTIVE"
              : (fed.current_rate ?? 0) > 2.5
                ? "NEUTRAL"
                : "ACCOMMODATIVE"}
          </div>
        </div>

        <div
          className="border p-3 font-mono"
          style={{ borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <div
            className="flex items-center gap-1.5 text-[9px] tracking-widest"
            style={{ color: colors.textSecondary }}
          >
            <Calendar className="h-3 w-3" /> NEXT FOMC
          </div>
          <div className="text-lg font-bold mt-1" style={{ color: colors.accent }}>
            {fed.next_fomc.date !== "TBA" ? fmtDate(fed.next_fomc.date) : "TBA"}
          </div>
          {fed.next_fomc.days_until != null && (
            <div className="text-[9px] mt-0.5" style={{ color: colors.textSecondary }}>
              in{" "}
              <span className="font-bold" style={{ color: colors.text }}>
                {fed.next_fomc.days_until}
              </span>{" "}
              days
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionHeader
          title="FED FUNDS RATE HISTORY"
          sub="monthly (last 36 months)"
          colors={colors}
        />
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={rateSeries} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
            <defs>
              <linearGradient id="fedGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef5350" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef5350" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={gridColor} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
              angle={-45}
              textAnchor="end"
              interval={3}
            />
            <YAxis
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 10, fontFamily: "monospace", fill: colors.textSecondary }}
              domain={[0, "auto"]}
            />
            <Tooltip
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Fed Funds Rate"]}
              contentStyle={tooltipStyle}
              labelStyle={{ color: colors.text }}
            />
            <ReferenceLine
              y={restrictiveThreshold}
              stroke="#888"
              strokeDasharray="4 2"
              label={{ value: "Neutral", position: "insideTopRight", fontSize: 9, fill: "#888" }}
            />
            <Area
              type="stepAfter"
              dataKey="value"
              stroke="#ef5350"
              strokeWidth={2}
              fill="url(#fedGrad)"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div>
        <SectionHeader title="FOMC MEETING SCHEDULE 2026" colors={colors} />
        <div className="flex flex-wrap gap-2">
          {[
            "2026-01-29",
            "2026-03-19",
            "2026-05-01",
            "2026-06-18",
            "2026-07-29",
            "2026-09-17",
            "2026-10-29",
            "2026-12-10",
          ].map((d) => {
            const today = new Date().toISOString().slice(0, 10);
            const past = d < today;
            const isNext = d === fed.next_fomc.date;
            return (
              <div
                key={d}
                className="px-3 py-1.5 border text-xs font-mono"
                style={{
                  borderColor: isNext ? colors.accent : colors.border,
                  backgroundColor: isNext
                    ? isDark
                      ? "#1a1a0a"
                      : "#ffffee"
                    : past
                      ? isDark
                        ? "#0a0a0a"
                        : "#f8f8f8"
                      : colors.surface,
                  color: past ? colors.textSecondary : isNext ? colors.accent : colors.text,
                  opacity: past ? 0.5 : 1,
                }}
              >
                {fmtDate(d)} {isNext && <span className="ml-1 text-[8px] font-bold">NEXT</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ COUNTRY MACRO TAB — World Bank Data (6 Categories) ═══════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

export function MacroView({ onBack }: { onBack: () => void }) {
  const [isDark] = useAtom(isDarkModeAtom);
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;

  const [activeTab, setActiveTab] = useState<MacroTab>("dashboard");
  const [focusIndicator, setFocusInd] = useState<IndicatorKey>("cpi");

  const { data, isLoading, error } = useMacroData();
  const refresh = useMacroRefresh();

  const secClr = { color: colors.textSecondary };

  const tabs: { id: MacroTab; label: string }[] = [
    { id: "dashboard", label: "DASHBOARD" },
    { id: "yield", label: "YIELD CURVE" },
    { id: "indicators", label: "INDICATORS" },
    { id: "fed", label: "FED WATCH" },
    { id: "country", label: "COUNTRY" },
    { id: "signals", label: "SIGNALS" },
  ];

  useTabShortcuts(tabs, setActiveTab);

  function handleSelectIndicator(key: IndicatorKey) {
    setFocusInd(key);
    setActiveTab("indicators");
  }

  const isUSTab = activeTab !== "country" && activeTab !== "signals";

  return (
    <div
      className="h-full overflow-y-auto"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* Tab bar (no separate header row — title shown in terminal-header centerSlot) */}
      <div
        className="flex items-center gap-1 px-4 py-1.5 border-b"
        style={{ borderColor: colors.border }}
      >
        <div className="flex gap-1 flex-wrap flex-1">
          {tabs.map((t, i) => (
            <TabBtn
              key={t.id}
              active={activeTab === t.id}
              onClick={() => setActiveTab(t.id)}
              label={t.label}
              accent={colors.accent}
              text={colors.text}
              border={colors.border}
              shortcutN={i + 1}
            />
          ))}
        </div>
        {isUSTab && (
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1 text-[10px] font-mono hover:opacity-70 ml-2 shrink-0"
            style={{ color: colors.accent }}
            title="Force-refresh (Ctrl+R)"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        {/* US tabs need FRED data */}
        {isUSTab && isLoading && !data && (
          <div className="flex items-center justify-center py-20" style={secClr}>
            <RefreshCw className="h-5 w-5 animate-spin mr-3" style={{ color: colors.accent }} />
            <span className="text-sm font-mono">
              Fetching macro data... (first load may take ~15s)
            </span>
          </div>
        )}

        {isUSTab && error && !data && (
          <div
            className="flex items-center gap-2 p-4 border text-sm font-mono"
            style={{ borderColor: "#ef5350", color: "#ef5350" }}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Backend error: {String(error)} — make sure the Python backend is running.</span>
          </div>
        )}

        {isUSTab && data && (
          <>
            {activeTab === "dashboard" && (
              <DashboardTab
                data={data}
                colors={colors}
                isDark={isDark}
                onSelectIndicator={handleSelectIndicator}
              />
            )}
            {activeTab === "yield" && (
              <YieldCurveTab
                data={data}
                colors={colors}
                isDark={isDark}
                isActive={activeTab === "yield"}
              />
            )}
            {activeTab === "indicators" && (
              <IndicatorsTab data={data} colors={colors} isDark={isDark} />
            )}
            {activeTab === "fed" && <FedWatchTab data={data} colors={colors} isDark={isDark} />}
          </>
        )}

        {/* Country tab — World Bank data */}
        {activeTab === "country" && <CountryMacroTab colors={colors} isDark={isDark} />}
      </div>

      {/* Signals tab — full-height split panel (outside p-4 wrapper) */}
      {activeTab === "signals" && (
        <div className="flex-1 overflow-hidden px-3 pb-3" style={{ height: "calc(100% - 40px)" }}>
          <SignalsTab colors={colors} isDark={isDark} />
        </div>
      )}
    </div>
  );
}
