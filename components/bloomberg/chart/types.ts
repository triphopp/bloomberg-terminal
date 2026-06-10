/**
 * Modular Chart System — Core Types
 *
 * Architecture: "Building-block" pattern where each indicator is a self-contained
 * plugin that declares how to compute data and how to render on the chart.
 *
 * Two indicator categories:
 *   - "overlay" → drawn on the main price pane (e.g. EMA, Bollinger Bands, VWAP)
 *   - "pane"    → rendered in a separate sub-pane below (e.g. MACD, RSI, Volume)
 */

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

// ── OHLCV Bar ────────────────────────────────────────────────────────────────

export interface OhlcvBar {
  /** "YYYY-MM-DD" for daily/weekly; UNIX seconds for intraday */
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ── Timeframe Types ──────────────────────────────────────────────────────────

export type TimePeriod = "1d" | "5d" | "1m" | "3m" | "ytd" | "1y" | "5y" | "max";
export type BarInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1wk";

/** Which period ranges are valid for each interval */
export const INTERVAL_VALID_RANGES: Record<BarInterval, TimePeriod[]> = {
  "1m":  ["1d"],
  "5m":  ["1d"],
  "15m": ["1d", "5d"],
  "30m": ["1d", "5d", "1m"],
  "1h":  ["1d", "5d", "1m", "3m"],
  "2h":  ["5d", "1m", "3m", "1y"],
  "4h":  ["5d", "1m", "3m", "1y"],
  "1d":  ["1m", "3m", "ytd", "1y", "5y", "max"],
  "1wk": ["1y", "5y", "max"],
};

/** Sensible default range when user picks a new interval */
export const INTERVAL_DEFAULT_RANGE: Record<BarInterval, TimePeriod> = {
  "1m":  "1d",
  "5m":  "1d",
  "15m": "5d",
  "30m": "1m",
  "1h":  "1m",
  "2h":  "3m",
  "4h":  "3m",
  "1d":  "1y",
  "1wk": "max",
};

// ── Chart Theme ──────────────────────────────────────────────────────────────

export interface ChartColors {
  background: string;
  surface: string;
  border: string;
  text: string;
  textSecondary: string;
  positive: string;
  negative: string;
  accent?: string;
}

// ── Indicator Parameter Definition ───────────────────────────────────────────

export interface IndicatorParam {
  key: string;
  label: string;
  type: "number" | "boolean" | "select";
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

// ── Computed Series Data ─────────────────────────────────────────────────────

export interface SeriesDataPoint {
  time: string | number;
  value: number;
}

export interface HistogramDataPoint {
  time: string | number;
  value: number;
  color?: string;
}

export type IndicatorSeriesType = "line" | "histogram" | "area";

export interface IndicatorSeriesOutput {
  id: string;
  label: string;
  type: IndicatorSeriesType;
  data: SeriesDataPoint[] | HistogramDataPoint[];
  color?: string;
  lineWidth?: number;
  priceScaleId?: string;       // separate scale for pane indicators
  opacity?: number;
}

// ── Indicator Plugin Interface ───────────────────────────────────────────────

export interface ChartIndicator {
  /** Unique machine ID (e.g. "ema-20", "macd-12-26-9") */
  id: string;

  /** Human-readable name (e.g. "EMA 20") */
  name: string;

  /** Category slug for grouping in the selector UI */
  category: "trend" | "momentum" | "volume" | "volatility" | "custom";

  /** Where it renders */
  type: "overlay" | "pane";

  /** Short description shown in the indicator picker */
  description: string;

  /** Configurable parameters */
  params: IndicatorParam[];

  /** Current param values (key→value map). May contain complex objects for data-driven indicators (e.g. preloadedData). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;

  /**
   * Pure compute function: given OHLCV bars + config, return one or more series.
   * Must be stateless and deterministic.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compute(data: OhlcvBar[], config: Record<string, any>): IndicatorSeriesOutput[];

  /** Minimum bars required before this indicator can produce output */
  minBars: number;
}

// ── Indicator Factory ────────────────────────────────────────────────────────

/** A factory creates indicator instances with given config overrides */
export type IndicatorFactory = (configOverrides?: Record<string, number | boolean | string>) => ChartIndicator;

// ── Registry ─────────────────────────────────────────────────────────────────

export interface IndicatorRegistryEntry {
  id: string;
  name: string;
  category: ChartIndicator["category"];
  type: ChartIndicator["type"];
  description: string;
  defaultParams: IndicatorParam[];
  factory: IndicatorFactory;
}

// ── Chart State ──────────────────────────────────────────────────────────────

export interface ChartState {
  /** Active indicator instances */
  indicators: ChartIndicator[];
  /** Chart type */
  chartType: "candle" | "area";
  /** Current timeframe settings */
  timePeriod: TimePeriod;
  barInterval: BarInterval;
}

// ── Chart Event Markers (Dividends, Earnings, Splits) ───────────────────────

export type ChartEventType = "dividend" | "earnings" | "split";

export interface ChartEventMarker {
  time: string | number;
  type: ChartEventType;
  label: string;
  /** e.g. dividend amount, EPS surprise %, split ratio */
  value?: number;
  /** Extra detail shown in tooltip */
  detail?: string;
}

// ── Canvas Overlay (for Volume Profile etc.) ─────────────────────────────────

export interface CanvasOverlay {
  id: string;
  name: string;
  /** "right" = fixed-width strip beside price scale (default); "full" = spans entire chart area */
  mode?: "right" | "full";
  /** Called each frame / range-change to draw on the overlay canvas */
  draw(ctx: CanvasRenderingContext2D, chart: IChartApi, mainSeries: ISeriesApi<SeriesType>, data: OhlcvBar[], isDark: boolean): void;
  /** Width in pixels the overlay occupies (only for mode="right") */
  width: number;
}
