/**
 * Chart Module — Public API
 *
 * Usage:
 *   import { ModularChart, IndicatorPicker, INDICATOR_REGISTRY, createEMA, ... } from "../chart";
 */

// Core component
export { ModularChart } from "./ModularChart";
export type { ModularChartProps } from "./ModularChart";

// Indicator picker UI
export { IndicatorPicker } from "./IndicatorPicker";

// Hooks
export { useChartIndicators } from "./useChartIndicators";
export { useChartTimeframe } from "./useChartTimeframe";
export type { ChartTimeframeOptions } from "./useChartTimeframe";
export { TIME_PERIODS, BAR_INTERVALS, PERIOD_LABEL, INTERVAL_LABEL, PERIOD_TO_YF } from "./useChartTimeframe";

// Timeframe bar component
export { ChartTimeframeBar } from "./ChartTimeframeBar";
export type { ChartTimeframeBarProps } from "./ChartTimeframeBar";

// Types
export type {
  OhlcvBar,
  TimePeriod,
  BarInterval,
  ChartColors,
  ChartIndicator,
  ChartEventMarker,
  ChartState,
  CanvasOverlay,
  IndicatorFactory,
  IndicatorRegistryEntry,
  IndicatorParam,
  IndicatorSeriesOutput,
} from "./types";

export {
  INTERVAL_VALID_RANGES,
  INTERVAL_DEFAULT_RANGE,
} from "./types";

// Indicators
export {
  INDICATOR_REGISTRY,
  getIndicatorEntry,
  createEMA,
  createSMA,
  createMACD,
  createRSI,
  createBollingerBands,
  createVWAP,
  createVolume,
  createStochastic,
  createFearGreed,
  fearGreedZoneColor,
  fearGreedZoneName,
  createVolumeProfileOverlay,
  createSessionVPOverlay,
  createCompositeVPOverlay,
} from "./indicators";
