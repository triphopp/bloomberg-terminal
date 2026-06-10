/**
 * VWAP (Volume Weighted Average Price) Indicator
 *
 * Overlay indicator. Cumulative VWAP from session start.
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";

function calcVWAP(data: OhlcvBar[]): (number | null)[] {
  let cumulativeTPV = 0; // cumulative (typical price × volume)
  let cumulativeVol = 0;
  const result: (number | null)[] = [];

  for (const bar of data) {
    const vol = bar.volume ?? 0;
    if (vol <= 0) {
      result.push(cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : null);
      continue;
    }
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeTPV += typicalPrice * vol;
    cumulativeVol += vol;
    result.push(cumulativeTPV / cumulativeVol);
  }

  return result;
}

export const createVWAP: IndicatorFactory = (overrides = {}) => {
  const color = (overrides.color as string) ?? "#ff6f00";

  const indicator: ChartIndicator = {
    id: "vwap",
    name: "VWAP",
    category: "volume",
    type: "overlay",
    description: "Volume Weighted Average Price (session cumulative)",
    minBars: 1,
    params: [
      { key: "color", label: "Color", type: "select", default: color, options: [
        { value: "#ff6f00", label: "Amber" },
        { value: "#2196f3", label: "Blue" },
        { value: "#4caf50", label: "Green" },
        { value: "#e91e63", label: "Pink" },
      ]},
    ],
    config: { color },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const c = config.color as string;
      const vwapValues = calcVWAP(data);

      return [{
        id: "vwap-line",
        label: "VWAP",
        type: "line",
        color: c,
        lineWidth: 2,
        data: data
          .map((d, i) => ({ time: d.time, value: vwapValues[i]! }))
          .filter(d => d.value != null),
      }];
    },
  };

  return indicator;
};
