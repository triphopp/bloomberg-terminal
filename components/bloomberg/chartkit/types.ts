/**
 * chartkit — core types.
 *
 * Deliberately free of any charting-engine import. Everything in this folder
 * (except `adapters/`) is pure arithmetic over these shapes, so the day this
 * repo grows its own candlestick renderer the viewport logic moves across
 * untouched — only a new adapter is written.
 */

/**
 * A viewport expressed in BAR INDICES, not time.
 *
 * `from` may be negative and `to` may exceed the bar count: that is the
 * whitespace either side of the data, and it is exactly what tells us the user
 * has zoomed out past what has been loaded.
 */
export interface LogicalRange {
  from: number;
  to: number;
}

/** A viewport expressed in the engine's own time values. */
export interface TimeRange<T = string | number> {
  from: T;
  to: T;
}

/** One reading of the viewport, taken whenever the user pans or zooms. */
export interface ViewportSample {
  range: LogicalRange;
  /** How many bars are currently loaded. */
  barCount: number;
}
