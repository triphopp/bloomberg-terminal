"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart2,
  Check,
  LineChart,
  Pin,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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
  type PinGroup,
  type PinnedAsset,
  chartTypeAtom,
  isDarkModeAtom,
  pinGroupsAtom,
  pinnedAssetsAtom,
  stockAnalysisTabAtom,
} from "../atoms";
import {
  ChartTimeframeBar,
  EventDetailPopover,
  IndicatorPicker,
  ModularChart,
  useChartIndicators,
  useChartTimeframe,
} from "../chart";
import type { IndicatorRegistryEntry, OhlcvBar } from "../chart";
import { FearGreedPane } from "../chart/FearGreedPane";
import { PEPane } from "../chart/PEPane";
import { useSdBands } from "../chart/useSdBands";
import { BloombergButton } from "../core/bloomberg-button";
import { CompanyOutlookPanel } from "../core/company-outlook-panel";
import { ExtendedHoursPrice, MarketSessionBadge } from "../core/market-session";
import { useStockQuality } from "../hooks/useMarketQuality";
import {
  useStockFinancials,
  useStockHistory,
  useStockQuote,
  useStockSearch,
} from "../hooks/useStockData";
import { calcHurst } from "../lib/market-utils";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import { displayName, displaySymbol } from "../lib/symbol-display";
import { bloombergColors } from "../lib/theme-config";
import { OptionsTab } from "./options-tab";
import { RateStressTab } from "./stock/rate-stress";

// ─── Pin helpers (shared with global-search) ─────────────────────────────────────

import { DEFAULT_WATCHLIST_GROUP } from "../core/global-search";
const LS_GROUPS = "bloomberg_pin_groups";
const LS_PINS = "bloomberg_pinned_assets";

function loadPinGroups(): PinGroup[] {
  try {
    const s = localStorage.getItem(LS_GROUPS);
    return s ? JSON.parse(s) : [DEFAULT_WATCHLIST_GROUP];
  } catch {
    return [DEFAULT_WATCHLIST_GROUP];
  }
}

function savePinToStorage(pin: PinnedAsset) {
  try {
    const existing: PinnedAsset[] = JSON.parse(localStorage.getItem(LS_PINS) ?? "[]");
    if (!existing.some((p) => p.symbol === pin.symbol && p.groupId === pin.groupId)) {
      localStorage.setItem(LS_PINS, JSON.stringify([...existing, pin]));
    }
  } catch {
    /* ignore */
  }
}

// ─── GroupPicker popover ──────────────────────────────────────────────────────────

function PinGroupPicker({
  groups,
  onPick,
  onClose,
  colors,
}: {
  groups: PinGroup[];
  onPick: (g: PinGroup) => void;
  onClose: () => void;
  colors: typeof bloombergColors.dark;
}) {
  return (
    <div
      className="absolute right-0 top-full mt-1 z-[200] border min-w-[160px]"
      style={{ background: colors.surface, borderColor: colors.border }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="px-3 py-1.5 text-xs font-bold border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        PIN TO GROUP
      </div>
      {groups.map((g) => (
        <button
          key={g.id}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:opacity-70 transition-opacity"
          style={{ color: colors.text }}
          onClick={() => onPick(g)}
        >
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
          {g.name}
        </button>
      ))}
      <button
        className="w-full text-left px-3 py-1.5 text-xs border-t"
        style={{ color: colors.textSecondary, borderColor: colors.border }}
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────────

type TimePeriod = import("../chart").TimePeriod;
type BarInterval = import("../chart").BarInterval;
type FinancialMetric = "revenue" | "netIncome" | "eps" | "freeCashFlow" | "grossMargin";
type PeriodMode = "annual" | "quarterly";
type AnalysisTab =
  | "financials"
  | "outlook"
  | "keymetrics"
  | "quantitative"
  | "options"
  | "analyst"
  | "ownership"
  | "estimates"
  | "calendar"
  | "quality"
  | "grid"
  | "strategy-fit"
  | "rate-stress";

type FinancialBar = { label: string; value: number | null };

// ─── Math utilities for Quantitative tab ────────────────────────────────────────

function calcReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) r.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return r;
}
function statMean(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function statStd(arr: number[], mu?: number): number {
  if (arr.length < 2) return 0;
  const m = mu ?? statMean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function statSkewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = statMean(arr);
  const s = statStd(arr, m);
  if (!s) return 0;
  const n = arr.length;
  return (n / ((n - 1) * (n - 2))) * arr.reduce((a, v) => a + ((v - m) / s) ** 3, 0);
}
function statKurtosis(arr: number[]): number {
  // Excess kurtosis
  if (arr.length < 4) return 0;
  const m = statMean(arr);
  const s = statStd(arr, m);
  if (!s) return 0;
  const n = arr.length;
  return (
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
      arr.reduce((a, v) => a + ((v - m) / s) ** 4, 0) -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
  );
}
function historicalVaR(returns: number[], conf: number): number {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((1 - conf) * sorted.length) - 1);
  return -(sorted[idx] ?? 0);
}
function expectedShortfall(returns: number[], conf: number): number {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.floor((1 - conf) * sorted.length);
  const tail = sorted.slice(0, cutoff);
  return tail.length ? -statMean(tail) : 0;
}
function calcMaxDrawdown(prices: number[]): number {
  if (prices.length < 2) return 0;
  let peak = prices[0];
  let maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = peak > 0 ? (peak - p) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
function buildHistogram(
  returns: number[],
  buckets = 22
): { label: string; count: number; mid: number }[] {
  if (!returns.length) return [];
  const mn = Math.min(...returns);
  const mx = Math.max(...returns);
  const w = (mx - mn) / buckets || 0.001;
  const bins = Array.from({ length: buckets }, (_, i) => ({
    label: `${((mn + (i + 0.5) * w) * 100).toFixed(1)}%`,
    mid: mn + (i + 0.5) * w,
    count: 0,
  }));
  for (const r of returns) {
    const i = Math.min(buckets - 1, Math.floor((r - mn) / w));
    if (i >= 0) bins[i].count++;
  }
  return bins;
}
function buildDrawdownSeries(prices: number[], dates: string[]): { label: string; dd: number }[] {
  let peak = prices[0];
  return prices.map((p, i) => {
    if (p > peak) peak = p;
    return { label: dates[i] ?? String(i), dd: peak > 0 ? -((peak - p) / peak) * 100 : 0 };
  });
}
/** Normal PDF scaled to histogram counts */
function normalCurve(
  bins: { mid: number }[],
  returns: number[],
  mu: number,
  sigma: number
): number[] {
  if (!sigma) return bins.map(() => 0);
  const w = bins.length > 1 ? (bins[bins.length - 1].mid - bins[0].mid) / (bins.length - 1) : 1;
  return bins.map(({ mid }) => {
    const z = (mid - mu) / sigma;
    return returns.length * w * (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
  });
}

// ─── Grid Trading Math ───────────────────────────────────────────────────────────

function calcOUTheta(prices: number[]): number {
  if (prices.length < 20) return 0;
  const x = prices.slice(0, -1);
  const y = prices.slice(1);
  const mx = x.reduce((a, b) => a + b) / x.length;
  const my = y.reduce((a, b) => a + b) / y.length;
  const num = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
  const den = x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
  const beta = den > 0 ? num / den : 1;
  return beta > 0 && beta < 1 ? -Math.log(beta) * 252 : 0;
}

// ─── Strategy Fit Math ──────────────────────────────────────────────────────────

function calcLogReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  return r;
}

function calcRho1(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mu = statMean(returns);
  let num = 0;
  let den = 0;
  for (let t = 0; t < returns.length - 1; t++) {
    num += (returns[t] - mu) * (returns[t + 1] - mu);
    den += (returns[t] - mu) ** 2;
  }
  return den > 0 ? Math.max(-0.5, Math.min(0.5, num / den)) : 0;
}

function adjustedSharpe(SR: number, skew: number, exKurt: number): number {
  return SR * (1 + (skew / 6) * SR - (exKurt / 24) * SR * SR);
}

function splitNormalKernel(x: number, mu: number, sigmaL: number, sigmaR: number): number {
  const sigma = x <= mu ? sigmaL : sigmaR;
  return Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
}

interface StrategyParams {
  id: string;
  name: string;
  dims: { name: string; mu: number; sigmaL: number; sigmaR: number; w: number }[];
}

const STRATEGY_PARAMS: StrategyParams[] = [
  {
    id: "S1",
    name: "GRID / RANGE",
    dims: [
      { name: "H", mu: 0.35, sigmaL: 0.1, sigmaR: 0.06, w: 0.35 },
      { name: "SR_adj", mu: 0.0, sigmaL: 0.3, sigmaR: 0.18, w: 0.3 },
      { name: "ρ₁", mu: -0.08, sigmaL: 0.08, sigmaR: 0.06, w: 0.2 },
      { name: "σ_ann", mu: 0.22, sigmaL: 0.08, sigmaR: 0.14, w: 0.15 },
    ],
  },
  {
    id: "S2",
    name: "MEAN REVERSION",
    dims: [
      { name: "H", mu: 0.35, sigmaL: 0.1, sigmaR: 0.06, w: 0.25 },
      { name: "ρ₁", mu: -0.12, sigmaL: 0.08, sigmaR: 0.06, w: 0.35 },
      { name: "θ", mu: 15.0, sigmaL: 6.0, sigmaR: 10.0, w: 0.25 },
      { name: "σ_ann", mu: 0.28, sigmaL: 0.08, sigmaR: 0.16, w: 0.15 },
    ],
  },
  {
    id: "S3",
    name: "MOMENTUM",
    dims: [
      { name: "H", mu: 0.62, sigmaL: 0.05, sigmaR: 0.09, w: 0.3 },
      { name: "SR_adj", mu: 0.8, sigmaL: 0.22, sigmaR: 0.38, w: 0.3 },
      { name: "ρ₁", mu: 0.05, sigmaL: 0.04, sigmaR: 0.06, w: 0.25 },
      { name: "σ_ann", mu: 0.28, sigmaL: 0.08, sigmaR: 0.16, w: 0.15 },
    ],
  },
  {
    id: "S4",
    name: "TREND FOLLOWING",
    dims: [
      { name: "H", mu: 0.7, sigmaL: 0.06, sigmaR: 0.1, w: 0.4 },
      { name: "|SR_adj|", mu: 1.0, sigmaL: 0.25, sigmaR: 0.45, w: 0.35 },
      { name: "ρ₁", mu: 0.06, sigmaL: 0.04, sigmaR: 0.08, w: 0.25 },
    ],
  },
  {
    id: "S5",
    name: "BUY & HOLD",
    dims: [
      { name: "H", mu: 0.62, sigmaL: 0.06, sigmaR: 0.1, w: 0.25 },
      { name: "SR_adj", mu: 1.2, sigmaL: 0.3, sigmaR: 0.5, w: 0.4 },
      { name: "σ_ann", mu: 0.18, sigmaL: 0.14, sigmaR: 0.06, w: 0.2 },
      { name: "ExKurt", mu: 0.0, sigmaL: 1.5, sigmaR: 1.5, w: 0.15 },
    ],
  },
  {
    id: "S6",
    name: "VOLATILITY HARVEST",
    dims: [
      { name: "H", mu: 0.5, sigmaL: 0.05, sigmaR: 0.05, w: 0.2 },
      { name: "|SR_adj|", mu: 0.0, sigmaL: 0.3, sigmaR: 0.3, w: 0.25 },
      { name: "σ_ann", mu: 0.4, sigmaL: 0.16, sigmaR: 0.08, w: 0.35 },
      { name: "ρ₁", mu: 0.0, sigmaL: 0.08, sigmaR: 0.08, w: 0.2 },
    ],
  },
  {
    id: "S7",
    name: "BREAKOUT",
    dims: [
      { name: "H", mu: 0.65, sigmaL: 0.06, sigmaR: 0.1, w: 0.3 },
      { name: "ρ₁", mu: 0.08, sigmaL: 0.04, sigmaR: 0.08, w: 0.3 },
      { name: "σ_ann", mu: 0.35, sigmaL: 0.1, sigmaR: 0.14, w: 0.25 },
      { name: "SR_adj", mu: 0.6, sigmaL: 0.25, sigmaR: 0.45, w: 0.15 },
    ],
  },
];

interface StrategyScore {
  id: string;
  name: string;
  score: number;
  label: "SUITABLE" | "MARGINAL" | "WEAK";
  dims: {
    name: string;
    value: number;
    mu: number;
    phi: number;
    w: number;
    contrib: number;
  }[];
}

function calcStrategyScores(
  H: number,
  SR: number,
  rho1: number,
  sigmaAnn: number,
  theta: number,
  exKurt: number
): StrategyScore[] {
  const absSR = Math.abs(SR);
  const metricMap: Record<string, number> = {
    H: H,
    SR_adj: SR,
    "|SR_adj|": absSR,
    "ρ₁": rho1,
    σ_ann: sigmaAnn,
    θ: theta,
    ExKurt: exKurt,
  };

  const results: StrategyScore[] = STRATEGY_PARAMS.map((s) => {
    const dims = s.dims.map((d) => {
      const value = metricMap[d.name] ?? 0;
      const phi = splitNormalKernel(value, d.mu, d.sigmaL, d.sigmaR);
      return { name: d.name, value, mu: d.mu, phi, w: d.w, contrib: d.w * phi };
    });
    const score = 100 * dims.reduce((sum, d) => sum + d.contrib, 0);
    const label: StrategyScore["label"] =
      score >= 60 ? "SUITABLE" : score >= 40 ? "MARGINAL" : "WEAK";
    return { id: s.id, name: s.name, score: Math.round(score * 10) / 10, label, dims };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

interface GridSimResult {
  chartData: { label: string; gridIncome: number; inventoryPnl: number; total: number }[];
  completedTrips: number;
  maxInventory: number;
  finalGridIncome: number;
  finalInventoryPnl: number;
  finalTotal: number;
}

function simulateGrid(
  prices: number[],
  dates: string[],
  spacingPct: number,
  nLevels: number,
  transCostPct: number
): GridSimResult {
  const P0 = prices[0];
  const levels: number[] = [];
  for (let k = -nLevels; k <= nLevels; k++) {
    levels.push(P0 * (1 + spacingPct) ** k);
  }
  levels.sort((a, b) => a - b);

  const inventory: number[] = [];
  let cumulGridIncome = 0;
  let completedTrips = 0;
  let maxInventory = 0;
  const chartData: GridSimResult["chartData"] = [
    { label: dates[0] ?? "0", gridIncome: 0, inventoryPnl: 0, total: 0 },
  ];

  for (let t = 1; t < prices.length; t++) {
    const prev = prices[t - 1];
    const curr = prices[t];

    if (curr < prev) {
      for (const lv of levels) {
        if (lv < prev && lv >= curr && inventory.length < nLevels) {
          inventory.push(lv);
          cumulGridIncome -= lv * transCostPct;
        }
      }
    } else if (curr > prev) {
      for (const lv of [...levels].reverse()) {
        if (lv > prev && lv <= curr) {
          const matchIdx = inventory.findIndex((bp) => bp < lv);
          if (matchIdx >= 0) {
            const buyPrice = inventory[matchIdx];
            inventory.splice(matchIdx, 1);
            cumulGridIncome += lv - buyPrice - (lv + buyPrice) * transCostPct;
            completedTrips++;
          }
        }
      }
    }

    maxInventory = Math.max(maxInventory, inventory.length);
    const invPnl = inventory.reduce((s, bp) => s + (curr - bp), 0);
    const label = dates[t] ?? String(t);
    chartData.push({
      label,
      gridIncome: cumulGridIncome,
      inventoryPnl: invPnl,
      total: cumulGridIncome + invPnl,
    });
  }

  const lastPrice = prices[prices.length - 1];
  const finalInventoryPnl = inventory.reduce((s, bp) => s + (lastPrice - bp), 0);
  return {
    chartData,
    completedTrips,
    maxInventory,
    finalGridIncome: cumulGridIncome,
    finalInventoryPnl,
    finalTotal: cumulGridIncome + finalInventoryPnl,
  };
}

// ─── Formatters ──────────────────────────────────────────────────────────────────

function fmtLarge(val: number | null | undefined, prefix = "$"): string {
  if (val == null || Number.isNaN(val)) return "N/A";
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${prefix}${(val / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${prefix}${(val / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(val / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${prefix}${(val / 1e3).toFixed(0)}K`;
  return `${prefix}${val.toFixed(2)}`;
}
function fmtPrice(val: number | null | undefined): string {
  if (val == null) return "N/A";
  return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(val: number | null | undefined, decimals = 2): string {
  if (val == null || Number.isNaN(val)) return "N/A";
  return `${val >= 0 ? "+" : ""}${val.toFixed(decimals)}%`;
}

function fmtDateLabel(dateStr: string, period: TimePeriod): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  if (period === "1d" || dateStr.includes("T"))
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (period === "5d")
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (period === "5y" || period === "1y")
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Financials data transform ───────────────────────────────────────────────────

function transformFinancials(data: any, metric: FinancialMetric, mode: PeriodMode): FinancialBar[] {
  const incKey = mode === "annual" ? "incomeStatementHistory" : "incomeStatementHistoryQuarterly";
  const cfKey =
    mode === "annual" ? "cashflowStatementHistory" : "cashflowStatementHistoryQuarterly";
  const incList: any[] =
    data?.[incKey]?.[
      mode === "annual" ? "incomeStatementHistory" : "incomeStatementHistoryQuarterly"
    ] ?? [];
  const cfList: any[] =
    data?.[cfKey]?.[
      mode === "annual" ? "cashflowStatementHistory" : "cashflowStatementHistoryQuarterly"
    ] ?? [];

  const cfMap = new Map<string, number | null>();
  for (const cf of cfList) {
    const d = cf.endDate instanceof Date ? cf.endDate : new Date(cf.endDate);
    cfMap.set(d.toISOString().slice(0, 7), cf.freeCashflow ?? null);
  }

  return incList
    .map((stmt: any) => {
      const d = stmt.endDate instanceof Date ? stmt.endDate : new Date(stmt.endDate);
      const monthKey = d.toISOString().slice(0, 7);
      const label =
        mode === "annual"
          ? String(d.getFullYear())
          : `Q${Math.floor(d.getMonth() / 3) + 1}'${String(d.getFullYear()).slice(2)}`;
      const revenue = stmt.totalRevenue ?? null;
      const grossProfit = stmt.grossProfit ?? null;
      let value: number | null = null;
      switch (metric) {
        case "revenue":
          value = revenue;
          break;
        case "netIncome":
          value = stmt.netIncome ?? null;
          break;
        case "eps":
          value = stmt.basicEPS ?? null;
          break;
        case "freeCashFlow":
          value = cfMap.get(monthKey) ?? null;
          break;
        case "grossMargin":
          value = revenue && grossProfit ? (grossProfit / revenue) * 100 : null;
          break;
      }
      return { label, value };
    })
    .reverse()
    .slice(-8);
}

// ─── Tab button factory ──────────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  colors,
}: { active: boolean; onClick: () => void; label: string; colors: typeof bloombergColors.dark }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-1 text-xs font-mono border"
      style={{
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accent : "transparent",
        color: active ? "#000" : colors.text,
      }}
    >
      {label}
    </button>
  );
}

// ─── Metric row with bar ─────────────────────────────────────────────────────────

function MetricRow({
  label,
  value,
  suffix = "%",
  min = 0,
  max = 100,
  good,
  invert = false,
  colors,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  min?: number;
  max?: number;
  good?: number;
  invert?: boolean;
  colors: typeof bloombergColors.dark;
}) {
  if (value == null || Number.isNaN(value)) {
    return (
      <div className="flex justify-between items-center text-xs py-0.5">
        <span style={{ color: colors.textSecondary }}>{label}</span>
        <span style={{ color: colors.textSecondary }}>N/A</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min || 1)) * 100));
  const isGood = good == null ? true : invert ? value <= good : value >= good;
  const barColor = isGood ? colors.positive : colors.negative;

  return (
    <div className="py-0.5">
      <div className="flex justify-between text-xs mb-0.5">
        <span style={{ color: colors.textSecondary }}>{label}</span>
        <span
          className="font-bold font-mono"
          style={{ color: isGood ? colors.positive : colors.text }}
        >
          {value.toFixed(2)}
          {suffix}
        </span>
      </div>
      <div className="h-1.5" style={{ backgroundColor: colors.border }}>
        <div className="h-1.5" style={{ width: `${pct}%`, backgroundColor: barColor }} />
      </div>
    </div>
  );
}

// ─── Key Metrics tab ─────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<FinancialMetric, string> = {
  revenue: "Revenue",
  netIncome: "Net Income",
  eps: "EPS",
  freeCashFlow: "Free Cash Flow",
  grossMargin: "Gross Margin %",
};

function KeyMetricsTab({ quote, colors }: { quote: any; colors: typeof bloombergColors.dark }) {
  const sec = { color: colors.textSecondary };

  // ROIC: Net Income / (Equity + Debt - Cash)
  const netIncome =
    quote.profitMargins != null && quote.totalRevenue != null
      ? quote.profitMargins * quote.totalRevenue
      : quote.epsTrailingTwelveMonths != null && quote.sharesOutstanding != null
        ? quote.epsTrailingTwelveMonths * quote.sharesOutstanding
        : null;
  const equity =
    quote.totalStockholdersEquity ??
    (quote.bookValue != null && quote.sharesOutstanding != null
      ? quote.bookValue * quote.sharesOutstanding
      : null);
  const debt = quote.totalDebt ?? 0;
  const cash = quote.totalCash ?? 0;
  const investedCap = equity != null ? equity + debt - cash : null;
  const roic =
    netIncome != null && investedCap != null && investedCap > 0
      ? (netIncome / investedCap) * 100
      : null;

  const fcfMargin =
    quote.operatingCashflow != null && quote.capitalExpenditures != null && quote.totalRevenue
      ? ((quote.operatingCashflow + quote.capitalExpenditures) / quote.totalRevenue) * 100
      : null;

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="p-3 border" style={panel}>
      <div className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
        {title}
      </div>
      {children}
    </div>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {/* PROFITABILITY */}
      <Section title="PROFITABILITY">
        <MetricRow
          label="ROE"
          value={quote.returnOnEquity != null ? quote.returnOnEquity * 100 : null}
          suffix="%"
          min={0}
          max={60}
          good={15}
          colors={colors}
        />
        <MetricRow
          label="ROA"
          value={quote.returnOnAssets != null ? quote.returnOnAssets * 100 : null}
          suffix="%"
          min={0}
          max={30}
          good={5}
          colors={colors}
        />
        {roic != null && (
          <MetricRow
            label="ROIC"
            value={roic}
            suffix="%"
            min={0}
            max={60}
            good={10}
            colors={colors}
          />
        )}
        <MetricRow
          label="Gross Margin"
          value={quote.grossMargins != null ? quote.grossMargins * 100 : null}
          suffix="%"
          min={0}
          max={100}
          good={30}
          colors={colors}
        />
        <MetricRow
          label="Op. Margin"
          value={quote.operatingMargins != null ? quote.operatingMargins * 100 : null}
          suffix="%"
          min={0}
          max={50}
          good={10}
          colors={colors}
        />
        <MetricRow
          label="Net Margin"
          value={quote.profitMargins != null ? quote.profitMargins * 100 : null}
          suffix="%"
          min={0}
          max={40}
          good={5}
          colors={colors}
        />
      </Section>

      {/* VALUATION */}
      <Section title="VALUATION">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {[
            {
              label: "P/E (TTM)",
              value: quote.trailingPE != null ? `${quote.trailingPE.toFixed(1)}x` : "N/A",
            },
            {
              label: "Fwd P/E",
              value: quote.forwardPE != null ? `${quote.forwardPE.toFixed(1)}x` : "N/A",
            },
            {
              label: "EV/EBITDA",
              value:
                quote.enterpriseToEbitda != null
                  ? `${quote.enterpriseToEbitda.toFixed(1)}x`
                  : "N/A",
            },
            {
              label: "P/B",
              value: quote.priceToBook != null ? `${quote.priceToBook.toFixed(1)}x` : "N/A",
            },
            {
              label: "P/S",
              value:
                quote.priceToSalesTrailing12Months != null
                  ? `${quote.priceToSalesTrailing12Months.toFixed(1)}x`
                  : "N/A",
            },
            { label: "EV", value: fmtLarge(quote.enterpriseValue) },
            { label: "EBITDA", value: fmtLarge(quote.ebitda) },
            {
              label: "Book/Share",
              value: quote.bookValue != null ? `$${quote.bookValue.toFixed(2)}` : "N/A",
            },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="flex justify-between py-0.5 border-b"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <span className="font-bold font-mono">{value}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* LEVERAGE */}
      <Section title="LEVERAGE & LIQUIDITY">
        <MetricRow
          label="D/E Ratio"
          value={quote.debtToEquity}
          suffix="%"
          min={0}
          max={300}
          good={150}
          invert={true}
          colors={colors}
        />
        <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
          {[
            { label: "Total Debt", value: fmtLarge(quote.totalDebt) },
            { label: "Cash", value: fmtLarge(quote.totalCash) },
            {
              label: "Net Debt",
              value: debt != null && cash != null ? fmtLarge(debt - cash) : "N/A",
            },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-2 border text-center"
              style={{ borderColor: colors.border }}
            >
              <div style={sec} className="text-[9px] tracking-wider mb-1">
                {label}
              </div>
              <div className="font-bold font-mono">{value}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* CASH FLOW */}
      <Section title="CASH FLOW (TTM)">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {[
            { label: "Operating CF", value: fmtLarge(quote.operatingCashflow) },
            { label: "CapEx", value: fmtLarge(quote.capitalExpenditures) },
            {
              label: "Free Cash Flow",
              value:
                quote.operatingCashflow != null && quote.capitalExpenditures != null
                  ? fmtLarge(quote.operatingCashflow + quote.capitalExpenditures)
                  : "N/A",
            },
            { label: "FCF Margin", value: fcfMargin != null ? `${fcfMargin.toFixed(1)}%` : "N/A" },
            { label: "Revenue (TTM)", value: fmtLarge(quote.totalRevenue) },
            { label: "Shares Out.", value: fmtLarge(quote.sharesOutstanding, "") },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="flex justify-between py-0.5 border-b"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <span className="font-bold font-mono">{value}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ─── Quantitative tab ────────────────────────────────────────────────────────────

function QuantitativeTab({
  histData,
  colors,
}: { histData: any; colors: typeof bloombergColors.dark }) {
  const rawQuotes: any[] = (histData?.quotes ?? []).filter((q: any) => q.close != null);
  const prices = rawQuotes.map((q: any) => q.close as number);
  const dates = rawQuotes.map((q: any) => q.date as string);

  if (prices.length < 10) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-xs" style={{ color: colors.textSecondary }}>
          Loading 1-year price history for quantitative analysis…
        </p>
      </div>
    );
  }

  const returns = calcReturns(prices);
  const mu = statMean(returns);
  const sigma = statStd(returns, mu);
  const skew = statSkewness(returns);
  const kurt = statKurtosis(returns);
  const annRet = ((1 + mu) ** 252 - 1) * 100;
  const annVol = sigma * Math.sqrt(252) * 100;
  const var95 = historicalVaR(returns, 0.95) * 100;
  const var99 = historicalVaR(returns, 0.99) * 100;
  const es95 = expectedShortfall(returns, 0.95) * 100;
  const maxDD = calcMaxDrawdown(prices) * 100;
  const bins = buildHistogram(returns, 22);
  const normalY = normalCurve(bins, returns, mu, sigma);
  const histChartData = bins.map((b, i) => ({ ...b, normal: normalY[i] }));
  const ddSeries = buildDrawdownSeries(prices, dates);

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };
  const n = returns.length;

  return (
    <div className="space-y-4">
      {/* Return Distribution */}
      <div className="p-4 border" style={panel}>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
            RETURN DISTRIBUTION
          </h4>
          <span className="text-xs" style={sec}>
            n = {n} daily returns · 1Y history
          </span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={histChartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="2 2" stroke={colors.border} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              interval={3}
            />
            <YAxis
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                fontSize: 10,
                fontFamily: "monospace",
              }}
              formatter={(val: number, name: string) => [
                name === "normal" ? val.toFixed(1) : val,
                name === "normal" ? "Normal fit" : "Count",
              ]}
            />
            <Bar dataKey="count" isAnimationActive={false} maxBarSize={18}>
              {histChartData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.mid >= 0 ? colors.positive : colors.negative}
                  fillOpacity={0.8}
                />
              ))}
            </Bar>
            <Line
              dataKey="normal"
              stroke={colors.accent}
              strokeWidth={1.5}
              dot={false}
              strokeDasharray="3 2"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="text-[9px] mt-1" style={sec}>
          Dashed line = fitted normal distribution. Fat left tail (negative skew/high kurtosis) =
          higher tail risk than normal assumes.
        </p>
      </div>

      {/* Stats + Risk in 2 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Distribution Moments */}
        <div className="p-3 border" style={panel}>
          <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
            DISTRIBUTION &amp; MOMENTS
          </h4>
          {[
            { label: "Mean Return (daily)", value: `${(mu * 100).toFixed(4)}%`, note: "" },
            { label: "Ann. Return (est.)", value: `${fmtPct(annRet)}`, note: "" },
            { label: "Volatility (daily)", value: `${(sigma * 100).toFixed(4)}%`, note: "" },
            { label: "Ann. Volatility", value: `${annVol.toFixed(2)}%`, note: "" },
            {
              label: "Skewness",
              value: skew.toFixed(4),
              note:
                skew < -0.5
                  ? "⚠ negative — left-tail risk"
                  : skew > 0.5
                    ? "positive skew"
                    : "near-normal",
            },
            {
              label: "Excess Kurtosis",
              value: kurt.toFixed(4),
              note: kurt > 1 ? "⚠ fat tails — rare events larger than normal" : "near-normal tails",
            },
          ].map(({ label, value, note }) => (
            <div
              key={label}
              className="flex justify-between items-start py-1 border-b text-xs"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <div className="text-right">
                <span className="font-bold font-mono">{value}</span>
                {note && (
                  <div className="text-[9px] mt-0.5" style={sec}>
                    {note}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Risk Metrics */}
        <div className="p-3 border" style={panel}>
          <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
            RISK METRICS
          </h4>
          {[
            {
              label: "VaR 95% (1-day)",
              value: `${var95.toFixed(3)}%`,
              note: "Loss not exceeded 95% of days",
              color: colors.negative,
            },
            {
              label: "VaR 99% (1-day)",
              value: `${var99.toFixed(3)}%`,
              note: "Loss not exceeded 99% of days",
              color: colors.negative,
            },
            {
              label: "CVaR / ES 95%",
              value: `${es95.toFixed(3)}%`,
              note: "Expected loss beyond VaR 95%",
              color: colors.negative,
            },
            {
              label: "Max Drawdown",
              value: `-${maxDD.toFixed(2)}%`,
              note: "Worst peak-to-trough decline",
              color: colors.negative,
            },
            {
              label: "Ann. Volatility",
              value: `${annVol.toFixed(2)}%`,
              note: "σ × √252",
              color: kurt > 1 ? colors.negative : colors.text,
            },
            {
              label: "Sharpe (rf=0, approx.)",
              value: annVol > 0 ? (annRet / annVol).toFixed(3) : "N/A",
              note: "Higher = better risk/reward",
              color: annRet / annVol >= 1 ? colors.positive : colors.text,
            },
          ].map(({ label, value, note, color }) => (
            <div
              key={label}
              className="flex justify-between items-start py-1 border-b text-xs"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <div className="text-right">
                <span className="font-bold font-mono" style={{ color }}>
                  {value}
                </span>
                {note && (
                  <div className="text-[9px] mt-0.5" style={sec}>
                    {note}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Drawdown chart */}
      <div className="p-4 border" style={panel}>
        <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
          DRAWDOWN CHART
        </h4>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={ddSeries} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.negative} stopOpacity={0.6} />
                <stop offset="100%" stopColor={colors.negative} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              width={36}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke={colors.border} />
            <Tooltip
              contentStyle={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                fontSize: 10,
                fontFamily: "monospace",
              }}
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Drawdown"]}
            />
            <Area
              type="monotone"
              dataKey="dd"
              stroke={colors.negative}
              strokeWidth={1}
              fill="url(#ddGrad)"
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Grid Trading tab ────────────────────────────────────────────────────────────

function GridTradingTab({
  histData,
  colors,
}: { histData: any; colors: typeof bloombergColors.dark }) {
  const rawQuotes: any[] = (histData?.quotes ?? []).filter((q: any) => q.close != null);

  // AF-5: memoize derived arrays so slider drags don't re-derive these
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prices = useMemo(() => rawQuotes.map((q: any) => q.close as number), [histData]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dates = useMemo(() => rawQuotes.map((q: any) => (q.date as string) ?? ""), [histData]);

  const [spacingPct, setSpacingPct] = useState(1.5);
  const [nLevels, setNLevels] = useState(5);
  const [transCostPct, setTransCostPct] = useState(0.1);

  // Layer 1: price statistics — recompute only when prices change
  const stats = useMemo(() => {
    if (prices.length < 30) return null;
    const returns = calcReturns(prices);
    const mu = statMean(returns);
    const sigma = statStd(returns, mu);
    const annRet = ((1 + mu) ** 252 - 1) * 100;
    const annVol = sigma * Math.sqrt(252) * 100;
    const sharpe = annVol > 0 ? annRet / annVol : 0;
    const hurst = calcHurst(prices);
    const theta = calcOUTheta(prices);
    return { returns, mu, sigma, annRet, annVol, sharpe, hurst, theta };
  }, [prices]);

  // Layer 2: grid parameters — recompute when stats or spacing sliders change
  const gridParams = useMemo(() => {
    if (!stats) return null;
    const { sigma, theta } = stats;
    const thetaDaily = theta / 252;
    const optSpacing = thetaDaily > 0.001 ? (sigma / Math.sqrt(thetaDaily)) * 100 : sigma * 3 * 100;
    const clampedOptSpacing = Math.max(0.5, Math.min(10, optSpacing));
    const delta = spacingPct / 100;
    const crossRate = (sigma * Math.sqrt(2 / Math.PI)) / delta;
    const netProfit = delta - 2 * (transCostPct / 100);
    const expectedPnlPerDay = crossRate * netProfit * prices[prices.length - 1];
    return {
      thetaDaily,
      optSpacing,
      clampedOptSpacing,
      delta,
      crossRate,
      netProfit,
      expectedPnlPerDay,
    };
  }, [stats, spacingPct, transCostPct, prices]);

  // Layer 3: simulation — recompute when prices or any slider changes
  const sim = useMemo(
    () =>
      prices.length >= 30
        ? simulateGrid(prices, dates, spacingPct / 100, nLevels, transCostPct / 100)
        : null,
    [prices, dates, spacingPct, nLevels, transCostPct]
  );

  // Layer 4: suitability — depends on Layer 1 only
  const suit = useMemo(() => {
    if (!stats) return { score: 0, color: colors.negative, label: "UNSUITABLE" };
    const { hurst, sharpe, theta } = stats;
    const hurstScore = Math.max(0, Math.min(100, (0.5 - hurst) * 400 + 50));
    const sharpeScore = Math.max(0, Math.min(100, 100 - Math.abs(sharpe) * 60));
    const thetaScore = Math.max(0, Math.min(100, Math.log1p(theta) * 15));
    const score = Math.round(hurstScore * 0.4 + sharpeScore * 0.35 + thetaScore * 0.25);
    const color = score >= 65 ? colors.positive : score >= 40 ? colors.accent : colors.negative;
    const label = score >= 65 ? "SUITABLE" : score >= 40 ? "MARGINAL" : "UNSUITABLE";
    return { score, color, label };
  }, [stats, colors.positive, colors.accent, colors.negative]);

  // Thin chart data for rendering performance
  const chartData = useMemo(() => {
    if (!sim) return [];
    const step = Math.max(1, Math.floor(sim.chartData.length / 200));
    return sim.chartData.filter((_, i) => i % step === 0 || i === sim.chartData.length - 1);
  }, [sim]);

  if (prices.length < 30) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-xs" style={{ color: colors.textSecondary }}>
          Loading price history…
        </p>
      </div>
    );
  }
  if (!stats || !gridParams || !sim) return null;

  const { hurst, theta, sharpe, annVol } = stats;
  const { thetaDaily, clampedOptSpacing, crossRate, netProfit, expectedPnlPerDay } = gridParams;
  const { score: suitability, color: suitColor, label: suitLabel } = suit;

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };
  const tooltipStyle = {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    fontSize: 10,
    fontFamily: "monospace",
  };

  const P0 = prices[0];
  const Plast = prices[prices.length - 1];
  const buyHoldPnl = ((Plast - P0) / P0) * 100;

  return (
    <div className="space-y-4">
      {/* Suitability + Key Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Suitability gauge */}
        <div className="p-4 border flex flex-col items-center justify-center gap-2" style={panel}>
          <div className="text-[9px] tracking-widest font-bold" style={sec}>
            GRID SUITABILITY
          </div>
          <div className="text-4xl font-bold font-mono" style={{ color: suitColor }}>
            {suitability}
          </div>
          <div
            className="text-xs font-bold tracking-widest px-3 py-0.5 border"
            style={{ color: suitColor, borderColor: suitColor }}
          >
            {suitLabel}
          </div>
          <div className="text-[9px] text-center mt-1" style={sec}>
            Score 0–100 · Higher = more range-bound
          </div>
        </div>

        {/* Mean-reversion metrics */}
        <div className="p-3 border" style={panel}>
          <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
            MEAN REVERSION
          </h4>
          {[
            {
              label: "Hurst Exponent",
              value: hurst.toFixed(3),
              note:
                hurst < 0.45 ? "mean-reverting ✓" : hurst > 0.55 ? "trending ✗" : "random walk ~",
              color: hurst < 0.45 ? colors.positive : hurst > 0.55 ? colors.negative : colors.text,
            },
            {
              label: "OU Speed θ (ann.)",
              value: theta > 0 ? theta.toFixed(1) : "—",
              note:
                theta > 5 ? "fast reversion ✓" : theta > 1 ? "slow reversion ~" : "no reversion ✗",
              color: theta > 5 ? colors.positive : theta > 1 ? colors.accent : colors.negative,
            },
            {
              label: "Sharpe Ratio (ann.)",
              value: sharpe.toFixed(2),
              note:
                Math.abs(sharpe) < 0.5
                  ? "low drift ✓"
                  : Math.abs(sharpe) < 1
                    ? "moderate drift ~"
                    : "strong trend ✗",
              color:
                Math.abs(sharpe) < 0.5
                  ? colors.positive
                  : Math.abs(sharpe) < 1
                    ? colors.accent
                    : colors.negative,
            },
            {
              label: "Ann. Volatility",
              value: `${annVol.toFixed(1)}%`,
              note: "grid income driver",
              color: colors.text,
            },
          ].map(({ label, value, note, color }) => (
            <div
              key={label}
              className="flex justify-between items-start py-1 border-b text-xs"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <div className="text-right">
                <span className="font-bold font-mono" style={{ color }}>
                  {value}
                </span>
                <div className="text-[9px]" style={sec}>
                  {note}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Optimal config */}
        <div className="p-3 border" style={panel}>
          <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
            OPTIMAL CONFIG
          </h4>
          {[
            {
              label: "Optimal Spacing δ*",
              value: `${clampedOptSpacing.toFixed(2)}%`,
              note: thetaDaily > 0.001 ? "σ / √θ_daily" : "3 × daily σ (no OU)",
            },
            {
              label: "Crossing Rate (est.)",
              value: `${crossRate.toFixed(2)}×/day`,
              note: `at ${spacingPct}% spacing`,
            },
            {
              label: "Expected P&L/day",
              value: expectedPnlPerDay > 0 ? `+$${expectedPnlPerDay.toFixed(2)}` : "—",
              note: "per unit · gross of risk",
            },
            {
              label: "Grid Edge",
              value: netProfit > 0 ? `${(netProfit * 100).toFixed(3)}%/trip` : "NONE",
              note: `after ${transCostPct}% round-trip cost`,
              color: netProfit > 0 ? colors.positive : colors.negative,
            },
          ].map(({ label, value, note, color }) => (
            <div
              key={label}
              className="flex justify-between items-start py-1 border-b text-xs"
              style={{ borderColor: colors.border }}
            >
              <span style={sec}>{label}</span>
              <div className="text-right">
                <span className="font-bold font-mono" style={{ color: color ?? colors.text }}>
                  {value}
                </span>
                <div className="text-[9px]" style={sec}>
                  {note}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive backtest config */}
      <div className="p-4 border" style={panel}>
        <h4 className="text-xs font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
          BACKTEST CONFIG (1Y HISTORY)
        </h4>
        <div className="grid grid-cols-3 gap-6">
          {[
            {
              label: "Grid Spacing",
              value: spacingPct,
              min: 0.5,
              max: 10,
              step: 0.5,
              unit: "%",
              set: setSpacingPct,
              note: `Optimal: ${clampedOptSpacing.toFixed(1)}%`,
            },
            {
              label: "Grid Levels (each side)",
              value: nLevels,
              min: 2,
              max: 10,
              step: 1,
              unit: "",
              set: setNLevels,
              note: `Max capital deployed: ${nLevels} units`,
            },
            {
              label: "Transaction Cost",
              value: transCostPct,
              min: 0.01,
              max: 1,
              step: 0.05,
              unit: "%",
              set: setTransCostPct,
              note: `Round-trip: ${(transCostPct * 2).toFixed(2)}%`,
            },
          ].map(({ label, value, min, max, step, unit, set, note }) => (
            <div key={label}>
              <div className="flex justify-between mb-1">
                <span className="text-[10px]" style={sec}>
                  {label}
                </span>
                <span className="text-[10px] font-bold font-mono" style={{ color: colors.text }}>
                  {value}
                  {unit}
                </span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => set(Number(e.target.value))}
                className="w-full h-1 appearance-none cursor-pointer"
                style={{ accentColor: colors.accent }}
              />
              <div className="text-[9px] mt-1" style={sec}>
                {note}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* P&L Decomposition chart */}
      <div className="p-4 border" style={panel}>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
            P&L DECOMPOSITION
          </h4>
          <div className="flex gap-4 text-[9px]" style={sec}>
            <span>
              <span style={{ color: colors.positive }}>■</span> Grid Income (closed trips)
            </span>
            <span>
              <span style={{ color: colors.negative }}>■</span> Inventory P&L (open pos)
            </span>
            <span>
              <span style={{ color: colors.accent }}>■</span> Total
            </span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="2 2" stroke={colors.border} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 7, fill: colors.textSecondary }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <ReferenceLine y={0} stroke={colors.border} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: colors.text }}
              formatter={(v: number, name: string) => [
                `$${v.toFixed(2)}`,
                name === "gridIncome"
                  ? "Grid Income"
                  : name === "inventoryPnl"
                    ? "Inventory P&L"
                    : "Total P&L",
              ]}
            />
            <Line
              type="monotone"
              dataKey="gridIncome"
              stroke={colors.positive}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="inventoryPnl"
              stroke={colors.negative}
              strokeWidth={1}
              dot={false}
              isAnimationActive={false}
              strokeDasharray="3 2"
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke={colors.accent}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Backtest summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: "Completed Round-Trips",
            value: sim.completedTrips.toString(),
            note: "closed buy→sell pairs",
          },
          {
            label: "Grid Income (gross)",
            value: `$${sim.finalGridIncome.toFixed(2)}`,
            note: "per 1 unit position",
            color: sim.finalGridIncome > 0 ? colors.positive : colors.negative,
          },
          {
            label: "Total P&L",
            value: `$${sim.finalTotal.toFixed(2)}`,
            note: "grid + open inventory",
            color: sim.finalTotal > 0 ? colors.positive : colors.negative,
          },
          {
            label: "Buy & Hold P&L",
            value: `${buyHoldPnl >= 0 ? "+" : ""}${buyHoldPnl.toFixed(2)}%`,
            note: "baseline comparison",
            color: buyHoldPnl > 0 ? colors.positive : colors.negative,
          },
        ].map(({ label, value, note, color }) => (
          <div key={label} className="p-3 border text-center" style={panel}>
            <div className="text-[9px] tracking-wider mb-1" style={sec}>
              {label}
            </div>
            <div className="text-lg font-bold font-mono" style={{ color: color ?? colors.text }}>
              {value}
            </div>
            <div className="text-[9px] mt-1" style={sec}>
              {note}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[9px] px-1" style={sec}>
        Simulation: geometric grid around P₀={P0.toFixed(2)}, {nLevels} levels × {spacingPct}%
        spacing, {transCostPct}% cost/leg. Grid income = closed round-trips only. Inventory P&L =
        unrealized open positions marked to last close. No slippage model.
      </p>
    </div>
  );
}

// ─── Strategy Fit tab ────────────────────────────────────────────────────────────

function regimeLabel(metric: string, value: number): { text: string; color: string } {
  switch (metric) {
    case "H":
      if (value < 0.45) return { text: "MEAN-REV", color: "#00FF00" };
      if (value <= 0.55) return { text: "RANDOM WALK", color: "#ff9900" };
      return { text: "TRENDING", color: "#FF0000" };
    case "SR_adj":
      if (value > 1.0) return { text: "HIGH DRIFT ↑", color: "#00FF00" };
      if (value >= -1.0) return { text: "NOISE DOM.", color: "#ff9900" };
      return { text: "HIGH DRIFT ↓", color: "#FF0000" };
    case "ρ₁":
      if (value < -0.05) return { text: "MEAN-REV", color: "#00FF00" };
      if (value <= 0.05) return { text: "NEUTRAL", color: "#888888" };
      return { text: "MOMENTUM", color: "#ff9900" };
    case "σ_ann":
      if (value > 0.4) return { text: "HIGH VOL", color: "#FF0000" };
      if (value >= 0.15) return { text: "MOD VOL", color: "#ff9900" };
      return { text: "LOW VOL", color: "#888888" };
    case "θ":
      if (value > 10) return { text: "FAST REV", color: "#00FF00" };
      if (value >= 2) return { text: "SLOW REV", color: "#ff9900" };
      return { text: "NO REV", color: "#888888" };
    case "ExKurt":
      if (value > 2) return { text: "FAT TAILS", color: "#FF0000" };
      if (value >= 0) return { text: "NORMAL", color: "#888888" };
      return { text: "THIN TAILS", color: "#00FF00" };
    case "Skew":
      if (value < -0.5) return { text: "LEFT TAIL", color: "#FF0000" };
      if (value > 0.5) return { text: "RIGHT TAIL", color: "#00FF00" };
      return { text: "SYMMETRIC", color: "#888888" };
    default:
      return { text: "—", color: "#555555" };
  }
}

function StrategyFitTab({
  histData,
  colors,
}: { histData: any; colors: typeof bloombergColors.dark }) {
  const quotes: { close: number }[] = histData?.quotes ?? [];

  // AF-5: memoize price array — avoid re-filtering on every parent render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prices = useMemo(
    () => quotes.map((q: any) => q.close ?? q).filter((p: any) => typeof p === "number" && p > 0),
    [histData]
  );

  // AF-5: all heavy metrics depend only on prices — memoize as one block
  const metrics = useMemo(() => {
    if (prices.length < 60) return null;
    const logRets = calcLogReturns(prices);
    const muDaily = statMean(logRets);
    const sigmaDaily = statStd(logRets, muDaily);
    const SR = sigmaDaily > 0 ? (muDaily * Math.sqrt(252)) / sigmaDaily : 0;
    const skew = statSkewness(logRets);
    const exKurt = statKurtosis(logRets);
    const SR_adj = adjustedSharpe(SR, skew, exKurt);
    const sigmaAnn = sigmaDaily * Math.sqrt(252);
    const rho1 = calcRho1(logRets);
    const H = calcHurst(prices);
    const theta = calcOUTheta(prices);
    return { logRets, muDaily, sigmaDaily, SR, skew, exKurt, SR_adj, sigmaAnn, rho1, H, theta };
  }, [prices]);

  // AF-5: scores depend only on derived metrics
  const scores = useMemo(() => {
    if (!metrics) return null;
    const { H, SR_adj, rho1, sigmaAnn, theta, exKurt } = metrics;
    return calcStrategyScores(H, SR_adj, rho1, sigmaAnn, theta, exKurt);
  }, [metrics]);

  // Minimum data guard (after hooks)
  if (prices.length < 60) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-xs" style={{ color: colors.textSecondary }}>
          Requires ≥ 60 trading days of history (current: {prices.length})
        </p>
      </div>
    );
  }
  if (!metrics || !scores) return null;

  const { H, SR_adj, rho1, sigmaAnn, theta, skew, exKurt } = metrics;
  const primary = scores[0];

  const sec = { color: colors.textSecondary, fontFamily: "monospace" };

  // Regime Map coordinate mapping (static geometry — no useMemo needed)
  const mapW = 240;
  const mapH = 200;
  const pad = { l: 36, r: 16, t: 16, b: 28 };
  const plotW = mapW - pad.l - pad.r;
  const plotH = mapH - pad.t - pad.b;
  const hMin = 0.25;
  const hMax = 0.8;
  const srMin = 0.0;
  const srMax = 2.5;
  const toX = (h: number) => pad.l + ((h - hMin) / (hMax - hMin)) * plotW;
  const toY = (sr: number) => pad.t + plotH - ((sr - srMin) / (srMax - srMin)) * plotH;

  // Strategy zones for Regime Map
  const zones: { label: string; h1: number; h2: number; sr1: number; sr2: number }[] = [
    { label: "GRID + MR", h1: 0.25, h2: 0.5, sr1: 0.0, sr2: 0.6 },
    { label: "VOL HARVEST", h1: 0.45, h2: 0.55, sr1: 0.0, sr2: 0.8 },
    { label: "BREAKOUT", h1: 0.55, h2: 0.8, sr1: 0.0, sr2: 0.6 },
    { label: "MOM / TF / B&H", h1: 0.55, h2: 0.8, sr1: 0.6, sr2: 2.5 },
  ];

  const stockX = toX(Math.max(hMin, Math.min(hMax, H)));
  const stockY = toY(Math.max(srMin, Math.min(srMax, Math.abs(SR_adj))));

  // Metric cards for regime vector
  const metricCards: { name: string; value: number; fmt: string }[] = [
    { name: "H", value: H, fmt: H.toFixed(3) },
    { name: "SR_adj", value: SR_adj, fmt: (SR_adj >= 0 ? "+" : "") + SR_adj.toFixed(2) },
    { name: "ρ₁", value: rho1, fmt: (rho1 >= 0 ? "+" : "") + rho1.toFixed(3) },
    { name: "σ_ann", value: sigmaAnn, fmt: `${(sigmaAnn * 100).toFixed(1)}%` },
    { name: "θ", value: theta, fmt: theta.toFixed(1) },
    { name: "Skew", value: skew, fmt: (skew >= 0 ? "+" : "") + skew.toFixed(2) },
    { name: "ExKurt", value: exKurt, fmt: (exKurt >= 0 ? "+" : "") + exKurt.toFixed(2) },
  ];

  return (
    <div className="flex flex-col gap-2" style={{ fontFamily: "monospace" }}>
      {/* Disclaimer */}
      <div className="text-[9px] px-1" style={{ color: colors.textSecondary }}>
        ※ All scores are computed from trailing 1Y daily close prices. They describe past
        statistical regime, not future returns.
      </div>

      {/* ── Section A: Regime Vector ── */}
      <div
        className="grid grid-cols-7 gap-px"
        style={{ background: colors.border, border: `1px solid ${colors.border}` }}
      >
        {metricCards.map((m) => {
          const rl = regimeLabel(m.name, m.value);
          return (
            <div
              key={m.name}
              className="flex flex-col items-center py-2 px-1"
              style={{ background: colors.surface }}
            >
              <span className="text-[9px] tracking-wider" style={{ color: colors.textSecondary }}>
                {m.name === "ρ₁" ? "RHO₁" : m.name === "SR_adj" ? "SR_ADJ" : m.name.toUpperCase()}
              </span>
              <span className="text-xs font-bold mt-0.5" style={{ color: colors.text }}>
                {m.fmt}
              </span>
              <span className="text-[7px] mt-0.5" style={{ color: rl.color }}>
                {rl.text}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Section B + C: Leaderboard + Regime Map ── */}
      <div className="flex gap-2">
        {/* Leaderboard */}
        <div
          className="flex-1 flex flex-col gap-1 p-2"
          style={{ background: colors.surface, border: `1px solid ${colors.border}` }}
        >
          <h4
            className="text-[10px] font-bold tracking-widest mb-1"
            style={{ color: colors.accent }}
          >
            STRATEGY SCORES
          </h4>
          {scores.map((s) => {
            const barColor =
              s.score >= 60 ? colors.positive : s.score >= 40 ? colors.accent : "#333333";
            const isPrimary = s.id === primary.id;
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span
                  className="text-[9px] w-4 text-right"
                  style={{ color: isPrimary ? colors.accent : "#555555" }}
                >
                  {isPrimary ? "●" : ""}
                </span>
                <span
                  className="text-[9px] w-40 truncate"
                  style={{ color: isPrimary ? colors.text : colors.textSecondary }}
                >
                  {s.name}
                </span>
                <div className="flex-1 h-[6px]" style={{ background: "#111111" }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(100, s.score)}%`,
                      background: barColor,
                      borderRadius: "1px",
                    }}
                  />
                </div>
                <span className="text-[10px] font-bold w-8 text-right" style={{ color: barColor }}>
                  {Math.round(s.score)}
                </span>
                {isPrimary && (
                  <span
                    className="text-[7px] px-1 py-0.5 border font-bold"
                    style={{
                      borderColor:
                        s.label === "SUITABLE"
                          ? colors.positive
                          : s.label === "MARGINAL"
                            ? colors.accent
                            : "#333333",
                      color:
                        s.label === "SUITABLE"
                          ? colors.positive
                          : s.label === "MARGINAL"
                            ? colors.accent
                            : "#555555",
                    }}
                  >
                    {s.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Regime Map */}
        <div
          className="p-2"
          style={{ background: colors.surface, border: `1px solid ${colors.border}` }}
        >
          <h4
            className="text-[10px] font-bold tracking-widest mb-1"
            style={{ color: colors.accent }}
          >
            REGIME MAP
          </h4>
          <svg width={mapW} height={mapH} viewBox={`0 0 ${mapW} ${mapH}`}>
            {/* Zone rects */}
            {zones.map((z) => (
              <rect
                key={z.label}
                x={toX(z.h1)}
                y={toY(z.sr2)}
                width={toX(z.h2) - toX(z.h1)}
                height={toY(z.sr1) - toY(z.sr2)}
                fill={colors.accent}
                opacity={0.06}
              />
            ))}
            {/* Reference lines */}
            <line
              x1={toX(0.5)}
              y1={pad.t}
              x2={toX(0.5)}
              y2={pad.t + plotH}
              stroke={colors.border}
              strokeDasharray="3 2"
            />
            <line
              x1={pad.l}
              y1={toY(1.0)}
              x2={pad.l + plotW}
              y2={toY(1.0)}
              stroke={colors.border}
              strokeDasharray="3 2"
            />
            {/* Axes */}
            <line
              x1={pad.l}
              y1={pad.t + plotH}
              x2={pad.l + plotW}
              y2={pad.t + plotH}
              stroke={colors.border}
            />
            <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke={colors.border} />
            {/* Axis labels */}
            <text
              x={pad.l + plotW / 2}
              y={mapH - 4}
              textAnchor="middle"
              fontSize={8}
              fill={colors.textSecondary}
            >
              ← MEAN-REV · H · TRENDING →
            </text>
            <text
              x={8}
              y={pad.t + plotH / 2}
              textAnchor="middle"
              fontSize={8}
              fill={colors.textSecondary}
              transform={`rotate(-90, 8, ${pad.t + plotH / 2})`}
            >
              │SR│ →
            </text>
            {/* Tick labels */}
            {[0.3, 0.4, 0.5, 0.6, 0.7].map((v) => (
              <text
                key={`h${v}`}
                x={toX(v)}
                y={pad.t + plotH + 12}
                textAnchor="middle"
                fontSize={7}
                fill={colors.textSecondary}
              >
                {v.toFixed(1)}
              </text>
            ))}
            {[0.5, 1.0, 1.5, 2.0].map((v) => (
              <text
                key={`sr${v}`}
                x={pad.l - 6}
                y={toY(v) + 3}
                textAnchor="end"
                fontSize={7}
                fill={colors.textSecondary}
              >
                {v.toFixed(1)}
              </text>
            ))}
            {/* Zone labels */}
            {zones.map((z) => {
              const cx = (toX(z.h1) + toX(z.h2)) / 2;
              const cy = (toY(z.sr1) + toY(z.sr2)) / 2;
              return (
                <text
                  key={`zl${z.label}`}
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  fontSize={6}
                  fill={colors.textSecondary}
                  opacity={0.6}
                >
                  {z.label}
                </text>
              );
            })}
            {/* Stock marker */}
            <circle cx={stockX} cy={stockY} r={5} fill={colors.accent} />
            <circle cx={stockX} cy={stockY} r={2} fill="#000" />
          </svg>
        </div>
      </div>

      {/* ── Section D: Primary Strategy Detail ── */}
      {primary && (
        <div
          className="p-3"
          style={{ background: colors.surface, border: `1px solid ${colors.border}` }}
        >
          <h4 className="text-xs font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
            PRIMARY STRATEGY: {primary.name}
            <span
              className="ml-2 text-[10px] px-1.5 py-0.5 border font-bold"
              style={{
                borderColor:
                  primary.label === "SUITABLE"
                    ? colors.positive
                    : primary.label === "MARGINAL"
                      ? colors.accent
                      : "#333333",
                color:
                  primary.label === "SUITABLE"
                    ? colors.positive
                    : primary.label === "MARGINAL"
                      ? colors.accent
                      : "#555555",
              }}
            >
              {primary.score.toFixed(0)} / 100
            </span>
          </h4>

          {/* Dimension table header */}
          <div
            className="grid grid-cols-11 gap-1 mb-1 px-2 py-1 text-[8px] font-bold"
            style={{ color: "#555555", borderBottom: `1px solid ${colors.border}` }}
          >
            <span className="col-span-3">DIMENSION</span>
            <span className="col-span-2 text-right">MEASURED</span>
            <span className="col-span-2 text-right">OPTIMAL</span>
            <span className="col-span-2 text-right">φ</span>
            <span className="text-right">WEIGHT</span>
            <span className="text-right">CONTRIB</span>
          </div>

          {primary.dims.map((d) => {
            const phiBarW = Math.round(d.phi * 60);
            const bottleneck = primary.dims.reduce((a, b) => (a.phi < b.phi ? a : b));
            const isBottleneck = d.name === bottleneck.name;
            return (
              <div
                key={d.name}
                className="grid grid-cols-11 gap-1 px-2 py-1.5 text-[9px] items-center"
                style={{
                  borderBottom: `1px solid ${colors.border}`,
                  background: isBottleneck ? "rgba(255,0,0,0.04)" : "transparent",
                }}
              >
                <span
                  className="col-span-3 font-bold"
                  style={{ color: isBottleneck ? colors.negative : colors.text }}
                >
                  {d.name === "ρ₁" ? "RHO₁" : d.name.toUpperCase()}
                </span>
                <span className="col-span-2 text-right font-mono" style={{ color: colors.text }}>
                  {d.name === "σ_ann"
                    ? `${(d.value * 100).toFixed(1)}%`
                    : d.name === "θ"
                      ? d.value.toFixed(1)
                      : d.name === "ExKurt"
                        ? (d.value >= 0 ? "+" : "") + d.value.toFixed(2)
                        : d.value.toFixed(3)}
                </span>
                <span
                  className="col-span-2 text-right font-mono"
                  style={{ color: colors.textSecondary }}
                >
                  {d.name === "σ_ann"
                    ? `${(d.mu * 100).toFixed(0)}%`
                    : d.name === "θ"
                      ? d.mu.toFixed(0)
                      : d.mu.toFixed(3)}
                </span>
                <span
                  className="col-span-2 text-right font-mono"
                  style={{
                    color:
                      d.phi >= 0.5
                        ? colors.positive
                        : d.phi >= 0.2
                          ? colors.accent
                          : colors.negative,
                  }}
                >
                  <span
                    className="inline-block h-[4px] align-middle mr-1"
                    style={{
                      width: `${Math.max(1, phiBarW)}px`,
                      background:
                        d.phi >= 0.5
                          ? colors.positive
                          : d.phi >= 0.2
                            ? colors.accent
                            : colors.negative,
                      borderRadius: "1px",
                    }}
                  />
                  {d.phi.toFixed(2)}
                </span>
                <span className="text-right" style={{ color: colors.textSecondary }}>
                  {(d.w * 100).toFixed(0)}%
                </span>
                <span className="text-right font-bold font-mono" style={{ color: colors.text }}>
                  {d.contrib.toFixed(3)}
                </span>
              </div>
            );
          })}

          {/* Total row */}
          <div
            className="grid gap-1 px-2 py-1.5 text-[9px] font-bold"
            style={{ color: colors.accent }}
          >
            <span className="col-span-11 text-right">
              Σ CONTRIBUTION × 100 = {primary.score.toFixed(0)}
            </span>
          </div>

          {/* Bottleneck interpretation */}
          {(() => {
            const bottleneck = primary.dims.reduce((a, b) => (a.phi < b.phi ? a : b));
            const bnName = bottleneck.name === "ρ₁" ? "RHO₁" : bottleneck.name.toUpperCase();
            const bnVal =
              bottleneck.name === "σ_ann"
                ? `${(bottleneck.value * 100).toFixed(1)}%`
                : bottleneck.value.toFixed(3);
            const bnMu =
              bottleneck.name === "σ_ann"
                ? `${(bottleneck.mu * 100).toFixed(0)}%`
                : bottleneck.mu.toFixed(3);
            return (
              <div className="mt-2 text-[9px]" style={{ color: colors.textSecondary }}>
                {bnName} = {bnVal} (optimal: {bnMu}) —{" "}
                {bottleneck.phi < 0.1
                  ? "far from optimal, limiting overall score"
                  : bottleneck.phi < 0.3
                    ? "below optimal range"
                    : "moderate fit"}
              </div>
            );
          })()}
        </div>
      )}

      {/* Divider with data source note */}
      <div className="text-[8px] pb-2" style={{ color: "#444444" }}>
        Data: Yahoo Finance via backend. Metrics recomputed on tab load. 1Y daily close prices (
        {prices.length} observations).
      </div>
    </div>
  );
}

// ─── Financials tab ──────────────────────────────────────────────────────────────

type FinSubTab = "income" | "balanceSheet" | "ratios" | "dividends" | "management" | "secFilings";

function FinancialsTab({
  financialsQuery,
  activeSymbol,
  colors,
}: { financialsQuery: any; activeSymbol: string; colors: typeof bloombergColors.dark }) {
  const [subTab, setSubTab] = useState<FinSubTab>("income");
  const [financialMetric, setFinancialMetric] = useState<FinancialMetric>("revenue");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("annual");

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };

  const SUB_TABS: { id: FinSubTab; label: string }[] = [
    { id: "income", label: "INCOME" },
    { id: "balanceSheet", label: "BALANCE SHEET" },
    { id: "ratios", label: "RATIOS" },
    { id: "dividends", label: "DIVIDENDS" },
    { id: "management", label: "MANAGEMENT" },
    { id: "secFilings", label: "SEC FILINGS" },
  ];

  return (
    <div className="p-4 border" style={panel}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
          FINANCIALS
        </h3>
      </div>
      {/* Sub-tab selector */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {SUB_TABS.map(({ id, label }) => (
          <TabBtn
            key={id}
            active={subTab === id}
            onClick={() => setSubTab(id)}
            label={label}
            colors={colors}
          />
        ))}
      </div>

      {subTab === "income" && (
        <IncomeSubTab
          financialsQuery={financialsQuery}
          activeSymbol={activeSymbol}
          colors={colors}
          financialMetric={financialMetric}
          setFinancialMetric={setFinancialMetric}
          periodMode={periodMode}
          setPeriodMode={setPeriodMode}
        />
      )}
      {subTab === "balanceSheet" && activeSymbol && (
        <BalanceSheetSubTab symbol={activeSymbol} colors={colors} />
      )}
      {subTab === "ratios" && activeSymbol && (
        <RatiosSubTab symbol={activeSymbol} colors={colors} />
      )}
      {subTab === "dividends" && activeSymbol && (
        <DividendsSubTab symbol={activeSymbol} colors={colors} />
      )}
      {subTab === "management" && activeSymbol && (
        <ManagementSubTab symbol={activeSymbol} colors={colors} />
      )}
      {subTab === "secFilings" && activeSymbol && (
        <SecFilingsSubTab symbol={activeSymbol} colors={colors} />
      )}
    </div>
  );
}

/* ── Income Statement (original financials chart) ────────────────────────── */
function IncomeSubTab({
  financialsQuery,
  activeSymbol,
  colors,
  financialMetric,
  setFinancialMetric,
  periodMode,
  setPeriodMode,
}: {
  financialsQuery: any;
  activeSymbol: string;
  colors: typeof bloombergColors.dark;
  financialMetric: FinancialMetric;
  setFinancialMetric: (m: FinancialMetric) => void;
  periodMode: PeriodMode;
  setPeriodMode: (m: PeriodMode) => void;
}) {
  const financialBars: FinancialBar[] =
    activeSymbol && financialsQuery.data
      ? transformFinancials(financialsQuery.data, financialMetric, periodMode)
      : [];

  const metricYAxisFmt = (metric: FinancialMetric) => {
    if (metric === "eps") return (v: number) => `$${v.toFixed(2)}`;
    if (metric === "grossMargin") return (v: number) => `${v.toFixed(1)}%`;
    return (v: number) => fmtLarge(v, "");
  };
  const metricValueFmt = (metric: FinancialMetric) => {
    if (metric === "eps") return (v: number | null) => (v != null ? `$${v.toFixed(2)}` : "N/A");
    if (metric === "grossMargin")
      return (v: number | null) => (v != null ? `${v.toFixed(2)}%` : "N/A");
    return (v: number | null) => fmtLarge(v);
  };

  const valueFmt = metricValueFmt(financialMetric);
  const yAxisFmt = metricYAxisFmt(financialMetric);

  return (
    <>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(METRIC_LABELS) as FinancialMetric[]).map((m) => (
            <TabBtn
              key={m}
              active={financialMetric === m}
              onClick={() => setFinancialMetric(m)}
              label={METRIC_LABELS[m]}
              colors={colors}
            />
          ))}
        </div>
        <div className="flex gap-1">
          {(["annual", "quarterly"] as PeriodMode[]).map((m) => (
            <TabBtn
              key={m}
              active={periodMode === m}
              onClick={() => setPeriodMode(m)}
              label={m === "annual" ? "Annual" : "Quarterly"}
              colors={colors}
            />
          ))}
        </div>
      </div>

      {financialsQuery.isLoading ? (
        <div className="flex items-center justify-center h-52">
          <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
        </div>
      ) : financialBars.length === 0 ? (
        <div className="flex items-center justify-center h-52">
          <span className="text-xs" style={{ color: colors.textSecondary }}>
            {financialsQuery.isError
              ? "Financial data unavailable"
              : "No data — try Annual or different metric"}
          </span>
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={financialBars} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: colors.textSecondary }}
                tickLine={false}
                axisLine={{ stroke: colors.border }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: colors.textSecondary }}
                tickLine={false}
                axisLine={false}
                tickFormatter={yAxisFmt}
                width={60}
              />
              <ReferenceLine y={0} stroke={colors.border} />
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  color: colors.text,
                  fontSize: 11,
                  fontFamily: "monospace",
                  borderRadius: 0,
                }}
                formatter={(value: number) => [valueFmt(value), METRIC_LABELS[financialMetric]]}
                labelStyle={{ color: colors.textSecondary }}
                cursor={{ fill: colors.border, fillOpacity: 0.2 }}
              />
              <Bar dataKey="value" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {financialBars.map((entry, i) => (
                  <Cell
                    key={`c-${i}`}
                    fill={(entry.value ?? 0) >= 0 ? colors.positive : colors.negative}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-6 mt-3 text-xs" style={{ color: colors.textSecondary }}>
            <span>
              Latest:{" "}
              <span className="font-bold" style={{ color: colors.text }}>
                {valueFmt(financialBars[financialBars.length - 1]?.value ?? null)}
              </span>
            </span>
            {financialBars.length >= 2 &&
              (() => {
                const first = financialBars[0].value;
                const last = financialBars[financialBars.length - 1].value;
                if (first == null || last == null || first === 0) return null;
                const pct = ((last - first) / Math.abs(first)) * 100;
                return (
                  <span>
                    vs {financialBars[0].label}:{" "}
                    <span
                      className="font-bold"
                      style={{ color: pct >= 0 ? colors.positive : colors.negative }}
                    >
                      {pct >= 0 ? "+" : ""}
                      {pct.toFixed(1)}%
                    </span>
                  </span>
                );
              })()}
          </div>
        </>
      )}
    </>
  );
}

/* ── Balance Sheet Sub-Tab ────────────────────────────────────────────────── */
function BalanceSheetSubTab({
  symbol,
  colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const [bsPeriod, setBsPeriod] = useState<"annual" | "quarterly">("annual");
  const { data, isLoading } = useQuery({
    queryKey: ["balanceSheet", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=balance-sheet&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 300_000,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-52">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );

  const rows = data?.[bsPeriod] ?? [];
  if (rows.length === 0)
    return (
      <div className="text-xs text-center py-8" style={{ color: colors.textSecondary }}>
        No balance sheet data
      </div>
    );

  const fmtB = (v: number | null) => {
    if (v == null) return "—";
    if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toLocaleString()}`;
  };

  const fields: { key: string; label: string }[] = [
    { key: "totalAssets", label: "Total Assets" },
    { key: "totalLiabilities", label: "Total Liabilities" },
    { key: "stockholdersEquity", label: "Stockholders' Equity" },
    { key: "totalDebt", label: "Total Debt" },
    { key: "netDebt", label: "Net Debt" },
    { key: "cash", label: "Cash" },
    { key: "shortTermInvestments", label: "Short-Term Investments" },
    { key: "currentAssets", label: "Current Assets" },
    { key: "currentLiabilities", label: "Current Liabilities" },
  ];

  return (
    <>
      <div className="flex gap-1 mb-3">
        {(["annual", "quarterly"] as const).map((m) => (
          <TabBtn
            key={m}
            active={bsPeriod === m}
            onClick={() => setBsPeriod(m)}
            label={m === "annual" ? "Annual" : "Quarterly"}
            colors={colors}
          />
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left py-1 pr-4" style={{ color: colors.textSecondary }}>
                ITEM
              </th>
              {rows.map((r: any) => (
                <th
                  key={r.endDate}
                  className="text-right py-1 px-2 whitespace-nowrap"
                  style={{ color: colors.textSecondary }}
                >
                  {r.endDate?.slice(0, 7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map(({ key, label }) => (
              <tr key={key} style={{ borderBottom: `1px solid ${colors.border}22` }}>
                <td className="py-1.5 pr-4 whitespace-nowrap" style={{ color: colors.text }}>
                  {label}
                </td>
                {rows.map((r: any) => (
                  <td
                    key={r.endDate}
                    className="text-right py-1.5 px-2 whitespace-nowrap"
                    style={{ color: colors.text }}
                  >
                    {fmtB(r[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Stacked bar chart for Assets vs Liabilities vs Equity */}
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart
            data={rows.map((r: any) => ({
              period: r.endDate?.slice(0, 7),
              assets: r.totalAssets,
              liabilities: r.totalLiabilities,
              equity: r.stockholdersEquity,
            }))}
            margin={{ top: 5, right: 10, left: 5, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
            <XAxis
              dataKey="period"
              tick={{ fontSize: 9, fill: colors.textSecondary }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: colors.textSecondary }}
              tickLine={false}
              tickFormatter={(v) => `${(v / 1e9).toFixed(0)}B`}
              width={50}
              domain={[0, "auto"]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                color: colors.text,
                fontSize: 10,
                fontFamily: "monospace",
                borderRadius: 0,
              }}
              formatter={(value: unknown) => [fmtB(Number(value)), ""]}
            />
            <Bar
              dataKey="assets"
              name="Assets"
              fill="#00C853"
              isAnimationActive={false}
              radius={[2, 2, 0, 0]}
            />
            <Bar
              dataKey="liabilities"
              name="Liabilities"
              fill="#FF5252"
              isAnimationActive={false}
              radius={[2, 2, 0, 0]}
            />
            <Bar
              dataKey="equity"
              name="Equity"
              fill="#448AFF"
              isAnimationActive={false}
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
        <div
          className="flex gap-4 mt-1 text-[9px] font-mono"
          style={{ color: colors.textSecondary }}
        >
          <span>
            <span style={{ color: "#00C853" }}>{"■"}</span> Assets
          </span>
          <span>
            <span style={{ color: "#FF5252" }}>{"■"}</span> Liabilities
          </span>
          <span>
            <span style={{ color: "#448AFF" }}>{"■"}</span> Equity
          </span>
        </div>
      </div>
    </>
  );
}

/* ── Financial Ratios Sub-Tab ─────────────────────────────────────────────── */
function RatiosSubTab({ symbol, colors }: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ratios", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=ratios&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 300_000,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-52">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  if (!data)
    return (
      <div className="text-xs text-center py-8" style={{ color: colors.textSecondary }}>
        No ratios data
      </div>
    );

  const fmtPct = (v: number | null) => (v != null ? `${(v * 100).toFixed(2)}%` : "—");
  const fmtNum = (v: number | null) => (v != null ? v.toFixed(2) : "—");
  const fmtDollar = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : "—");
  const fmtBig = (v: number | null) => {
    if (v == null) return "—";
    if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toLocaleString()}`;
  };

  const sections: { title: string; items: { label: string; value: string }[] }[] = [
    {
      title: "PROFITABILITY",
      items: [
        { label: "Return on Equity (ROE)", value: fmtPct(data.profitability?.returnOnEquity) },
        { label: "Return on Assets (ROA)", value: fmtPct(data.profitability?.returnOnAssets) },
        { label: "Gross Margin", value: fmtPct(data.profitability?.grossMargins) },
        { label: "Operating Margin", value: fmtPct(data.profitability?.operatingMargins) },
        { label: "Net Profit Margin", value: fmtPct(data.profitability?.profitMargins) },
        { label: "EBITDA Margin", value: fmtPct(data.profitability?.ebitdaMargins) },
      ],
    },
    {
      title: "LEVERAGE & LIQUIDITY",
      items: [
        { label: "Debt to Equity", value: fmtNum(data.leverage?.debtToEquity) },
        { label: "Current Ratio", value: fmtNum(data.leverage?.currentRatio) },
        { label: "Quick Ratio", value: fmtNum(data.leverage?.quickRatio) },
        { label: "Total Debt", value: fmtBig(data.leverage?.totalDebt) },
        { label: "Total Cash", value: fmtBig(data.leverage?.totalCash) },
        { label: "Cash Per Share", value: fmtDollar(data.leverage?.totalCashPerShare) },
      ],
    },
    {
      title: "VALUATION",
      items: [
        { label: "Trailing P/E", value: fmtNum(data.valuation?.trailingPE) },
        { label: "Forward P/E", value: fmtNum(data.valuation?.forwardPE) },
        { label: "Price/Book", value: fmtNum(data.valuation?.priceToBook) },
        { label: "Price/Sales", value: fmtNum(data.valuation?.priceToSalesTrailing12Months) },
        { label: "EV/Revenue", value: fmtNum(data.valuation?.enterpriseToRevenue) },
        { label: "EV/EBITDA", value: fmtNum(data.valuation?.enterpriseToEbitda) },
        { label: "PEG Ratio", value: fmtNum(data.valuation?.pegRatio) },
      ],
    },
    {
      title: "GROWTH",
      items: [
        { label: "Revenue Growth (YoY)", value: fmtPct(data.growth?.revenueGrowth) },
        { label: "Earnings Growth (YoY)", value: fmtPct(data.growth?.earningsGrowth) },
        { label: "Quarterly Earnings Growth", value: fmtPct(data.growth?.earningsQuarterlyGrowth) },
      ],
    },
    {
      title: "PER SHARE",
      items: [
        { label: "Book Value", value: fmtDollar(data.perShare?.bookValue) },
        { label: "Trailing EPS", value: fmtDollar(data.perShare?.trailingEps) },
        { label: "Forward EPS", value: fmtDollar(data.perShare?.forwardEps) },
        { label: "Revenue / Share", value: fmtDollar(data.perShare?.revenuePerShare) },
      ],
    },
    {
      title: "DIVIDENDS",
      items: [
        { label: "Dividend Rate", value: fmtDollar(data.dividends?.dividendRate) },
        { label: "Dividend Yield", value: fmtPct(data.dividends?.dividendYield) },
        { label: "Payout Ratio", value: fmtPct(data.dividends?.payoutRatio) },
        {
          label: "5Y Avg Yield",
          value:
            data.dividends?.fiveYearAvgDividendYield != null
              ? `${data.dividends.fiveYearAvgDividendYield.toFixed(2)}%`
              : "—",
        },
      ],
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {sections.map((sec) => (
        <div key={sec.title} className="border p-3" style={{ borderColor: colors.border }}>
          <h4
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            {sec.title}
          </h4>
          {sec.items.map((item) => (
            <div
              key={item.label}
              className="flex justify-between py-0.5"
              style={{ borderBottom: `1px solid ${colors.border}22` }}
            >
              <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                {item.label}
              </span>
              <span className="text-[10px] font-mono font-bold" style={{ color: colors.text }}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Dividends Sub-Tab ────────────────────────────────────────────────────── */
function DividendsSubTab({
  symbol,
  colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["dividends", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=dividends&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 300_000,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-52">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );

  const divs: { date: string; dividend: number }[] = data?.dividends ?? [];
  const splits: { date: string; ratio: number }[] = data?.splits ?? [];

  // Show last 40 dividends for chart
  const chartDivs = divs.slice(-40);

  return (
    <>
      {chartDivs.length > 0 ? (
        <>
          <h4
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            DIVIDEND HISTORY ({divs.length} payments)
          </h4>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartDivs} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 8, fill: colors.textSecondary }}
                tickLine={false}
                minTickGap={30}
              />
              <YAxis
                tick={{ fontSize: 9, fill: colors.textSecondary }}
                tickLine={false}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
                width={50}
                domain={[0, "auto"]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  color: colors.text,
                  fontSize: 10,
                  fontFamily: "monospace",
                  borderRadius: 0,
                }}
                formatter={(value: unknown) => [`$${Number(value).toFixed(4)}`, "Dividend"]}
              />
              <Bar
                dataKey="dividend"
                fill="#00C853"
                isAnimationActive={false}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
          {/* Recent dividends table */}
          <h4
            className="text-[10px] font-bold tracking-widest mt-4 mb-2"
            style={{ color: colors.accent }}
          >
            RECENT DIVIDENDS
          </h4>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-[10px] font-mono border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left py-1" style={{ color: colors.textSecondary }}>
                    DATE
                  </th>
                  <th className="text-right py-1" style={{ color: colors.textSecondary }}>
                    AMOUNT
                  </th>
                </tr>
              </thead>
              <tbody>
                {divs
                  .slice(-20)
                  .reverse()
                  .map((d, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${colors.border}22` }}>
                      <td className="py-1" style={{ color: colors.text }}>
                        {d.date}
                      </td>
                      <td className="text-right py-1" style={{ color: "#00C853" }}>
                        ${d.dividend.toFixed(4)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="text-xs text-center py-8" style={{ color: colors.textSecondary }}>
          No dividend data
        </div>
      )}

      {splits.length > 0 && (
        <>
          <h4
            className="text-[10px] font-bold tracking-widest mt-4 mb-2"
            style={{ color: colors.accent }}
          >
            STOCK SPLITS
          </h4>
          <div className="flex gap-3 flex-wrap">
            {splits.map((s, i) => (
              <div key={i} className="border px-3 py-2" style={{ borderColor: colors.border }}>
                <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                  {s.date}
                </div>
                <div className="text-[11px] font-mono font-bold" style={{ color: colors.accent }}>
                  {s.ratio}:1
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ── Management Sub-Tab ───────────────────────────────────────────────────── */
function ManagementSubTab({
  symbol,
  colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["management", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=management&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 300_000,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-52">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  if (!data)
    return (
      <div className="text-xs text-center py-8" style={{ color: colors.textSecondary }}>
        No management data
      </div>
    );

  const fmtPay = (v: number | null) => {
    if (v == null) return "—";
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  };

  return (
    <>
      {/* Company info header */}
      <div className="flex gap-6 mb-4 flex-wrap">
        {data.sector && (
          <div>
            <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              SECTOR
            </div>
            <div className="text-[11px] font-mono font-bold" style={{ color: colors.text }}>
              {data.sector}
            </div>
          </div>
        )}
        {data.industry && (
          <div>
            <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              INDUSTRY
            </div>
            <div className="text-[11px] font-mono font-bold" style={{ color: colors.text }}>
              {data.industry}
            </div>
          </div>
        )}
        {data.fullTimeEmployees && (
          <div>
            <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              EMPLOYEES
            </div>
            <div className="text-[11px] font-mono font-bold" style={{ color: colors.text }}>
              {data.fullTimeEmployees.toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <h4 className="text-[10px] font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
        KEY EXECUTIVES ({data.officers?.length ?? 0})
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left py-1.5 pr-4" style={{ color: colors.textSecondary }}>
                NAME
              </th>
              <th className="text-left py-1.5 pr-4" style={{ color: colors.textSecondary }}>
                TITLE
              </th>
              <th className="text-right py-1.5 px-2" style={{ color: colors.textSecondary }}>
                AGE
              </th>
              <th className="text-right py-1.5 px-2" style={{ color: colors.textSecondary }}>
                TOTAL PAY
              </th>
            </tr>
          </thead>
          <tbody>
            {(data.officers ?? []).map((o: any, i: number) => (
              <tr key={i} style={{ borderBottom: `1px solid ${colors.border}22` }}>
                <td className="py-1.5 pr-4 font-bold" style={{ color: colors.text }}>
                  {o.name}
                </td>
                <td className="py-1.5 pr-4" style={{ color: colors.textSecondary }}>
                  {o.title}
                </td>
                <td className="text-right py-1.5 px-2" style={{ color: colors.text }}>
                  {o.age ?? "—"}
                </td>
                <td className="text-right py-1.5 px-2" style={{ color: "#00C853" }}>
                  {fmtPay(o.totalPay)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── SEC Filings Sub-Tab ──────────────────────────────────────────────────── */
function SecFilingsSubTab({
  symbol,
  colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["secFilings", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=sec-filings&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 300_000,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-52">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );

  const filings: { date: string; type: string; title: string; url: string }[] = data?.filings ?? [];
  if (filings.length === 0)
    return (
      <div className="text-xs text-center py-8" style={{ color: colors.textSecondary }}>
        No SEC filings data
      </div>
    );

  const typeColor = (t: string) => {
    if (t.includes("10-K")) return "#FFD600";
    if (t.includes("10-Q")) return "#448AFF";
    if (t.includes("8-K")) return "#FF6D00";
    if (t.includes("DEF 14A") || t.includes("DEFA14A")) return "#AB47BC";
    return colors.textSecondary;
  };

  return (
    <>
      <h4 className="text-[10px] font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
        SEC FILINGS ({filings.length})
      </h4>
      <div className="overflow-y-auto max-h-96">
        <table className="w-full text-[10px] font-mono border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left py-1.5 pr-2" style={{ color: colors.textSecondary }}>
                DATE
              </th>
              <th className="text-left py-1.5 pr-2" style={{ color: colors.textSecondary }}>
                TYPE
              </th>
              <th className="text-left py-1.5" style={{ color: colors.textSecondary }}>
                TITLE
              </th>
            </tr>
          </thead>
          <tbody>
            {filings.map((f, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${colors.border}22` }}>
                <td className="py-1.5 pr-2 whitespace-nowrap" style={{ color: colors.text }}>
                  {f.date}
                </td>
                <td
                  className="py-1.5 pr-2 whitespace-nowrap font-bold"
                  style={{ color: typeColor(f.type) }}
                >
                  {f.type}
                </td>
                <td className="py-1.5" style={{ color: colors.textSecondary }}>
                  {f.url ? (
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      style={{ color: colors.accent }}
                    >
                      {f.title || f.type}
                    </a>
                  ) : (
                    f.title || f.type
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Analyst Tab ──────────────────────────────────────────────────────────────────

function AnalystTab({ symbol, colors }: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["analyst", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=analyst&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 5 * 60_000,
  });

  if (isLoading)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        Loading analyst data…
      </div>
    );
  if (!data)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        No analyst data
      </div>
    );

  const pt = data.priceTargets;
  const recs = data.recommendations ?? [];
  const updowns = data.upgradesDowngrades ?? [];
  const latestRec = recs[0];
  const totalRec = latestRec
    ? latestRec.strongBuy + latestRec.buy + latestRec.hold + latestRec.sell + latestRec.strongSell
    : 0;

  return (
    <div className="space-y-3 py-2">
      {/* Price Targets */}
      {pt && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            PRICE TARGETS
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div
                className="flex justify-between text-[9px] font-mono mb-1"
                style={{ color: colors.textSecondary }}
              >
                <span>
                  Low: <span style={{ color: "#ef4444" }}>${pt.low?.toFixed(2)}</span>
                </span>
                <span>
                  Mean: <span style={{ color: colors.text }}>${pt.mean?.toFixed(2)}</span>
                </span>
                <span>
                  High: <span style={{ color: "#4ade80" }}>${pt.high?.toFixed(2)}</span>
                </span>
              </div>
              <div className="h-2 relative" style={{ background: "#222" }}>
                {pt.low != null && pt.high != null && pt.mean != null && (
                  <>
                    <div
                      className="absolute h-full"
                      style={{
                        left: `${((pt.mean - pt.low) / (pt.high - pt.low)) * 100}%`,
                        width: "2px",
                        background: colors.accent,
                        transform: "translateX(-50%)",
                      }}
                    />
                    {pt.current != null && (
                      <div
                        className="absolute h-full"
                        style={{
                          left: `${Math.max(0, Math.min(100, ((pt.current - pt.low) / (pt.high - pt.low)) * 100))}%`,
                          width: "3px",
                          background: "#fff",
                          transform: "translateX(-50%)",
                        }}
                      />
                    )}
                    <div
                      className="absolute h-full"
                      style={{
                        left: "0",
                        width: `${((pt.mean - pt.low) / (pt.high - pt.low)) * 100}%`,
                        background: "linear-gradient(90deg, #ef535040, #4caf5040)",
                      }}
                    />
                  </>
                )}
              </div>
              {pt.current != null && (
                <div className="text-[9px] font-mono mt-1" style={{ color: colors.textSecondary }}>
                  Current: <span style={{ color: "#fff" }}>${pt.current.toFixed(2)}</span>
                  {pt.mean != null && (
                    <span style={{ color: pt.current < pt.mean ? "#4ade80" : "#ef4444" }}>
                      {" "}
                      ({(((pt.mean - pt.current) / pt.current) * 100).toFixed(1)}% to mean)
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Recommendation Summary */}
      {latestRec && totalRec > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            RECOMMENDATIONS ({totalRec} analysts)
          </div>
          <div className="flex gap-1 h-6">
            {[
              { key: "strongBuy", label: "Strong Buy", color: "#00c853", val: latestRec.strongBuy },
              { key: "buy", label: "Buy", color: "#4ade80", val: latestRec.buy },
              { key: "hold", label: "Hold", color: "#ff9800", val: latestRec.hold },
              { key: "sell", label: "Sell", color: "#ef5350", val: latestRec.sell },
              {
                key: "strongSell",
                label: "Strong Sell",
                color: "#b71c1c",
                val: latestRec.strongSell,
              },
            ]
              .filter((b) => b.val > 0)
              .map((b) => (
                <div
                  key={b.key}
                  className="flex items-center justify-center text-[8px] font-bold font-mono"
                  style={{
                    flex: b.val,
                    background: `${b.color}33`,
                    color: b.color,
                    border: `1px solid ${b.color}55`,
                  }}
                >
                  {b.val} {b.label}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Upgrades / Downgrades */}
      {updowns.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            UPGRADES / DOWNGRADES
          </div>
          <div className="max-h-[300px] overflow-y-auto" style={SCROLLBAR_THIN_LIGHTER}>
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    DATE
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    FIRM
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    ACTION
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    RATING
                  </th>
                  <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    TARGET
                  </th>
                </tr>
              </thead>
              <tbody>
                {updowns.map((u: any, i: number) => (
                  <tr
                    key={i}
                    className="hover:bg-[#111]"
                    style={{ borderBottom: "1px solid #1a1a1a" }}
                  >
                    <td className="px-1 py-0.5" style={{ color: colors.textSecondary }}>
                      {u.date?.slice(0, 10)}
                    </td>
                    <td className="px-1 py-0.5" style={{ color: colors.text }}>
                      {u.firm}
                    </td>
                    <td className="px-1 py-0.5">
                      <span
                        style={{
                          color:
                            u.action === "up"
                              ? "#4ade80"
                              : u.action === "down"
                                ? "#ef4444"
                                : colors.textSecondary,
                        }}
                      >
                        {u.action === "up" ? "▲" : u.action === "down" ? "▼" : "—"} {u.action}
                      </span>
                    </td>
                    <td className="px-1 py-0.5" style={{ color: colors.text }}>
                      {u.toGrade}
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      {u.currentPriceTarget != null ? (
                        <span style={{ color: colors.text }}>
                          ${u.currentPriceTarget.toFixed(0)}
                          {u.priorPriceTarget != null && (
                            <span style={{ color: colors.textSecondary }}>
                              {" "}
                              ← ${u.priorPriceTarget.toFixed(0)}
                            </span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Estimates Tab ────────────────────────────────────────────────────────────────

function EstimatesTab({ symbol, colors }: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["estimates", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=estimates&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 5 * 60_000,
  });

  if (isLoading)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        Loading estimates…
      </div>
    );
  if (!data)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        No estimates data
      </div>
    );

  const fmtB = (n: any) => {
    if (n == null) return "—";
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    return v.toFixed(2);
  };
  const fmtPct = (n: any) => (n != null ? `${(Number(n) * 100).toFixed(1)}%` : "—");

  const renderTable = (
    title: string,
    rows: any[],
    cols: { key: string; label: string; fmt?: (v: any) => string }[]
  ) => {
    if (!rows || rows.length === 0) return null;
    return (
      <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
        <div
          className="text-[10px] font-bold tracking-widest mb-2"
          style={{ color: colors.accent }}
        >
          {title}
        </div>
        <table className="w-full text-[9px] font-mono">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                PERIOD
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className="text-right px-1 py-0.5"
                  style={{ color: colors.textSecondary }}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any, i: number) => (
              <tr key={i} style={{ borderBottom: "1px solid #1a1a1a" }}>
                <td className="px-1 py-0.5" style={{ color: colors.text }}>
                  {r.period}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="px-1 py-0.5 text-right" style={{ color: colors.text }}>
                    {c.fmt ? c.fmt(r[c.key]) : r[c.key] != null ? Number(r[c.key]).toFixed(2) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-3 py-2">
      {renderTable("EARNINGS ESTIMATE (EPS)", data.earningsEstimate, [
        { key: "avg", label: "AVG" },
        { key: "low", label: "LOW" },
        { key: "high", label: "HIGH" },
        { key: "yearAgoEps", label: "Y-AGO" },
        {
          key: "numberOfAnalysts",
          label: "#ANLST",
          fmt: (v: any) => (v != null ? Math.round(v).toString() : "—"),
        },
        { key: "growth", label: "GROWTH", fmt: fmtPct },
      ])}
      {renderTable("REVENUE ESTIMATE", data.revenueEstimate, [
        { key: "avg", label: "AVG", fmt: fmtB },
        { key: "low", label: "LOW", fmt: fmtB },
        { key: "high", label: "HIGH", fmt: fmtB },
        {
          key: "numberOfAnalysts",
          label: "#ANLST",
          fmt: (v: any) => (v != null ? Math.round(v).toString() : "—"),
        },
        { key: "growth", label: "GROWTH", fmt: fmtPct },
      ])}
      {/* Earnings History — actual vs estimate */}
      {data.earningsHistory && data.earningsHistory.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            EARNINGS HISTORY (Beat/Miss)
          </div>
          <div className="flex gap-2 flex-wrap">
            {data.earningsHistory.map((e: any, i: number) => {
              const beat =
                e.epsActual != null && e.epsEstimate != null && e.epsActual >= e.epsEstimate;
              return (
                <div
                  key={i}
                  className="border px-2 py-1 text-center min-w-[80px]"
                  style={{
                    borderColor: beat ? "#4ade8044" : "#ef535044",
                    background: beat ? "#4ade8008" : "#ef535008",
                  }}
                >
                  <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                    {e.period}
                  </div>
                  <div
                    className="text-[10px] font-bold font-mono"
                    style={{ color: beat ? "#4ade80" : "#ef5350" }}
                  >
                    {e.epsActual?.toFixed(2) ?? "—"}
                  </div>
                  <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                    Est: {e.epsEstimate?.toFixed(2) ?? "—"}
                  </div>
                  {e.surprisePercent != null && (
                    <div
                      className="text-[8px] font-bold font-mono"
                      style={{ color: beat ? "#4ade80" : "#ef5350" }}
                    >
                      {e.surprisePercent >= 0 ? "+" : ""}
                      {e.surprisePercent.toFixed(1)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {renderTable("GROWTH ESTIMATES", data.growthEstimates, [
        { key: "stock", label: "STOCK", fmt: fmtPct },
        { key: "industry", label: "INDUSTRY", fmt: fmtPct },
        { key: "sector", label: "SECTOR", fmt: fmtPct },
        { key: "index", label: "S&P 500", fmt: fmtPct },
      ])}
    </div>
  );
}

// ─── Ownership Tab ────────────────────────────────────────────────────────────────

function OwnershipTab({ symbol, colors }: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ownership", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock?type=ownership&symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 60 * 60_000,
  });

  if (isLoading)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        Loading ownership…
      </div>
    );
  if (!data)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        No ownership data
      </div>
    );

  const fmtM = (n: any) => {
    if (n == null) return "—";
    const v = Number(n);
    if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  };
  const fmtShares = (n: any) => {
    if (n == null) return "—";
    const v = Number(n);
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return v.toFixed(0);
  };

  const mh = data.majorHolders ?? {};

  return (
    <div className="space-y-3 py-2">
      {/* Major Holders Breakdown */}
      {Object.keys(mh).length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            HOLDER BREAKDOWN
          </div>
          <div className="flex gap-4 text-[10px] font-mono">
            <div>
              <span style={{ color: colors.textSecondary }}>Insiders: </span>
              <span style={{ color: "#ff9800" }}>
                {mh.insidersPercentHeld != null
                  ? `${(mh.insidersPercentHeld * 100).toFixed(2)}%`
                  : "—"}
              </span>
            </div>
            <div>
              <span style={{ color: colors.textSecondary }}>Institutions: </span>
              <span style={{ color: "#42a5f5" }}>
                {mh.institutionsPercentHeld != null
                  ? `${(mh.institutionsPercentHeld * 100).toFixed(2)}%`
                  : "—"}
              </span>
            </div>
            <div>
              <span style={{ color: colors.textSecondary }}># Institutions: </span>
              <span style={{ color: colors.text }}>
                {mh.institutionsCount != null
                  ? Math.round(mh.institutionsCount).toLocaleString()
                  : "—"}
              </span>
            </div>
          </div>
          {/* Visual bar */}
          <div className="flex h-3 mt-2 gap-px">
            {mh.insidersPercentHeld != null && (
              <div
                style={{
                  flex: mh.insidersPercentHeld,
                  background: "#ff9800",
                  minWidth: mh.insidersPercentHeld > 0.005 ? 2 : 0,
                }}
                title={`Insiders ${(mh.insidersPercentHeld * 100).toFixed(2)}%`}
              />
            )}
            {mh.institutionsPercentHeld != null && (
              <div
                style={{ flex: mh.institutionsPercentHeld, background: "#42a5f5" }}
                title={`Institutions ${(mh.institutionsPercentHeld * 100).toFixed(2)}%`}
              />
            )}
            <div
              style={{
                flex: 1 - (mh.insidersPercentHeld ?? 0) - (mh.institutionsPercentHeld ?? 0),
                background: "#333",
              }}
              title="Public/Other"
            />
          </div>
          <div
            className="flex gap-3 mt-1 text-[8px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            <span>
              <span className="inline-block w-2 h-2 mr-0.5" style={{ background: "#ff9800" }} />
              Insiders
            </span>
            <span>
              <span className="inline-block w-2 h-2 mr-0.5" style={{ background: "#42a5f5" }} />
              Institutions
            </span>
            <span>
              <span className="inline-block w-2 h-2 mr-0.5" style={{ background: "#333" }} />
              Public
            </span>
          </div>
        </div>
      )}

      {/* Top Institutional Holders */}
      {data.institutionalHolders?.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            TOP INSTITUTIONAL HOLDERS
          </div>
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  HOLDER
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  SHARES
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  VALUE
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  %HELD
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  %CHG
                </th>
              </tr>
            </thead>
            <tbody>
              {data.institutionalHolders.map((h: any, i: number) => (
                <tr
                  key={i}
                  className="hover:bg-[#111]"
                  style={{ borderBottom: "1px solid #1a1a1a" }}
                >
                  <td className="px-1 py-0.5 truncate max-w-[200px]" style={{ color: colors.text }}>
                    {h.holder}
                  </td>
                  <td className="px-1 py-0.5 text-right" style={{ color: colors.text }}>
                    {fmtShares(h.shares)}
                  </td>
                  <td className="px-1 py-0.5 text-right" style={{ color: colors.text }}>
                    {fmtM(h.value)}
                  </td>
                  <td className="px-1 py-0.5 text-right" style={{ color: "#42a5f5" }}>
                    {h.pctHeld != null ? `${(h.pctHeld * 100).toFixed(2)}%` : "—"}
                  </td>
                  <td
                    className="px-1 py-0.5 text-right"
                    style={{
                      color:
                        h.pctChange > 0
                          ? "#4ade80"
                          : h.pctChange < 0
                            ? "#ef4444"
                            : colors.textSecondary,
                    }}
                  >
                    {h.pctChange != null
                      ? `${h.pctChange >= 0 ? "+" : ""}${(h.pctChange * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Insider Transactions */}
      {data.insiderTransactions?.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            INSIDER TRANSACTIONS
          </div>
          <div className="max-h-[300px] overflow-y-auto" style={SCROLLBAR_THIN_LIGHTER}>
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    DATE
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    INSIDER
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    POSITION
                  </th>
                  <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    TYPE
                  </th>
                  <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    SHARES
                  </th>
                  <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                    VALUE
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.insiderTransactions.map((t: any, i: number) => {
                  const isSale = (t.text || "").toLowerCase().includes("sale");
                  return (
                    <tr
                      key={i}
                      className="hover:bg-[#111]"
                      style={{ borderBottom: "1px solid #1a1a1a" }}
                    >
                      <td className="px-1 py-0.5" style={{ color: colors.textSecondary }}>
                        {t.date}
                      </td>
                      <td
                        className="px-1 py-0.5 truncate max-w-[130px]"
                        style={{ color: colors.text }}
                      >
                        {t.insider}
                      </td>
                      <td
                        className="px-1 py-0.5 truncate max-w-[100px]"
                        style={{ color: colors.textSecondary }}
                      >
                        {t.position}
                      </td>
                      <td className="px-1 py-0.5" style={{ color: isSale ? "#ef4444" : "#4ade80" }}>
                        {isSale ? "SELL" : t.transaction || "BUY"}
                      </td>
                      <td className="px-1 py-0.5 text-right" style={{ color: colors.text }}>
                        {fmtShares(t.shares)}
                      </td>
                      <td className="px-1 py-0.5 text-right" style={{ color: colors.text }}>
                        {fmtM(t.value)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Earnings Calendar Tab ────────────────────────────────────────────────────────

function EarningsCalendarTab({
  symbol,
  colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const { data, isLoading } = useQuery({
    queryKey: ["earnings-cal", symbol],
    queryFn: async () => {
      const r = await fetch(
        `/api/stock?type=earnings-calendar&symbol=${encodeURIComponent(symbol)}`
      );
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 60 * 60_000,
  });

  if (isLoading)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        Loading earnings calendar…
      </div>
    );
  if (!data?.earningsDates?.length)
    return (
      <div className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
        No earnings dates
      </div>
    );

  const now = new Date();
  const upcoming = data.earningsDates.filter((e: any) => new Date(e.date) > now);
  const past = data.earningsDates.filter((e: any) => new Date(e.date) <= now);

  return (
    <div className="space-y-3 py-2">
      {/* Next Earnings */}
      {upcoming.length > 0 && (
        <div
          className="border p-2"
          style={{ borderColor: `${colors.accent}44`, background: `${colors.accent}08` }}
        >
          <div
            className="text-[10px] font-bold tracking-widest mb-1"
            style={{ color: colors.accent }}
          >
            NEXT EARNINGS
          </div>
          <div className="text-lg font-bold font-mono" style={{ color: colors.text }}>
            {upcoming[0].date}
          </div>
          {upcoming[0].epsEstimate != null && (
            <div className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
              EPS Estimate:{" "}
              <span style={{ color: colors.text }}>${upcoming[0].epsEstimate.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}

      {/* Past Earnings */}
      {past.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.border, background: "#050505" }}>
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: colors.accent }}
          >
            EARNINGS HISTORY
          </div>
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                <th className="text-left px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  DATE
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  ESTIMATE
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  ACTUAL
                </th>
                <th className="text-right px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  SURPRISE
                </th>
                <th className="text-center px-1 py-0.5" style={{ color: colors.textSecondary }}>
                  RESULT
                </th>
              </tr>
            </thead>
            <tbody>
              {past.map((e: any, i: number) => {
                const beat =
                  e.reportedEPS != null && e.epsEstimate != null && e.reportedEPS >= e.epsEstimate;
                const hasBoth = e.reportedEPS != null && e.epsEstimate != null;
                return (
                  <tr
                    key={i}
                    className="hover:bg-[#111]"
                    style={{ borderBottom: "1px solid #1a1a1a" }}
                  >
                    <td className="px-1 py-0.5" style={{ color: colors.text }}>
                      {e.date?.slice(0, 10)}
                    </td>
                    <td className="px-1 py-0.5 text-right" style={{ color: colors.textSecondary }}>
                      {e.epsEstimate != null ? `$${e.epsEstimate.toFixed(2)}` : "—"}
                    </td>
                    <td
                      className="px-1 py-0.5 text-right font-bold"
                      style={{ color: hasBoth ? (beat ? "#4ade80" : "#ef4444") : colors.text }}
                    >
                      {e.reportedEPS != null ? `$${e.reportedEPS.toFixed(2)}` : "—"}
                    </td>
                    <td
                      className="px-1 py-0.5 text-right"
                      style={{
                        color:
                          e.surprise != null
                            ? e.surprise >= 0
                              ? "#4ade80"
                              : "#ef4444"
                            : colors.textSecondary,
                      }}
                    >
                      {e.surprise != null
                        ? `${e.surprise >= 0 ? "+" : ""}${e.surprise.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td className="px-1 py-0.5 text-center">
                      {hasBoth && (
                        <span
                          className="text-[8px] px-1 py-0 font-bold"
                          style={{
                            background: beat ? "#4ade8020" : "#ef535020",
                            color: beat ? "#4ade80" : "#ef5350",
                            border: `1px solid ${beat ? "#4ade8040" : "#ef535040"}`,
                          }}
                        >
                          {beat ? "BEAT" : "MISS"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Earnings Quality Tab ────────────────────────────────────────────────────────

const PIOTROSKI_LABELS: Record<string, string> = {
  F1_ROA: "ROA>0",
  F2_CFO: "CFO>0",
  F3_dROA: "ΔROA",
  F4_Accrual: "CFO/A>ROA",
  F5_Leverage: "ΔLev↓",
  F6_Liquidity: "ΔCR↑",
  F7_Dilution: "No Dilute",
  F8_GrossMargin: "ΔGM↑",
  F9_AssetTurn: "ΔAT↑",
};

const QUALITY_COLORS = {
  GREEN: { text: "#4caf50", bgDark: "#051a05", bgLight: "#f0fff0" },
  YELLOW: { text: "#ffc107", bgDark: "#1a1500", bgLight: "#fffde0" },
  ORANGE: { text: "#ff9800", bgDark: "#1a0a00", bgLight: "#fff8f0" },
  RED: { text: "#ef5350", bgDark: "#1a0505", bgLight: "#fff0f0" },
};

function EarningsQualityTab({
  symbol,
  colors,
  isDark,
}: { symbol: string; colors: any; isDark: boolean }) {
  const { data, isLoading, error } = useStockQuality(symbol);
  const flagCfg = data
    ? (QUALITY_COLORS[data.flag as keyof typeof QUALITY_COLORS] ?? QUALITY_COLORS.YELLOW)
    : null;

  return (
    <div className="space-y-4 mt-3">
      <div className="flex items-center gap-2">
        <div
          className="text-[9px] tracking-widest font-mono font-bold"
          style={{ color: colors.textSecondary }}
        >
          EARNINGS QUALITY MONITOR — {symbol}
        </div>
        {isLoading && (
          <RefreshCw className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
        )}
      </div>

      {error && (
        <div
          className="p-2 border text-xs font-mono"
          style={{ borderColor: "#ef5350", color: "#ef5350" }}
        >
          <AlertTriangle className="h-3 w-3 inline mr-1" />
          {String(error)}
        </div>
      )}

      {data && flagCfg && (
        <>
          {/* Overall score */}
          <div
            className="border p-3 flex items-center gap-4"
            style={{
              borderColor: flagCfg.text,
              backgroundColor: isDark ? flagCfg.bgDark : flagCfg.bgLight,
            }}
          >
            <div>
              <div
                className="text-[9px] tracking-widest font-mono"
                style={{ color: colors.textSecondary }}
              >
                OVERALL QUALITY SCORE
              </div>
              <div className="text-3xl font-bold font-mono mt-1" style={{ color: flagCfg.text }}>
                {data.overall_quality_score.toFixed(0)}
                <span
                  className="text-base font-normal ml-1"
                  style={{ color: colors.textSecondary }}
                >
                  / 100
                </span>
              </div>
            </div>
            <div
              className="px-3 py-1 border text-xs font-mono font-bold tracking-widest"
              style={{
                borderColor: flagCfg.text,
                color: flagCfg.text,
                backgroundColor: isDark ? flagCfg.bgDark : flagCfg.bgLight,
              }}
            >
              {data.flag}
            </div>
          </div>

          {/* Three metric columns */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Accrual */}
            <div
              className="border p-3 font-mono space-y-2"
              style={{ borderColor: colors.border, backgroundColor: colors.surface }}
            >
              <div className="text-[8px] tracking-widest" style={{ color: colors.textSecondary }}>
                SLOAN ACCRUAL RATIO
              </div>
              <div className="text-2xl font-bold" style={{ color: colors.text }}>
                {data.accrual.ratio != null ? `${data.accrual.ratio.toFixed(1)}%` : "N/A"}
              </div>
              <div
                className="text-[8px] px-1.5 py-0.5 border inline-block tracking-wider"
                style={{
                  color:
                    data.accrual.level === "NORMAL"
                      ? "#4caf50"
                      : data.accrual.level === "WATCH"
                        ? "#ffc107"
                        : "#ef5350",
                  borderColor:
                    data.accrual.level === "NORMAL"
                      ? "#4caf50"
                      : data.accrual.level === "WATCH"
                        ? "#ffc107"
                        : "#ef5350",
                }}
              >
                {data.accrual.level}
              </div>
              <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                score {data.accrual.score} / 100 · weight 30%
              </div>
            </div>

            {/* Beneish */}
            <div
              className="border p-3 font-mono space-y-2"
              style={{ borderColor: colors.border, backgroundColor: colors.surface }}
            >
              <div className="text-[8px] tracking-widest" style={{ color: colors.textSecondary }}>
                BENEISH M-SCORE
              </div>
              <div className="text-2xl font-bold" style={{ color: colors.text }}>
                {data.beneish.m_score != null ? data.beneish.m_score.toFixed(3) : "N/A"}
              </div>
              <div
                className="text-[8px] px-1.5 py-0.5 border inline-block tracking-wider"
                style={{
                  color:
                    data.beneish.level === "NOT_MANIPULATED"
                      ? "#4caf50"
                      : data.beneish.level === "GRAY_ZONE"
                        ? "#ffc107"
                        : "#ef5350",
                  borderColor:
                    data.beneish.level === "NOT_MANIPULATED"
                      ? "#4caf50"
                      : data.beneish.level === "GRAY_ZONE"
                        ? "#ffc107"
                        : "#ef5350",
                }}
              >
                {data.beneish.level.replace(/_/g, " ")}
              </div>
              <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                score {data.beneish.score} / 100 · weight 40%
              </div>
            </div>

            {/* Piotroski */}
            <div
              className="border p-3 font-mono space-y-2"
              style={{ borderColor: colors.border, backgroundColor: colors.surface }}
            >
              <div className="text-[8px] tracking-widest" style={{ color: colors.textSecondary }}>
                PIOTROSKI F-SCORE
              </div>
              <div className="text-2xl font-bold" style={{ color: colors.text }}>
                {data.piotroski.f_score}
                <span className="text-sm font-normal ml-1" style={{ color: colors.textSecondary }}>
                  / 9
                </span>
              </div>
              <div
                className="text-[8px] px-1.5 py-0.5 border inline-block tracking-wider"
                style={{
                  color:
                    data.piotroski.level === "STRONG"
                      ? "#4caf50"
                      : data.piotroski.level === "NEUTRAL"
                        ? "#ffc107"
                        : "#ef5350",
                  borderColor:
                    data.piotroski.level === "STRONG"
                      ? "#4caf50"
                      : data.piotroski.level === "NEUTRAL"
                        ? "#ffc107"
                        : "#ef5350",
                }}
              >
                {data.piotroski.level}
              </div>
              <div className="grid grid-cols-3 gap-1 mt-1">
                {Object.entries(data.piotroski.signals).map(([k, v]) => (
                  <div
                    key={k}
                    className="text-[7px] px-1 py-0.5 border text-center"
                    style={{
                      color:
                        v === true ? "#4caf50" : v === false ? "#ef5350" : colors.textSecondary,
                      borderColor: v === true ? "#4caf50" : v === false ? "#ef5350" : colors.border,
                    }}
                  >
                    {PIOTROSKI_LABELS[k] ?? k}
                  </div>
                ))}
              </div>
              <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                weight 30%
              </div>
            </div>
          </div>

          <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
            Data: yfinance · as of {new Date(data.as_of).toLocaleDateString()}
          </div>
        </>
      )}
    </div>
  );
}

function formatChartDate(t: string | number): string {
  if (typeof t === "number") {
    return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return t.slice(0, 7);
}

// ─── Fear & Greed dedicated view ─────────────────────────────────────────────────

const FG_ZONE_COLORS_SV: Record<string, { bg: string; border: string; text: string }> = {
  extreme_fear: { bg: "#1a0000", border: "#CC2200", text: "#FF6644" },
  fear: { bg: "#1a0a00", border: "#CC6600", text: "#FFAA44" },
  neutral: { bg: "#111100", border: "#888800", text: "#DDDD00" },
  greed: { bg: "#001a08", border: "#00AA44", text: "#44DD88" },
  extreme_greed: { bg: "#001408", border: "#007733", text: "#44BB66" },
};

interface FGHistoryPoint {
  time: string;
  value: number;
  zone: string;
}

function FearGreedDetailView({
  onBack,
  isDarkMode,
  colors,
}: { onBack: () => void; isDarkMode: boolean; colors: typeof bloombergColors.dark }) {
  const [period, setPeriod] = useState<string>("1y");

  const { data, isLoading } = useQuery<{
    history: FGHistoryPoint[];
    current: number;
    zone: string;
    label: string;
  }>({
    queryKey: ["fear-greed-history", period],
    queryFn: () => fetch(`/api/fear-greed/history?period=${period}`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
  });

  const history = data?.history ?? [];
  const current = data?.current ?? 50;
  const zone = data?.zone ?? "neutral";
  const label = data?.label ?? "NEUTRAL";
  const zoneCol = FG_ZONE_COLORS_SV[zone] ?? FG_ZONE_COLORS_SV.neutral;

  // Zone reference bands for Recharts
  const ZONES = [
    { y1: 0, y2: 25, color: "#CC220020" },
    { y1: 25, y2: 45, color: "#CC660020" },
    { y1: 45, y2: 55, color: "#88880020" },
    { y1: 55, y2: 75, color: "#00AA4420" },
    { y1: 75, y2: 100, color: "#00773320" },
  ];

  const periods = ["1m", "3m", "ytd", "1y", "5y", "max"];

  return (
    <div
      className="h-full overflow-y-auto p-4 font-mono"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <BloombergButton color="default" onClick={onBack}>
          <ArrowLeft className="h-3 w-3 mr-1" />
          BACK
        </BloombergButton>
        <span className="text-xs tracking-widest font-bold" style={{ color: colors.accent }}>
          FEAR &amp; GREED INDEX
        </span>
      </div>

      {/* Current value card */}
      <div
        className="border p-4 mb-4 flex items-center gap-6"
        style={{ borderColor: zoneCol.border, backgroundColor: zoneCol.bg }}
      >
        <div>
          <div className="text-[9px] tracking-widest mb-1 opacity-60">CURRENT READING</div>
          <div className="text-5xl font-bold" style={{ color: zoneCol.text }}>
            {Math.round(current)}
          </div>
        </div>
        <div>
          <div
            className="text-xl font-bold tracking-widest px-3 py-1 border"
            style={{ color: zoneCol.text, borderColor: zoneCol.border }}
          >
            {label}
          </div>
          <div className="text-[9px] mt-1 opacity-50">
            0 = Extreme Fear · 50 = Neutral · 100 = Extreme Greed
          </div>
        </div>

        {/* Zone gauge */}
        <div className="flex gap-1 ml-auto">
          {[
            { label: "EXT FEAR", range: "0–25", zone: "extreme_fear" },
            { label: "FEAR", range: "25–45", zone: "fear" },
            { label: "NEUTRAL", range: "45–55", zone: "neutral" },
            { label: "GREED", range: "55–75", zone: "greed" },
            { label: "EXT GREED", range: "75–100", zone: "extreme_greed" },
          ].map((z) => {
            const c = FG_ZONE_COLORS_SV[z.zone];
            const active = z.zone === zone;
            return (
              <div
                key={z.zone}
                className="text-[8px] text-center px-1.5 py-1 border"
                style={{
                  borderColor: active ? c.border : `${c.border}44`,
                  backgroundColor: active ? c.bg : "transparent",
                  color: active ? c.text : `${c.text}66`,
                  fontWeight: active ? 700 : 400,
                }}
              >
                <div>{z.label}</div>
                <div className="opacity-60">{z.range}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Period selector */}
      <div className="flex gap-1 mb-3">
        {periods.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className="px-2 py-0.5 text-[9px] font-mono border"
            style={{
              borderColor: period === p ? colors.accent : colors.border,
              backgroundColor: period === p ? `${colors.accent}22` : "transparent",
              color: period === p ? colors.accent : colors.textSecondary,
            }}
          >
            {p.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div
        className="border"
        style={{ borderColor: colors.border, backgroundColor: colors.surface }}
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <RefreshCw className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
          </div>
        ) : history.length === 0 ? (
          <div
            className="flex items-center justify-center h-48 text-xs"
            style={{ color: colors.textSecondary }}
          >
            No data — backend may be loading
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={history} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#1a1a1a" : "#e0e0e0"} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 8, fill: colors.textSecondary }}
                tickFormatter={(v: string) => v.slice(0, 7)}
                interval="preserveStartEnd"
              />
              <YAxis domain={[0, 100]} tick={{ fontSize: 8, fill: colors.textSecondary }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.surface,
                  border: `1px solid ${colors.border}`,
                  fontSize: 10,
                }}
                labelStyle={{ color: colors.textSecondary }}
                formatter={(v: number) => [
                  `${v.toFixed(1)} — ${
                    data?.history
                      ?.find((h) => h.value === v)
                      ?.zone?.replace(/_/g, " ")
                      .toUpperCase() ?? ""
                  }`,
                  "F&G",
                ]}
              />
              {/* Zone reference areas */}
              {ZONES.map((z) => (
                <ReferenceLine key={z.y1} y={z.y1} stroke={z.color} strokeDasharray="0" />
              ))}
              <ReferenceLine y={25} stroke="#CC2200" strokeDasharray="3 3" strokeOpacity={0.5} />
              <ReferenceLine y={45} stroke="#CC6600" strokeDasharray="3 3" strokeOpacity={0.5} />
              <ReferenceLine y={50} stroke="#555" strokeDasharray="3 3" strokeOpacity={0.4} />
              <ReferenceLine y={55} stroke="#00AA44" strokeDasharray="3 3" strokeOpacity={0.5} />
              <ReferenceLine y={75} stroke="#007733" strokeDasharray="3 3" strokeOpacity={0.5} />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#FFD700"
                fill="url(#fgGrad)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <defs>
                <linearGradient id="fgGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFD700" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#FFD700" stopOpacity={0.02} />
                </linearGradient>
              </defs>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Methodology note */}
      <div className="mt-3 text-[8px] opacity-40" style={{ color: colors.textSecondary }}>
        Composite of 5 signals: VIX level (25%) · SPY momentum vs 125-day SMA (25%) · SPY/TLT
        safe-haven (20%) · HYG/LQD junk bond demand (15%) · RSP/SPY breadth (15%)
      </div>
    </div>
  );
}

// ─── Main StockView component ─────────────────────────────────────────────────────

type StockViewProps = { onBack: () => void; defaultSymbol?: string };

export default function StockView({ onBack, defaultSymbol }: StockViewProps) {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [inputValue, setInputValue] = useState(defaultSymbol ?? "");
  const [activeSymbol, setActiveSymbol] = useState<string | null>(defaultSymbol ?? null);
  const { timePeriod, barInterval, isIntraday, handlePeriodChange, handleIntervalChange } =
    useChartTimeframe({ defaultPeriod: "1y", defaultInterval: "1d" });
  const [chartType, setChartType] = useAtom(chartTypeAtom);

  // ── Modular chart system — indicators + overlays + events, all in one hook ──
  const {
    indicators: chartIndicators,
    overlays: chartOverlays,
    eventMarkers,
    showEvents,
    toggleEvents,
    supportsEvents,
    selectedEvent,
    clearSelectedEvent,
    showVolumeProfile,
    addIndicator: addChartIndicator,
    removeIndicator: removeChartIndicator,
    windowUnit: chartWindowUnit,
    toggleWindowUnit: toggleChartWindowUnit,
    regressionSel,
    regressionArmed,
    regressionPending,
    regressionOpts,
    toggleRegression,
    setRegressionMode,
    handleChartClick,
    toggleVolumeProfile,
    vpConfig,
    setVPConfig,
    showPE,
    togglePE,
    peData,
    peLoading,
    setIntradayData,
    needsIntradayData,
    showFootprint,
    toggleFootprint,
    isCryptoSymbol,
    footprintLoading,
    updateIndicatorConfig,
  } = useChartIndicators({ symbol: activeSymbol, barInterval, chartType });

  // ── Fear & Greed data injection ────────────────────────────────────────────
  const fearGreedActive = chartIndicators.some((i) => i.id === "fear-greed");
  const fearGreedQuery = useQuery<{ history: Array<{ time: string; value: number }> }>({
    queryKey: ["fear-greed-history", timePeriod],
    queryFn: () => fetch(`/api/fear-greed/history?period=${timePeriod}`).then((r) => r.json()),
    enabled: fearGreedActive,
    staleTime: 60 * 60 * 1000,
  });
  useEffect(() => {
    if (fearGreedActive && fearGreedQuery.data?.history) {
      updateIndicatorConfig("fear-greed", { preloadedData: fearGreedQuery.data.history });
    }
  }, [fearGreedActive, fearGreedQuery.data, updateIndicatorConfig]);

  // ── IV SD Heatmap ──────────────────────────────────────────────────────────
  // Fetch + self-heal live in useSdBands: the bands are computed backend-side
  // (it owns the IV snapshot history, the realized-vol series and the risk-free
  // rate), and a symbol with no IV on file gets one recorded on the spot.
  useSdBands({
    indicators: chartIndicators,
    symbol: activeSymbol,
    period: timePeriod,
    updateIndicatorConfig,
  });

  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("financials");

  // A caller can ask for a specific panel on the way in (NEWS opens a name straight
  // into RATE STRESS). Consume it once so an ordinary navigation later still lands
  // on the default tab.
  const [requestedTab, setRequestedTab] = useAtom(stockAnalysisTabAtom);
  useEffect(() => {
    if (!requestedTab) return;
    setAnalysisTab(requestedTab as AnalysisTab);
    setRequestedTab("");
  }, [requestedTab, setRequestedTab]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Pin state ────────────────────────────────────────────────────────────────
  const [pins, setPins] = useAtom(pinnedAssetsAtom);
  const [groups, setGroups] = useAtom(pinGroupsAtom);
  const [pinPickerOpen, setPinPickerOpen] = useState(false);
  const [pinFeedback, setPinFeedback] = useState<string | null>(null);

  // Sync groups from localStorage on mount / symbol change
  useEffect(() => {
    setGroups(loadPinGroups());
  }, [setGroups]);

  const isPinned = useCallback(
    (sym: string | null) => !!sym && pins.some((p) => p.symbol === sym),
    [pins]
  );

  const doPin = useCallback(
    (group: PinGroup) => {
      if (!activeSymbol) return;
      if (pins.some((p) => p.symbol === activeSymbol && p.groupId === group.id)) {
        setPinFeedback(`Already in ${group.name}`);
        setTimeout(() => setPinFeedback(null), 2000);
        return;
      }
      const newPin: PinnedAsset = {
        id: Date.now().toString(),
        symbol: activeSymbol,
        groupId: group.id,
        comment: "",
        addedAt: new Date().toISOString().split("T")[0],
      };
      setPins((ps) => [...ps, newPin]);
      savePinToStorage(newPin);
      setPinPickerOpen(false);
      setPinFeedback(`Pinned to ${group.name}`);
      setTimeout(() => setPinFeedback(null), 2500);
      fetch("/api/pins/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newPin.id,
          symbol: newPin.symbol,
          group_id: newPin.groupId,
          comment: "",
          buy_target: null,
          sell_target: null,
          price_at_pin: null,
          priority: 1,
          added_at: newPin.addedAt,
          tags: [],
        }),
      }).catch((err) => console.error("[doPin stock-view]", err));
    },
    [activeSymbol, pins, setPins]
  );

  const handlePinClick = useCallback(() => {
    const effectiveGroups = groups.length ? groups : [DEFAULT_WATCHLIST_GROUP];
    if (effectiveGroups.length === 1) {
      doPin(effectiveGroups[0]);
    } else {
      setPinPickerOpen((v) => !v);
    }
  }, [groups, doPin]);

  useEffect(() => {
    if (inputValue.length >= 1) {
      const t = setTimeout(() => setSearchQuery(inputValue), 300);
      return () => clearTimeout(t);
    }
    setSearchQuery("");
    setShowDropdown(false);
  }, [inputValue]);

  const searchResult = useStockSearch(searchQuery);
  const quoteQuery = useStockQuote(activeSymbol);
  // Area chart: no explicit interval → backend uses per-period default (e.g. 5m for 1d)
  const areaHistQuery = useStockHistory(activeSymbol, timePeriod);
  // Candle chart: explicit interval from user selection
  const candleHistQuery = useStockHistory(activeSymbol, timePeriod, barInterval);
  const historyQuery = chartType === "candle" ? candleHistQuery : areaHistQuery;
  const financialsQuery = useStockFinancials(activeSymbol);
  // Always fetch 1Y daily history for quantitative analysis
  const quantHistQuery = useStockHistory(activeSymbol, "1y", "1d");

  // ── Intraday data for session-based Volume Profile ──
  // When VP is active and chart is on daily+ bars, fetch 5m data for session VP.
  // 5m over 1 month gives a finer session shape than 15m and stays within Yahoo's
  // ~60-day cap on 5m bars (a longer window would need a new backend "2m" period token).
  const vpNeedsIntraday = needsIntradayData && ["1d", "1wk"].includes(barInterval);
  const vpIntradayQuery = useStockHistory(
    vpNeedsIntraday ? activeSymbol : null,
    "1m", // 1 month of data
    "5m" // 5-minute bars
  );

  const handleSubmit = () => {
    const sym = inputValue.trim().toUpperCase();
    if (!sym) return;
    setActiveSymbol(sym);
    setShowDropdown(false);
    inputRef.current?.blur();
  };
  const handleSelectSuggestion = (sym: string) => {
    setInputValue(sym);
    setActiveSymbol(sym);
    setShowDropdown(false);
  };

  const quote = quoteQuery.data;
  const isPositive = (quote?.regularMarketChangePercent ?? 0) >= 0;
  const dayColor = isPositive ? colors.positive : colors.negative;

  const rawChartData = useMemo(
    () => (historyQuery.data?.quotes ?? []).filter((q: any) => q.close != null),
    [historyQuery.data]
  );
  const chartData = useMemo(
    () =>
      rawChartData.map((q: any) => ({
        date: q.date,
        price: q.close,
        label: fmtDateLabel(q.date, timePeriod),
      })),
    [rawChartData, timePeriod]
  );

  // OHLCV data for candlestick chart (memoized to prevent re-render loops with VP)
  const ohlcvData: OhlcvBar[] = useMemo(
    () =>
      rawChartData
        .filter((q: any) => q.open != null && q.high != null && q.low != null)
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
        ),
    [rawChartData, isIntraday]
  );

  // ── Feed intraday data to VP when available ──
  const vpIntradayOhlcv: OhlcvBar[] = useMemo(() => {
    const raw = vpIntradayQuery.data?.quotes ?? [];
    if (!raw.length) return [];
    return (
      raw
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((q: any) => q.open != null && q.high != null && q.low != null)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((q: any) => ({
          time: Math.floor(new Date(q.date as string).getTime() / 1000),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume ?? undefined,
        }))
        .sort((a: OhlcvBar, b: OhlcvBar) => (a.time as number) - (b.time as number))
        .filter(
          (bar: OhlcvBar, i: number, arr: OhlcvBar[]) => i === 0 || bar.time !== arr[i - 1].time
        )
    );
  }, [vpIntradayQuery.data]);

  // When VP is active and we have intraday data OR intraday chart data, feed it
  useEffect(() => {
    if (!needsIntradayData) {
      setIntradayData(undefined);
      return;
    }
    // If chart is already intraday, use that data directly
    if (!["1d", "1wk"].includes(barInterval) && ohlcvData.length > 0) {
      setIntradayData(ohlcvData);
    } else if (vpIntradayOhlcv.length > 0) {
      setIntradayData(vpIntradayOhlcv);
    }
  }, [needsIntradayData, barInterval, ohlcvData, vpIntradayOhlcv, setIntradayData]);

  const chartTrend =
    chartData.length >= 2
      ? chartData[chartData.length - 1].price >= chartData[0].price
      : isPositive;
  const chartColor = chartTrend ? colors.positive : colors.negative;

  const panel = { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text };
  const secText = { color: colors.textSecondary };

  // ── Dedicated Fear & Greed view ────────────────────────────────────────────
  if (activeSymbol === "FEAR-GREED") {
    return <FearGreedDetailView onBack={onBack} isDarkMode={isDarkMode} colors={colors} />;
  }

  return (
    <div
      className="h-full overflow-y-auto p-4 font-mono"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <BloombergButton color="default" onClick={onBack}>
          <ArrowLeft className="h-3 w-3 mr-1" />
          BACK
        </BloombergButton>
        <span className="text-xs tracking-widest font-bold" style={{ color: colors.accent }}>
          EQUITY ANALYSIS
        </span>
      </div>

      {/* Search bar */}
      <div className="relative mb-5">
        <div className="flex items-center gap-2 p-2 border" style={panel}>
          <Search className="h-4 w-4 shrink-0" style={secText} />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setShowDropdown(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") setShowDropdown(false);
            }}
            onFocus={() => inputValue.length > 0 && setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            placeholder="Enter ticker symbol (e.g. AAPL · TSLA · NVDA · ^SET.BK)"
            className="flex-1 bg-transparent outline-none text-sm font-mono placeholder:opacity-40"
            style={{ color: colors.text }}
          />
          <BloombergButton color="accent" onClick={handleSubmit}>
            GO
          </BloombergButton>
        </div>
        {showDropdown && (searchResult.data?.length ?? 0) > 0 && (
          <div
            className="absolute top-full left-0 right-0 z-50 border border-t-0"
            style={{ backgroundColor: colors.surface, borderColor: colors.border }}
          >
            {(searchResult.data as any[]).map((item: any) => (
              <button
                type="button"
                key={item.symbol}
                className="w-full text-left px-4 py-2 text-xs flex items-center gap-3 border-b last:border-b-0 hover:opacity-70"
                style={{ borderColor: colors.border, color: colors.text }}
                onMouseDown={() => handleSelectSuggestion(item.symbol)}
              >
                <span
                  className="font-bold w-16 shrink-0"
                  style={{ color: colors.accent }}
                  title={item.symbol}
                >
                  {displaySymbol(item)}
                </span>
                <span className="truncate flex-1" style={secText}>
                  {displayName(item)}
                </span>
                <span className="ml-auto shrink-0" style={secText}>
                  {item.exchDisp}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Empty state */}
      {!activeSymbol && (
        <div className="py-24 text-center">
          <Search className="h-12 w-12 mx-auto mb-4 opacity-20" />
          <p className="text-sm mb-1" style={secText}>
            Enter a ticker symbol to begin
          </p>
          <p className="text-xs" style={secText}>
            Stocks · ETFs · Indices (e.g. ^DJI, ^GSPC, ^SET.BK)
          </p>
        </div>
      )}

      {/* Loading / Error */}
      {activeSymbol && quoteQuery.isLoading && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="h-6 w-6 animate-spin mr-3" style={{ color: colors.accent }} />
          <span className="text-sm">Loading {activeSymbol}…</span>
        </div>
      )}
      {activeSymbol && quoteQuery.isError && (
        <div className="py-12 text-center">
          <p className="text-sm" style={{ color: colors.negative }}>
            Could not load &ldquo;{activeSymbol}&rdquo;
          </p>
          <p className="text-xs mt-1" style={secText}>
            {quoteQuery.error instanceof Error ? quoteQuery.error.message : "Unknown error"}
          </p>
        </div>
      )}

      {/* Main content */}
      {activeSymbol && quote && (
        <div className="space-y-4">
          {/* Overview panel */}
          <div className="p-4 border" style={panel}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-base font-bold tracking-wide leading-tight">
                  {quote.longName ?? quote.shortName ?? activeSymbol}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs font-bold" style={{ color: colors.accent }}>
                    {quote.symbol}
                  </span>
                  <span className="text-xs" style={secText}>
                    {quote.fullExchangeName ?? quote.exchange}
                    {quote.currency ? ` · ${quote.currency}` : ""}
                  </span>
                  <MarketSessionBadge state={quote?.marketState} />

                  {/* ── PIN button ── */}
                  <div className="relative ml-2">
                    <button
                      type="button"
                      onClick={handlePinClick}
                      className="flex items-center gap-1 text-xs px-2 py-0.5 rounded font-bold transition-all hover:scale-105"
                      style={{
                        background: isPinned(activeSymbol) ? "#22c55e22" : `${colors.accent}22`,
                        color: isPinned(activeSymbol) ? "#4ade80" : colors.accent,
                        border: `1px solid ${isPinned(activeSymbol) ? "#22c55e44" : `${colors.accent}44`}`,
                      }}
                      title={isPinned(activeSymbol) ? "Already pinned" : "Pin this asset"}
                    >
                      {isPinned(activeSymbol) ? (
                        <>
                          <Check className="h-3 w-3" />
                          <span>PINNED</span>
                        </>
                      ) : (
                        <>
                          <Pin className="h-3 w-3" />
                          <span>PIN</span>
                        </>
                      )}
                    </button>

                    {/* Group picker popover */}
                    {pinPickerOpen && (
                      <PinGroupPicker
                        groups={groups.length ? groups : [DEFAULT_WATCHLIST_GROUP]}
                        onPick={doPin}
                        onClose={() => setPinPickerOpen(false)}
                        colors={colors}
                      />
                    )}
                  </div>

                  {/* Pin feedback toast */}
                  {pinFeedback && (
                    <span
                      className="text-xs px-2 py-0.5 rounded font-bold animate-pulse"
                      style={{
                        background: "#22c55e22",
                        color: "#4ade80",
                        border: "1px solid #22c55e44",
                      }}
                    >
                      {pinFeedback}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tracking-tight">
                  {quote.currency === "USD" ? "$" : ""}
                  {fmtPrice(quote.regularMarketPrice)}
                </div>
                <div className="flex items-center justify-end gap-1 mt-1">
                  {isPositive ? (
                    <TrendingUp className="h-3.5 w-3.5" style={{ color: dayColor }} />
                  ) : (
                    <TrendingDown className="h-3.5 w-3.5" style={{ color: dayColor }} />
                  )}
                  <span className="text-sm font-bold" style={{ color: dayColor }}>
                    {isPositive ? "+" : ""}
                    {fmtPrice(quote.regularMarketChange)}&nbsp; ({isPositive ? "+" : ""}
                    {fmtPrice(quote.regularMarketChangePercent)}%)
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={secText}>
                  {quote.regularMarketTime
                    ? new Date(quote.regularMarketTime * 1000).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </div>
                <ExtendedHoursPrice
                  quote={quote}
                  positiveColor={colors.positive}
                  negativeColor={colors.negative}
                />
              </div>
            </div>

            {/* Key metrics grid */}
            <div
              className="grid grid-cols-3 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs py-3 border-t border-b mb-3"
              style={{ borderColor: colors.border }}
            >
              {[
                { label: "Market Cap", value: fmtLarge(quote.marketCap) },
                {
                  label: "P/E (TTM)",
                  value: quote.trailingPE != null ? `${quote.trailingPE.toFixed(2)}x` : "N/A",
                },
                {
                  label: "Fwd P/E",
                  value: quote.forwardPE != null ? `${quote.forwardPE.toFixed(2)}x` : "N/A",
                },
                { label: "Beta", value: quote.beta != null ? quote.beta.toFixed(2) : "N/A" },
                { label: "Volume", value: fmtLarge(quote.regularMarketVolume, "") },
                { label: "Avg Vol (3M)", value: fmtLarge(quote.averageDailyVolume3Month, "") },
                { label: "52W High", value: `$${fmtPrice(quote.fiftyTwoWeekHigh)}` },
                { label: "52W Low", value: `$${fmtPrice(quote.fiftyTwoWeekLow)}` },
                {
                  label: "Div Yield",
                  value: quote.dividendYield != null ? `${quote.dividendYield.toFixed(2)}%` : "N/A",
                },
                {
                  label: "EPS (TTM)",
                  value:
                    quote.epsTrailingTwelveMonths != null
                      ? `$${quote.epsTrailingTwelveMonths.toFixed(2)}`
                      : "N/A",
                },
                { label: "Open", value: `$${fmtPrice(quote.regularMarketOpen)}` },
                { label: "Prev Close", value: `$${fmtPrice(quote.regularMarketPreviousClose)}` },
              ].map(({ label, value }) => (
                <div key={label}>
                  <span style={secText}>{label}: </span>
                  <span className="font-bold">{value}</span>
                </div>
              ))}
            </div>

            {/* 52W range bar */}
            {quote.fiftyTwoWeekHigh != null &&
              quote.fiftyTwoWeekLow != null &&
              quote.regularMarketPrice != null && (
                <div>
                  <div className="flex justify-between text-xs mb-1" style={secText}>
                    <span>52W Low: ${fmtPrice(quote.fiftyTwoWeekLow)}</span>
                    <span style={{ color: colors.text }}>
                      Current: ${fmtPrice(quote.regularMarketPrice)}
                    </span>
                    <span>52W High: ${fmtPrice(quote.fiftyTwoWeekHigh)}</span>
                  </div>
                  <div className="relative h-2" style={{ backgroundColor: colors.border }}>
                    <div
                      className="absolute h-2"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(
                            0,
                            ((quote.regularMarketPrice - quote.fiftyTwoWeekLow) /
                              (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow)) *
                              100
                          )
                        )}%`,
                        backgroundColor: dayColor,
                      }}
                    />
                  </div>
                </div>
              )}
          </div>

          {/* Price chart */}
          <div className="p-4 border" style={panel}>
            {/* ── Row 1: title + chart-type toggle + EMA/VP legends ── */}
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
                  PRICE HISTORY
                </h3>
                <MarketSessionBadge state={quote?.marketState} />
                {(quote?.marketState === "PRE" || quote?.marketState === "PREPRE") &&
                  quote?.preMarketPrice && (
                    <span className="text-[9px] font-mono" style={{ color: "#f59e0b" }}>
                      PRE ${quote.preMarketPrice.toFixed(2)} (
                      {(quote.preMarketChangePercent ?? 0) >= 0 ? "+" : ""}
                      {(quote.preMarketChangePercent ?? 0).toFixed(2)}%)
                    </span>
                  )}
                {(quote?.marketState === "POST" || quote?.marketState === "POSTPOST") &&
                  quote?.postMarketPrice && (
                    <span className="text-[9px] font-mono" style={{ color: "#818cf8" }}>
                      AH ${quote.postMarketPrice.toFixed(2)} (
                      {(quote.postMarketChangePercent ?? 0) >= 0 ? "+" : ""}
                      {(quote.postMarketChangePercent ?? 0).toFixed(2)}%)
                    </span>
                  )}
                {/* Chart type toggle */}
                <div className="flex border overflow-hidden" style={{ borderColor: colors.border }}>
                  <button
                    type="button"
                    onClick={() => setChartType("area")}
                    title="Area chart"
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors"
                    style={{
                      backgroundColor: chartType === "area" ? colors.accent : "transparent",
                      color: chartType === "area" ? "#000" : colors.textSecondary,
                    }}
                  >
                    <LineChart className="h-3 w-3" /> AREA
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartType("candle")}
                    title="Candlestick chart"
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors border-l"
                    style={{
                      borderColor: colors.border,
                      backgroundColor: chartType === "candle" ? colors.accent : "transparent",
                      color: chartType === "candle" ? "#000" : colors.textSecondary,
                    }}
                  >
                    <BarChart2 className="h-3 w-3" /> CANDLE
                  </button>
                </div>
                {/* Indicator picker + VP toggle (candle mode) */}
                {chartType === "candle" && (
                  <div
                    className="flex items-center gap-2 text-[9px] font-mono"
                    style={{ color: colors.textSecondary }}
                  >
                    <IndicatorPicker
                      colors={colors}
                      activeIndicators={chartIndicators}
                      onAdd={addChartIndicator}
                      onRemove={removeChartIndicator}
                      windowUnit={chartWindowUnit}
                      onToggleWindowUnit={toggleChartWindowUnit}
                    />
                    {/* Volume Profile toggle */}
                    {ohlcvData.some((d) => (d.volume ?? 0) > 0) && (
                      <button
                        type="button"
                        onClick={toggleVolumeProfile}
                        title="Toggle Volume Profile"
                        className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                        style={{
                          borderColor: showVolumeProfile ? colors.accent : colors.border,
                          backgroundColor: showVolumeProfile ? `${colors.accent}22` : "transparent",
                          color: showVolumeProfile ? colors.accent : colors.textSecondary,
                        }}
                      >
                        VP
                      </button>
                    )}
                    {/* VP display-option chips — only when VP is active */}
                    {showVolumeProfile &&
                      ohlcvData.some((d) => (d.volume ?? 0) > 0) &&
                      (
                        [
                          ["deltaMode", "Δ", "Buy/sell split per level"],
                          ["showNakedPoc", "nPOC", "Extend untested prior-session POCs"],
                          ["showHvnLvn", "HVN", "Mark high/low volume nodes"],
                        ] as const
                      ).map(([field, label, tip]) => {
                        const on = vpConfig[field];
                        return (
                          <button
                            key={field}
                            type="button"
                            onClick={() => setVPConfig({ ...vpConfig, [field]: !on })}
                            title={tip}
                            className="px-1 py-0.5 border font-mono text-[9px] transition-colors"
                            style={{
                              borderColor: on ? colors.accent : colors.border,
                              backgroundColor: on ? `${colors.accent}22` : "transparent",
                              color: on ? colors.accent : colors.textSecondary,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    {/* Regression Channel — click two bars to set the range */}
                    <button
                      type="button"
                      onClick={toggleRegression}
                      title={
                        regressionSel
                          ? "Clear regression channel"
                          : regressionArmed
                            ? "Click two bars on the chart to set the range (click again to cancel)"
                            : "Regression Channel: click two bars to fit a trend + channel"
                      }
                      className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                      style={{
                        borderColor: regressionArmed || regressionSel ? "#ffc107" : colors.border,
                        backgroundColor:
                          regressionArmed || regressionSel ? "#ffc10722" : "transparent",
                        color: regressionArmed || regressionSel ? "#ffc107" : colors.textSecondary,
                      }}
                    >
                      {regressionArmed ? (regressionPending ? "REG 2/2" : "REG 1/2") : "REG"}
                    </button>
                    {regressionSel && (
                      <button
                        type="button"
                        onClick={() =>
                          setRegressionMode(
                            regressionOpts.mode === "stddev" ? "quantile" : "stddev"
                          )
                        }
                        title={
                          regressionOpts.mode === "stddev"
                            ? "Rails at ±kσ of the residuals (symmetric). Click for quantile rails."
                            : "Rails fitted as conditional quantiles (asymmetric). Click for ±kσ rails."
                        }
                        className="px-1 py-0.5 border font-mono text-[9px] transition-colors"
                        style={{
                          borderColor: "#ffc107",
                          backgroundColor: "#ffc10711",
                          color: "#ffc107",
                        }}
                      >
                        {regressionOpts.mode === "stddev"
                          ? `${regressionOpts.stdDevMult}σ`
                          : `q${regressionOpts.tauPct}`}
                      </button>
                    )}
                    {/* Events toggle (dividends, earnings, splits) — equities only */}
                    {supportsEvents && (
                      <button
                        type="button"
                        onClick={toggleEvents}
                        title="Toggle Events (Dividends, Earnings, Splits)"
                        className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                        style={{
                          borderColor: showEvents ? "#4fc3f7" : colors.border,
                          backgroundColor: showEvents ? "#4fc3f722" : "transparent",
                          color: showEvents ? "#4fc3f7" : colors.textSecondary,
                        }}
                      >
                        EVENTS
                      </button>
                    )}
                    {/* Trailing P/E pane toggle — equities only */}
                    {supportsEvents && (
                      <button
                        type="button"
                        onClick={togglePE}
                        title="Toggle Trailing P/E history pane"
                        className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                        style={{
                          borderColor: showPE ? "#ba68c8" : colors.border,
                          backgroundColor: showPE ? "#ba68c822" : "transparent",
                          color: showPE ? "#ba68c8" : colors.textSecondary,
                        }}
                      >
                        P/E{showPE && peLoading ? "…" : ""}
                      </button>
                    )}
                    {/* Order Footprint toggle (crypto only) */}
                    {isCryptoSymbol && (
                      <button
                        type="button"
                        onClick={toggleFootprint}
                        title="Order Footprint (Binance)"
                        className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                        style={{
                          borderColor: showFootprint ? "#ff9800" : colors.border,
                          backgroundColor: showFootprint ? "#ff980022" : "transparent",
                          color: showFootprint ? "#ff9800" : colors.textSecondary,
                        }}
                      >
                        FP{footprintLoading ? "…" : ""}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ── Timeframe controls ── */}
              <ChartTimeframeBar
                timePeriod={timePeriod}
                barInterval={barInterval}
                chartType={chartType}
                colors={colors}
                onPeriodChange={(p) => handlePeriodChange(p, chartType)}
                onIntervalChange={handleIntervalChange}
              />
              {ohlcvData.length > 0 && (
                <span className="text-[8px] font-mono ml-2" style={{ color: colors.textSecondary }}>
                  {formatChartDate(ohlcvData[0].time)} –{" "}
                  {formatChartDate(ohlcvData[ohlcvData.length - 1].time)}
                  <span className="ml-1 opacity-50">({ohlcvData.length} bars)</span>
                </span>
              )}
            </div>

            {/* Chart body */}
            {historyQuery.isLoading ? (
              <div className="flex flex-col items-center justify-center h-52 gap-2">
                <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
                <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                  {timePeriod === "max"
                    ? "Loading full history… this may take 10–30s"
                    : timePeriod === "5y"
                      ? "Loading 5-year history…"
                      : "Loading chart…"}
                </span>
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex items-center justify-center h-52">
                <span className="text-xs" style={secText}>
                  No price data for this period
                </span>
              </div>
            ) : chartType === "candle" ? (
              /* ── Candlestick (Modular Chart System) ── */
              <>
                <ModularChart
                  data={ohlcvData}
                  isDark={isDarkMode}
                  colors={colors}
                  height={260}
                  indicators={chartIndicators.filter((i) => i.id !== "fear-greed")}
                  overlays={chartOverlays}
                  eventMarkers={eventMarkers}
                  onBarClick={handleChartClick}
                  crosshairCursor={regressionArmed}
                />
                {selectedEvent && (
                  <EventDetailPopover
                    markers={selectedEvent.markers}
                    anchor={selectedEvent.anchor}
                    data={ohlcvData}
                    colors={colors}
                    symbol={activeSymbol}
                    onClose={clearSelectedEvent}
                  />
                )}
                {fearGreedActive && fearGreedQuery.data?.history && (
                  <FearGreedPane data={fearGreedQuery.data.history} colors={colors} height={100} />
                )}
                {showPE && peData?.history && peData.history.length > 0 && (
                  <PEPane data={peData.history} stats={peData.stats} colors={colors} height={110} />
                )}
              </>
            ) : (
              /* ── Area chart (Recharts) ── */
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                  <defs>
                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColor} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9, fill: colors.textSecondary }}
                    tickLine={false}
                    axisLine={{ stroke: colors.border }}
                    interval="preserveStartEnd"
                    minTickGap={50}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: colors.textSecondary }}
                    tickLine={false}
                    axisLine={{ stroke: colors.border }}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) =>
                      `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}`
                    }
                    width={60}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      color: colors.text,
                      fontSize: 11,
                      fontFamily: "monospace",
                      borderRadius: 0,
                    }}
                    formatter={(v: number) => [`$${fmtPrice(v)}`, "Price"]}
                    labelStyle={secText}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke={chartColor}
                    strokeWidth={1.5}
                    fill="url(#priceGrad)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}

            {/* Footer stat bar (area mode only) */}
            {chartType === "area" && chartData.length > 0 && (
              <div className="flex justify-between text-xs mt-2" style={secText}>
                <span>Open: ${fmtPrice(chartData[0]?.price)}</span>
                <span style={{ color: chartColor }}>
                  {chartTrend ? "▲" : "▼"}&nbsp;
                  {chartData.length >= 2
                    ? `${Math.abs(((chartData[chartData.length - 1].price - chartData[0].price) / chartData[0].price) * 100).toFixed(2)}%`
                    : ""}
                  &nbsp;period change
                </span>
                <span>Close: ${fmtPrice(chartData[chartData.length - 1]?.price)}</span>
              </div>
            )}
          </div>

          {/* ── Analysis tab selector ───────────────────────────────────────── */}
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                { id: "financials", label: "FINANCIALS" },
                { id: "outlook", label: "OUTLOOK" },
                { id: "keymetrics", label: "KEY METRICS" },
                { id: "analyst", label: "ANALYST" },
                { id: "estimates", label: "ESTIMATES" },
                { id: "ownership", label: "OWNERSHIP" },
                { id: "calendar", label: "CALENDAR" },
                { id: "quantitative", label: "QUANTITATIVE" },
                { id: "options", label: "OPTIONS" },
                { id: "quality", label: "EARNINGS QUALITY" },
                { id: "grid", label: "GRID TRADING" },
                { id: "strategy-fit", label: "STRATEGY FIT" },
                { id: "rate-stress", label: "RATE STRESS" },
              ] as { id: AnalysisTab; label: string }[]
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setAnalysisTab(id)}
                className="px-4 py-1.5 text-xs font-mono font-bold border tracking-wider"
                style={{
                  borderColor: analysisTab === id ? colors.accent : colors.border,
                  backgroundColor: analysisTab === id ? colors.accent : colors.surface,
                  color: analysisTab === id ? "#000" : colors.text,
                  borderBottomColor: analysisTab === id ? colors.accent : colors.border,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ── Tab content ───────────────────────────────────────────────────── */}
          {analysisTab === "financials" && (
            <FinancialsTab
              financialsQuery={financialsQuery}
              activeSymbol={activeSymbol}
              colors={colors}
            />
          )}
          {analysisTab === "rate-stress" && activeSymbol && (
            <RateStressTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "outlook" && activeSymbol && (
            <CompanyOutlookPanel symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "keymetrics" && <KeyMetricsTab quote={quote} colors={colors} />}
          {analysisTab === "quantitative" && (
            <QuantitativeTab histData={quantHistQuery.data ?? historyQuery.data} colors={colors} />
          )}
          {analysisTab === "analyst" && activeSymbol && (
            <AnalystTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "estimates" && activeSymbol && (
            <EstimatesTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "ownership" && activeSymbol && (
            <OwnershipTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "calendar" && activeSymbol && (
            <EarningsCalendarTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "options" && activeSymbol && (
            <OptionsTab symbol={activeSymbol} colors={colors} />
          )}
          {analysisTab === "quality" && activeSymbol && (
            <EarningsQualityTab symbol={activeSymbol} colors={colors} isDark={isDarkMode} />
          )}
          {analysisTab === "grid" && (
            <GridTradingTab histData={quantHistQuery.data ?? historyQuery.data} colors={colors} />
          )}
          {analysisTab === "strategy-fit" && (
            <StrategyFitTab histData={quantHistQuery.data ?? historyQuery.data} colors={colors} />
          )}
        </div>
      )}
    </div>
  );
}
