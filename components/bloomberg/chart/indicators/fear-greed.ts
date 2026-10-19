/**
 * Fear & Greed Index — pane indicator.
 *
 * Displays the CNN-style Fear & Greed composite (0–100) as a colored
 * histogram + smoothed line, with zone reference lines at 25/45/55/75.
 *
 * Data is NOT computed from OHLCV — it is pre-fetched from
 * /api/fear-greed/history and injected into config.preloadedData by
 * the parent component (stock-view / market-view) via updateIndicatorConfig().
 */

import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory, SeriesColumns } from "../types";

// ── Zone colors ───────────────────────────────────────────────────────────────

const ZONE_PALETTE = [
  "#CC2200", // extreme fear — red
  "#CC6600", // fear         — orange
  "#999900", // neutral      — olive
  "#00AA44", // greed        — green
  "#007733", // extreme greed — dark green
] as const;

/** Index into `ZONE_PALETTE`. */
function zone(value: number): number {
  if (value < 25) return 0;
  if (value < 45) return 1;
  if (value < 55) return 2;
  if (value < 75) return 3;
  return 4;
}

export function fearGreedZoneColor(value: number): string {
  return ZONE_PALETTE[zone(value)];
}

export function fearGreedZoneName(value: number): string {
  if (value < 25) return "EXTREME FEAR";
  if (value < 45) return "FEAR";
  if (value < 55) return "NEUTRAL";
  if (value < 75) return "GREED";
  return "EXTREME GREED";
}

// ── Factory ───────────────────────────────────────────────────────────────────

export const createFearGreed: IndicatorFactory = (_overrides = {}) => {
  const indicator: ChartIndicator = {
    id: "fear-greed",
    name: "Fear & Greed",
    category: "custom",
    type: "pane",
    description: "Fear & Greed Index (VIX + momentum + safe-haven + junk bonds + breadth)",
    minBars: 1,
    params: [],
    config: { preloadedData: [] },

    ...columnar((bars, config) => {
      const rawData = config.preloadedData as Array<{ time: string; value: number }> | undefined;
      if (!rawData || rawData.length === 0) return [];

      // Build date → value lookup
      const lookup = new Map<string, number>();
      for (const d of rawData) lookup.set(d.time, d.value);

      const n = bars.length;
      const { times } = bars;
      const values = new Float64Array(n).fill(Number.NaN);
      const has = new Uint8Array(n);
      const zones = new Uint8Array(n);
      let found = 0;

      for (let i = 0; i < n; i++) {
        // Normalise bar time to YYYY-MM-DD for lookup
        const time = times[i];
        const dateStr =
          typeof time === "number"
            ? new Date(time * 1000).toISOString().slice(0, 10)
            : time.slice(0, 10);

        const val = lookup.get(dateStr);
        if (val == null) continue;

        values[i] = val;
        has[i] = 1;
        zones[i] = zone(val);
        found++;
      }

      if (found === 0) return [];

      const scaleId = "fear-greed";

      // Horizontal reference lines at zone boundaries
      const refLine = (id: string, v: number, color: string): SeriesColumns => {
        const level = new Float64Array(n).fill(Number.NaN);
        for (let i = 0; i < n; i++) if (has[i] === 1) level[i] = v;
        return {
          id,
          label: String(v),
          type: "line",
          color,
          lineWidth: 1,
          values: level,
          from: 0,
          emit: has,
          priceScaleId: scaleId,
        };
      };

      return [
        // Colored histogram bars
        {
          id: "fg-histogram",
          label: "F&G",
          type: "histogram",
          values,
          from: 0,
          emit: has,
          colors: zones,
          palette: ZONE_PALETTE,
          priceScaleId: scaleId,
        },
        // Smoothed line overlay
        {
          id: "fg-line",
          label: "F&G Line",
          type: "line",
          color: "rgba(255,255,255,0.6)",
          lineWidth: 1,
          values,
          from: 0,
          emit: has,
          priceScaleId: scaleId,
        },
        // Zone boundary lines
        refLine("fg-ref-25", 25, "#CC2200"),
        refLine("fg-ref-45", 45, "#CC6600"),
        refLine("fg-ref-50", 50, "#555555"),
        refLine("fg-ref-55", 55, "#00AA44"),
        refLine("fg-ref-75", 75, "#007733"),
      ];
    }),
  };

  return indicator;
};
