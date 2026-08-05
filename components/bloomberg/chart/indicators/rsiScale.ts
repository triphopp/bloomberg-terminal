/**
 * Presentation layer for the RSI pane's price scale.
 *
 * Every mode past `standard` relabels the axis; none of them transform the
 * plotted series. That is deliberate: RSI inverts to price bar by bar, so
 * running the whole series back through the inverse reproduces the price chart
 * exactly and tells you nothing. What is worth converting is a *level* — a
 * constant in RSI space with no preimage of its own — which is why only the
 * tick labels move.
 *
 * The labels are read against one bar's smoothing state, so they answer "what
 * would the next close have to be", not "what was this bar worth".
 */

import { type RsiState, priceForRsi } from "./rsiInverse.ts";

export type RsiScaleMode =
  | "standard" // fixed 0–100
  | "autofit" // zoom to the visible range
  | "price" // next-bar close that reaches each level
  | "pct" // move required from the last close
  | "avgmoves" // that move in units of (avgGain + avgLoss)
  | "logrs"; // log(avgGain / avgLoss) — symmetric in both directions

export interface RsiScaleConfig {
  mode: RsiScaleMode;
  /**
   * Which bar's smoothing state the projection reads. A forming bar has already
   * absorbed the current price, so projecting from it makes the levels chase the
   * quote; "closed" steps back one bar so the target holds still intraday.
   */
  basis: "closed" | "live";
  rounding: "tick" | "fixed2";
  projectToPricePane: boolean;
  clipOffScale: boolean;
}

export const RSI_SCALE_MODES: { mode: RsiScaleMode; label: string }[] = [
  { mode: "standard", label: "Standard 0–100" },
  { mode: "autofit", label: "Auto-fit" },
  { mode: "price", label: "Price projection" },
  { mode: "pct", label: "Distance %" },
  { mode: "avgmoves", label: "Distance in avg moves" },
  { mode: "logrs", label: "log RS" },
];

/** The bar a projection is measured from, plus the state that produced it. */
export interface RsiScaleBasis {
  close: number;
  state: RsiState;
  period: number;
  decimals: number;
}

/** Shown wherever a level cannot be reached in one bar — see `rsiFloor`. */
const UNREACHABLE = "—";

/**
 * Decimals to print a projected price with.
 *
 * Read off the data rather than hardcoded: a JGB yield, a THB equity and a
 * crypto pair do not agree on what "two decimals" means, and a level printed to
 * the wrong precision reads as a different price.
 */
export function inferPriceDecimals(closes: number[]): number {
  let decimals = 0;
  for (const close of closes.slice(-50)) {
    const text = String(close);
    const dot = text.indexOf(".");
    if (dot >= 0) decimals = Math.max(decimals, text.length - dot - 1);
    if (decimals >= 4) return 4;
  }
  return Math.min(4, Math.max(2, decimals));
}

/**
 * Formatter for the RSI axis, or null when the axis should stay in RSI units.
 *
 * The tick *values* are still chosen by lightweight-charts in RSI space, so the
 * labels come out evenly spaced in RSI and unevenly spaced in price — which is
 * the honest rendering. Equal RSI steps genuinely are unequal price steps, and
 * the gap widens fast toward either extreme.
 */
export function rsiAxisFormatter(
  mode: RsiScaleMode,
  basis: RsiScaleBasis | null
): ((rsi: number) => string) | null {
  if (mode === "standard" || mode === "autofit") return null;

  if (mode === "logrs") {
    // Needs no state at all: log RS is a reparametrisation of the axis itself.
    return (rsi: number) => {
      if (rsi <= 0 || rsi >= 100) return UNREACHABLE;
      return (Math.log(rsi / (100 - rsi)) as number).toFixed(2);
    };
  }

  if (!basis) return null;
  const { close, state, period, decimals } = basis;

  return (rsi: number) => {
    const projection = priceForRsi(close, state, period, rsi);
    if (!projection) return UNREACHABLE;

    if (mode === "price") return projection.price.toFixed(decimals);
    if (mode === "pct") return `${(((projection.price - close) / close) * 100).toFixed(1)}%`;

    // avgmoves: the gap in units of one bar's average movement, which is the
    // scale coordinate RSI discarded. Unlike a raw price gap this is comparable
    // across symbols and across time.
    const perBar = state.avgGain + state.avgLoss;
    if (perBar <= 0) return UNREACHABLE;
    return `${((projection.price - close) / perBar).toFixed(1)}x`;
  };
}

/**
 * One-line summary of what a level costs right now, for the context menu.
 *
 * Deliberately a single line: the full table this replaced said the same thing
 * six times over, and only the level the user is watching is ever the question.
 */
export function rsiLevelPreview(level: number, basis: RsiScaleBasis | null): string {
  if (!basis) return `RSI ${level} — no data`;
  const projection = priceForRsi(basis.close, basis.state, basis.period, level);
  if (!projection) return `RSI ${level} — unreachable in one bar`;

  const pct = ((projection.price - basis.close) / basis.close) * 100;
  return `RSI ${level} → ${projection.price.toFixed(basis.decimals)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}
