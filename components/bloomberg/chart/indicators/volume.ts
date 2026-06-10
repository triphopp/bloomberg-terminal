/**
 * Volume Histogram Indicator
 *
 * Pane indicator rendering volume bars colored by candle direction.
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput, HistogramDataPoint } from "../types";

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
      { key: "opacity", label: "Opacity", type: "select", default: opacity, options: [
        { value: "33", label: "Light" },
        { value: "55", label: "Medium" },
        { value: "88", label: "Strong" },
        { value: "ff", label: "Full" },
      ]},
    ],
    config: { upColor, downColor, opacity },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const up = config.upColor as string;
      const down = config.downColor as string;
      const op = config.opacity as string;

      const points: HistogramDataPoint[] = data
        .filter(d => d.volume != null && d.volume! > 0)
        .map(d => ({
          time: d.time,
          value: d.volume!,
          color: d.close >= d.open ? `${up}${op}` : `${down}${op}`,
        }));

      return [{
        id: "volume-histogram",
        label: "Volume",
        type: "histogram",
        data: points,
        priceScaleId: "vol",
      }];
    },
  };

  return indicator;
};
