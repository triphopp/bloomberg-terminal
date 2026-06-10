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

import type {
  ChartIndicator,
  IndicatorFactory,
  OhlcvBar,
  IndicatorSeriesOutput,
  HistogramDataPoint,
  SeriesDataPoint,
} from "../types";

// ── Zone colors ───────────────────────────────────────────────────────────────

export function fearGreedZoneColor(value: number): string {
  if (value < 25) return "#CC2200";   // extreme fear — red
  if (value < 45) return "#CC6600";   // fear         — orange
  if (value < 55) return "#999900";   // neutral      — olive
  if (value < 75) return "#00AA44";   // greed        — green
  return "#007733";                   // extreme greed — dark green
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
    id:          "fear-greed",
    name:        "Fear & Greed",
    category:    "custom",
    type:        "pane",
    description: "Fear & Greed Index (VIX + momentum + safe-haven + junk bonds + breadth)",
    minBars:     1,
    params:      [],
    config:      { preloadedData: [] },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const rawData = config.preloadedData as Array<{ time: string; value: number }> | undefined;
      if (!rawData || rawData.length === 0) return [];

      // Build date → value lookup
      const lookup = new Map<string, number>();
      for (const d of rawData) lookup.set(d.time, d.value);

      const fgHist:  HistogramDataPoint[] = [];
      const fgLine:  SeriesDataPoint[]    = [];

      for (const bar of data) {
        // Normalise bar time to YYYY-MM-DD for lookup
        let dateStr: string;
        if (typeof bar.time === "number") {
          dateStr = new Date(bar.time * 1000).toISOString().slice(0, 10);
        } else {
          dateStr = (bar.time as string).slice(0, 10);
        }

        const val = lookup.get(dateStr);
        if (val == null) continue;

        fgHist.push({ time: bar.time, value: val, color: fearGreedZoneColor(val) });
        fgLine.push({ time: bar.time, value: val });
      }

      if (fgLine.length === 0) return [];

      const scaleId = "fear-greed";
      const times   = fgLine.map(d => d.time);

      // Horizontal reference lines at zone boundaries
      const refLine = (id: string, v: number, color: string): IndicatorSeriesOutput => ({
        id,
        label:        String(v),
        type:         "line",
        color,
        lineWidth:    1,
        data:         times.map(t => ({ time: t, value: v })),
        priceScaleId: scaleId,
      });

      return [
        // Colored histogram bars
        {
          id:           "fg-histogram",
          label:        "F&G",
          type:         "histogram",
          data:         fgHist,
          priceScaleId: scaleId,
        },
        // Smoothed line overlay
        {
          id:           "fg-line",
          label:        "F&G Line",
          type:         "line",
          color:        "rgba(255,255,255,0.6)",
          lineWidth:    1,
          data:         fgLine,
          priceScaleId: scaleId,
        },
        // Zone boundary lines
        refLine("fg-ref-25", 25, "#CC2200"),
        refLine("fg-ref-45", 45, "#CC6600"),
        refLine("fg-ref-50", 50, "#555555"),
        refLine("fg-ref-55", 55, "#00AA44"),
        refLine("fg-ref-75", 75, "#007733"),
      ];
    },
  };

  return indicator;
};
