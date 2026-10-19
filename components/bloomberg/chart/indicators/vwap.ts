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

import type { BarColumns } from "../columns.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory, SeriesColumns } from "../types";

const SESSION_GAP_SEC = 4 * 60 * 60;

interface VWAPColumns {
  /** NaN until the session has traded any volume. */
  vwap: Float64Array;
  sd: Float64Array;
}

function calcVWAP(bars: BarColumns): VWAPColumns {
  const n = bars.length;
  const { times, high, low, close, volume } = bars;
  const vwap = new Float64Array(n);
  const sd = new Float64Array(n);
  let cumTPV = 0; // Σ typical price × volume
  let cumTP2V = 0; // Σ typical price² × volume
  let cumVol = 0;
  let prevTime: number | null = null;

  for (let i = 0; i < n; i++) {
    const time = times[i];
    // Session reset on intraday gap (daily string times never reset → anchored VWAP)
    if (typeof time === "number") {
      if (prevTime !== null && time - prevTime > SESSION_GAP_SEC) {
        cumTPV = 0;
        cumTP2V = 0;
        cumVol = 0;
      }
      prevTime = time;
    }

    const vol = volume[i];
    if (vol > 0) {
      const tp = (high[i] + low[i] + close[i]) / 3;
      cumTPV += tp * vol;
      cumTP2V += tp * tp * vol;
      cumVol += vol;
    }

    if (cumVol > 0) {
      const v = cumTPV / cumVol;
      const variance = Math.max(0, cumTP2V / cumVol - v * v);
      vwap[i] = v;
      sd[i] = Math.sqrt(variance);
    } else {
      vwap[i] = Number.NaN;
      sd[i] = Number.NaN;
    }
  }

  return { vwap, sd };
}

/** `vwap + mult·sd` where that is a finite number, NaN (no point) elsewhere. */
function band(points: VWAPColumns, mult: number): Float64Array {
  const { vwap, sd } = points;
  const out = new Float64Array(vwap.length);
  for (let i = 0; i < out.length; i++) {
    const v = mult === 0 ? vwap[i] : vwap[i] + mult * sd[i];
    out[i] = Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
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

    ...columnar((bars, config) => {
      const c = config.color as string;
      const showBands = config.bands as boolean;
      const points = calcVWAP(bars);

      const out: SeriesColumns[] = [
        {
          id: "vwap-line",
          label: "VWAP",
          type: "line",
          color: c,
          lineWidth: 2,
          values: band(points, 0),
          from: 0,
          emit: "valued",
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
            values: band(points, b.mult),
            from: 0,
            emit: "valued",
          });
        }
      }

      return out;
    }),
    // Cumulative from the start of the range (or of the session): a tick moves
    // only the last point.
    causal: true,
  };

  return indicator;
};
