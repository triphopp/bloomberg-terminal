/**
 * Flow Toxicity (VPIN-style order-flow imbalance) — Pane indicator
 *
 * Estimates how one-sided recent flow is: the probability-flavored signal that
 * informed traders are active (Easley / López de Prado / O'Hara's VPIN idea,
 * adapted to bar data without a tick feed).
 *
 * Per-bar buy/sell split uses close-position weighting (bulk volume
 * classification): buyFrac = (close − low) / (high − low). This is the same
 * classifier as the Volume Profile delta mode, so the two read consistently.
 *
 * Toxicity over a rolling window of W bars:
 *   toxicity = |Σbuy − Σsell| / Σvolume   ∈ [0, 1]
 *
 * High values mean flow is persistently one-sided — do not fade it, and expect
 * volatility. Low values mean balanced two-way trade. Note this is an
 * ESTIMATE from bar shape, not true aggressor-side data.
 */

import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "../types";

function calcToxicity(data: OhlcvBar[], window: number): { tox: number | null; signed: number }[] {
  const buy: number[] = new Array(data.length).fill(0);
  const vol: number[] = new Array(data.length).fill(0);

  let prevClose: number | null = null;
  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const v = bar.volume ?? 0;
    const range = bar.high - bar.low;
    let buyFrac: number;
    if (range > 0) buyFrac = (bar.close - bar.low) / range;
    else if (prevClose !== null && bar.close !== prevClose) buyFrac = bar.close > prevClose ? 1 : 0;
    else buyFrac = 0.5;
    prevClose = bar.close;

    vol[i] = v;
    buy[i] = v * buyFrac;
  }

  const result: { tox: number | null; signed: number }[] = [];
  let sumVol = 0;
  let sumBuy = 0;
  for (let i = 0; i < data.length; i++) {
    sumVol += vol[i];
    sumBuy += buy[i];
    if (i >= window) {
      sumVol -= vol[i - window];
      sumBuy -= buy[i - window];
    }
    if (i >= window - 1 && sumVol > 0) {
      const imbalance = (2 * sumBuy - sumVol) / sumVol; // ∈ [-1, 1], sign = direction
      result.push({ tox: Math.abs(imbalance), signed: imbalance });
    } else {
      result.push({ tox: null, signed: 0 });
    }
  }
  return result;
}

export const createFlowToxicity: IndicatorFactory = (overrides = {}) => {
  const window = (overrides.window as number) ?? 50;

  const indicator: ChartIndicator = {
    id: `flow-toxicity-${window}`,
    name: `Flow Toxicity ${window}`,
    category: "volume",
    type: "pane",
    description: "VPIN-style rolling order-flow imbalance estimate (0 = balanced, 1 = one-sided)",
    minBars: window,
    params: [
      {
        key: "window",
        label: "Window",
        type: "number",
        default: window,
        min: 10,
        max: 200,
        step: 5,
      },
    ],
    config: { window },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const w = config.window as number;
      const values = calcToxicity(data, w);

      // Histogram colored by flow direction; height = |imbalance|.
      const points: HistogramDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = values[i];
        if (v.tox == null) continue;
        const hot = v.tox >= 0.4;
        const color =
          v.signed >= 0
            ? hot
              ? "#26a69a"
              : "rgba(38,166,154,0.35)"
            : hot
              ? "#ef5350"
              : "rgba(239,83,80,0.35)";
        points.push({ time: data[i].time, value: v.tox, color });
      }

      return [
        {
          id: "toxicity-hist",
          label: "Toxicity",
          type: "histogram",
          data: points,
        },
      ];
    },
  };

  return indicator;
};
