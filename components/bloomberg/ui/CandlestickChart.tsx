"use client";

/**
 * CandlestickChart — Backward-compatible wrapper around the modular chart system.
 *
 * This component preserves the old API (showEMA, showVolume, showVolumeProfile props)
 * while delegating to the new ModularChart + indicator plugins under the hood.
 *
 * For new code, prefer importing ModularChart + useChartIndicators directly.
 */

import { useMemo } from "react";
import { ModularChart } from "../chart/ModularChart";
import { createEMA, createVolume, createVolumeProfileOverlay } from "../chart/indicators";
import type { ChartIndicator, CanvasOverlay, ChartColors } from "../chart/types";

// ── Re-export the OhlcvBar type for backward compat ──────────────────────────
export type { OhlcvBar } from "../chart/types";

// ── Props (unchanged from original) ─────────────────────────────────────────

interface Props {
  data: import("../chart/types").OhlcvBar[];
  isDark: boolean;
  colors: {
    background: string;
    surface: string;
    border: string;
    text: string;
    textSecondary: string;
    positive: string;
    negative: string;
  };
  height?: number;
  showEMA?: boolean;
  showVolume?: boolean;
  showVolumeProfile?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function CandlestickChart({
  data,
  isDark,
  colors,
  height = 280,
  showEMA = true,
  showVolume = true,
  showVolumeProfile = false,
}: Props) {
  // Build indicator list from legacy boolean props
  const indicators: ChartIndicator[] = useMemo(() => {
    const list: ChartIndicator[] = [];

    if (showEMA && data.length >= 50) {
      list.push(createEMA({ period: 20, color: "#ffc107" }));
      list.push(createEMA({ period: 50, color: "#2196f3" }));
    }

    if (showVolume && data.some(d => d.volume != null && d.volume! > 0)) {
      list.push(createVolume({ upColor: colors.positive, downColor: colors.negative }));
    }

    return list;
  }, [showEMA, showVolume, data, colors.positive, colors.negative]);

  // Canvas overlays
  const overlays: CanvasOverlay[] = useMemo(() => {
    if (!showVolumeProfile || !data.some(d => (d.volume ?? 0) > 0)) return [];
    return [createVolumeProfileOverlay()];
  }, [showVolumeProfile, data]);

  return (
    <ModularChart
      data={data}
      isDark={isDark}
      colors={colors as ChartColors}
      height={height}
      indicators={indicators}
      overlays={overlays}
    />
  );
}
