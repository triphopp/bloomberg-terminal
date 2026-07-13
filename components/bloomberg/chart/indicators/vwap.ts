/**
 * VWAP (Volume Weighted Average Price) Indicator
 *
 * Overlay indicator with optional ±1σ/±2σ bands (volume-weighted std dev).
 *
 * Session anchoring: intraday bars (UNIX-second times) reset accumulators at
 * each session boundary (time gap > 4h — same rule as Volume Profile), so the
 * line is a true session VWAP. Daily/weekly bars ("YYYY-MM-DD" times) never
 * reset: the line is an anchored VWAP from the start of the loaded range.
 *
 * Bands use the volume-weighted variance of typical price:
 *   σ² = Σ(vol·tp²)/Σvol − VWAP²
 * which is the standard "VWAP bands" construction (≈ ±1σ contains ~68% of
 * traded volume if prices were normal). Institutional execution algos are
 * benchmarked against VWAP, which is what makes these levels behave as
 * genuine support/resistance rather than chart folklore.
 */

import type { ChartIndicator, IndicatorFactory, IndicatorSeriesOutput, OhlcvBar } from "../types";

const SESSION_GAP_SEC = 4 * 60 * 60;

interface VWAPPoint {
  vwap: number | null;
  sd: number | null;
}

function calcVWAP(data: OhlcvBar[]): VWAPPoint[] {
  let cumTPV = 0; // Σ typical price × volume
  let cumTP2V = 0; // Σ typical price² × volume
  let cumVol = 0;
  let prevTime: number | null = null;
  const result: VWAPPoint[] = [];

  for (const bar of data) {
    // Session reset on intraday gap (daily string times never reset → anchored VWAP)
    if (
      typeof bar.time === "number" &&
      prevTime !== null &&
      bar.time - prevTime > SESSION_GAP_SEC
    ) {
      cumTPV = 0;
      cumTP2V = 0;
      cumVol = 0;
    }
    if (typeof bar.time === "number") prevTime = bar.time;

    const vol = bar.volume ?? 0;
    if (vol > 0) {
      const tp = (bar.high + bar.low + bar.close) / 3;
      cumTPV += tp * vol;
      cumTP2V += tp * tp * vol;
      cumVol += vol;
    }

    if (cumVol > 0) {
      const vwap = cumTPV / cumVol;
      const variance = Math.max(0, cumTP2V / cumVol - vwap * vwap);
      result.push({ vwap, sd: Math.sqrt(variance) });
    } else {
      result.push({ vwap: null, sd: null });
    }
  }

  return result;
}

export const createVWAP: IndicatorFactory = (overrides = {}) => {
  const color = (overrides.color as string) ?? "#ff6f00";
  const bands = (overrides.bands as boolean) ?? true;

  const indicator: ChartIndicator = {
    id: "vwap",
    name: "VWAP",
    category: "volume",
    type: "overlay",
    description: "Session VWAP with ±1σ/±2σ volume-weighted bands",
    minBars: 1,
    params: [
      {
        key: "color",
        label: "Color",
        type: "select",
        default: color,
        options: [
          { value: "#ff6f00", label: "Amber" },
          { value: "#2196f3", label: "Blue" },
          { value: "#4caf50", label: "Green" },
          { value: "#e91e63", label: "Pink" },
        ],
      },
      { key: "bands", label: "SD Bands", type: "boolean", default: bands },
    ],
    config: { color, bands },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const c = config.color as string;
      const showBands = config.bands as boolean;
      const points = calcVWAP(data);

      const line = (pick: (p: VWAPPoint) => number | null) =>
        data
          .map((d, i) => ({ time: d.time, value: pick(points[i]) as number }))
          .filter((d) => d.value != null && Number.isFinite(d.value));

      const out: IndicatorSeriesOutput[] = [
        {
          id: "vwap-line",
          label: "VWAP",
          type: "line",
          color: c,
          lineWidth: 2,
          data: line((p) => p.vwap),
        },
      ];

      if (showBands) {
        // Renderer uses the color verbatim, so bake band translucency into the
        // hex (8-digit RGBA): ±1σ at ~45% alpha, ±2σ at ~25%.
        const bandDefs: { id: string; label: string; mult: number; alpha: string }[] = [
          { id: "vwap-u1", label: "VWAP +1σ", mult: 1, alpha: "73" },
          { id: "vwap-l1", label: "VWAP -1σ", mult: -1, alpha: "73" },
          { id: "vwap-u2", label: "VWAP +2σ", mult: 2, alpha: "40" },
          { id: "vwap-l2", label: "VWAP -2σ", mult: -2, alpha: "40" },
        ];
        for (const b of bandDefs) {
          out.push({
            id: b.id,
            label: b.label,
            type: "line",
            color: `${c}${b.alpha}`,
            lineWidth: 1,
            data: line((p) => (p.vwap != null && p.sd != null ? p.vwap + b.mult * p.sd : null)),
          });
        }
      }

      return out;
    },
  };

  return indicator;
};
