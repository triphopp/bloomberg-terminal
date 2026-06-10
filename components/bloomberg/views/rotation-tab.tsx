"use client";

import { AlertTriangle, TrendingDown, TrendingUp, Minus, RefreshCw } from "lucide-react";
import { useAllocation } from "../hooks/useAllocation";
import type { RotationScores, RotationEntry } from "../hooks/useCountryRotation";

const CLASS_COLORS: Record<string, string> = {
  STRONG_OVERWEIGHT:  "#00e676",
  OVERWEIGHT:         "#4ade80",
  NEUTRAL:            "#888888",
  UNDERWEIGHT:        "#f87171",
  STRONG_UNDERWEIGHT: "#ff1744",
};

const COUNTRY_FLAGS: Record<string, string> = {
  "United States":   "🇺🇸", "Europe": "🇪🇺", "Japan": "🇯🇵",
  "India":           "🇮🇳", "China": "🇨🇳", "Brazil": "🇧🇷",
  "Canada":          "🇨🇦", "Taiwan": "🇹🇼", "South Korea": "🇰🇷",
  "Australia":       "🇦🇺", "Thailand": "🇹🇭",
  "Developed ex-US": "🌍", "Emerging Markets": "🌏", "Asia ex-Japan": "🌏",
};

function ScoreMiniBar({ score, maxAbs = 2.0 }: { score: number; maxAbs?: number }) {
  const pct = Math.min(100, Math.max(0, ((score + maxAbs) / (maxAbs * 2)) * 100));
  const color = score > 0.25 ? "#4ade80" : score < -0.25 ? "#f87171" : "#616161";
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-mono w-8 text-right" style={{ color }}>
        {score > 0 ? "+" : ""}{score.toFixed(1)}
      </span>
      <div className="flex-1 h-1.5 rounded-sm" style={{ backgroundColor: "#1a1a1a" }}>
        <div
          className="h-full rounded-sm"
          style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.3s" }}
        />
      </div>
    </div>
  );
}

function AllocationBadge() {
  const { data } = useAllocation();
  if (!data) return null;

  const { regime, conflict } = data;
  const colors: Record<string, string> = {
    STRONG_RISK_ON:  "#00e676",
    MILD_RISK_ON:    "#76ff03",
    NEUTRAL:         "#9e9e9e",
    MILD_RISK_OFF:   "#ff9800",
    STRONG_RISK_OFF: "#ff1744",
  };
  const color = colors[regime] ?? "#9e9e9e";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono" style={{ color: "#757575" }}>ALLOC:</span>
      <span
        className="text-[10px] font-mono px-2 py-0.5 border rounded-sm"
        style={{ color, borderColor: color, backgroundColor: `${color}10` }}
      >
        {conflict ? "⚠ CONFLICT" : regime.replace(/_/g, " ")}
      </span>
      {regime === "STRONG_RISK_OFF" && (
        <span className="text-[10px] font-mono" style={{ color: "#ff9800" }}>
          <AlertTriangle className="h-3 w-3 inline mr-0.5" />
          Rotation signals less reliable
        </span>
      )}
    </div>
  );
}

function RowItem({ entry }: { entry: RotationEntry }) {
  const color = CLASS_COLORS[entry.classification] ?? "#888";
  const flag = COUNTRY_FLAGS[entry.country] ?? "";
  const ScoreIcon = entry.rotation_score > 0 ? TrendingUp : entry.rotation_score < 0 ? TrendingDown : Minus;

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-b"
      style={{ borderColor: "#151515", backgroundColor: entry.rank % 2 === 0 ? "#050505" : "transparent" }}
    >
      {/* Rank */}
      <span className="text-[10px] font-mono w-5 text-right" style={{ color: "#616161" }}>
        {entry.rank}
      </span>

      {/* Flag + Country */}
      <div className="w-36 min-w-[9rem]">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{flag}</span>
          <span className="text-[10px] font-mono font-bold" style={{ color: "#ccc" }}>{entry.country}</span>
          {entry.type === "regional" && (
            <span className="text-[8px] font-mono px-1 rounded" style={{ color: "#757575", backgroundColor: "#111" }}>
              REG
            </span>
          )}
        </div>
        <span className="text-[8px] font-mono" style={{ color: "#424242" }}>{entry.ticker}</span>
      </div>

      {/* Rotation Score */}
      <div className="w-28 min-w-[7rem]">
        <div className="flex items-center gap-1 mb-0.5">
          <ScoreIcon className="h-3 w-3" style={{ color }} />
          <span className="text-xs font-bold font-mono" style={{ color }}>
            {entry.rotation_score > 0 ? "+" : ""}{entry.rotation_score.toFixed(2)}
          </span>
        </div>
        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm" style={{ color, backgroundColor: `${color}15` }}>
          {entry.classification.replace(/_/g, " ")}
        </span>
      </div>

      {/* Layer scores */}
      <div className="flex-1 flex gap-4">
        <div className="flex-1">
          <ScoreMiniBar score={entry.layers.M.score} />
          <div className="flex gap-2 mt-0.5">
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              12M-1M: {entry.layers.M.momentum_12m_1m != null ? `${(entry.layers.M.momentum_12m_1m * 100).toFixed(1)}%` : "—"}
            </span>
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              6M: {entry.layers.M.momentum_6m != null ? `${(entry.layers.M.momentum_6m * 100).toFixed(1)}%` : "—"}
            </span>
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              3M: {entry.layers.M.momentum_3m != null ? `${(entry.layers.M.momentum_3m * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
        <div className="w-24 min-w-[6rem]">
          <ScoreMiniBar score={entry.layers.Q.score} />
          <div className="flex gap-2 mt-0.5">
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              GDP: {entry.layers.Q.gdp_growth_3y_ma != null ? `${entry.layers.Q.gdp_growth_3y_ma.toFixed(1)}%` : "—"}
            </span>
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              CA: {entry.layers.Q.current_account != null ? `${entry.layers.Q.current_account.toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
        <div className="w-20 min-w-[5rem]">
          <ScoreMiniBar score={entry.layers.C.score} />
          <div className="mt-0.5">
            <span className="text-[8px] font-mono" style={{ color: "#555" }}>
              YLD: {entry.layers.C.dividend_yield != null ? `${(entry.layers.C.dividend_yield * 100).toFixed(2)}%` : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RotationTab({
  data,
  isLoading,
  error,
  refresh,
  colors,
}: {
  data?: RotationScores;
  isLoading: boolean;
  error: unknown;
  refresh?: () => void;
  colors: { accent: string; text: string; textSecondary: string; border: string; surface: string; background: string };
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16" style={{ color: colors.textSecondary }}>
        <RefreshCw className="h-4 w-4 animate-spin mr-2" />
        <span className="text-sm font-mono">Loading rotation scores... (fetching 14 ETFs + World Bank data)</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-2 p-4 border text-sm font-mono" style={{ borderColor: "#ef5350", color: "#ef5350" }}>
        <AlertTriangle className="h-4 w-4" />
        <span>Backend unavailable: {String(error ?? "no data")}</span>
      </div>
    );
  }

  const { rankings, universe_stats } = data;
  const fresh = universe_stats.data_freshness;

  return (
    <div className="flex flex-col h-full" style={{ color: colors.text }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 border rounded-sm shrink-0"
        style={{ borderColor: colors.border, backgroundColor: colors.surface }}
      >
        <div className="flex items-center gap-4">
          <span className="text-xs font-bold font-mono tracking-widest" style={{ color: colors.accent }}>
            ⚡ COUNTRY EQUITY ROTATION
          </span>
          <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
            {universe_stats.n_countries} markets
          </span>
          <AllocationBadge />
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-3 text-[9px] font-mono" style={{ color: "#555" }}>
            <span>Prices: {fresh.prices}</span>
            <span>Macro: {fresh.macro}</span>
            <span>Carry: {fresh.carry}</span>
          </div>
          {refresh && (
            <button type="button" onClick={refresh} className="p-1 hover:opacity-70" title="Refresh">
              <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} style={{ color: colors.accent }} />
            </button>
          )}
        </div>
      </div>

      {/* Column Headers */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[9px] font-mono font-bold shrink-0" style={{ color: "#555" }}>
        <span className="w-5" />
        <span className="w-36">COUNTRY</span>
        <span className="w-28">SCORE</span>
        <span className="flex-1 text-center">MOMENTUM</span>
        <span className="w-24 text-center">MACRO Q</span>
        <span className="w-20 text-center">CARRY</span>
      </div>

      {/* Rankings — scrollable */}
      <div className="flex-1 overflow-y-auto rounded-sm border" style={{ borderColor: "#151515" }}>
        {rankings.map((entry) => (
          <RowItem key={entry.ticker} entry={entry} />
        ))}
      </div>

      {/* Disclaimer */}
      <p className="text-[8px] font-mono shrink-0 pt-1" style={{ color: "#424242", lineHeight: "1.6" }}>
        Cross-sectional momentum per Jegadeesh & Titman (1993). Macro quality from World Bank GDP growth + current account.
        Carry from dividend yield. All returns in USD. Regional ETFs (EFA, EEM, AAXJ) have no single-country macro data —
        weights shift to M + C. This is a quantitative ranking tool, not investment advice.
      </p>
    </div>
  );
}
