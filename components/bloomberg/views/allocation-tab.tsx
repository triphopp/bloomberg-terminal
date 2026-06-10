"use client";

import { AlertTriangle, TrendingDown, TrendingUp, Minus } from "lucide-react";
import type { AllocationSignal, LayerDetail } from "../hooks/useAllocation";

const layerLabels: Record<string, string> = {
  A: "Sentiment — SPY vs AGG relative return z-score (20d, 252d rolling)",
  B: "Flow — ETF equity/bond flow proxy (price-adjusted AUM, 9 ETFs)",
  C: "Structural — FRED Z.1 Household equity share vs 1990-present",
};

function RegimeBadge({ regime, conflict }: { regime: string; conflict: boolean }) {
  const colors: Record<string, string> = {
    STRONG_RISK_ON:  "#00e676",
    MILD_RISK_ON:    "#76ff03",
    NEUTRAL:         "#9e9e9e",
    MILD_RISK_OFF:   "#ff9800",
    STRONG_RISK_OFF: "#ff1744",
  };
  const color = colors[regime] ?? "#9e9e9e";
  return (
    <span
      className="text-xs font-bold font-mono px-3 py-1 border"
      style={{ color, borderColor: color, backgroundColor: `${color}15` }}
    >
      {conflict ? "⚠ CONFLICT" : regime.replace(/_/g, " ")}
    </span>
  );
}

function ScoreBar({ score, max = 3 }: { score: number; max?: number }) {
  const pct = ((score + max) / (max * 2)) * 100;
  const isPositive = score > 0;
  const isNegative = score < 0;
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-xs font-mono w-6 text-right"
        style={{ color: isPositive ? "#00e676" : isNegative ? "#ff1744" : "#9e9e9e" }}
      >
        {score > 0 ? "+" : ""}{score}
      </span>
      <div className="flex-1 h-2 rounded-sm" style={{ backgroundColor: "#1a1a1a" }}>
        <div
          className="h-full rounded-sm transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: isPositive ? "#00e676" : isNegative ? "#ff1744" : "#424242",
            marginLeft: `${50}%`,
          }}
        />
      </div>
    </div>
  );
}

function LayerRow({ id, detail }: { id: string; detail: LayerDetail }) {
  const score = detail.score ?? 0;
  const z = detail.z_score ?? 0;
  const ScoreIcon = score > 0 ? TrendingUp : score < 0 ? TrendingDown : Minus;
  const scoreColor = score > 0 ? "#00e676" : score < 0 ? "#ff1744" : "#9e9e9e";

  const detailLines: string[] = [];
  if (id === "A") {
    detailLines.push(`Equity 20d: ${((detail.r_equity_20d ?? 0) * 100).toFixed(2)}%`);
    detailLines.push(`Bond 20d: ${((detail.r_bond_20d ?? 0) * 100).toFixed(2)}%`);
    detailLines.push(`Rel return: ${((detail.r_rel_20d ?? 0) * 100).toFixed(2)}%`);
    if (detail.realized_vol != null) detailLines.push(`Realized vol: ${(detail.realized_vol * 100).toFixed(1)}%`);
  } else if (id === "B") {
    detailLines.push(`Flow ratio: ${(detail.flow_ratio ?? 0).toFixed(4)}`);
    detailLines.push(`Equity flow: $${((detail.equity_flow_20d ?? 0) / 1e9).toFixed(2)}B`);
    detailLines.push(`Bond flow: $${((detail.bond_flow_20d ?? 0) / 1e9).toFixed(2)}B`);
    detailLines.push(`Method: ${detail.method ?? "price_adjusted_aum"}`);
  } else if (id === "C") {
    detailLines.push(`Equity share: ${((detail.equity_share ?? 0) * 100).toFixed(1)}%`);
    detailLines.push(`Mean: ${((detail.mu_C ?? 0) * 100).toFixed(1)}%  σ: ${((detail.sigma_C ?? 0) * 100).toFixed(1)}%`);
  }

  return (
    <div
      className="p-3 border"
      style={{ backgroundColor: "#050505", borderColor: "#1a1a1a" }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold font-mono tracking-wider" style={{ color: "#ff9900" }}>
            LAYER {id}
          </span>
          <ScoreIcon className="h-3 w-3" style={{ color: scoreColor }} />
          <span className="text-xs font-mono" style={{ color: scoreColor }}>
            {score > 0 ? "+" : ""}{score}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono" style={{ color: "#757575" }}>
            z={z > 0 ? "+" : ""}{z.toFixed(3)}
          </span>
          <span className="text-[10px] font-mono" style={{ color: "#424242" }}>
            {detail.freshness}
          </span>
        </div>
      </div>
      <p className="text-[10px] font-mono mb-2" style={{ color: "#616161", lineHeight: "1.6" }}>
        {layerLabels[id]}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {detailLines.map((line, i) => (
          <span key={i} className="text-[10px] font-mono" style={{ color: "#757575" }}>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AllocationTab({
  data,
  isLoading,
  error,
  colors,
}: {
  data?: AllocationSignal;
  isLoading: boolean;
  error: unknown;
  colors: { accent: string; text: string; textSecondary: string; border: string; surface: string; background: string };
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16" style={{ color: colors.textSecondary }}>
        <span className="text-sm font-mono">Loading allocation signal...</span>
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

  const regimeLabel = data.regime.replace(/_/g, " ");
  const wScore = data.weighted_score;

  return (
    <div className="space-y-4" style={{ color: colors.text }}>
      {/* Header — Confluence Score */}
      <div
        className="p-4 border"
        style={{ borderColor: colors.border, backgroundColor: colors.surface }}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold font-mono tracking-widest" style={{ color: colors.accent }}>
            EQUITY ALLOCATION CONFLUENCE SIGNAL
          </h3>
          <RegimeBadge regime={data.regime} conflict={data.conflict} />
        </div>

        <div className="grid grid-cols-3 gap-4 mb-3">
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: colors.textSecondary }}>
              EQUAL SCORE
            </div>
            <div className="text-lg font-bold font-mono" style={{
              color: data.equal_score > 0 ? "#00e676" : data.equal_score < 0 ? "#ff1744" : "#9e9e9e",
            }}>
              {data.equal_score > 0 ? "+" : ""}{data.equal_score} <span className="text-[10px]" style={{ color: colors.textSecondary }}>/ +3</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: colors.textSecondary }}>
              WEIGHTED (0.25A+0.35B+0.40C)
            </div>
            <div className="text-lg font-bold font-mono" style={{
              color: wScore > 0 ? "#00e676" : wScore < 0 ? "#ff1744" : "#9e9e9e",
            }}>
              {wScore > 0 ? "+" : ""}{wScore.toFixed(2)} <span className="text-[10px]" style={{ color: colors.textSecondary }}>/ ±1.00</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: colors.textSecondary }}>
              REGIME
            </div>
            <div className="text-sm font-bold font-mono" style={{
              color: wScore > 0.33 ? "#00e676" : wScore < -0.33 ? "#ff1744" : "#9e9e9e",
            }}>
              {regimeLabel}
            </div>
          </div>
        </div>

        {/* Recommendation */}
        <div
          className="p-2 border text-xs font-mono"
          style={{
            borderColor: data.conflict ? "#ff9800" : colors.border,
            backgroundColor: data.conflict ? "rgba(255,152,0,0.1)" : "rgba(0,0,0,0.3)",
            color: data.conflict ? "#ff9800" : colors.textSecondary,
          }}
        >
          {data.conflict && <AlertTriangle className="h-3 w-3 inline mr-1" style={{ color: "#ff9800" }} />}
          {data.recommendation}
        </div>
      </div>

      {/* Layer Details */}
      <div className="space-y-2">
        {(["A", "B", "C"] as const).map((id) => (
          <LayerRow key={id} id={id} detail={data.layers[id]} />
        ))}
      </div>

      {/* Disclaimer */}
      <p className="text-[9px] font-mono" style={{ color: "#424242", lineHeight: "1.6" }}>
        This is a quantitative allocation signal based on multi-factor confluence analysis.
        It is not investment advice. All scores are derived from publicly available data (FRED, Yahoo Finance).
        Past signals do not guarantee future outcomes. Always consider your personal risk tolerance and constraints.
      </p>
    </div>
  );
}
