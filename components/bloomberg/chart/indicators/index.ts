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
export { createVWAP } from "./vwap";
export { createVolume } from "./volume";
export { createStochastic } from "./stochastic";
export { createFearGreed, fearGreedZoneColor, fearGreedZoneName } from "./fear-greed";
export { createVolumeProfileOverlay, createSessionVPOverlay, createCompositeVPOverlay } from "./volume-profile";
export { createFootprintOverlay } from "./order-footprint";
export type { FootprintData, FootprintCandle, FootprintLevel } from "./order-footprint";

import type { IndicatorRegistryEntry } from "../types";
import { createEMA } from "./ema";
import { createSMA } from "./sma";
import { createMACD } from "./macd";
import { createRSI } from "./rsi";
import { createBollingerBands } from "./bollinger";
import { createBollingerB } from "./bollinger-b";
import { createVWAP } from "./vwap";
import { createVolume } from "./volume";
import { createStochastic } from "./stochastic";
import { createFearGreed } from "./fear-greed";

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
    factory: createEMA,
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
    factory: createSMA,
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
    factory: createMACD,
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
    factory: createRSI,
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
    factory: createStochastic,
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
    factory: createBollingerBands,
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
    factory: createBollingerB,
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
    description: "Volume Weighted Average Price",
    defaultParams: [],
    factory: createVWAP,
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
  return INDICATOR_REGISTRY.find(e => e.id === id);
}
