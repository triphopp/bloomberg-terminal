"use client";

import { useAtom, useSetAtom } from "jotai";
import { LayoutGrid, List, RefreshCw } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, Treemap } from "recharts";
import { currentViewAtom, showYTDAtom, stockSearchSymbolAtom } from "../atoms";
import { BloombergButton } from "../core/bloomberg-button";
import { SCROLLBAR_THIN } from "../lib/style-constants";
import { bloombergColors } from "../lib/theme-config";
import type { MarketItem } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = "table" | "heatmap";
type HeatGroup =
  | "global"
  | "sectors"
  | "commodities"
  | "bonds"
  | "sectors_th"
  | "sectors_cn"
  | "sectors_kr"
  | "sectors_eu";

type HeatTile = {
  id: string;
  symbol: string;
  value: number;
  change: number;
  pctChange: number;
  ytd: number;
  avat: number;
  time: string;
  size?: number;
};

type TreeNode = {
  name: string;
  symbol?: string;
  size?: number;
  pctChange?: number;
  ytd?: number;
  price?: number; // NOT named "value" — Recharts overwrites that field
  children?: TreeNode[];
};

type SectorHolding = {
  symbol: string;
  name: string;
  weight: number;
  price: number;
  pctChange: number;
  pe: number | null;
  forwardPE: number | null;
  peg: number | null;
  debtEq: number | null;
  marketCap: number | null;
};

type MetricStats = {
  median: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  n: number;
};
type SectorDetailData = {
  etf: string;
  sector: string;
  holdings: SectorHolding[];
  aggregate: {
    count: number;
    pe: MetricStats & { wtd: number | null };
    forwardPE: MetricStats & { wtd: number | null };
    peg: MetricStats;
    debtEq: MetricStats;
    marketCap: MetricStats & { total: number | null };
  };
};

type SectorStock = {
  symbol: string;
  id: string;
  name: string;
  price: number;
  pctChange: number;
  ytd: number;
  size: number;
};

// Extended stock data from intl-sectors endpoint (includes fundamentals)
type IntlStockDetail = SectorStock & {
  pe?: number | null;
  forwardPE?: number | null;
  peg?: number | null;
  debtEq?: number | null;
  marketCap?: number | null;
  weight?: number;
};

type IntlAggregates = {
  count: number;
  pe: MetricStats & { wtd: number | null };
  forwardPE: MetricStats & { wtd: number | null };
  peg: MetricStats;
  debtEq: MetricStats;
  marketCap: MetricStats & { total: number | null };
};

const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLB", "XLU", "XLRE", "XLC"];
const ETF_TO_SECTOR: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLY: "Consumer Disc",
  XLP: "Consumer Stpls",
  XLB: "Materials",
  XLU: "Utilities",
  XLRE: "Real Estate",
  XLC: "Communication",
};

const INTL_COUNTRIES = ["th", "cn", "kr", "eu"] as const;
type IntlCountry = (typeof INTL_COUNTRIES)[number];

const GROUP_LABELS: Record<HeatGroup, string> = {
  global: "GLOBAL INDICES",
  sectors: "US SECTORS",
  sectors_th: "🇹🇭 TH SECTORS",
  sectors_cn: "🇨🇳 CN SECTORS",
  sectors_kr: "🇰🇷 KR SECTORS",
  sectors_eu: "🇪🇺 EU SECTORS",
  commodities: "COMMODITIES",
  bonds: "BONDS",
};

// ─── Color helper ─────────────────────────────────────────────────────────────

function tileStyle(pct: number, isDark: boolean) {
  const p = Math.abs(pct);
  if (isDark) {
    if (pct >= 0) {
      if (p >= 4) return { bg: "#0f4d0f", border: "#1a7a1a", text: "#7fff7f" };
      if (p >= 2) return { bg: "#0d3d0d", border: "#156b15", text: "#90ee90" };
      if (p >= 1) return { bg: "#0a2e0a", border: "#0f5c0f", text: "#90ee90" };
      if (p >= 0.2) return { bg: "#071e07", border: "#0a3a0a", text: "#76d276" };
      return { bg: "#1a1f1a", border: "#2a352a", text: "#888" };
    }
    if (p >= 4) return { bg: "#4d0f0f", border: "#7a1a1a", text: "#ff9090" };
    if (p >= 2) return { bg: "#3d0d0d", border: "#6b1515", text: "#ff9090" };
    if (p >= 1) return { bg: "#2e0a0a", border: "#5c0f0f", text: "#ff8080" };
    if (p >= 0.2) return { bg: "#1e0a0a", border: "#3a0a0a", text: "#d27676" };
    return { bg: "#1f1a1a", border: "#352a2a", text: "#888" };
  }
  if (pct >= 0) {
    if (p >= 4) return { bg: "#c8efca", border: "#4caf50", text: "#1a5c1a" };
    if (p >= 2) return { bg: "#d7f0d7", border: "#66bb6a", text: "#2e7d32" };
    if (p >= 1) return { bg: "#e4f4e4", border: "#81c784", text: "#388e3c" };
    if (p >= 0.2) return { bg: "#eff8ef", border: "#a5d6a7", text: "#4caf50" };
    return { bg: "#f5f5f5", border: "#ddd", text: "#666" };
  }
  if (p >= 4) return { bg: "#efcaca", border: "#f44336", text: "#5c1a1a" };
  if (p >= 2) return { bg: "#f0d7d7", border: "#ef5350", text: "#7d2e2e" };
  if (p >= 1) return { bg: "#f4e4e4", border: "#e57373", text: "#8e3838" };
  if (p >= 0.2) return { bg: "#f8efef", border: "#ef9a9a", text: "#c62828" };
  return { bg: "#f5f5f5", border: "#ddd", text: "#666" };
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtTreePrice(v: number): string {
  if (!v || Number.isNaN(v)) return "—";
  if (v >= 10000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 1000)
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

// ─── Treemap data builders ────────────────────────────────────────────────────

function buildGlobalTreemap(mktData: Record<string, MarketItem[]>): TreeNode[] {
  const regions: { key: string; name: string }[] = [
    { key: "americas", name: "AMERICAS" },
    { key: "emea", name: "EMEA" },
    { key: "asiaPacific", name: "ASIA PACIFIC" },
  ];
  return regions
    .map(({ key, name }) => ({
      name,
      children: ((mktData[key] ?? []) as MarketItem[])
        .map((item) => ({
          name: item.id,
          size: item.size ?? 1,
          pctChange: item.pctChange ?? 0,
          ytd: item.ytd ?? 0,
          price: item.value,
        }))
        .filter((n) => (n.size ?? 0) > 0),
    }))
    .filter((r) => (r.children?.length ?? 0) > 0);
}

function buildGroupTreemap(tiles: HeatTile[]): TreeNode[] {
  return tiles
    .map((t) => ({
      name: t.id,
      symbol: t.symbol,
      size: t.size ?? 1,
      pctChange: t.pctChange ?? 0,
      ytd: t.ytd ?? 0,
      price: t.value,
    }))
    .filter((n) => (n.size ?? 0) > 0);
}

function buildSectorNestedTree(
  tiles: HeatTile[],
  stocks: Record<string, SectorStock[]>
): TreeNode[] {
  return tiles
    .map((t) => {
      const children = stocks[t.id] ?? [];
      if (children.length === 0) {
        return {
          name: t.id,
          symbol: t.symbol,
          size: t.size ?? 1,
          pctChange: t.pctChange ?? 0,
          ytd: t.ytd ?? 0,
          price: t.value,
        };
      }
      return {
        name: t.id,
        children: children.map((s) => ({
          name: s.name.length > 13 ? `${s.name.slice(0, 12)}…` : s.name,
          symbol: s.symbol,
          size: s.size,
          pctChange: s.pctChange,
          ytd: s.ytd,
          price: s.price,
        })),
      };
    })
    .filter((n) => (n.children ? n.children.length > 0 : (n.size ?? 0) > 0));
}

// ─── Custom Treemap cell ──────────────────────────────────────────────────────

/**
 * Recharts injects far more into a Treemap `content` prop than its own types
 * expose (computed x/y/width/height plus whatever payload was on the node) —
 * this is the subset TreeCell actually reads, not a full recharts type.
 */
interface TreeCellProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  pctChange?: number;
  ytd?: number;
  price?: number;
  symbol?: string;
  children?: unknown;
  isDark?: boolean;
  showYTD?: boolean;
  onCellClick?: () => void;
}

function TreeCell(props: TreeCellProps) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    name = "",
    pctChange = 0,
    ytd = 0,
    price,
    symbol,
    children: nodeChildren,
    isDark = false,
    showYTD,
    onCellClick,
  } = props;

  if (width <= 1 || height <= 1) return null;

  const displayPct = showYTD && ytd != null ? ytd : (pctChange ?? 0);
  const cs = tileStyle(displayPct, isDark);

  if (Array.isArray(nodeChildren) && nodeChildren.length > 0) {
    const groupBg = isDark ? "#0a0a0a" : "#ececec";
    const groupBorder = isDark ? "#1e1e1e" : "#d0d0d0";
    const labelColor = isDark ? "#3a3a3a" : "#bbb";
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={groupBg}
          stroke={groupBorder}
          strokeWidth={2}
        />
        {width > 40 && (
          <text
            x={x + 6}
            y={y + 14}
            fill={labelColor}
            fontSize={9}
            fontWeight="bold"
            fontFamily="monospace"
          >
            {name}
          </text>
        )}
      </g>
    );
  }

  const area = width * height;
  const fSize = Math.max(7, Math.min(14, Math.sqrt(area) / 8));
  const showLbl = width > 26 && height > 18;
  const showVal = width > 50 && height > 46 && price != null;
  const showPct = width > 36 && height > 30;

  const lineH = fSize * 1.35;
  const rowCount = (showLbl ? 1 : 0) + (showVal ? 1 : 0) + (showPct ? 1 : 0);
  const blockH = rowCount * lineH;
  const rowY = y + height / 2 - blockH / 2 + lineH * 0.8;

  const rows: { text: string; bold: boolean; size: number }[] = [];
  if (showLbl)
    rows.push({
      text: name.length > 13 ? `${name.slice(0, 12)}…` : name,
      bold: true,
      size: Math.min(fSize, 12),
    });
  if (showVal)
    rows.push({
      text: fmtTreePrice(price as number),
      bold: false,
      size: Math.min(fSize * 0.9, 11),
    });
  if (showPct)
    rows.push({
      text: `${displayPct >= 0 ? "+" : ""}${displayPct.toFixed(2)}%`,
      bold: false,
      size: Math.min(fSize * 0.85, 10),
    });

  return (
    <g
      role={onCellClick ? "button" : undefined}
      tabIndex={onCellClick ? 0 : undefined}
      style={{ cursor: onCellClick ? "pointer" : "default" }}
      onClick={onCellClick}
      onKeyDown={
        onCellClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCellClick();
              }
            }
          : undefined
      }
    >
      <rect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        fill={cs.bg}
        stroke={cs.border}
        strokeWidth={1}
        rx={1}
      />
      {rows.map((row, i) => (
        <text
          key={row.text}
          x={x + width / 2}
          y={rowY + i * lineH}
          textAnchor="middle"
          fill={cs.text}
          fontSize={row.size}
          fontWeight={row.bold ? "bold" : "normal"}
          fontFamily="monospace"
        >
          {row.text}
        </text>
      ))}
    </g>
  );
}

// ─── Treemap section ──────────────────────────────────────────────────────────

function TreemapSection({
  activeGroup,
  mktData,
  currentTiles,
  sectorStocks,
  intlStocks,
  isDark,
  showYTD,
  onNavigate,
}: {
  activeGroup: HeatGroup;
  mktData: Record<string, MarketItem[]>;
  currentTiles: HeatTile[];
  sectorStocks: Record<string, SectorStock[]>;
  intlStocks: Record<string, SectorStock[]>;
  isDark: boolean;
  showYTD: boolean;
  onNavigate: (sym: string) => void;
}) {
  const isIntl = /^sectors_(th|cn|kr|eu)$/.test(activeGroup);
  const hasSectorStocks =
    (activeGroup === "sectors" && Object.keys(sectorStocks).length > 0) ||
    (isIntl && Object.keys(intlStocks).length > 0);

  const treeData = useMemo<TreeNode[]>(() => {
    if (activeGroup === "global") return buildGlobalTreemap(mktData);
    if (isIntl && Object.keys(intlStocks).length > 0)
      return buildSectorNestedTree(currentTiles, intlStocks);
    if (activeGroup === "sectors" && Object.keys(sectorStocks).length > 0)
      return buildSectorNestedTree(currentTiles, sectorStocks);
    return buildGroupTreemap(currentTiles);
  }, [activeGroup, mktData, currentTiles, sectorStocks, intlStocks, isIntl]);

  const treemapHeight = hasSectorStocks ? 640 : activeGroup === "global" ? 560 : 480;

  if (treeData.length === 0) return null;

  const renderCell = (props: TreeCellProps) => {
    // Navigate for leaf cells that have a symbol (including nested stock sub-tiles)
    const sym = activeGroup !== "global" ? props.symbol : undefined;
    // Don't navigate on parent group cells (those with children)
    const hasChildren = Array.isArray(props.children) && props.children.length > 0;
    return (
      <TreeCell
        {...props}
        isDark={isDark}
        showYTD={showYTD}
        onCellClick={sym && !hasChildren ? () => onNavigate(sym) : undefined}
      />
    );
  };

  return (
    <div style={{ width: "100%", height: treemapHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* @ts-ignore — Recharts Treemap types are loose */}
        <Treemap
          data={treeData}
          dataKey="size"
          aspectRatio={16 / 9}
          isAnimationActive={false}
          // Recharts types `content` as a ReactElement, but its own runtime
          // (renderContentItem) special-cases functions and invokes them with
          // the computed layout props instead of cloning — a function is the
          // correct and documented usage, the type just doesn't say so.
          // Bridged through unknown rather than any so this stays an explicit,
          // narrow escape instead of disabling checks on the whole expression.
          content={renderCell as unknown as ReactElement}
        />
      </ResponsiveContainer>
    </div>
  );
}

// ─── Legend strip ─────────────────────────────────────────────────────────────

function TreemapLegend({ isDark }: { isDark: boolean }) {
  const steps = [
    { label: "≥ +4%", pct: 5 },
    { label: "+2%", pct: 3 },
    { label: "+1%", pct: 1.5 },
    { label: "~0%", pct: 0 },
    { label: "−1%", pct: -1.5 },
    { label: "−2%", pct: -3 },
    { label: "≤ −4%", pct: -5 },
  ];
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map(({ label, pct }) => {
        const cs = tileStyle(pct, isDark);
        return (
          <div
            key={label}
            className="flex items-center gap-1 px-1.5 py-0.5 border text-[9px] font-mono"
            style={{ backgroundColor: cs.bg, borderColor: cs.border, color: cs.text }}
          >
            {label}
          </div>
        );
      })}
      <span className="text-[9px] ml-2" style={{ color: isDark ? "#555" : "#aaa" }}>
        Size = market cap
      </span>
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  accent,
  text,
  border,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: string;
  text: string;
  border: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 text-xs font-mono font-bold border tracking-wider"
      style={{
        borderColor: active ? accent : border,
        backgroundColor: active ? accent : "transparent",
        color: active ? "#000" : text,
      }}
    >
      {label}
    </button>
  );
}

// ─── Column row type ──────────────────────────────────────────────────────────

type ColRow =
  | { kind: "subheader"; label: string }
  | { kind: "item"; id: string; value: number; change: number; pctChange: number; ytd: number };

// ─── Column section ───────────────────────────────────────────────────────────

function ColumnSection({
  label,
  rows,
  isDark,
  isLoading,
  showYTD,
  onNavigate,
}: {
  label: string;
  rows: ColRow[];
  isDark: boolean;
  isLoading: boolean;
  showYTD: boolean;
  onNavigate?: (sym: string) => void;
}) {
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;
  const accentColor = isDark ? colors.accent : colors.accent;

  // Summary stats
  const items = rows.filter((r): r is ColRow & { kind: "item" } => r.kind === "item");
  const advancing = items.filter((r) => r.pctChange > 0).length;
  const declining = items.filter((r) => r.pctChange < 0).length;
  const unchanged = items.length - advancing - declining;
  const avgPct = items.length > 0 ? items.reduce((s, r) => s + r.pctChange, 0) / items.length : 0;
  const maxGainer =
    items.length > 0 ? items.reduce((a, b) => (b.pctChange > a.pctChange ? b : a), items[0]) : null;
  const maxLoser =
    items.length > 0 ? items.reduce((a, b) => (b.pctChange < a.pctChange ? b : a), items[0]) : null;

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ borderRight: "1px solid #1a1a1a" }}
    >
      {/* Column header */}
      <div
        className="px-2 py-1.5 shrink-0"
        style={{ background: "#0a0a0a", borderBottom: "1px solid #1a1a1a" }}
      >
        <span
          className="text-[9px] font-bold font-mono tracking-widest"
          style={{ color: accentColor }}
        >
          {label}
        </span>
      </div>

      {/* Summary stats bar */}
      {items.length > 0 && !isLoading && (
        <div
          className="px-2 py-1 shrink-0 flex flex-wrap gap-x-2 gap-y-0.5 text-[7px] font-mono"
          style={{ background: "#060606", borderBottom: "1px solid #1a1a1a", color: "#555" }}
        >
          <span>
            <span style={{ color: "#00FF00" }}>▲{advancing}</span>
            {unchanged > 0 && <span style={{ color: "#555" }}> ─{unchanged}</span>}
            <span style={{ color: "#FF0000" }}> ▼{declining}</span>
          </span>
          <span>
            avg{" "}
            <span style={{ color: avgPct >= 0 ? "#00FF00" : "#FF0000" }}>
              {avgPct >= 0 ? "+" : ""}
              {avgPct.toFixed(2)}%
            </span>
          </span>
          {maxGainer && maxGainer.pctChange > 0 && (
            <span>
              best{" "}
              <span style={{ color: "#00FF00" }}>
                {maxGainer.id} +{maxGainer.pctChange.toFixed(2)}%
              </span>
            </span>
          )}
          {maxLoser && maxLoser.pctChange < 0 && (
            <span>
              worst{" "}
              <span style={{ color: "#FF0000" }}>
                {maxLoser.id} {maxLoser.pctChange.toFixed(2)}%
              </span>
            </span>
          )}
        </div>
      )}

      {/* Breadth bar (visual: green/red proportional strip) */}
      {items.length > 0 && !isLoading && (
        <div className="flex shrink-0" style={{ height: 2 }}>
          <div style={{ flex: advancing, backgroundColor: "#00aa00" }} />
          <div style={{ flex: unchanged || 0.01, backgroundColor: "#333" }} />
          <div style={{ flex: declining, backgroundColor: "#aa0000" }} />
        </div>
      )}

      {/* Table header */}
      <div
        className="flex items-center px-1 py-0.5 text-[8px] font-bold font-mono shrink-0"
        style={{ background: "#050505", borderBottom: "1px solid #1a1a1a", color: "#555" }}
      >
        <span className="flex-1 truncate">NAME</span>
        <span className="w-[72px] text-right">LAST</span>
        <span className="w-[56px] text-right">CHG</span>
        <span className="w-[56px] text-right">{showYTD ? "YTD%" : "%CHG"}</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto" style={SCROLLBAR_THIN}>
        {isLoading ? (
          <div className="flex justify-center items-center pt-8">
            <RefreshCw className="h-4 w-4 animate-spin" style={{ color: accentColor }} />
          </div>
        ) : (
          rows.map((row, idx) => {
            if (row.kind === "subheader") {
              return (
                <div
                  key={`sh-${row.label}`}
                  className="px-1 py-0.5 text-[7px] font-bold font-mono tracking-widest"
                  style={{
                    background: "#0d0d0d",
                    color: "#444",
                    borderBottom: "1px solid #1a1a1a",
                  }}
                >
                  {row.label}
                </div>
              );
            }
            const valColor = isDark ? "#f5f5b8" : "#8b7500";
            const activeVal = showYTD ? row.ytd : row.pctChange;
            const activeColor = activeVal >= 0 ? "#00FF00" : "#FF0000";
            const chgColor = row.change >= 0 ? "#00FF00" : "#FF0000";
            return (
              <div
                key={`${row.id}-${idx}`}
                role={onNavigate ? "button" : undefined}
                tabIndex={onNavigate ? 0 : undefined}
                className="flex items-center px-1 py-[3px] border-b transition-colors"
                style={{ borderColor: "#1a1a1a", cursor: onNavigate ? "pointer" : "default" }}
                onClick={onNavigate ? () => onNavigate(row.id) : undefined}
                onKeyDown={
                  onNavigate
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onNavigate(row.id);
                        }
                      }
                    : undefined
                }
              >
                <span
                  className="flex-1 text-[10px] font-bold font-mono truncate leading-none"
                  style={{ color: accentColor }}
                >
                  {row.id}
                </span>
                <span
                  className="w-[72px] text-right text-[9px] font-mono leading-none"
                  style={{ color: valColor }}
                >
                  {fmtTreePrice(row.value)}
                </span>
                <span
                  className="w-[56px] text-right text-[8px] font-mono leading-none"
                  style={{ color: chgColor }}
                >
                  {row.change >= 0 ? "+" : ""}
                  {fmtTreePrice(
                    Math.abs(row.change) < 1
                      ? Number.parseFloat(row.change.toFixed(4))
                      : Number.parseFloat(row.change.toFixed(2))
                  )}
                </span>
                <span
                  className="w-[56px] text-right text-[9px] font-bold font-mono leading-none"
                  style={{ color: activeColor }}
                >
                  {activeVal >= 0 ? "+" : ""}
                  {activeVal.toFixed(2)}%
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Sector column (expandable, with cluster metrics) ────────────────────────

function SectorColumn({
  tiles,
  isDark,
  isLoading,
  showYTD,
  onNavigate,
  activeTab,
  onTabChange,
  intlTiles,
  intlStocks,
  intlLoading,
  intlDetail,
  intlAggregates,
}: {
  tiles: HeatTile[];
  isDark: boolean;
  isLoading: boolean;
  showYTD: boolean;
  onNavigate: (symbol: string) => void;
  activeTab: "us" | IntlCountry;
  onTabChange: (tab: "us" | IntlCountry) => void;
  intlTiles: HeatTile[];
  intlStocks: Record<string, SectorStock[]>;
  intlLoading: boolean;
  intlDetail: Record<string, IntlStockDetail[]>;
  intlAggregates: Record<string, IntlAggregates>;
}) {
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;
  const accentColor = isDark ? colors.accent : colors.accent;
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, SectorDetailData>>({});
  const [loadingDetail, setLoadingDetail] = useState<Record<string, boolean>>({});

  const handleClick = (sectorId: string, etfSymbol: string) => {
    if (expandedSymbol === etfSymbol) {
      setExpandedSymbol(null);
      return;
    }
    setExpandedSymbol(etfSymbol);
    if (detail[etfSymbol]) return;
    setLoadingDetail((p) => ({ ...p, [etfSymbol]: true }));
    fetch(`/api/heatmap/sector-detail?etf=${etfSymbol}&limit=10`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      })
      .then((d) => setDetail((p) => ({ ...p, [etfSymbol]: d })))
      .catch(() =>
        setDetail((p) => ({
          ...p,
          [etfSymbol]: {
            etf: etfSymbol,
            sector: sectorId,
            holdings: [],
            aggregate: {
              count: 0,
              pe: { median: null, avg: null, wtd: null, min: null, max: null, n: 0 },
              forwardPE: { median: null, avg: null, wtd: null, min: null, max: null, n: 0 },
              peg: { median: null, avg: null, min: null, max: null, n: 0 },
              debtEq: { median: null, avg: null, min: null, max: null, n: 0 },
              marketCap: { median: null, avg: null, min: null, max: null, total: null, n: 0 },
            },
          },
        }))
      )
      .finally(() => setLoadingDetail((p) => ({ ...p, [etfSymbol]: false })));
  };

  const fmtMCap = (v: number | null | undefined): string => {
    if (!v) return "—";
    if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    return v.toFixed(0);
  };

  const fmtMetric = (v: number | null | undefined): string => (v != null ? v.toFixed(1) : "—");

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ borderRight: "1px solid #1a1a1a" }}
    >
      {/* Column header with country tabs */}
      <div
        className="px-2 py-1 shrink-0 flex items-center gap-1"
        style={{ background: "#0a0a0a", borderBottom: "1px solid #1a1a1a" }}
      >
        {(["us", "th", "cn", "kr", "eu"] as const).map((tab) => {
          const labels: Record<string, string> = {
            us: "US",
            th: "🇹🇭TH",
            cn: "🇨🇳CN",
            kr: "🇰🇷KR",
            eu: "🇪🇺EU",
          };
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onTabChange(tab)}
              className="px-1.5 py-0.5 text-[8px] font-bold font-mono border transition-colors"
              style={{
                borderColor: isActive ? accentColor : "#222",
                backgroundColor: isActive ? accentColor : "transparent",
                color: isActive ? "#000" : "#555",
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>

      {/* Summary stats bar for sectors */}
      {(() => {
        const sItems = activeTab === "us" ? tiles : intlTiles;
        if (sItems.length === 0) return null;
        const adv = sItems.filter((t) => t.pctChange > 0).length;
        const dec = sItems.filter((t) => t.pctChange < 0).length;
        const unc = sItems.length - adv - dec;
        const avg = sItems.reduce((s, t) => s + t.pctChange, 0) / sItems.length;
        return (
          <div
            className="px-2 py-1 shrink-0 flex flex-wrap gap-x-2 gap-y-0.5 text-[7px] font-mono"
            style={{ background: "#060606", borderBottom: "1px solid #1a1a1a", color: "#555" }}
          >
            <span>
              <span style={{ color: "#00FF00" }}>▲{adv}</span>
              {unc > 0 && <span style={{ color: "#555" }}> ─{unc}</span>}
              <span style={{ color: "#FF0000" }}> ▼{dec}</span>
            </span>
            <span>
              avg{" "}
              <span style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}>
                {avg >= 0 ? "+" : ""}
                {avg.toFixed(2)}%
              </span>
            </span>
          </div>
        );
      })()}

      {/* Table header */}
      <div
        className="flex items-center px-1 py-0.5 text-[8px] font-bold font-mono shrink-0"
        style={{ background: "#050505", borderBottom: "1px solid #1a1a1a", color: "#555" }}
      >
        <span className="flex-1 truncate">NAME</span>
        <span className="w-[68px] text-right">LAST</span>
        <span className="w-[64px] text-right">{showYTD ? "YTD%" : "%CHG"}</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto" style={SCROLLBAR_THIN}>
        {/* International sectors: sector-grouped flat list */}
        {activeTab !== "us" &&
          (intlLoading ? (
            <div className="flex justify-center items-center pt-8">
              <RefreshCw className="h-4 w-4 animate-spin" style={{ color: accentColor }} />
            </div>
          ) : intlTiles.length > 0 ? (
            intlTiles.map((sectorTile, si) => {
              const isSectorExpanded = expandedSymbol === sectorTile.id;
              const stks = intlStocks[sectorTile.id] ?? [];
              const activeVal = showYTD ? sectorTile.ytd : sectorTile.pctChange;
              const activeColor = activeVal >= 0 ? "#00FF00" : "#FF0000";
              const valColor = isDark ? "#f5f5b8" : "#8b7500";
              return (
                <div key={`intl-${sectorTile.id}-${si}`}>
                  <button
                    type="button"
                    className="w-full flex items-center px-1 py-[3px] border-b text-left transition-colors"
                    style={{ borderColor: "#1a1a1a" }}
                    onClick={() => setExpandedSymbol(isSectorExpanded ? null : sectorTile.id)}
                  >
                    <span className="text-[8px] mr-1" style={{ color: "#555" }}>
                      {isSectorExpanded ? "▼" : "▶"}
                    </span>
                    <span
                      className="flex-1 text-[10px] font-bold font-mono truncate leading-none"
                      style={{ color: accentColor }}
                    >
                      {sectorTile.id}
                    </span>
                    <span
                      className="w-[20px] text-right text-[7px] font-mono"
                      style={{ color: "#555" }}
                    >
                      {stks.length}
                    </span>
                    <span
                      className="w-[64px] text-right text-[9px] font-bold font-mono leading-none"
                      style={{ color: activeColor }}
                    >
                      {activeVal >= 0 ? "+" : ""}
                      {activeVal.toFixed(2)}%
                    </span>
                  </button>
                  {isSectorExpanded && (
                    <div style={{ background: "#080808", borderBottom: "1px solid #1a1a1a" }}>
                      {/* Aggregate metrics panel */}
                      {(() => {
                        const agg = intlAggregates[sectorTile.id];
                        if (!agg || agg.count === 0) return null;
                        return (
                          <div
                            className="px-2 py-1.5 text-[8px] font-mono leading-relaxed"
                            style={{ color: "#777", borderBottom: "1px solid #1a1a1a" }}
                          >
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>
                                P/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(agg.pe.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {agg.pe.wtd != null && (
                                  <span>
                                    {" "}
                                    | <span style={{ color: "#aaa" }}>{fmtMetric(agg.pe.wtd)}</span>
                                    <span style={{ color: "#555" }}> wtd</span>
                                  </span>
                                )}
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(agg.pe.min)}–{fmtMetric(agg.pe.max)}]
                                </span>
                              </span>
                              <span>
                                Fwd P/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(agg.forwardPE.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {agg.forwardPE.wtd != null && (
                                  <span>
                                    {" "}
                                    |{" "}
                                    <span style={{ color: "#aaa" }}>
                                      {fmtMetric(agg.forwardPE.wtd)}
                                    </span>
                                    <span style={{ color: "#555" }}> wtd</span>
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                              <span>
                                PEG{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(agg.peg.median)}
                                </span>
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(agg.peg.min)}–{fmtMetric(agg.peg.max)}]
                                </span>
                              </span>
                              <span>
                                D/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(agg.debtEq.median)}%
                                </span>
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(agg.debtEq.min)}–{fmtMetric(agg.debtEq.max)}%]
                                </span>
                              </span>
                              <span>
                                MCap{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMCap(agg.marketCap.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {agg.marketCap.total != null && (
                                  <span>
                                    {" "}
                                    | Σ{" "}
                                    <span style={{ color: "#aaa" }}>
                                      {fmtMCap(agg.marketCap.total)}
                                    </span>
                                  </span>
                                )}
                              </span>
                              <span style={{ color: "#444" }}>n={agg.count}</span>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Holdings list with per-stock P/E */}
                      {(intlDetail[sectorTile.id] ?? stks).map((s) => {
                        const sChgColor = s.pctChange >= 0 ? "#00FF00" : "#FF0000";
                        const sActiveVal = showYTD ? s.ytd : s.pctChange;
                        const det = s as IntlStockDetail;
                        return (
                          <button
                            key={s.symbol}
                            type="button"
                            className="w-full flex items-center px-1 py-[2px] text-left border-b transition-colors"
                            style={{ borderColor: "#111" }}
                            onClick={() => onNavigate(s.symbol)}
                          >
                            <span className="w-[10px]" />
                            <span
                              className="flex-1 text-[9px] font-bold font-mono truncate leading-none"
                              style={{ color: accentColor }}
                            >
                              {s.id}
                            </span>
                            {det.weight != null && det.weight > 0 && (
                              <span
                                className="w-[36px] text-right text-[7px] font-mono leading-none"
                                style={{ color: "#555" }}
                              >
                                {det.weight.toFixed(1)}%
                              </span>
                            )}
                            <span
                              className="w-[60px] text-right text-[8px] font-mono leading-none"
                              style={{ color: valColor }}
                            >
                              {fmtTreePrice(s.price)}
                            </span>
                            <span
                              className="w-[50px] text-right text-[8px] font-bold font-mono leading-none"
                              style={{ color: sChgColor }}
                            >
                              {sActiveVal >= 0 ? "+" : ""}
                              {sActiveVal.toFixed(2)}%
                            </span>
                            <span
                              className="w-[44px] text-right text-[7px] font-mono leading-none"
                              style={{ color: "#777" }}
                            >
                              P/E {det.pe != null ? det.pe.toFixed(1) : "—"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div
              className="flex items-center justify-center pt-8 text-[9px] font-mono"
              style={{ color: "#555" }}
            >
              No data — check backend
            </div>
          ))}
        {activeTab === "us" &&
          (isLoading ? (
            <div className="flex justify-center items-center pt-8">
              <RefreshCw className="h-4 w-4 animate-spin" style={{ color: accentColor }} />
            </div>
          ) : (
            tiles.map((tile, idx) => {
              const isExpanded = expandedSymbol === tile.symbol;
              const d = detail[tile.symbol];
              const loading = !!loadingDetail[tile.symbol];
              const activeVal = showYTD ? tile.ytd : tile.pctChange;
              const activeColor = activeVal >= 0 ? "#00FF00" : "#FF0000";
              const valColor = isDark ? "#f5f5b8" : "#8b7500";

              return (
                <div key={`${tile.id}-${idx}`}>
                  {/* Sector row */}
                  <button
                    type="button"
                    className="w-full flex items-center px-1 py-[3px] border-b text-left transition-colors"
                    style={{ borderColor: "#1a1a1a" }}
                    onClick={() => handleClick(tile.id, tile.symbol)}
                  >
                    <span className="text-[8px] mr-1" style={{ color: "#555" }}>
                      {isExpanded ? "▼" : "▶"}
                    </span>
                    <span
                      className="flex-1 text-[10px] font-bold font-mono truncate leading-none"
                      style={{ color: accentColor }}
                    >
                      {tile.id}
                    </span>
                    <span
                      className="w-[68px] text-right text-[9px] font-mono leading-none"
                      style={{ color: valColor }}
                    >
                      {fmtTreePrice(tile.value)}
                    </span>
                    <span
                      className="w-[64px] text-right text-[9px] font-bold font-mono leading-none"
                      style={{ color: activeColor }}
                    >
                      {activeVal >= 0 ? "+" : ""}
                      {activeVal.toFixed(2)}%
                    </span>
                  </button>

                  {/* Expanded detail panel */}
                  {isExpanded && (
                    <div style={{ background: "#080808", borderBottom: "1px solid #1a1a1a" }}>
                      {loading ? (
                        <div className="flex justify-center items-center py-3">
                          <RefreshCw
                            className="h-3 w-3 animate-spin"
                            style={{ color: accentColor }}
                          />
                        </div>
                      ) : d && d.holdings.length > 0 ? (
                        <>
                          {/* Aggregate metrics — median (robust) + wtd avg + range */}
                          <div
                            className="px-2 py-1.5 text-[8px] font-mono leading-relaxed"
                            style={{ color: "#777", borderBottom: "1px solid #1a1a1a" }}
                          >
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>
                                P/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(d.aggregate.pe.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {d.aggregate.pe.wtd != null && (
                                  <span>
                                    {" "}
                                    |{" "}
                                    <span style={{ color: "#aaa" }}>
                                      {fmtMetric(d.aggregate.pe.wtd)}
                                    </span>
                                    <span style={{ color: "#555" }}> wtd</span>
                                  </span>
                                )}
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(d.aggregate.pe.min)}–{fmtMetric(d.aggregate.pe.max)}]
                                </span>
                              </span>
                              <span>
                                Fwd P/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(d.aggregate.forwardPE.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {d.aggregate.forwardPE.wtd != null && (
                                  <span>
                                    {" "}
                                    |{" "}
                                    <span style={{ color: "#aaa" }}>
                                      {fmtMetric(d.aggregate.forwardPE.wtd)}
                                    </span>
                                    <span style={{ color: "#555" }}> wtd</span>
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                              <span>
                                PEG{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(d.aggregate.peg.median)}
                                </span>
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(d.aggregate.peg.min)}–{fmtMetric(d.aggregate.peg.max)}
                                  ]
                                </span>
                              </span>
                              <span>
                                D/E{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMetric(d.aggregate.debtEq.median)}%
                                </span>
                                <span style={{ color: "#444" }}>
                                  {" "}
                                  [{fmtMetric(d.aggregate.debtEq.min)}–
                                  {fmtMetric(d.aggregate.debtEq.max)}%]
                                </span>
                              </span>
                              <span>
                                MCap{" "}
                                <span style={{ color: accentColor }}>
                                  {fmtMCap(d.aggregate.marketCap.median)}
                                </span>
                                <span style={{ color: "#555" }}> med</span>
                                {d.aggregate.marketCap.total != null && (
                                  <span>
                                    {" "}
                                    | Σ{" "}
                                    <span style={{ color: "#aaa" }}>
                                      {fmtMCap(d.aggregate.marketCap.total)}
                                    </span>
                                  </span>
                                )}
                              </span>
                              <span style={{ color: "#444" }}>n={d.aggregate.count}</span>
                            </div>
                          </div>

                          {/* Holdings list */}
                          {d.holdings.map((h) => {
                            const hChgColor = h.pctChange >= 0 ? "#00FF00" : "#FF0000";
                            return (
                              <button
                                key={h.symbol}
                                type="button"
                                className="w-full flex items-center px-1 py-[2px] text-left border-b transition-colors"
                                style={{ borderColor: "#111" }}
                                onClick={() => onNavigate(h.symbol)}
                              >
                                <span
                                  className="w-[10px] text-[7px] font-mono"
                                  style={{ color: "#555" }}
                                >
                                  {d.holdings.indexOf(h) + 1}
                                </span>
                                <span
                                  className="w-[48px] text-[9px] font-bold font-mono truncate leading-none"
                                  style={{ color: accentColor }}
                                >
                                  {h.symbol}
                                </span>
                                <span
                                  className="w-[42px] text-right text-[8px] font-mono leading-none"
                                  style={{ color: "#666" }}
                                >
                                  {h.weight.toFixed(1)}%
                                </span>
                                <span
                                  className="flex-1 text-right text-[8px] font-mono leading-none"
                                  style={{ color: valColor }}
                                >
                                  {h.price.toFixed(2)}
                                </span>
                                <span
                                  className="w-[52px] text-right text-[8px] font-bold font-mono leading-none"
                                  style={{ color: hChgColor }}
                                >
                                  {h.pctChange >= 0 ? "+" : ""}
                                  {h.pctChange.toFixed(2)}%
                                </span>
                                <span
                                  className="w-[44px] text-right text-[7px] font-mono leading-none"
                                  style={{ color: "#777" }}
                                >
                                  P/E {fmtMetric(h.pe)}
                                </span>
                              </button>
                            );
                          })}
                        </>
                      ) : (
                        <div className="px-2 py-2 text-[8px] font-mono" style={{ color: "#555" }}>
                          No holdings data available for {tile.symbol}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ))}
      </div>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface MarketMoversViewProps {
  isDarkMode: boolean;
  onBack: () => void;
  marketData: {
    americas: {
      id: string;
      value: number;
      change: number;
      pctChange: number;
      ytd: number;
      size?: number;
    }[];
    emea: {
      id: string;
      value: number;
      change: number;
      pctChange: number;
      ytd: number;
      size?: number;
    }[];
    asiaPacific: {
      id: string;
      value: number;
      change: number;
      pctChange: number;
      ytd: number;
      size?: number;
    }[];
    lastUpdated?: string;
  };
  onRefresh: () => void;
  isLoading: boolean;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MarketMoversView({
  isDarkMode,
  onBack,
  marketData,
  onRefresh,
  isLoading,
}: MarketMoversViewProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [activeGroup, setActiveGroup] = useState<HeatGroup>("global");
  const [groupTiles, setGroupTiles] = useState<Partial<Record<HeatGroup, HeatTile[]>>>({});
  const [loadingGroups, setLoadingGroups] = useState<Partial<Record<HeatGroup, boolean>>>({});
  const [showYTD] = useAtom(showYTDAtom);
  const setCurrentView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const [sectorStocks, setSectorStocks] = useState<Record<string, SectorStock[]>>({});
  const [tableSectorTab, setTableSectorTab] = useState<"us" | IntlCountry>("us");

  // International sector data: { tiles, stocks, detail, aggregates } per country
  const [intlData, setIntlData] = useState<
    Record<
      string,
      {
        tiles: HeatTile[];
        stocks: Record<string, SectorStock[]>;
        detail: Record<string, IntlStockDetail[]>;
        aggregates: Record<string, IntlAggregates>;
      }
    >
  >({});
  const [loadingIntl, setLoadingIntl] = useState<Record<string, boolean>>({});

  // Fetch all non-global groups immediately on mount
  useEffect(() => {
    const load = (g: HeatGroup) => {
      setLoadingGroups((p) => ({ ...p, [g]: true }));
      fetch(`/api/heatmap?group=${g}`)
        .then((r) => r.json())
        .then((d) => setGroupTiles((p) => ({ ...p, [g]: d.tiles ?? [] })))
        .catch(() => setGroupTiles((p) => ({ ...p, [g]: [] })))
        .finally(() => setLoadingGroups((p) => ({ ...p, [g]: false })));
    };
    load("sectors");
    load("commodities");
    load("bonds");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch sector stocks for nested treemap (background, fire-and-forget)
  useEffect(() => {
    for (const etf of SECTOR_ETFS) {
      fetch(`/api/heatmap/sector-stocks?etf=${etf}&limit=10`)
        .then((r) => r.json())
        .then((d) => {
          if (d.stocks?.length > 0) {
            setSectorStocks((p) => ({ ...p, [ETF_TO_SECTOR[etf] ?? etf]: d.stocks }));
          }
        })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch international sector data on-demand when a country tab is activated
  // (from either heatmap tabs or table sector switcher)
  const fetchIntlCountry = (country: IntlCountry) => {
    if (intlData[country] || loadingIntl[country]) return;
    setLoadingIntl((p) => ({ ...p, [country]: true }));
    fetch(`/api/heatmap/intl-sectors?country=${country}`)
      .then((r) => r.json())
      .then((d) => {
        type RawIntlTile = Pick<HeatTile, "id" | "symbol"> &
          Partial<Omit<HeatTile, "id" | "symbol">>;
        const tiles: HeatTile[] = (d.tiles ?? []).map((t: RawIntlTile) => ({
          id: t.id,
          symbol: t.symbol,
          value: t.value ?? 0,
          change: 0,
          pctChange: t.pctChange ?? 0,
          ytd: t.ytd ?? 0,
          avat: 0,
          time: "",
          size: t.size ?? 1,
        }));
        const stocks: Record<string, SectorStock[]> = {};
        const detail: Record<string, IntlStockDetail[]> = {};
        type RawIntlStock = Pick<IntlStockDetail, "symbol" | "id" | "price" | "pctChange"> &
          Partial<Omit<IntlStockDetail, "symbol" | "id" | "price" | "pctChange">>;
        for (const [sector, stks] of Object.entries(d.stocks ?? {})) {
          const parsed = (stks as RawIntlStock[]).map((s) => ({
            symbol: s.symbol,
            id: s.id,
            name: s.name ?? s.id,
            price: s.price,
            pctChange: s.pctChange,
            ytd: s.ytd ?? 0,
            size: s.size ?? 1,
            pe: s.pe ?? null,
            forwardPE: s.forwardPE ?? null,
            peg: s.peg ?? null,
            debtEq: s.debtEq ?? null,
            marketCap: s.marketCap ?? null,
            weight: s.weight ?? 0,
          }));
          stocks[sector] = parsed;
          detail[sector] = parsed;
        }
        const aggregates: Record<string, IntlAggregates> = d.aggregates ?? {};
        setIntlData((p) => ({ ...p, [country]: { tiles, stocks, detail, aggregates } }));
      })
      .catch(() =>
        setIntlData((p) => ({
          ...p,
          [country]: { tiles: [], stocks: {}, detail: {}, aggregates: {} },
        }))
      )
      .finally(() => setLoadingIntl((p) => ({ ...p, [country]: false })));
  };

  // fetchIntlCountry is redefined every render and is itself guarded (no-ops if
  // already loaded/loading) — depending on it would re-run this on every render
  // instead of only when the active group changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const match = activeGroup.match(/^sectors_(th|cn|kr|eu)$/);
    if (match) fetchIntlCountry(match[1] as IntlCountry);
  }, [activeGroup]);

  // Same as above — only tableSectorTab should retrigger this, not
  // fetchIntlCountry's identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (tableSectorTab !== "us") fetchIntlCountry(tableSectorTab);
  }, [tableSectorTab]);

  // Keyboard shortcut: H = toggle view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "h" && e.key !== "H") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setViewMode((v) => (v === "table" ? "heatmap" : "table"));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavigate = (symbol: string) => {
    setStockSymbol(symbol);
    setCurrentView("stock");
  };

  const handleRefresh = () => {
    onRefresh();
    // Re-fetch all groups
    const load = (g: HeatGroup) => {
      setLoadingGroups((p) => ({ ...p, [g]: true }));
      fetch(`/api/heatmap?group=${g}`)
        .then((r) => r.json())
        .then((d) => setGroupTiles((p) => ({ ...p, [g]: d.tiles ?? [] })))
        .catch(() => setGroupTiles((p) => ({ ...p, [g]: [] })))
        .finally(() => setLoadingGroups((p) => ({ ...p, [g]: false })));
    };
    load("sectors");
    load("commodities");
    load("bonds");
    // Re-fetch sector stocks
    for (const etf of SECTOR_ETFS) {
      fetch(`/api/heatmap/sector-stocks?etf=${etf}&limit=10`)
        .then((r) => r.json())
        .then((d) => {
          if (d.stocks?.length > 0) {
            setSectorStocks((p) => ({ ...p, [ETF_TO_SECTOR[etf] ?? etf]: d.stocks }));
          }
        })
        .catch(() => {});
    }
    // Clear intl cache so next tab switch re-fetches
    setIntlData({});
  };

  const mktDataForTree = marketData as unknown as Record<string, MarketItem[]>;

  // Resolve current tiles & stocks based on active group
  const intlMatch = activeGroup.match(/^sectors_(th|cn|kr|eu)$/);
  const intlCountry = intlMatch ? (intlMatch[1] as IntlCountry) : null;
  const currentTiles = intlCountry
    ? (intlData[intlCountry]?.tiles ?? [])
    : activeGroup !== "global"
      ? (groupTiles[activeGroup] ?? [])
      : [];
  const isGroupLoading = intlCountry ? !!loadingIntl[intlCountry] : !!loadingGroups[activeGroup];
  const currentIntlStocks = intlCountry ? (intlData[intlCountry]?.stocks ?? {}) : {};

  // Build GLOBAL INDICES column rows (grouped by region)
  const globalRows = useMemo((): ColRow[] => {
    const result: ColRow[] = [];
    const regions: [keyof typeof marketData, string][] = [
      ["americas", "AMERICAS"],
      ["emea", "EMEA"],
      ["asiaPacific", "ASIA PACIFIC"],
    ];
    for (const [key, label] of regions) {
      const items =
        (marketData[key] as {
          id: string;
          value: number;
          change: number;
          pctChange: number;
          ytd: number;
        }[]) ?? [];
      if (items.length === 0) continue;
      result.push({ kind: "subheader", label });
      for (const item of items) {
        result.push({
          kind: "item",
          id: item.id,
          value: item.value,
          change: item.change ?? 0,
          pctChange: item.pctChange,
          ytd: item.ytd,
        });
      }
    }
    return result;
  }, [marketData]);

  const tileToRows = (tiles: HeatTile[]): ColRow[] =>
    tiles.map((t) => ({
      kind: "item" as const,
      id: t.id,
      value: t.value,
      change: t.change ?? 0,
      pctChange: t.pctChange,
      ytd: t.ytd,
    }));

  // Merged COMMODITIES + BONDS rows. tileToRows is a pure function of its
  // `tiles` argument (closes over no render state) and is redefined every
  // render — depending on it would recompute this memo on every render
  // instead of only when the underlying tile data changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const commoditiesBondsRows = useMemo((): ColRow[] => {
    const result: ColRow[] = [];
    const cmdTiles = groupTiles.commodities ?? [];
    const bndTiles = groupTiles.bonds ?? [];
    if (cmdTiles.length > 0) {
      result.push({ kind: "subheader", label: "COMMODITIES" });
      result.push(...tileToRows(cmdTiles));
    }
    if (bndTiles.length > 0) {
      result.push({ kind: "subheader", label: "BONDS & YIELDS" });
      result.push(...tileToRows(bndTiles));
    }
    return result;
  }, [groupTiles.commodities, groupTiles.bonds]);

  return (
    <div
      className="h-full flex flex-col overflow-hidden font-mono"
      style={{ backgroundColor: "#000", color: colors.text }}
    >
      {/* ══ Header ══════════════════════════════════════════════════════════ */}
      <div
        className="flex items-center gap-2 px-2 py-1 border-b shrink-0"
        style={{ backgroundColor: "#0a0a0a", borderColor: "#1a1a1a" }}
      >
        <div className="ml-auto flex items-center gap-2">
          {/* View toggle */}
          <div className="flex border overflow-hidden" style={{ borderColor: "#333" }}>
            <button
              type="button"
              className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold font-mono border-r transition-colors"
              style={{
                borderColor: "#333",
                backgroundColor: viewMode === "table" ? colors.accent : "transparent",
                color: viewMode === "table" ? "#000" : "#666",
              }}
              onClick={() => setViewMode("table")}
              title="Table view  (H)"
            >
              <List className="h-2.5 w-2.5" />
              TABLE
            </button>
            <button
              type="button"
              className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold font-mono transition-colors"
              style={{
                backgroundColor: viewMode === "heatmap" ? colors.accent : "transparent",
                color: viewMode === "heatmap" ? "#000" : "#666",
              }}
              onClick={() => setViewMode("heatmap")}
              title="Heatmap view  (H)"
            >
              <LayoutGrid className="h-2.5 w-2.5" />
              HEAT
            </button>
          </div>

          <span className="text-[8px] font-mono" style={{ color: "#333" }}>
            H=view Y={showYTD ? "ytd" : "chg"}
          </span>

          <BloombergButton color="accent" onClick={handleRefresh} disabled={isLoading}>
            {isLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : "REFR"}
          </BloombergButton>
        </div>
      </div>

      {/* ══ TABLE VIEW ══════════════════════════════════════════════════════ */}
      {viewMode === "table" && (
        <div className="flex-1 grid grid-cols-3 overflow-hidden min-h-0">
          <ColumnSection
            label="GLOBAL INDICES"
            rows={globalRows}
            isDark={isDarkMode}
            isLoading={isLoading && globalRows.length === 0}
            showYTD={showYTD}
          />
          <SectorColumn
            tiles={groupTiles.sectors ?? []}
            isDark={isDarkMode}
            isLoading={!!loadingGroups.sectors && !groupTiles.sectors}
            showYTD={showYTD}
            onNavigate={handleNavigate}
            activeTab={tableSectorTab}
            onTabChange={setTableSectorTab}
            intlTiles={tableSectorTab !== "us" ? (intlData[tableSectorTab]?.tiles ?? []) : []}
            intlStocks={tableSectorTab !== "us" ? (intlData[tableSectorTab]?.stocks ?? {}) : {}}
            intlLoading={tableSectorTab !== "us" ? !!loadingIntl[tableSectorTab] : false}
            intlDetail={tableSectorTab !== "us" ? (intlData[tableSectorTab]?.detail ?? {}) : {}}
            intlAggregates={
              tableSectorTab !== "us" ? (intlData[tableSectorTab]?.aggregates ?? {}) : {}
            }
          />
          <ColumnSection
            label="COMMODITIES & BONDS"
            rows={commoditiesBondsRows}
            isDark={isDarkMode}
            isLoading={
              (!!loadingGroups.commodities && !groupTiles.commodities) ||
              (!!loadingGroups.bonds && !groupTiles.bonds)
            }
            showYTD={showYTD}
          />
        </div>
      )}

      {/* ══ HEATMAP VIEW ════════════════════════════════════════════════════ */}
      {viewMode === "heatmap" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Tab bar */}
          <div
            className="flex gap-1 px-2 py-1.5 border-b flex-wrap"
            style={{ backgroundColor: "#0a0a0a", borderColor: "#1a1a1a" }}
          >
            {(Object.entries(GROUP_LABELS) as [HeatGroup, string][]).map(([g, label]) => (
              <TabBtn
                key={g}
                active={activeGroup === g}
                onClick={() => setActiveGroup(g)}
                label={label}
                accent={colors.accent}
                text={colors.text}
                border="#1a1a1a"
              />
            ))}
          </div>

          {/* Group label + legend */}
          <div
            className="flex items-center gap-3 px-3 py-1.5 border-b"
            style={{ backgroundColor: "#0a0a0a", borderColor: "#1a1a1a" }}
          >
            <span
              className="text-[10px] font-bold tracking-widest"
              style={{ color: colors.accent }}
            >
              {GROUP_LABELS[activeGroup]}
            </span>
            <TreemapLegend isDark={isDarkMode} />
          </div>

          {/* Treemap canvas */}
          <div className="p-1">
            {isGroupLoading && currentTiles.length === 0 && activeGroup !== "global" ? (
              // Loading spinner for all non-global groups (US sectors, intl sectors, commodities, bonds)
              <div className="flex items-center justify-center py-20">
                <RefreshCw className="h-5 w-5 animate-spin mr-3" style={{ color: colors.accent }} />
                <span className="text-sm" style={{ color: "#555" }}>
                  Loading…
                </span>
              </div>
            ) : (
              <TreemapSection
                activeGroup={activeGroup}
                mktData={mktDataForTree}
                currentTiles={currentTiles}
                sectorStocks={sectorStocks}
                intlStocks={currentIntlStocks}
                isDark={isDarkMode}
                showYTD={showYTD}
                onNavigate={handleNavigate}
              />
            )}
            {activeGroup !== "global" &&
              !isGroupLoading &&
              !intlCountry &&
              currentTiles.length === 0 && (
                <div className="flex items-center justify-center py-20">
                  <span className="text-sm" style={{ color: "#555" }}>
                    No data — check that the Python backend is running
                  </span>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
