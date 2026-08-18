/**
 * Indicator Registry — Central catalog of all available indicators.
 *
 * To add a new indicator:
 * 1. Create a file in this directory (e.g. `atr.ts`)
 * 2. Export a factory function: `export const createATR: IndicatorFactory = ...`
 * 3. Register it in the `INDICATOR_REGISTRY` array below
 *
 * That's it. The indicator will appear in the chart's indicator picker UI.
 */

export { createEMA, calcEMA } from "./ema";
export { createSMA, calcSMA } from "./sma";
export { createMACD } from "./macd";
export { createRSI } from "./rsi";
export { createBollingerBands } from "./bollinger";
export { createBollingerB } from "./bollinger-b";
export { createBollingerWidth } from "./bollinger-width";
export { createVWAP } from "./vwap";
export { createVolume } from "./volume";
export { createRVOL } from "./rvol";
export { createRealizedVol } from "./realized-vol";
export { createRVRank } from "./rv-rank";
export { createRVRatio } from "./rv-ratio";
export {
  createSdHeatmap,
  cheapnessColor,
  occupancyColor,
  SD_HEATMAP_MODES,
} from "./sd-heatmap";
export type { SdBandRow, SdBandsPayload } from "./sd-heatmap";
export {
  calcRealizedVol,
  inferPeriodsPerYear,
  rollingPercentRank,
  RV_ESTIMATOR_OPTIONS,
  RV_ESTIMATOR_SHORT,
} from "./rv-core";
export type { RvEstimator } from "./rv-core";
export { createFlowToxicity } from "./flow-toxicity";
export { createAbsorption } from "./absorption";
export { createStochastic } from "./stochastic";
export { createFearGreed, fearGreedZoneColor, fearGreedZoneName } from "./fear-greed";
export {
  createVolumeProfileOverlay,
  createSessionVPOverlay,
  createCompositeVPOverlay,
} from "./volume-profile";
export { createFootprintOverlay } from "./order-footprint";
export type { FootprintData, FootprintCandle, FootprintLevel } from "./order-footprint";

import type { IndicatorRegistryEntry } from "../types";
import { createAbsorption } from "./absorption";
import {
  BB_WIDTH_LABELS,
  BOLLINGER_B_LABELS,
  BOLLINGER_LABELS,
  EMA_LABELS,
  MACD_LABELS,
  RSI_LABELS,
  RVOL_LABELS,
  SMA_LABELS,
  STOCHASTIC_LABELS,
} from "./alertLabels";
import { createBollingerBands } from "./bollinger";
import { createBollingerB } from "./bollinger-b";
import { createBollingerWidth } from "./bollinger-width";
import { createEMA } from "./ema";
import { createFearGreed } from "./fear-greed";
import { createFlowToxicity } from "./flow-toxicity";
import { createMACD } from "./macd";
import { createRealizedVol } from "./realized-vol";
import { createRSI } from "./rsi";
import { RV_ESTIMATOR_OPTIONS } from "./rv-core";
import { createRVRank } from "./rv-rank";
import { createRVRatio } from "./rv-ratio";
import { createRVOL } from "./rvol";
import { SD_HEATMAP_MODES, createSdHeatmap } from "./sd-heatmap";
import { createSMA } from "./sma";
import { createStochastic } from "./stochastic";
import { createVolume } from "./volume";
import { createVWAP } from "./vwap";

// ── Global Indicator Registry ────────────────────────────────────────────────

export const INDICATOR_REGISTRY: IndicatorRegistryEntry[] = [
  // ─── Trend ───
  {
    id: "ema",
    name: "EMA",
    category: "trend",
    type: "overlay",
    description: "Exponential Moving Average",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 20, min: 2, max: 500, step: 1 },
    ],
    timeScalableParams: ["period"],
    factory: createEMA,
    outputs: [{ key: "value", label: "EMA", unbounded: true }],
    alertLabels: EMA_LABELS,
  },
  {
    id: "sma",
    name: "SMA",
    category: "trend",
    type: "overlay",
    description: "Simple Moving Average",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 20, min: 2, max: 500, step: 1 },
    ],
    timeScalableParams: ["period"],
    factory: createSMA,
    outputs: [{ key: "value", label: "SMA", unbounded: true }],
    alertLabels: SMA_LABELS,
  },

  // ─── Momentum ───
  {
    id: "macd",
    name: "MACD",
    category: "momentum",
    type: "pane",
    description: "Moving Average Convergence Divergence",
    defaultParams: [
      { key: "fast", label: "Fast", type: "number", default: 12, min: 2, max: 100, step: 1 },
      { key: "slow", label: "Slow", type: "number", default: 26, min: 2, max: 200, step: 1 },
      { key: "signal", label: "Signal", type: "number", default: 9, min: 2, max: 50, step: 1 },
    ],
    timeScalableParams: ["fast", "slow", "signal"],
    factory: createMACD,
    // Only "hist" is wired up in backend/alerts/operands.py's phase-2 subset —
    // line/signal join `outputs` once the backend resolver supports them too.
    outputs: [{ key: "hist", label: "Histogram", unbounded: true }],
    alertLabels: MACD_LABELS,
  },
  {
    id: "rsi",
    name: "RSI",
    category: "momentum",
    type: "pane",
    description: "Relative Strength Index",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 14, min: 2, max: 100, step: 1 },
    ],
    timeScalableParams: ["period"],
    factory: createRSI,
    outputs: [{ key: "rsi", label: "RSI", range: [0, 100] }],
    alertLabels: RSI_LABELS,
  },
  {
    id: "stochastic",
    name: "Stochastic",
    category: "momentum",
    type: "pane",
    description: "Stochastic Oscillator (%K / %D)",
    defaultParams: [
      { key: "kPeriod", label: "%K", type: "number", default: 14, min: 2, max: 100, step: 1 },
      { key: "dPeriod", label: "%D", type: "number", default: 3, min: 2, max: 50, step: 1 },
    ],
    timeScalableParams: ["kPeriod", "dPeriod"],
    factory: createStochastic,
    outputs: [
      { key: "k", label: "%K", range: [0, 100] },
      { key: "d", label: "%D", range: [0, 100] },
    ],
    alertLabels: STOCHASTIC_LABELS,
  },

  // ─── Volatility ───
  {
    id: "bollinger",
    name: "Bollinger Bands",
    category: "volatility",
    type: "overlay",
    description: "SMA ± N standard deviations",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 20, min: 5, max: 200, step: 1 },
      { key: "stdDev", label: "Std Dev", type: "number", default: 2, min: 0.5, max: 4, step: 0.5 },
    ],
    timeScalableParams: ["period"],
    factory: createBollingerBands,
    outputs: [
      { key: "upper", label: "Upper Band", unbounded: true },
      { key: "middle", label: "Middle Band", unbounded: true },
      { key: "lower", label: "Lower Band", unbounded: true },
    ],
    alertLabels: BOLLINGER_LABELS,
  },
  {
    id: "bollinger-b",
    name: "Bollinger %B",
    category: "volatility",
    type: "pane",
    description: "Price position within Bollinger Bands (0=lower, 0.5=mid, 1=upper)",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 20, min: 5, max: 200, step: 1 },
      { key: "stdDev", label: "Std Dev", type: "number", default: 2, min: 0.5, max: 4, step: 0.5 },
    ],
    timeScalableParams: ["period"],
    factory: createBollingerB,
    outputs: [{ key: "b", label: "%B", range: [0, 1] }],
    alertLabels: BOLLINGER_B_LABELS,
  },
  {
    id: "bb-width",
    name: "BB Width",
    category: "volatility",
    type: "pane",
    description: "Bollinger BandWidth (Upper−Lower)/Middle — orange = squeeze at N-bar low",
    defaultParams: [
      { key: "period", label: "Period", type: "number", default: 20, min: 5, max: 200, step: 1 },
      { key: "stdDev", label: "Std Dev", type: "number", default: 2, min: 0.5, max: 4, step: 0.5 },
      {
        key: "lookback",
        label: "Squeeze lookback",
        type: "number",
        default: 125,
        min: 20,
        max: 250,
        step: 5,
      },
    ],
    timeScalableParams: ["period", "lookback"],
    factory: createBollingerWidth,
    outputs: [{ key: "width", label: "BB Width", unbounded: true }],
    alertLabels: BB_WIDTH_LABELS,
  },
  {
    id: "realized-vol",
    name: "Realized Vol",
    category: "volatility",
    type: "pane",
    description: "Annualised realized vol at 3 windows (5/21/63) — 5 estimators, 0 hides a line",
    defaultParams: [
      { key: "fast", label: "Fast", type: "number", default: 5, min: 0, max: 250, step: 1 },
      { key: "slow", label: "Slow", type: "number", default: 21, min: 0, max: 250, step: 1 },
      { key: "long", label: "Long", type: "number", default: 63, min: 0, max: 500, step: 1 },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: "yz",
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    timeScalableParams: ["fast", "slow", "long"],
    factory: createRealizedVol,
    // No `outputs`/`alertLabels` yet: alert operands must also resolve in
    // backend/alerts/operands.py, which has no RV branch — advertising them
    // here would offer rules the scanner cannot evaluate.
  },
  {
    id: "rv-rank",
    name: "RV Rank",
    category: "volatility",
    type: "pane",
    description: "Percentile of RV within its trailing lookback — cyan ≤20 compressed, red ≥95",
    defaultParams: [
      { key: "period", label: "RV window", type: "number", default: 21, min: 2, max: 250, step: 1 },
      {
        key: "lookback",
        label: "Rank lookback",
        type: "number",
        default: 252,
        min: 30,
        max: 1250,
        step: 10,
      },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: "yz",
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    timeScalableParams: ["period", "lookback"],
    factory: createRVRank,
  },
  {
    id: "rv-ratio",
    name: "RV Ratio",
    category: "volatility",
    type: "pane",
    description: "RV(fast)/RV(slow) realized term structure — <1 compressed, >1 expanding",
    defaultParams: [
      { key: "fast", label: "Fast", type: "number", default: 5, min: 2, max: 250, step: 1 },
      { key: "slow", label: "Slow", type: "number", default: 21, min: 2, max: 500, step: 1 },
      {
        key: "expansion",
        label: "Expansion ≥",
        type: "number",
        default: 1.3,
        min: 1,
        max: 4,
        step: 0.1,
      },
      {
        key: "compression",
        label: "Compression ≤",
        type: "number",
        default: 0.7,
        min: 0.1,
        max: 1,
        step: 0.05,
      },
      {
        key: "estimator",
        label: "Estimator",
        type: "select",
        default: "yz",
        options: [...RV_ESTIMATOR_OPTIONS],
      },
    ],
    // Thresholds are ratios, not durations — only the two windows rescale.
    timeScalableParams: ["fast", "slow"],
    factory: createRVRatio,
  },
  {
    id: "sd-heatmap",
    name: "IV SD Heatmap",
    category: "volatility",
    type: "pane",
    description:
      "BS σ-bands from ATM IV mid — 5 buckets (−2σ…+2σ) by realized occupancy or IV-vs-RV cheapness",
    defaultParams: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        default: "cheapness",
        options: [...SD_HEATMAP_MODES],
      },
      {
        key: "horizonDays",
        label: "Horizon (cal. days)",
        type: "number",
        default: 30,
        min: 1,
        max: 365,
        step: 1,
      },
      {
        key: "rvWindow",
        label: "RV window",
        type: "number",
        default: 21,
        min: 5,
        max: 252,
        step: 1,
      },
      {
        key: "occWindow",
        label: "Occupancy window",
        type: "number",
        default: 63,
        min: 5,
        max: 500,
        step: 1,
      },
    ],
    // Nothing here is measured in bars: the horizon is CALENDAR days (it has to
    // be, to match `T = D/365` in the pricing), and the two windows are counted
    // in daily IV snapshots regardless of the interval on screen.
    factory: createSdHeatmap,
    // Five stacked rows whose entire purpose is the numbers in them. At 190px a
    // row is 38px, which carries 14px type comfortably; the 80px default gave
    // 16px rows, and the 44px floor 9px — smaller than the text itself.
    preferredPaneHeight: 190,
  },

  // ─── Volume ───
  {
    id: "volume",
    name: "Volume",
    category: "volume",
    type: "pane",
    description: "Volume histogram by candle direction",
    defaultParams: [],
    factory: createVolume,
  },
  {
    id: "vwap",
    name: "VWAP",
    category: "volume",
    type: "overlay",
    description: "Session VWAP with ±1σ/±2σ volume-weighted bands",
    defaultParams: [{ key: "bands", label: "SD Bands", type: "boolean", default: true }],
    factory: createVWAP,
  },
  {
    id: "rvol",
    name: "RVOL",
    category: "volume",
    type: "pane",
    description: "Relative Volume vs same time-of-day baseline (≥2 = abnormal)",
    defaultParams: [
      { key: "lookback", label: "Lookback", type: "number", default: 20, min: 5, max: 60, step: 1 },
    ],
    // No timeScalableParams: RVOL's lookback already counts SESSIONS, not bars
    // (intraday it averages the same time-of-day across prior days), so it is
    // interval-invariant as written and must not be rescaled.
    factory: createRVOL,
    outputs: [{ key: "rvol", label: "RVOL", unbounded: true }],
    alertLabels: RVOL_LABELS,
  },
  {
    id: "flow-toxicity",
    name: "Flow Toxicity",
    category: "volume",
    type: "pane",
    description:
      "Order-flow one-sidedness from bar shape: net flow (bars) vs total toxicity (line)",
    defaultParams: [
      { key: "window", label: "Window", type: "number", default: 50, min: 10, max: 200, step: 5 },
      {
        key: "hotThreshold",
        label: "Hot threshold",
        type: "number",
        default: 0.15,
        min: 0.05,
        max: 0.6,
        step: 0.05,
      },
    ],
    timeScalableParams: ["window"],
    factory: createFlowToxicity,
  },
  {
    id: "absorption",
    name: "Absorption",
    category: "volume",
    type: "pane",
    description: "Effort-vs-result churn: high volume + no progress = absorption",
    defaultParams: [
      {
        key: "window",
        label: "Baseline window",
        type: "number",
        default: 20,
        min: 10,
        max: 100,
        step: 5,
      },
    ],
    timeScalableParams: ["window"],
    factory: createAbsorption,
  },

  // ─── Custom / Sentiment ───
  {
    id: "fear-greed",
    name: "Fear & Greed",
    category: "custom",
    type: "pane",
    description: "Fear & Greed Index (VIX + momentum + safe-haven + junk bonds + breadth)",
    defaultParams: [],
    factory: createFearGreed,
  },
];

/** Lookup helper */
export function getIndicatorEntry(id: string): IndicatorRegistryEntry | undefined {
  return INDICATOR_REGISTRY.find((e) => e.id === id);
}
