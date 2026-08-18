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

import type { AlertLabel, IndicatorOutput } from "@/lib/alerts/labels";
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

export type { AlertLabel, IndicatorOutput };

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
  "1m": ["1d"],
  "5m": ["1d"],
  "15m": ["1d", "5d"],
  "30m": ["1d", "5d", "1m"],
  "1h": ["1d", "5d", "1m", "3m"],
  "2h": ["5d", "1m", "3m", "1y"],
  "4h": ["5d", "1m", "3m", "1y"],
  "1d": ["1m", "3m", "ytd", "1y", "5y", "max"],
  "1wk": ["1y", "5y", "max"],
};

/** Sensible default range when user picks a new interval */
export const INTERVAL_DEFAULT_RANGE: Record<BarInterval, TimePeriod> = {
  "1m": "1d",
  "5m": "1d",
  "15m": "5d",
  "30m": "1m",
  "1h": "1m",
  "2h": "3m",
  "4h": "3m",
  "1d": "1y",
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

export type IndicatorSeriesType = "line" | "histogram" | "area" | "heatmap";

/**
 * One column of a heatmap pane: a bar time plus one value per row.
 *
 * `values[i]` belongs to `rows[i]` of the owning output — the renderer never
 * infers row order, so a column with the wrong length is dropped rather than
 * silently mis-stacked.
 */
export interface HeatmapColumn {
  time: string | number;
  values: (number | null)[];
  /** Row index to outline as "this is where price actually is/landed". */
  markRow?: number | null;
  /**
   * Per-row text drawn inside the cell when it is wide enough, bottom row first.
   * Carried on the column rather than derived from `values` because the useful
   * label is often NOT the plotted number — an SD heatmap cell is coloured by an
   * occupancy frequency but reads best labelled with the price at that sigma.
   */
  cellLabels?: (string | null)[];
}

/**
 * Fixed strip down the right edge of a heatmap pane, one entry per row.
 *
 * The cells themselves are only as wide as a bar, so on a young series (a
 * handful of columns) or a zoomed-out chart there is nowhere to print the price
 * and probability each row stands for. The rail always has room, and it does not
 * scroll away with the data.
 */
export interface HeatmapRail {
  /** Primary line per row, bottom row first — e.g. the price at that sigma. */
  rows: string[];
  /** Optional second line per row, e.g. the probability of reaching it. */
  subRows?: (string | null)[];
  /** Heading drawn above the strip. */
  title?: string;
}

/** Maps a cell value to a fill. Returning null leaves the cell unpainted. */
export type HeatmapColorScale = (value: number, rowIndex: number) => string | null;

/**
 * What a row stands for, drawn in the pane's left gutter.
 *
 * Two fields rather than one string so they can be typeset apart — the level is
 * the primary reading and the odds are context beside it, which a single
 * pre-joined label cannot express.
 */
export interface HeatmapRowLabel {
  /** Primary: which row this is, e.g. "+1σ". */
  level: string;
  /** Secondary: the odds of that outcome, e.g. "15.9%". */
  odds?: string;
  /** Overrides the level's colour — e.g. tinting upside rows differently. */
  color?: string;
}

export interface HeatmapSpec {
  /** Row labels, bottom row first — matching each column's `values` order. */
  rows: (string | HeatmapRowLabel)[];
  columns: HeatmapColumn[];
  colorScale: HeatmapColorScale;
  /** Outline color for `markRow`. */
  markColor?: string;
  /** Formats a cell value when the column supplies no `cellLabels`. */
  formatValue?: (value: number) => string;
  /**
   * Right-edge strip of per-row reference values, used ONLY as a fallback: when
   * the cells are wide enough to print their own values the rail would just
   * repeat them, so it is dropped and its width returned to the plot.
   */
  rail?: HeatmapRail;
  /**
   * Drawn in the middle of the pane when there is nothing to plot.
   *
   * A heatmap with no columns is otherwise indistinguishable from a broken one:
   * the pane still exists (it is created from the indicator, not from the data),
   * so without this the user gets an empty box and no way to tell whether the
   * indicator is loading, starved of data, or simply not working.
   */
  emptyMessage?: string;
}

export interface IndicatorSeriesOutput {
  id: string;
  label: string;
  type: IndicatorSeriesType;
  data: SeriesDataPoint[] | HistogramDataPoint[];
  color?: string;
  lineWidth?: number;
  priceScaleId?: string; // separate scale for pane indicators
  opacity?: number;
  /**
   * Required when `type === "heatmap"`, ignored otherwise. Heatmap cells are not
   * expressible as a lightweight-charts series, so the pane hosts an invisible
   * anchor series and the cells are painted by a canvas primitive attached to
   * it (see chart/heatmap-overlay.ts). `data` stays empty for these.
   */
  heatmap?: HeatmapSpec;
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
  // biome-ignore lint/suspicious/noExplicitAny: config values are indicator-specific, intentionally untyped
  config: Record<string, any>;

  /**
   * Pure compute function: given OHLCV bars + config, return one or more series.
   * Must be stateless and deterministic.
   */
  // biome-ignore lint/suspicious/noExplicitAny: config values are indicator-specific, intentionally untyped
  compute(data: OhlcvBar[], config: Record<string, any>): IndicatorSeriesOutput[];

  /** Minimum bars required before this indicator can produce output */
  minBars: number;
}

// ── Indicator Factory ────────────────────────────────────────────────────────

/** A factory creates indicator instances with given config overrides */
export type IndicatorFactory = (
  configOverrides?: Record<string, number | boolean | string>
) => ChartIndicator;

// ── Registry ─────────────────────────────────────────────────────────────────

export interface IndicatorRegistryEntry {
  id: string;
  name: string;
  category: ChartIndicator["category"];
  type: ChartIndicator["type"];
  description: string;
  defaultParams: IndicatorParam[];
  factory: IndicatorFactory;
  /**
   * Param keys measured in bars, which the "days" window unit converts for the
   * interval on screen (see chart/windowUnits.ts). Omit keys that are not
   * durations — standard deviations, thresholds, ratios must never be scaled.
   */
  timeScalableParams?: string[];
  /**
   * Auto-layout height in px for this indicator's pane, when the default is too
   * small to be legible. Only a ceiling request — the layout still caps it at the
   * space actually available, and a user drag still wins.
   */
  preferredPaneHeight?: number;
  /** Values this indicator exposes for use as an alert Operand (plan §2). */
  outputs?: IndicatorOutput[];
  /** Named predicate templates for the alert rule builder (plan §2, §8.5). */
  alertLabels?: AlertLabel[];
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
  /** One-line summary shown in the detail popover header */
  detail?: string;
  /** Optional per-marker color override (e.g. earnings beat=green / miss=red) */
  color?: string;

  // ── Raw fields, kept unformatted so the detail popover can lay them out ──
  // The chart itself only needs `type`/`color`; everything below exists for the
  // click-through detail card and must not be pre-baked into strings.
  /** earnings — consensus EPS estimate ahead of the report */
  epsEstimate?: number | null;
  /** earnings — EPS actually reported */
  reportedEPS?: number | null;
  /** earnings — surprise %, positive = beat. Null for an upcoming report. */
  surprise?: number | null;
  /** earnings — Yahoo's "Event Type" string (e.g. "Earnings") */
  eventType?: string;
  /** earnings — original timestamp including the session hint (BMO/AMC) */
  reportedAt?: string;
  /** dividend — amount per share, in the listing currency */
  dividend?: number;
  /** split — new:old ratio (2 means a 2:1 split) */
  splitRatio?: number;
}

/** How a marker's price reaction played out, derived from the loaded OHLCV. */
export interface EventPriceReaction {
  /** Open of the event bar vs the previous close, in % */
  gapPct: number | null;
  /** Close of the event bar vs the previous close, in % */
  sameDayPct: number | null;
  /** Close one bar later vs the previous close, in % */
  nextDayPct: number | null;
  /** Close five bars later vs the previous close, in % */
  fiveDayPct: number | null;
  /** Close on the event bar — used to express a dividend as a yield */
  closeOnEvent: number | null;
}

// ── Canvas Overlay (for Volume Profile etc.) ─────────────────────────────────

/**
 * Drawing area handed to an overlay, in CSS pixels.
 *
 * Overlays must size themselves from this rather than from `ctx.canvas`: when
 * rendered as a lightweight-charts series primitive the context belongs to the
 * whole pane, so `canvas.offsetWidth/Height` describe the pane, not the slot
 * the overlay was given. The origin (0,0) is already translated to the
 * overlay's top-left corner.
 */
export interface OverlayRect {
  width: number;
  height: number;
}

export interface CanvasOverlay {
  id: string;
  name: string;
  /** "right" = fixed-width strip beside price scale (default); "full" = spans entire chart area */
  mode?: "right" | "full";
  /** Called each frame / range-change to draw on the overlay canvas */
  draw(
    ctx: CanvasRenderingContext2D,
    chart: IChartApi,
    mainSeries: ISeriesApi<SeriesType>,
    data: OhlcvBar[],
    isDark: boolean,
    rect: OverlayRect
  ): void;
  /** Width in pixels the overlay occupies (only for mode="right") */
  width: number;
}
