/**
 * Volume Histogram Indicator
 *
 * Pane indicator rendering volume bars colored by candle direction.
 */

import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

export const createVolume: IndicatorFactory = (overrides = {}) => {
  const upColor = (overrides.upColor as string) ?? "#4caf50";
  const downColor = (overrides.downColor as string) ?? "#ef5350";
  const opacity = (overrides.opacity as string) ?? "55";

  const indicator: ChartIndicator = {
    id: "volume",
    name: "Volume",
    category: "volume",
    type: "pane",
    description: "Volume histogram colored by price direction",
    minBars: 1,
    params: [
      {
        key: "opacity",
        label: "Opacity",
        type: "select",
        default: opacity,
        options: [
          { value: "33", label: "Light" },
          { value: "55", label: "Medium" },
          { value: "88", label: "Strong" },
          { value: "ff", label: "Full" },
        ],
      },
    ],
    config: { upColor, downColor, opacity },

    ...columnar((bars, config) => {
      const up = config.upColor as string;
      const down = config.downColor as string;
      const op = config.opacity as string;
      const n = bars.length;
      const { open, close, volume } = bars;

      // A bar with no volume (absent, zero or negative) draws nothing.
      const values = new Float64Array(n);
      const direction = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = volume[i];
        values[i] = v > 0 ? v : Number.NaN;
        direction[i] = close[i] >= open[i] ? 0 : 1;
      }

      return [
        {
          id: "volume-histogram",
          label: "Volume",
          type: "histogram",
          values,
          from: 0,
          emit: "valued",
          colors: direction,
          palette: [`${up}${op}`, `${down}${op}`],
          priceScaleId: "vol",
        },
      ];
    }),
    causal: true,
  };

  return indicator;
};
