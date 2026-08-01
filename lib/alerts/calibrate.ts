/**
 * Calibration — HOW a label's threshold is interpreted, kept separate from
 * WHAT the label means (concepts.ts). Same number, three legitimate readings:
 *
 *   static    RSI(14) <= 30                          — convention, easy to reason about
 *   adaptive  pctRank(RSI(14), window) <= 0.10        — fair across symbols with different vol
 *   regime    threshold shifts with trend context     — compiles to a plain OR, no new AST node
 *
 * See memory/plans/alert-rule-engine.md §8.5.2.
 */

export type CalibrationMode = "static" | "adaptive" | "regime";

export type Calibration =
  | { mode: "static" }
  | { mode: "adaptive"; window: number }
  | { mode: "regime" };

export const STATIC_CALIBRATION: Calibration = { mode: "static" };

/** Default window for adaptive (percentile-rank) calibration when the label
 *  doesn't specify its own — roughly a trading year of daily bars. */
export const DEFAULT_ADAPTIVE_WINDOW = 252;

export interface LabelBuildCtx {
  /** The indicator instance's own params (period, stdDev, ...). */
  indParams: Record<string, number>;
  /** The label's own params (e.g. threshold) — irrelevant in adaptive mode. */
  labelParams: Record<string, number>;
  calibration: Calibration;
}
