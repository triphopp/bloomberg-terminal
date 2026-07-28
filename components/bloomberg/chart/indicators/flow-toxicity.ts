/**
 * Flow Toxicity — Pane indicator
 *
 * Two related readings of how one-sided recent order flow is. Both are
 * ESTIMATES derived from bar shape, not true aggressor-side (tick) data.
 *
 * ── Per-bar classifier ──────────────────────────────────────────────────────
 * Each bar is split into buy/sell volume by where it closed inside its range,
 * anchored on the previous close so overnight gaps are not ignored:
 *
 *   hi = max(high, prevClose),  lo = min(low, prevClose)
 *   buyFrac = (close − lo) / (hi − lo)        ∈ [0, 1]
 *   flow    = 2·buyFrac − 1                   ∈ [−1, 1]
 *
 * Extending the range to include prevClose is the same idea as True Range.
 * When prevClose already sits inside [low, high] (the normal case) this is
 * identical to plain close-position weighting, so it stays consistent with the
 * Volume Profile delta classifier. It only differs on gap bars — where the
 * plain version is actively wrong: a bar that gaps down 10% but closes at its
 * own high would otherwise be scored as maximum buying.
 *
 * ── The two series, over a rolling window of W bars ─────────────────────────
 *   netFlow  = Σ(flow·vol) / Σvol   ∈ [−1, 1]   directional pressure
 *   toxicity = Σ(|flow|·vol) / Σvol ∈ [ 0, 1]   total one-sidedness
 *
 * netFlow is the net imbalance: buy-heavy and sell-heavy bars cancel out. It
 * is mathematically identical to Chaikin Money Flow.
 *
 * toxicity sums the ABSOLUTE imbalance of each bar before averaging, which is
 * the aggregation VPIN uses (Easley / López de Prado / O'Hara). It does not
 * cancel, so it still reads high when flow is violently two-way — the case
 * netFlow alone reports as "calm". Note real VPIN samples equal-volume buckets
 * rather than time bars; this is the time-bar approximation.
 *
 * By the triangle inequality |netFlow| ≤ toxicity always, so the line always
 * sits at or above the bars. The GAP between them is the informative part:
 *   small gap → the pressure is pulling one way (trend, do not fade)
 *   large gap → heavy churn cancelling itself out (two-way fight, chop)
 *
 * ── Caveat on levels ───────────────────────────────────────────────────────
 * `hotThreshold` only controls colour intensity. Its default has NOT been
 * calibrated against real market data — the repo has no OHLCV fixtures — so
 * treat it as provisional and tune it per instrument/timeframe.
 */

import type {
  ChartIndicator,
  HistogramDataPoint,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
  SeriesDataPoint,
} from "../types";

interface ToxicityPoint {
  /** Σ(|flow|·vol)/Σvol — total one-sidedness, VPIN-style. null until warmed up. */
  toxicity: number | null;
  /** Σ(flow·vol)/Σvol — net directional pressure (Chaikin Money Flow). */
  netFlow: number;
}

function calcToxicity(data: OhlcvBar[], window: number): ToxicityPoint[] {
  // Volume weights the average. If the feed carries no volume at all (some
  // index/FX sources), fall back to equal weighting so the pane still shows
  // the price-shape reading instead of rendering silently blank. Bars that are
  // individually zero-volume inside a volumed feed correctly contribute nothing.
  const hasVolume = data.some((b) => (b.volume ?? 0) > 0);

  const wFlow: number[] = new Array(data.length).fill(0);
  const wAbsFlow: number[] = new Array(data.length).fill(0);
  const weight: number[] = new Array(data.length).fill(0);

  let prevClose: number | null = null;
  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const w = hasVolume ? (bar.volume ?? 0) : 1;

    // Anchor the range on the previous close so gaps are priced in.
    const hi = prevClose !== null ? Math.max(bar.high, prevClose) : bar.high;
    const lo = prevClose !== null ? Math.min(bar.low, prevClose) : bar.low;
    const range = hi - lo;
    // range === 0 means the bar and the previous close are a single price:
    // genuinely no information, so treat it as balanced rather than guessing.
    const flow = range > 0 ? (2 * (bar.close - lo)) / range - 1 : 0;
    prevClose = bar.close;

    weight[i] = w;
    wFlow[i] = w * flow;
    wAbsFlow[i] = w * Math.abs(flow);
  }

  const result: ToxicityPoint[] = [];
  let sumW = 0;
  let sumFlow = 0;
  let sumAbsFlow = 0;
  for (let i = 0; i < data.length; i++) {
    sumW += weight[i];
    sumFlow += wFlow[i];
    sumAbsFlow += wAbsFlow[i];
    if (i >= window) {
      sumW -= weight[i - window];
      sumFlow -= wFlow[i - window];
      sumAbsFlow -= wAbsFlow[i - window];
    }
    if (i >= window - 1 && sumW > 0) {
      result.push({ toxicity: sumAbsFlow / sumW, netFlow: sumFlow / sumW });
    } else {
      result.push({ toxicity: null, netFlow: 0 });
    }
  }
  return result;
}

export const createFlowToxicity: IndicatorFactory = (overrides = {}) => {
  const window = (overrides.window as number) ?? 50;
  const hotThreshold = (overrides.hotThreshold as number) ?? 0.15;

  const indicator: ChartIndicator = {
    id: `flow-toxicity-${window}`,
    name: `Flow Toxicity ${window}`,
    category: "volume",
    type: "pane",
    description:
      "Order-flow one-sidedness from bar shape: net flow (bars) vs total toxicity (line)",
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
      {
        key: "hotThreshold",
        label: "Hot threshold",
        type: "number",
        default: hotThreshold,
        min: 0.05,
        max: 0.6,
        step: 0.05,
      },
    ],
    config: { window, hotThreshold },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const w = config.window as number;
      const hotAt = (config.hotThreshold as number) ?? 0.15;
      const values = calcToxicity(data, w);

      // Bars: |netFlow|, coloured by direction. Line: toxicity (always ≥ bars).
      const netPoints: HistogramDataPoint[] = [];
      const toxPoints: SeriesDataPoint[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = values[i];
        if (v.toxicity == null) continue;
        const magnitude = Math.abs(v.netFlow);
        const hot = magnitude >= hotAt;
        const color =
          v.netFlow >= 0
            ? hot
              ? "#26a69a"
              : "rgba(38,166,154,0.35)"
            : hot
              ? "#ef5350"
              : "rgba(239,83,80,0.35)";
        netPoints.push({ time: data[i].time, value: magnitude, color });
        toxPoints.push({ time: data[i].time, value: v.toxicity });
      }

      return [
        {
          id: "toxicity-net",
          label: "Net Flow",
          type: "histogram",
          data: netPoints,
          priceScaleId: "toxicity",
        },
        {
          id: "toxicity-total",
          label: "Toxicity",
          type: "line",
          color: "#ab47bc",
          lineWidth: 1,
          data: toxPoints,
          priceScaleId: "toxicity",
        },
      ];
    },
  };

  return indicator;
};
