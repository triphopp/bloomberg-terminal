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

import type { BarColumns } from "../columns.ts";
import { columnar } from "../series-columns.ts";
import type { ChartIndicator, IndicatorFactory } from "../types";

interface ToxicityColumns {
  /** Σ(|flow|·vol)/Σvol — total one-sidedness, VPIN-style. */
  toxicity: Float64Array;
  /** Σ(flow·vol)/Σvol — net directional pressure (Chaikin Money Flow). */
  netFlow: Float64Array;
  /** 1 once the window is full and has traded any weight; nothing is drawn before. */
  ready: Uint8Array;
}

function calcToxicity(bars: BarColumns, window: number): ToxicityColumns {
  const n = bars.length;
  const { high, low, close, volume } = bars;
  // Volume weights the average. If the feed carries no volume at all (some
  // index/FX sources), fall back to equal weighting so the pane still shows
  // the price-shape reading instead of rendering silently blank. Bars that are
  // individually zero-volume inside a volumed feed correctly contribute nothing.
  let hasVolume = false;
  for (let i = 0; i < n; i++) {
    if (volume[i] > 0) {
      hasVolume = true;
      break;
    }
  }

  const wFlow = new Float64Array(n);
  const wAbsFlow = new Float64Array(n);
  const weight = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const w = hasVolume ? volume[i] : 1;

    // Anchor the range on the previous close so gaps are priced in.
    const hi = i > 0 ? Math.max(high[i], close[i - 1]) : high[i];
    const lo = i > 0 ? Math.min(low[i], close[i - 1]) : low[i];
    const range = hi - lo;
    // range === 0 means the bar and the previous close are a single price:
    // genuinely no information, so treat it as balanced rather than guessing.
    const flow = range > 0 ? (2 * (close[i] - lo)) / range - 1 : 0;

    weight[i] = w;
    wFlow[i] = w * flow;
    wAbsFlow[i] = w * Math.abs(flow);
  }

  const toxicity = new Float64Array(n).fill(Number.NaN);
  const netFlow = new Float64Array(n);
  const ready = new Uint8Array(n);
  let sumW = 0;
  let sumFlow = 0;
  let sumAbsFlow = 0;
  for (let i = 0; i < n; i++) {
    sumW += weight[i];
    sumFlow += wFlow[i];
    sumAbsFlow += wAbsFlow[i];
    if (i >= window) {
      sumW -= weight[i - window];
      sumFlow -= wFlow[i - window];
      sumAbsFlow -= wAbsFlow[i - window];
    }
    if (i >= window - 1 && sumW > 0) {
      toxicity[i] = sumAbsFlow / sumW;
      netFlow[i] = sumFlow / sumW;
      ready[i] = 1;
    }
  }
  return { toxicity, netFlow, ready };
}

/** Net-flow bar colours by index: buy · buy hot · sell · sell hot. */
const NET_PALETTE = [
  "rgba(38,166,154,0.35)",
  "#26a69a",
  "rgba(239,83,80,0.35)",
  "#ef5350",
] as const;

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

    ...columnar((bars, config) => {
      const w = config.window as number;
      const hotAt = (config.hotThreshold as number) ?? 0.15;
      const { toxicity, netFlow, ready } = calcToxicity(bars, w);
      const n = bars.length;

      // Bars: |netFlow|, coloured by direction. Line: toxicity (always ≥ bars).
      const magnitude = new Float64Array(n).fill(Number.NaN);
      const colors = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (ready[i] === 0) continue;
        const net = netFlow[i];
        const m = Math.abs(net);
        magnitude[i] = m;
        colors[i] = (net >= 0 ? 0 : 2) + (m >= hotAt ? 1 : 0);
      }

      return [
        {
          id: "toxicity-net",
          label: "Net Flow",
          type: "histogram",
          values: magnitude,
          from: 0,
          emit: ready,
          colors,
          palette: NET_PALETTE,
          priceScaleId: "toxicity",
        },
        {
          id: "toxicity-total",
          label: "Toxicity",
          type: "line",
          color: "#ab47bc",
          lineWidth: 1,
          values: toxicity,
          from: 0,
          emit: ready,
          priceScaleId: "toxicity",
        },
      ];
    }),
    // Not `causal`: whether the feed has volume at all is asked of every bar —
    // the first bar to carry some re-weights the whole series.
  };

  return indicator;
};
